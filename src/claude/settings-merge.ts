type Json = Record<string, any>;

const SL_CMD = 'node "${CLAUDE_PROJECT_DIR:-.}/.claude/helpers/symgraph-statusline.cjs"';
/** Stable marker for "this statusLine is Symgraph's", not the full command string —
 * an older shim path or a SYMGRAPH_DIR wrapper still names this file. */
const SYMGRAPH_STATUSLINE_HELPER = 'symgraph-statusline.cjs';
const FOOTER = 'symgraph/[\\w./-]+\\.md';
// Every form symgraph is actually invoked as. 'symgraph:*' covers a global install;
// the other two cover a repo working on symgraph itself (or any consumer running it
// from a checkout), where the binary is not on PATH under that name. A retrieval
// call that raises a permission prompt loses to grep, which never does.
const ALLOW_ENTRIES = [
  'Bash(symgraph:*)',
  'Bash(npx symgraph:*)',
  'Bash(symgraph-dev:*)',
  'Bash(node dist/cli.js:*)',
];

/** Where the repo-level install's shims sit, relative to whatever project is open. */
const REPO_HELPERS = '${CLAUDE_PROJECT_DIR:-.}/.claude/helpers';

/**
 * `helpers` is the directory holding `symgraph-hooks.cjs`, and it is a parameter for
 * one reason: the user-level install (see hosts/claude-global.ts) has to name an
 * absolute path. A `${CLAUDE_PROJECT_DIR}` command works only where a previous
 * `symgraph init` wrote a shim into that project — which is exactly the case the
 * global copy exists to cover, so it cannot reuse the repo form.
 */
function hookCmd(arg: string, helpers: string = REPO_HELPERS): string {
  return `node "${helpers}/symgraph-hooks.cjs" ${arg}`;
}
function symgraphBlocks(helpers?: string): Record<string, Json[]> {
  return {
    PostToolUse: [
      { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command: hookCmd('post-edit', helpers), timeout: 10000 }] },
      // A retrieval tool (CLI `symgraph …` via Bash, or the `symgraph_*` MCP tools) opens its
      // output with the `[symgraph] answered from the index` marker; this hook counts those
      // into the session's call tally the statusline shows. Broad matcher, but the handler
      // no-ops instantly unless the marker is present, so non-symgraph Bash calls cost only a
      // stdin read.
      { matcher: 'Bash|mcp__symgraph__', hooks: [{ type: 'command', command: hookCmd('tool-savings', helpers), timeout: 8000 }] },
    ],
    // Longer budget than the other hooks: its `symgraph ask` is a real query, and a
    // query now brings the graph up to date first (graph/refresh.ts) — usually
    // milliseconds, but the first one after an upgrade re-parses the repo once.
    // `hooks.ts` reads this number back out of the installed settings.json at
    // runtime and caps its `symgraph ask` child just under it, so a repo wired before
    // this bump (8s) keeps a child that fits inside 8s. Changing the number here is
    // therefore safe on its own — but it only reaches an existing repo when someone
    // re-runs `symgraph init`, since that is the only caller of this function.
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('prompt', helpers), timeout: 15000 }] }],
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start', helpers), timeout: 8000 }] }],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop', helpers), timeout: 8000 }] }],
  };
}
function isSymgraphHookEntry(entry: Json): boolean {
  return JSON.stringify(entry ?? '').includes('symgraph-hooks.cjs');
}

/**
 * Is this allowlist entry one symgraph wrote?
 *
 * Scoped to the forms symgraph is actually invoked as — NOT any rule mentioning
 * "symgraph". A user who allowlists their own `Bash(symgraph-mytool:*)` keeps it; only
 * symgraph's own set is replaced, which is what lets a renamed entry disappear on
 * upgrade instead of accumulating beside its replacement.
 */
export function isSymgraphAllowEntry(entry: unknown): boolean {
  return /^Bash\((?:symgraph|npx symgraph|symgraph-dev|node dist\/cli\.js)(?::|\))/.test(String(entry));
}

/** Is this footer regex symgraph's? It points at the card tree, which is symgraph's alone. */
export function isSymgraphFooterRegex(re: unknown): boolean {
  return String(re).includes('symgraph/');
}

function envNoStatusline(): boolean {
  const v = process.env.SYMGRAPH_NO_STATUSLINE;
  return v !== undefined && v !== '' && v !== '0' && v !== 'false';
}

