/**
 * Retraction: undo every edit symgraph has ever made to a repo.
 *
 * `init` is additive — it writes the files the *currently selected* hosts need
 * and never looks at the rest. So a repo wired by an older version (or by the
 * same version with different `--agents`) keeps the files that run produced,
 * and the two sets accumulate. Retraction is the missing half: it walks every
 * target symgraph could ever have written and removes symgraph's contribution, so
 * `retract` + `init` converges the repo on exactly this version's intent.
 *
 * The target list is derived from the same registries `init` writes through
 * (`HOSTS`, `mcpTargets`, `hookTargets`, `claudeTargets`), so a host added
 * later is retractable for free — there is no second list to keep in sync.
 * Only {@link LEGACY_TARGETS} is hand-maintained, and only for paths that have
 * been *removed* from those registries: once a host is gone, nothing else
 * remembers the file it used to write.
 *
 * Two invariants, both load-bearing:
 *   1. Never delete what symgraph did not write. Inside a file the user owns, only
 *      the marker-fenced region and symgraph-named keys are touched; foreign MCP
 *      servers, hooks, and settings are preserved byte for byte.
 *   2. Never leave an empty shell. A file that held nothing but symgraph's
 *      contribution is deleted, not truncated to `{}` or a blank document —
 *      an orphan file is the very residue this exists to remove.
 */
import { readFileSync, writeFileSync, existsSync, rmSync, rmdirSync, statSync, readdirSync } from 'node:fs';
import { join, dirname, relative } from 'node:path';
import { homedir } from 'node:os';
import { HOSTS } from './registry.js';
import { START, END } from './sections.js';
import { mcpTargets, stripTomlSection } from './mcp-config.js';
import { hookTargets } from './codex-hooks.js';
import { antigravitySkillTargets } from './antigravity.js';
import { claudeGlobalTargets } from './claude-global.js';
import { claudeTargets } from '../claude/init.js';
import { isSymgraphAllowEntry, isSymgraphFooterRegex } from '../claude/settings-merge.js';
import { LEGACY_NAME, NAME } from '../util/legacy.js';
import type { WriteScope } from './plan.js';

/** What a retraction did to one target. */
export type RetractAction =
  /** symgraph's contribution was there and is now gone. */
  | 'removed'
  /** the whole file was symgraph's, so the file itself is gone. */
  | 'deleted'
  /** nothing of symgraph's here. */
  | 'absent'
  /** file exists but can't be parsed — left untouched rather than risk it. */
  | 'skipped-unparseable';

export interface Retraction {
  /** The host this target belongs to, for grouping the report. */
  hostId: string;
  path: string;
  /** Short human label for what was removed from that file. */
  what: string;
  scope: WriteScope;
  action: RetractAction;
  /** true → written by graft, this tool's name before the rename. */
  legacy?: boolean;
}

export interface RetractOpts {
  home?: string;
  /** false → report only, touch nothing. Defaults to false: a destructive
   *  operation must be asked for, never assumed. */
  apply?: boolean;
  /** false → skip targets outside the repo (the ~/.codex and ~/.gemini writes). */
  global?: boolean;
  /** false → keep `symgraph/` and the ignore entries. `init` sets this: the cache is
   *  regenerable but re-parsing a large repo costs minutes, and init is about to
   *  use it. */
  cache?: boolean;
  /** Host ids about to be re-written, so their targets are left alone. `init`
   *  passes its selection: retracting a file it is one step from rewriting is
   *  pure churn (and would report every write as `created`). */
  exclude?: string[];
}

/**
 * Paths that older versions wrote and the live registries no longer mention.
 * Empty today — every host in `HOSTS` since the multi-host layer landed is
 * still there. The one rename so far (graft → symgraph) is covered wholesale by
 * {@link legacyNameTargets} instead of being listed path by path.
 *
 * This is where a *removed* host's file goes. Deleting an entry from `HOSTS`
 * without adding it here is what strands a file in every existing repo.
 */
