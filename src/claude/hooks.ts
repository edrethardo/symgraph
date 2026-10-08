import '../util/env-compat.js';
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { join, basename, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readWiring } from './stats.js';
import { formatBlastRadius, relevantRetrieval, formatOrientation } from './format.js';
import { indexFreshness, staleBanner } from '../context/check.js';
import { patchStats, readStats, acquireLock, readSession, writeSession, resolveContextDir } from './state.js';
import { symgraphCliPath, claudeScriptPath } from './paths.js';
import { runUpkeep } from '../upkeep-run.js';
import { runningVersion } from '../upkeep.js';
import { scopeOf, scopesOfGraph } from '../graph/scopes.js';

/** Prompts shorter than this never trigger retrieval — they are almost always
 * conversational ("yes go ahead", "thanks") and the coverage gate can't judge
 * them reliably with so few terms. */
const MIN_PROMPT_CHARS = 12;

function readStdin(): any {
  const seam = process.env.SYMGRAPH_TEST_STDIN;
  const raw = seam !== undefined ? seam : safeReadFd0();
  try { return JSON.parse(raw); } catch { return {}; }
}
function safeReadFd0(): string { try { return readFileSync(0, 'utf8'); } catch { return ''; } }

function projectDir(input: any): string {
  return process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
}
export function underSymgraph(dir: string, file: string): boolean {
  const rel = file.startsWith(dir) ? file.slice(dir.length) : file;
  return rel.replace(/^[/\\]+/, '').replace(/\\/g, '/').startsWith('symgraph/');
}
/** Default budget for a symgraph child process invoked from a hook, matching the 8s
 * the installed hook entries carry. */
const CHILD_TIMEOUT_MS = 8000;
/** Headroom left for the hook's own work (read stdin, score, write session, emit)
 * after its `symgraph ask` child returns. */
const HOOK_OVERHEAD_MS = 2000;
/** Floor, so a hand-edited tiny timeout can't leave the child no time at all. */
const MIN_CHILD_TIMEOUT_MS = 4000;

/**
 * How long the prompt hook may let `symgraph ask` run — derived from the budget that is
 * *actually installed* in this repo's `.claude/settings.json`, not from what the
 * current version of `settings-merge.ts` would install.
 *
 * A query now brings the graph up to date first, so `symgraph init` raises the
 * UserPromptSubmit budget to 15s to cover the one cold rebuild after an upgrade. But
 * `mergeSymgraphSettings` only runs during `symgraph init` — upgrading the npm package does
 * not re-run it. So every repo wired before that change keeps `"timeout": 8000`, and
 * hard-coding a 13s child there means Claude Code kills the hook first: `emit()` and
 * `writeSession()` never run, the turn gets no retrieval pack at all, and the SIGKILLed
 * child can't even release the build lock. Reading the installed number keeps the child
 * strictly inside whatever budget this repo really has.
 */
export function promptAskTimeout(dir: string): number {
  const installed = installedHookTimeout(dir, 'UserPromptSubmit');
  if (installed === null) return CHILD_TIMEOUT_MS - HOOK_OVERHEAD_MS;
  return Math.max(MIN_CHILD_TIMEOUT_MS, installed - HOOK_OVERHEAD_MS);
}

/**
 * Every settings file Claude Code merges hook definitions from, for a session
 * rooted at `dir`. The per-repo file is not the only place symgraph's hooks can be
 * installed: declaring them once at the user level wires every repo on the
 * machine at once, and such a repo has no `.claude/settings.json` at all.
 */
function hookSettingsFiles(dir: string): string[] {
  const user = process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), '.claude');
  return [
    join(dir, '.claude', 'settings.json'),
    join(dir, '.claude', 'settings.local.json'),
    join(user, 'settings.json'),
  ];
}

/** The timeout on one settings file's symgraph hook entry for `event`, or null if it
 * can't be read (no settings file, hand-edited shape, unparseable JSON). */
