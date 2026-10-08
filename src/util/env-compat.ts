/**
 * The fork was renamed from graft to symgraph. Every setting is read as
 * `SYMGRAPH_*`; a `GRAFT_*` variable from an older setup still counts when its
 * `SYMGRAPH_*` twin is unset. Done once, here, by copying the value across at
 * process start, so no reader has to know the old spelling.
 *
 * Imported for its side effect as the FIRST import of every entry point (the CLI,
 * the Claude Code hook/statusline/sync-run entries, the library index): ES module
 * evaluation follows import order, so the copy lands before any module reads env.
 */
export const LEGACY_ENV_PREFIX = "GRAFT_";
export const ENV_PREFIX = "SYMGRAPH_";

/** Copy each `GRAFT_X` to `SYMGRAPH_X` unless the latter is already set. Returns
 * the names it filled in, for tests. */
export function applyLegacyEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  const filled: string[] = [];
  for (const [key, value] of Object.entries(env)) {
    if (!key.startsWith(LEGACY_ENV_PREFIX) || value === undefined) continue;
    const next = ENV_PREFIX + key.slice(LEGACY_ENV_PREFIX.length);
    if (env[next] !== undefined) continue;
    env[next] = value;
    filled.push(next);
  }
  return filled;
}

applyLegacyEnv();