const LEGACY_TARGETS: { relPath: string; kind: 'owned' | 'section'; what: string }[] = [];

/** How symgraph's entries in `.claude/settings.json` are recognized under one name. */
interface Matchers {
  name: string;
  allow: (entry: unknown) => boolean;
  footer: (re: unknown) => boolean;
}

const CURRENT: Matchers = { name: NAME, allow: isSymgraphAllowEntry, footer: isSymgraphFooterRegex };

/** The same recognizers for what graft (this tool's former name) wrote. */
const LEGACY: Matchers = {
  name: LEGACY_NAME,
  allow: (e) => /^Bash\((?:graft|npx graft|npx @nanonets\/graft|graft-dev)(?::|\))/.test(String(e)),
  footer: (re) => String(re).includes('graft/'),
};

/** graft's marker fences, from before the rename. */
const LEGACY_START = START.replace(NAME, LEGACY_NAME);
const LEGACY_END = END.replace(NAME, LEGACY_NAME);

// ---------------------------------------------------------------------------
// primitive operations
// ---------------------------------------------------------------------------

/** True when a file has no non-whitespace content left. */
function isBlank(text: string): boolean {
  return text.trim() === '';
}

function removeFile(path: string, apply: boolean): RetractAction {
  if (!existsSync(path)) return 'absent';
  if (apply) {
    rmSync(path, { force: true });
    pruneEmptyDirs(dirname(path));
  }
  return 'deleted';
}

/**
 * Walk up from a just-emptied directory removing empty ancestors, so retracting
 * `.claude/skills/symgraph/SKILL.md` doesn't leave a hollow `skills/symgraph/` behind.
 * Stops at the first non-empty directory — never climbs out of the repo, because
 * any ancestor that far up has other content in it.
 */
function pruneEmptyDirs(dir: string): void {
  for (let d = dir, i = 0; i < 6; i++) {
    try {
      if (readdirSync(d).length > 0) return;
      rmdirSync(d); // throws on a non-empty dir — exactly the guard we want
    } catch {
      return; // not a dir, not empty, or not ours to remove
    }
    const parent = dirname(d);
    if (parent === d) return;
    d = parent;
  }
}

/**
 * Strip the marker-fenced symgraph block from a file the user owns.
 *
 * Paragraph spacing around the removed block is collapsed back to a single
 * blank line, so a file that had prose either side of the block reads exactly
 * as it did before symgraph appended to it.
 */
function stripSection(path: string, apply: boolean, start = START, end = END): RetractAction {
  if (!existsSync(path)) return 'absent';
  const text = readFileSync(path, 'utf8');
  if (!text.includes(start)) return 'absent';
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r\n|\n/);
  const out: string[] = [];
  let inside = false;
  let found = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inside && t === start) { inside = true; found = true; continue; }
    if (inside) { if (t === end) inside = false; continue; }
    out.push(line);
  }
  if (!found) return 'absent';
  // Collapse the run of blank lines the block left behind, and trim the edges.
  const collapsed = out
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  if (!apply) return isBlank(collapsed) ? 'deleted' : 'removed';
  if (isBlank(collapsed)) return removeFile(path, true);
  writeFileSync(path, eol === '\n' ? collapsed : collapsed.replace(/\n/g, '\r\n'));
  return 'removed';
}

/**
 * Delete `<topKey>.symgraph` from a JSON config, preserving every other server.
 * An unparseable file is reported and left alone — the user may have comments or
 * a half-finished edit in there, and rewriting it would lose more than it fixes.
 */
function removeJsonKey(path: string, topKey: string, apply: boolean, key: string = NAME): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, unknown>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  const bucket = root[topKey];
  if (typeof bucket !== 'object' || bucket === null || Array.isArray(bucket)) return 'absent';
  const map = bucket as Record<string, unknown>;
  if (!(key in map)) return 'absent';
  if (!apply) {
    return Object.keys(map).length === 1 && Object.keys(root).length === 1 ? 'deleted' : 'removed';
  }
  delete map[key];
  if (Object.keys(map).length === 0) delete root[topKey];
  if (Object.keys(root).length === 0) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/**
 * Delete the `[mcp_servers.symgraph]` table from a TOML config.
 *
 * Line-based on purpose: a real TOML parse-and-reserialize would reformat the
 * user's whole file. The table runs from its header to the next `[`-header or
 * EOF, which is exactly what `upsertCodexToml` appends.
 */