function hookTimeoutIn(file: string, event: string): number | null {
  try {
    const settings = JSON.parse(readFileSync(file, 'utf8')) as any;
    const blocks = settings?.hooks?.[event];
    if (!Array.isArray(blocks)) return null;
    for (const block of blocks) {
      for (const h of block?.hooks ?? []) {
        if (typeof h?.command === 'string' && h.command.includes('symgraph-hooks.cjs') && typeof h.timeout === 'number') {
          return h.timeout;
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * The budget this hook is actually running under, or null when no settings file
 * declares one.
 *
 * The smallest declared timeout wins rather than the nearest, because when more
 * than one file declares the hook Claude Code runs every matching entry and this
 * process cannot tell which one launched it. Guessing high is the expensive
 * mistake: an overrunning child gets the whole hook SIGKILLed, so `emit()` and
 * `writeSession()` never run and the turn silently gets no retrieval at all.
 * Guessing low only shortens one query.
 */
function installedHookTimeout(dir: string, event: string): number | null {
  let smallest: number | null = null;
  for (const file of hookSettingsFiles(dir)) {
    const timeout = hookTimeoutIn(file, event);
    if (timeout === null) continue;
    if (smallest === null || timeout < smallest) smallest = timeout;
  }
  return smallest;
}

/**
 * Append `--dir <contextDir>` for the hooks' own `symgraph ask`/`symgraph check`
 * children — the one place in this file that spawns the CLI itself rather
 * than reading `symgraph/` off disk (which already resolves through
 * `resolveContextDir` inside `util/state.ts` and `claude/stats.ts`). A no-op
 * when `SYMGRAPH_DIR` isn't set, so an unconfigured repo's spawned CLI sees
 * byte-identical argv to before this existed.
 */
function withContextDirArg(dir: string, args: string[]): string[] {
  return process.env.SYMGRAPH_DIR ? [...args, '--dir', resolveContextDir(dir)] : args;
}

function symgraphJson(dir: string, args: string[], timeout: number = CHILD_TIMEOUT_MS): any | null {
  try {
    // SYMGRAPH_TEST_CLI is a test seam (mirrors SYMGRAPH_TEST_STDIN/SYMGRAPH_TEST_SYNC_RUN) so
    // tests can point the prompt hook's `symgraph ask`/`symgraph check` calls at a stub
    // script and observe the exact args it was invoked with, instead of shelling
    // out to the real CLI (which isn't built relative to the TS source under test).
    const cliPath = process.env.SYMGRAPH_TEST_CLI ?? symgraphCliPath();
    const out = execFileSync(process.execPath, [cliPath, ...args],
      { cwd: dir, encoding: 'utf8', timeout, stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out);
  } catch (e: any) {
    // `symgraph check` exits non-zero when the graph is stale (by design) but still
    // prints valid JSON to stdout; recover it from the thrown error before giving up.
    if (e && typeof e.stdout === 'string' && e.stdout.trim()) {
      try { return JSON.parse(e.stdout); } catch { /* not JSON — fall through */ }
    }
    return null;
  }
}
function checkStaleCount(dir: string): number {
  const r = symgraphJson(dir, withContextDirArg(dir, ['check', '.', '--json']));
  const g = r?.graph ?? {};
  return (g.changed?.length ?? 0) + (g.added?.length ?? 0) + (g.removed?.length ?? 0);
}
function emit(eventName: string, additionalContext: string): void {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
}

/**
 * The absolute path of the file a PostToolUse edit touched, across host edit-tool
 * shapes:
 *   - Claude Code (`Write`/`Edit`/`MultiEdit`) states it directly as
 *     `tool_input.file_path` (already absolute).
 *   - Codex (`apply_patch`) carries the whole patch in `tool_input.command` and
 *     names the file in the patch header (`*** Add File:` / `*** Update File:`),
 *     as a repo-relative path — resolved against `dir` here. Take the first
 *     Add/Update target; that one file is enough to mark the graph dirty and
 *     draw a blast radius (the sync re-checks the whole tree anyway).
 * Returns null when neither shape yields a path, so the hook stays a clean no-op.
 */
export function editedFilePath(input: any, dir: string): string | null {
  const direct = input?.tool_input?.file_path;
  if (typeof direct === 'string' && direct.trim()) return direct;
  const cmd = input?.tool_input?.command;
  if (typeof cmd === 'string' && cmd) {
    const m = /^\*\*\*\s+(?:Add|Update)\s+File:\s+(.+?)\s*$/m.exec(cmd);
    if (m) return isAbsolute(m[1]) ? m[1] : join(dir, m[1]);
  }
  return null;
}

async function handlePostEdit(input: any, dir: string): Promise<void> {
  const file = editedFilePath(input, dir);
  if (!file || underSymgraph(dir, file)) return;
  patchStats(dir, { dirty: true, staleCount: checkStaleCount(dir), lastFile: basename(file) });
  const w = readWiring(dir);
  if (w) { const br = formatBlastRadius(w, file); if (br) emit('PostToolUse', br); }
}

/**
 * The "you're working in backend/, weight it" hint: on a multi-scope repo,
 * narrow the prompt hook's `ask` call to whatever scope the last-edited file
 * (`stats.lastFile`, captured at {@link handlePostEdit}) sits in.
 *
 * `lastFile` is only a basename (not a repo-relative path — see
 * `handlePostEdit`), so this is a best-effort lookup against the CURRENT
 * graph: any file node whose path ends in `/<lastFile>` (or equals it, for a
 * repo-root file). Fails soft in every direction a hook must never crash on —
 * no graph, a single-scope graph, a lastFile no longer in the graph (moved,
 * deleted, or edited before the first build), or a basename that lands in
 * more than one scope (ambiguous: could be either sub-project) all skip the
 * hint silently, logging one line to stderr so the miss is visible without
 * ever failing the hook.
 */
export function lastFileScopeHint(dir: string, lastFile: string | null | undefined): string | null {
  if (!lastFile) return null;
  try {
    const w = readWiring(dir);
    if (!w) return null;
    const scopes = scopesOfGraph(w);
    if (scopes.length <= 1) return null; // single-scope: no hint, no --in
    const matches = (w.nodes ?? []).filter(
      (n) => n.kind === 'file' && (n.path === lastFile || n.path.endsWith(`/${lastFile}`)),
    );
    if (matches.length === 0) {
      console.error(`[symgraph] prompt hook: lastFile "${lastFile}" not found in the graph — skipping scope hint`);
      return null;
    }
    const prefixes = new Set(matches.map((n) => scopeOf(n.path, scopes).prefix));
    if (prefixes.size > 1) {
      console.error(`[symgraph] prompt hook: lastFile "${lastFile}" matches more than one scope — skipping scope hint`);
      return null;
    }
    const [prefix] = prefixes;
    return prefix === '' ? null : prefix; // root scope: nothing to narrow
  } catch (e: any) {
    console.error(`[symgraph] prompt hook: scope hint lookup failed (${e?.message ?? e}) — skipping`);
    return null;
  }
}

/** PostToolUse on a symgraph retrieval tool. Its rendered output opens with the
 * `[symgraph] answered from the index` marker; count those to keep the session's
 * symgraph-call tally, which the statusline shows as `N symgraph calls`, across CLI
 * and MCP. This used to sum the tokens-saved numbers the output carried, but
 * that estimate assumed you would otherwise have read every covered file in
 * full — an order of magnitude high — so the statusline reported a total that
 * was never real. A call count is a fact. Pure parse of the payload the hook
 * already received (no re-run), and a no-op unless the marker is present, so
 * it stays cheap on unrelated Bash calls. */
function handleToolSavings(input: any, dir: string): void {
  const blob = JSON.stringify(input?.tool_response ?? input ?? '');
  const calls = [...blob.matchAll(/\[symgraph\] answered from the index/g)].length;
  if (calls <= 0) return;
  const id = input?.session_id || 'default';
  const s = readSession(dir, id);
  s.symgraphCalls = (s.symgraphCalls ?? 0) + calls;
  writeSession(dir, id, s);
}

function handleStop(dir: string): void {
  // sync-run.js ships next to this module inside the package, so it resolves in
  // any repo that installs symgraph (not just symgraph's own). Defensive existsSync:
  // if the package is somehow incomplete, skip rather than wedge on syncing:true.
  // SYMGRAPH_TEST_SYNC_RUN is a test seam (mirrors SYMGRAPH_TEST_STDIN) so tests can point
  // this at a stub file inside their own sandbox instead of writing into src/claude/.
  const syncRun = process.env.SYMGRAPH_TEST_SYNC_RUN ?? claudeScriptPath('sync-run.js');
  if (!existsSync(syncRun)) return;
  const stats = readStats(dir);
  if (stats?.dirty && acquireLock(dir)) {
    patchStats(dir, { syncing: true });
    const child = spawn(process.execPath, [syncRun, dir], { detached: true, stdio: 'ignore', windowsHide: true });
    child.unref();
  }
}

export async function main(event: string): Promise<void> {
  const input = readStdin();
  const dir = projectDir(input);

  if (event === 'session-start') {
    // Before anything is emitted: refresh this repo's wiring if it was written by
    // an older symgraph, and pick up any cached "newer version on npm" answer.
    // background:false — a hook must never touch the network; the CLI and the MCP
    // server fill that cache, this only reads it.
    const upkeep = runUpkeep(dir, runningVersion(), { background: false }).lines;
    try {
      const idx = readFileSync(join(resolveContextDir(dir), 'INDEX.md'), 'utf8');
      const banner = staleBanner(indexFreshness(dir)) ?? undefined;
      const orientation = formatOrientation(idx, undefined, banner);
      emit('SessionStart', upkeep.length ? `${upkeep.join('\n')}\n\n${orientation}` : orientation);
    } catch {
      // No INDEX.md (never built here). An upgrade nudge is still worth saying.
      if (upkeep.length) emit('SessionStart', upkeep.join('\n'));
    }
    return;
  }

  if (event === 'post-edit') { await handlePostEdit(input, dir); return; }

  if (event === 'tool-savings') { handleToolSavings(input, dir); return; }

  if (event === 'stop') { handleStop(dir); return; }

  if (event === 'post-edit-sync') { await handlePostEdit(input, dir); handleStop(dir); return; }

  if (event === 'prompt') {
    const prompt = String(input?.prompt ?? '').trim();
    if (prompt.length < MIN_PROMPT_CHARS) return;
    // Pointers-only, small, gated. No --source: per-prompt injected tokens are
    // fresh full-price input on every turn (unlike the cached SessionStart
    // orientation), so the pack carries locators, never inlined code — the agent
    // pulls spans itself via `symgraph ask --source` when a pointer looks right.
    // relevantRetrieval then drops the pack entirely when the prompt barely
    // overlaps the top hit or when every hit was already injected this session.
    const askArgs = withContextDirArg(dir, ['ask', prompt, '.', '--json', '-n', '3']);
    // "You're working in backend/, weight it": only fires on a multi-scope
    // repo whose lastFile resolves cleanly to one scope — see lastFileScopeHint.
    const scopeHint = lastFileScopeHint(dir, readStats(dir)?.lastFile);
    if (scopeHint) askArgs.push('--in', scopeHint);
    const ask = symgraphJson(dir, askArgs, promptAskTimeout(dir));
    if (!ask) return;
    const id = input.session_id || 'default';
    const s = readSession(dir, id);
    s.lastQuery = prompt;
    const agent = input?.agent?.name;
    if (agent) s.perAgentQuery[agent] = prompt;
    const txt = relevantRetrieval(ask, s);
    if (txt) emit('UserPromptSubmit', txt);
    writeSession(dir, id, s);
  }
}