/** True when init should write (or refresh) Symgraph's Claude Code statusLine. */
export function statuslineWanted(opts: { statusline?: boolean } = {}): boolean {
  return opts.statusline !== false && !envNoStatusline();
}

function isSymgraphStatusline(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const command = (value as Json).command;
  return typeof command === 'string' && command.includes(SYMGRAPH_STATUSLINE_HELPER);
}

function applyStatusline(
  merged: Json,
  key: 'statusLine' | 'subagentStatusLine',
  warnings: string[],
  wanted: boolean,
  foreignWarning: string,
): void {
  const current = merged[key];
  const ours = isSymgraphStatusline(current);
  if (!wanted) {
    if (!current || ours) delete merged[key];
    else warnings.push(foreignWarning);
    return;
  }
  if (!current || ours) {
    merged[key] = { type: 'command', command: SL_CMD };
    return;
  }
  warnings.push(foreignWarning);
}

export function mergeSymgraphSettings(
  existing: Json,
  opts: { statusline?: boolean } = {},
): { merged: Json; warnings: string[] } {
  const merged: Json = { ...(existing ?? {}) };
  const warnings: string[] = [];
  const wanted = statuslineWanted(opts);

  applyStatusline(
    merged, 'statusLine', warnings, wanted,
    'Existing statusLine left untouched (a session allows only one). To use Symgraph, point it at .claude/helpers/symgraph-statusline.cjs.',
  );
  applyStatusline(
    merged, 'subagentStatusLine', warnings, wanted,
    'Existing subagentStatusLine left untouched.',
  );

  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(symgraphBlocks())) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isSymgraphHookEntry(e)); // drop old Symgraph entries → idempotent
    merged.hooks[event] = [...foreign, ...blocks];
  }

  // Drop symgraph's own prior regex before re-adding, so a change to FOOTER replaces
  // the old pattern instead of stacking beside it. The user's regexes are kept.
  const priorFooter = Array.isArray(merged.footerLinksRegexes) ? merged.footerLinksRegexes : [];
  merged.footerLinksRegexes = [...priorFooter.filter((r: unknown) => !isSymgraphFooterRegex(r)), FOOTER];

  // headless/subagent runs hard-deny Bash by default; without an allowlist entry
  // `symgraph ask`'s own Bash calls (and the skill it installs) can't run out-of-box.
  // Same shape as the hooks merge above: drop symgraph's prior entries, then add the
  // current set. Append-only left a renamed invocation form in the user's settings
  // forever, with nothing able to remove it.
  merged.permissions = { ...(merged.permissions ?? {}) };
  const priorAllow = Array.isArray(merged.permissions.allow) ? merged.permissions.allow : [];
  merged.permissions.allow = [...priorAllow.filter((e: unknown) => !isSymgraphAllowEntry(e)), ...ALLOW_ENTRIES];

  return { merged, warnings };
}

/**
 * The hook blocks alone, merged into a settings file, with the shims addressed by
 * absolute path — `~/.claude/settings.json`, where a write reaches every project on
 * the machine (see hosts/claude-global.ts for why that copy has to exist).
 *
 * Hooks only, deliberately. `mergeSymgraphSettings` also claims the statusline, the
 * footer regex and a Bash allowlist, and each of those is a reasonable thing to
 * accept for a repo you ran `symgraph init` in and an unreasonable thing to impose on
 * every repo you ever open — a statusline especially, since a session allows exactly
 * one and taking it globally would silently outrank the user's own. The hooks are the
 * piece that has to be global, because they are what a worktree loses.
 *
 * Same idempotent shape as the repo merge: symgraph's prior entries are dropped before
 * the current set is added, so re-running converges instead of stacking.
 */
export function mergeSymgraphHooks(existing: Json, helpers: string): { merged: Json } {
  const merged: Json = { ...(existing ?? {}) };
  merged.hooks = { ...(merged.hooks ?? {}) };
  for (const [event, blocks] of Object.entries(symgraphBlocks(helpers))) {
    const prior = Array.isArray(merged.hooks[event]) ? merged.hooks[event] : [];
    const foreign = prior.filter((e: Json) => !isSymgraphHookEntry(e));
    merged.hooks[event] = [...foreign, ...blocks];
  }
  return { merged };
}