function removeTomlSection(path: string, apply: boolean, header?: string): RetractAction {
  if (!existsSync(path)) return 'absent';
  const { rest: kept, found } = stripTomlSection(readFileSync(path, 'utf8'), header);
  if (!found) return 'absent';
  if (!apply) return isBlank(kept) ? 'deleted' : 'removed';
  if (isBlank(kept)) return removeFile(path, true);
  writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
  return 'removed';
}

/**
 * Remove symgraph's fragments from `.claude/settings.json`, keeping the user's.
 *
 * The statusline check is by *shim path*, not exact string equality: an older
 * version's command differed in shape, and `mergeSymgraphSettings` would read that
 * as a hand-written statusline and refuse to touch it forever. Matching the
 * helper path recognizes symgraph's own output across every version that wrote it.
 */
function stripClaudeSettings(path: string, apply: boolean, m: Matchers = CURRENT): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, any>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  const before = JSON.stringify(root);
  const isSymgraphCmd = (v: unknown) => JSON.stringify(v ?? '').includes(`${m.name}-statusline.cjs`);

  for (const key of ['statusLine', 'subagentStatusLine']) {
    if (root[key] !== undefined && isSymgraphCmd(root[key])) delete root[key];
  }

  if (root.hooks && typeof root.hooks === 'object' && !Array.isArray(root.hooks)) {
    for (const event of Object.keys(root.hooks)) {
      const prior = root.hooks[event];
      if (!Array.isArray(prior)) continue;
      const kept = prior.filter((e: unknown) => !JSON.stringify(e ?? '').includes(`${m.name}-hooks.cjs`));
      if (kept.length === 0) delete root.hooks[event];
      else root.hooks[event] = kept;
    }
    if (Object.keys(root.hooks).length === 0) delete root.hooks;
  }

  if (Array.isArray(root.footerLinksRegexes)) {
    const kept = root.footerLinksRegexes.filter((r: unknown) => !m.footer(r));
    if (kept.length === 0) delete root.footerLinksRegexes;
    else root.footerLinksRegexes = kept;
  }

  if (root.permissions && Array.isArray(root.permissions.allow)) {
    const kept = root.permissions.allow.filter((a: unknown) => !m.allow(a));
    if (kept.length === 0) delete root.permissions.allow;
    else root.permissions.allow = kept;
    if (Object.keys(root.permissions).length === 0) delete root.permissions;
  }

  const after = JSON.stringify(root);
  if (after === before) return 'absent';
  if (!apply) return Object.keys(root).length === 0 ? 'deleted' : 'removed';
  if (Object.keys(root).length === 0) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/** Remove symgraph's PostToolUse/SessionStart/etc. entries from Codex's hooks.json. */
function stripCodexHooks(path: string, apply: boolean, name: string = NAME): RetractAction {
  if (!existsSync(path)) return 'absent';
  let root: Record<string, any>;
  try {
    root = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return 'skipped-unparseable';
  }
  if (typeof root !== 'object' || root === null || Array.isArray(root)) return 'skipped-unparseable';
  if (!root.hooks || typeof root.hooks !== 'object' || Array.isArray(root.hooks)) return 'absent';
  const before = JSON.stringify(root);
  for (const event of Object.keys(root.hooks)) {
    const prior = root.hooks[event];
    if (!Array.isArray(prior)) continue;
    const kept = prior.filter((e: unknown) => !JSON.stringify(e ?? '').includes(`${name}-hooks.cjs`));
    if (kept.length === 0) delete root.hooks[event];
    else root.hooks[event] = kept;
  }
  if (Object.keys(root.hooks).length === 0) delete root.hooks;
  if (JSON.stringify(root) === before) return 'absent';
  if (!apply) return Object.keys(root).length === 0 ? 'deleted' : 'removed';
  if (Object.keys(root).length === 0) return removeFile(path, true);
  writeFileSync(path, `${JSON.stringify(root, null, 2)}\n`);
  return 'removed';
}

