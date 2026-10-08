/**
 * The `instructions` string returned in symgraph's MCP `initialize` response.
 *
 * This is the one piece of symgraph prose that survives **tool deferral**. When a
 * host has more tools than its schema budget allows, it sends tool *names* only
 * and withholds the JSONSchemas until a `ToolSearch`-style lookup fetches them —
 * measured in a real session: 111 tools deferred, of which symgraph's six arrived as
 * six bare strings with no descriptions at all. The MCP spec's `instructions`
 * field is delivered on a separate track (Claude Code records it as its own
 * `mcp_instructions_delta` context layer), so it lands whole even then. Other
 * servers already rely on this — `claude-in-chrome` uses it for exactly the
 * batch-your-ToolSearch instruction below; symgraph used to send nothing.
 *
 * Two jobs, in this order:
 *   1. Defuse the deferral tax. One lookup loads all six tools for the whole
 *      session, so the cost is a single round trip, not two calls per use. An
 *      agent that doesn't know this can only assume the worse reading.
 *   2. Say what each tool is FOR as a decision rule, not a feature summary —
 *      because in a host with no hooks and no skill listing (a plain chat client
 *      with an MCP config), this string plus the tool descriptions are the entire
 *      steering budget symgraph gets.
 *
 * Budget: keep this under ~1,000 characters. Observed sibling servers sit at
 * 660–984, and nothing proves a longer one survives un-truncated.
 */

/** Tool names in the order an agent should reach for them, most-used first. */
const TOOL_ORDER = [
  'symgraph_find_code',
  'symgraph_find_all',
  'symgraph_trace_calls',
  'symgraph_file_api',
  'symgraph_repo_map',
] as const;

/** The `select:` argument that loads every symgraph tool in one lookup. */
export function toolSearchQuery(prefix = 'mcp__symgraph__'): string {
  return `select:${TOOL_ORDER.map((t) => `${prefix}${t}`).join(',')}`;
}

export function mcpInstructions(unindexed?: { ext: string; files: number }[]): string {
  // Scope the "prefer these tools" claim to what the graph actually holds: on a
  // repo with unparseable code, an agent that trusts it unconditionally will
  // conclude a symbol doesn't exist when really no parser ever read its file
  // (issue #66).
  const total = (unindexed ?? []).reduce((n, s) => n + s.files, 0);
  const coverage =
    total > 0
      ? `CAVEAT: ${total} source files (${(unindexed ?? []).map((s) => s.ext).join(', ')}) have no parser and are NOT in the graph — for those, raw grep/read are the right tools.`
      : null;
  return [
    'This repo is indexed by symgraph: a prebuilt graph of every symbol, its file:line',
    'span, and who calls what. Prefer these tools over grep/read.',
    ...(coverage ? [coverage] : []),
    '',
    `**If these tools are deferred (names shown, schemas withheld), load them all in ONE lookup:** ToolSearch "${toolSearchQuery()}" — one round trip for the whole session. Never load them one at a time.`,
    '',
    '- symgraph_find_code — "how does X work" / "where is Y": ranked hits, code inlined.',
    '- symgraph_find_all — when you need EVERY occurrence; find_code is top-N and misses some.',
    '- symgraph_trace_calls — callers, callees, blast radius before a rename.',
    '- symgraph_file_api — a file\'s whole API in ~200 tokens.',
    '- symgraph_repo_map — orientation in an unfamiliar repo.',
    '',
    'Results already reflect uncommitted edits — the graph refreshes before each query.',
  ].join('\n');
}