/**
 * Drop symgraph's block from `.gitignore` / `.ignore`.
 *
 * Both are written as a comment line plus entries; the comment is symgraph's own
 * wording, so it identifies the block. Entries are matched individually too, so
 * a hand-tidied file (comment deleted, entry kept) still retracts cleanly.
 */
function stripIgnoreEntries(path: string, entries: RegExp[], apply: boolean, name: string = NAME): RetractAction {
  if (!existsSync(path)) return 'absent';
  const text = readFileSync(path, 'utf8');
  // A comment naming the tool starts its block; a comment line straight after it
  // is that comment's continuation (the .ignore note runs over two lines).
  let inComment = false;
  const kept = text
    .split('\n')
    .filter((l) => {
      const t = l.trim();
      const ours = t.startsWith('#') && (t.includes(name) || inComment);
      inComment = ours;
      if (ours) return false;
      return !entries.some((re) => re.test(t));
    })
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/^\n+/, '')
    .replace(/\n+$/, '\n');
  if (kept === text) return 'absent';
  if (!apply) return isBlank(kept) ? 'deleted' : 'removed';
  if (isBlank(kept)) return removeFile(path, true);
  writeFileSync(path, kept.endsWith('\n') ? kept : `${kept}\n`);
  return 'removed';
}

function removeDir(path: string, apply: boolean): RetractAction {
  try {
    if (!statSync(path).isDirectory()) return 'absent';
  } catch {
    return 'absent';
  }
  if (apply) {
    rmSync(path, { recursive: true, force: true });
    pruneEmptyDirs(dirname(path));
  }
  return 'deleted';
}

// ---------------------------------------------------------------------------
// the target list
// ---------------------------------------------------------------------------

type Op = (apply: boolean) => RetractAction;
interface Target extends Omit<Retraction, 'action'> {
  run: Op;
}

/**
 * Every target symgraph could have written, in removal order.
 *
 * Derived from the live registries, NOT hand-listed: `HOSTS` gives the
 * instruction files, `mcpTargets` over *all* host ids gives the MCP configs
 * (with the format and top-level key each one needs), and `claudeTargets`
 * gives the Claude Code layer. That's what keeps this complete as hosts are
 * added — see the module note.
 */
function targets(repo: string, opts: RetractOpts): Target[] {
  const home = opts.home ?? homedir();
  const exclude = new Set(opts.exclude ?? []);
  const out: Target[] = [];

  /**
   * Paths a *kept* host also writes, which must survive even though some other,
   * unselected host names them too.
   *
   * Three hosts share `AGENTS.md` (agents, hermes, antigravity). Excluding by host
   * id alone would strip that shared block on behalf of a host nobody selected,
   * and the only reason the end state came out right was that `init` happened to
   * rewrite it immediately afterwards. Exclude by path as well, so retraction
   * never depends on what runs next.
   */
  const keptPaths = new Set<string>();
  for (const host of HOSTS) {
    if (exclude.has(host.id)) keptPaths.add(join(repo, host.relPath));
  }
  for (const t of mcpTargets(repo, [...exclude], { home })) keptPaths.add(t.path);
  if (exclude.has('claude')) {
    for (const t of claudeTargets(repo)) keptPaths.add(t.path);
    for (const t of claudeGlobalTargets(home)) keptPaths.add(t.path);
  }
  if (exclude.has('agents')) for (const t of hookTargets(home)) keptPaths.add(t.path);
  if (exclude.has('antigravity')) for (const t of antigravitySkillTargets(home)) keptPaths.add(t.path);

  /** Queue a target unless a kept host owns that path, or it's already queued. */
  const seen = new Set<string>();
  const add = (t: Target): void => {
    if (keptPaths.has(t.path) || seen.has(t.path)) return;
    seen.add(t.path);
    out.push(t);
  };

  // 1. Instruction files, one per host. Owned files go wholesale; shared files
  //    lose only their fenced block.
  for (const host of HOSTS) {
    if (exclude.has(host.id)) continue;
    const path = join(repo, host.relPath);
    add(
      host.kind === 'owned'
        ? { hostId: host.id, path, what: 'symgraph-owned instruction file', scope: 'repo', run: (a) => removeFile(path, a) }
        : { hostId: host.id, path, what: 'fenced symgraph section', scope: 'repo', run: (a) => stripSection(path, a) },
    );
  }

  // 1b. Instruction files from hosts that no longer exist in the registry.
  for (const legacy of LEGACY_TARGETS) {
    const path = join(repo, legacy.relPath);
    add({
      hostId: 'legacy', path, what: legacy.what, scope: 'repo',
      run: (a) => (legacy.kind === 'owned' ? removeFile(path, a) : stripSection(path, a)),
    });
  }

  // 2. MCP registrations. Asking for every host id at once yields the union of
  //    config files, each already carrying its format and top-level key.
  const allIds = HOSTS.map((h) => h.id).filter((id) => !exclude.has(id));
  for (const t of mcpTargets(repo, allIds, { home })) {
    if (opts.global === false && t.scope === 'global') continue;
    add({
      hostId: t.hostId, path: t.path, what: t.what, scope: t.scope,
      run: (a) => (t.format === 'toml' ? removeTomlSection(t.path, a) : removeJsonKey(t.path, t.topKey!, a)),
    });
  }

  // 3. Claude Code: settings fragments, both shims, the skill, and the .mcp.json key.
  if (!exclude.has('claude')) {
    const [settings, statusline, hooks, skill, mcp] = claudeTargets(repo).map((t) => t.path);
    for (const t of [
      { hostId: 'claude', path: settings, what: 'statusline + hooks + allowlist + footer regex', scope: 'repo', run: (a) => stripClaudeSettings(settings, a) },
      { hostId: 'claude', path: statusline, what: 'statusline shim', scope: 'repo', run: (a) => removeFile(statusline, a) },
      { hostId: 'claude', path: hooks, what: 'hooks shim', scope: 'repo', run: (a) => removeFile(hooks, a) },
      { hostId: 'claude', path: skill, what: 'symgraph skill', scope: 'repo', run: (a) => removeFile(skill, a) },
      { hostId: 'claude', path: mcp, what: 'mcpServers.symgraph', scope: 'repo', run: (a) => removeJsonKey(mcp, 'mcpServers', a) },
    ] as Target[]) add(t);
  }

  // 4. Global: Claude Code's user-level copy, Codex's hook shim + entries, and
  //    Antigravity's shared skill.
  if (opts.global !== false) {
    if (!exclude.has('claude')) {
      const [shim, settings, mcp] = claudeGlobalTargets(home);
      for (const t of [
        { hostId: 'claude', path: shim.path, what: shim.what, scope: 'global', run: (a) => removeFile(shim.path, a) },
        { hostId: 'claude', path: settings.path, what: settings.what, scope: 'global', run: (a) => stripClaudeSettings(settings.path, a) },
        { hostId: 'claude', path: mcp.path, what: mcp.what, scope: 'global', run: (a) => removeJsonKey(mcp.path, 'mcpServers', a) },
      ] as Target[]) add(t);
    }
    if (!exclude.has('agents')) {
      for (const t of hookTargets(home)) {
        add({
          hostId: t.hostId, path: t.path, what: t.what, scope: 'global',
          run: (a) => (t.path.endsWith('.json') ? stripCodexHooks(t.path, a) : removeFile(t.path, a)),
        });
      }
    }
    if (!exclude.has('antigravity')) {
      for (const t of antigravitySkillTargets(home)) {
        add({ hostId: t.hostId, path: t.path, what: t.what, scope: 'global', run: (a) => removeFile(t.path, a) });
      }
    }
  }

  // 5. The graph cache and the ignore entries that admit it. Last, so a failure
  //    here can't strand the wiring half-retracted.
  if (opts.cache !== false) {
    const cache = join(repo, 'symgraph');
    const gitignore = join(repo, '.gitignore');
    const ignore = join(repo, '.ignore');
    for (const t of [
      { hostId: 'graph', path: cache, what: 'local graph cache', scope: 'repo', run: (a) => removeDir(cache, a) },
      { hostId: 'graph', path: gitignore, what: 'symgraph/ ignore entry', scope: 'repo', run: (a) => stripIgnoreEntries(gitignore, [/^\/?symgraph\/?$/], a) },
      { hostId: 'graph', path: ignore, what: 'symgraph/ search re-admit entries', scope: 'repo', run: (a) => stripIgnoreEntries(ignore, [/^!?symgraph\/?$/, /^symgraph\/\.(cache|graph)\/?$/], a) },
    ] as Target[]) add(t);
  }

  return out;
}

/**
 * Everything graft — this tool's name before the rename — wrote, so `init`
 * converges a graft-era repo and `uninstall` leaves nothing of either name.
 *
 * Derived from the same registries as {@link targets}: each current path with
 * `symgraph` spelled `graft` in its repo- or home-relative part is where graft
 * put that file (`.claude/helpers/graft-hooks.cjs`, `~/.codex/hooks/graft/…`), and
 * shared files get graft's key, TOML table, marker fences or hook entries removed.
 *
 * Unlike {@link targets} these ignore `exclude`: a host being re-written keeps its
 * symgraph wiring, but its graft wiring is exactly the duplicate to remove. An
 * owned file whose path has no `symgraph` in it maps onto itself and is left to
 * the regular targets, so init never deletes the file it is about to rewrite.
 */
function legacyNameTargets(repo: string, opts: RetractOpts): Target[] {
  const home = opts.home ?? homedir();
  const old = (base: string, p: string): string => join(base, relative(base, p).split(NAME).join(LEGACY_NAME));
  const out: Target[] = [];
  const seen = new Set<string>();
  const add = (t: Target): void => {
    const key = `${t.path}\0${t.what}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ ...t, legacy: true });
  };
  const what = (w: string): string => `${w} (graft)`;

  for (const host of HOSTS) {
    const now = join(repo, host.relPath);
    const path = old(repo, now);
    if (host.kind === 'owned') {
      if (path !== now) add({ hostId: host.id, path, what: what('instruction file'), scope: 'repo', run: (a) => removeFile(path, a) });
    } else {
      add({ hostId: host.id, path, what: what('fenced section'), scope: 'repo', run: (a) => stripSection(path, a, LEGACY_START, LEGACY_END) });
    }
  }

  for (const t of mcpTargets(repo, HOSTS.map((h) => h.id), { home })) {
    if (opts.global === false && t.scope === 'global') continue;
    const path = old(t.scope === 'global' ? home : repo, t.path);
    add({
      hostId: t.hostId, path, what: what(t.what.split(NAME).join(LEGACY_NAME)), scope: t.scope,
      run: (a) => (t.format === 'toml'
        ? removeTomlSection(path, a, `[mcp_servers.${LEGACY_NAME}]`)
        : removeJsonKey(path, t.topKey!, a, LEGACY_NAME)),
    });
  }

  const [settings, statusline, hooks, skill, mcp] = claudeTargets(repo).map((t) => old(repo, t.path));
  for (const t of [
    { hostId: 'claude', path: settings, what: what('statusline + hooks + allowlist + footer regex'), scope: 'repo', run: (a) => stripClaudeSettings(settings, a, LEGACY) },
    { hostId: 'claude', path: statusline, what: what('statusline shim'), scope: 'repo', run: (a) => removeFile(statusline, a) },
    { hostId: 'claude', path: hooks, what: what('hooks shim'), scope: 'repo', run: (a) => removeFile(hooks, a) },
    { hostId: 'claude', path: skill, what: what('skill'), scope: 'repo', run: (a) => removeFile(skill, a) },
    { hostId: 'claude', path: mcp, what: what('mcpServers.graft'), scope: 'repo', run: (a) => removeJsonKey(mcp, 'mcpServers', a, LEGACY_NAME) },
  ] as Target[]) add(t);

  if (opts.global !== false) {
    const [shim, gsettings, gmcp] = claudeGlobalTargets(home).map((t) => old(home, t.path));
    for (const t of [
      { hostId: 'claude', path: shim, what: what('hooks shim (user level)'), scope: 'global', run: (a) => removeFile(shim, a) },
      { hostId: 'claude', path: gsettings, what: what('user-level hooks + statusline'), scope: 'global', run: (a) => stripClaudeSettings(gsettings, a, LEGACY) },
      { hostId: 'claude', path: gmcp, what: what('mcpServers.graft (user level)'), scope: 'global', run: (a) => removeJsonKey(gmcp, 'mcpServers', a, LEGACY_NAME) },
    ] as Target[]) add(t);
    for (const t of hookTargets(home)) {
      const path = old(home, t.path);
      add({
        hostId: t.hostId, path, what: what(t.what), scope: 'global',
        run: (a) => (path.endsWith('.json') ? stripCodexHooks(path, a, LEGACY_NAME) : removeFile(path, a)),
      });
    }
    for (const t of antigravitySkillTargets(home)) {
      const path = old(home, t.path);
      add({ hostId: t.hostId, path, what: what(t.what), scope: 'global', run: (a) => removeFile(path, a) });
    }
  }

  if (opts.cache !== false) {
    const cache = join(repo, LEGACY_NAME);
    const gitignore = join(repo, '.gitignore');
    const ignore = join(repo, '.ignore');
    // Only a `graft/` that a build wrote — a source folder of that name is not ours.
    const isCache = (): boolean => existsSync(join(cache, '.graph')) || existsSync(join(cache, '.cache'));
    for (const t of [
      { hostId: 'graph', path: cache, what: what('local graph cache'), scope: 'repo', run: (a) => (isCache() ? removeDir(cache, a) : 'absent') },
      { hostId: 'graph', path: gitignore, what: what('graft/ ignore entry'), scope: 'repo', run: (a) => stripIgnoreEntries(gitignore, [/^\/?\.?graft\/?$/], a, `${LEGACY_NAME}'s`) },
      { hostId: 'graph', path: ignore, what: what('graft/ search re-admit entries'), scope: 'repo', run: (a) => stripIgnoreEntries(ignore, [/^!?graft\/?$/, /^graft\/\.(cache|graph)\/?$/], a, `${LEGACY_NAME}'s`) },
    ] as Target[]) add(t);
  }
  return out;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------

/** What a retraction *would* remove. Pure — touches nothing. */
export function planRetract(repo: string, opts: RetractOpts = {}): Retraction[] {
  return allTargets(repo, { ...opts, apply: false }).map(({ run, ...t }) => ({ ...t, action: run(false) }));
}

/** graft-era wiring first, so a shared file loses graft's part before symgraph's
 *  own entries are considered. */
function allTargets(repo: string, opts: RetractOpts): Target[] {
  return [...legacyNameTargets(repo, opts), ...targets(repo, opts)];
}

/**
 * Remove symgraph's contribution from every target. Reports every target it
 * considered, including the ones that were already clean, so a caller can show
 * either the full sweep or just what changed.
 */
export function runRetract(repo: string, opts: RetractOpts = {}): Retraction[] {
  const apply = opts.apply !== false;
  return allTargets(repo, opts).map(({ run, ...t }) => ({ ...t, action: run(apply) }));
}

/** The subset worth showing a user: targets that had something to remove. */
export function changed(retractions: Retraction[]): Retraction[] {
  return retractions.filter((r) => r.action !== 'absent');
}
