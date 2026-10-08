import { mkdirSync, writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { installClaudeGlobal, type GlobalWrite } from '../hosts/claude-global.js';
import { mergeSymgraphSettings } from './settings-merge.js';
import { statuslineShim, hooksShim } from './shim-template.js';
import { skillTemplate } from './skill-template.js';
import { claudeDistDir } from './paths.js';
import { mergeJsonKey, serverEntry, type McpWrite } from '../hosts/mcp-config.js';
import { hasSymgraphIndex } from '../graph/root.js';
import type { PlannedWrite } from '../hosts/plan.js';

/**
 * The files `runInit` writes — pure, no writes, so `--dry-run` and the picker
 * can report them up front. All repo-local: the Claude Code layer never writes
 * outside the project.
 */
export function claudeTargets(dir: string): PlannedWrite[] {
  const t = (path: string, what: string, kind: PlannedWrite['kind'] = 'claude'): PlannedWrite =>
    ({ hostId: 'claude', id: 'claude', path, scope: 'repo', kind, what });
  return [
    t(join(dir, '.claude', 'settings.json'), 'symgraph statusline + hook blocks'),
    t(join(dir, '.claude', 'helpers', 'symgraph-statusline.cjs'), 'statusline shim'),
    t(join(dir, '.claude', 'helpers', 'symgraph-hooks.cjs'), 'hooks shim'),
    t(join(dir, '.claude', 'skills', 'symgraph', 'SKILL.md'), 'symgraph skill'),
    // Tagged 'mcp' so the picker doesn't label Claude Code as having no MCP.
    t(join(dir, '.mcp.json'), 'mcpServers.symgraph', 'mcp'),
  ];
}

/**
 * Build the graph if it isn't there yet. Not Claude-specific: the wiring for any
 * host points at `symgraph/`, so `symgraph init` builds whichever hosts were selected —
 * this lives beside `runInit` only because that's the caller that owns `built`.
 * Best-effort; the user can always run `symgraph build` (the epilogue says so).
 */
export function buildGraphIfMissing(dir: string, opts: { build?: boolean; cliPath?: string }): boolean {
  // `hasSymgraphIndex`, not just wiring.json: a workspace parent's graph IS its
  // `workspace.json` (nodes live in the children), so testing for wiring.json
  // alone would call it unbuilt and rebuild every child on each init.
  if (opts.build === false || !opts.cliPath || hasSymgraphIndex(dir)) return false;
  try {
    execFileSync(process.execPath, [opts.cliPath, 'build', '.'], { cwd: dir, stdio: 'inherit', timeout: 300000 });
    return true;
  } catch {
    return false;
  }
}

export interface InitResult {
  settingsPath: string;
  shims: string[];
  skill: string;
  /** the `.mcp.json` write registering the symgraph MCP server for Claude Code. */
  mcp: McpWrite;
  /** the user-level writes under `~/.claude`, empty when `global: false`. */
  global: GlobalWrite[];
  warnings: string[];
  built: boolean;
}

export function runInit(
  dir: string,
  opts: { build?: boolean; cliPath?: string; statusline?: boolean; global?: boolean; home?: string } = {},
): InitResult {
  // Same list `--dry-run` and the picker report, so the two can't drift apart.
  const [settings, statusline, hooks, skill, mcpTarget] = claudeTargets(dir).map((t) => t.path);

  mkdirSync(dirname(statusline), { recursive: true });

  const settingsPath = settings;
  let existing: Record<string, any> = {};
  try { existing = JSON.parse(readFileSync(settingsPath, 'utf8')); } catch { /* none/invalid → start fresh */ }
  const { merged, warnings } = mergeSymgraphSettings(existing, { statusline: opts.statusline });
  writeFileSync(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);

  const sl = statusline;
  const hk = hooks;
  const bakedDir = claudeDistDir(); // absolute <pkg>/dist/claude — the shims' primary resolution path
  writeFileSync(sl, statuslineShim(bakedDir)); chmodSync(sl, 0o755);
  writeFileSync(hk, hooksShim(bakedDir)); chmodSync(hk, 0o755);

  // Install the symgraph skill — the piece that redirects the agent to symgraph/ before it
  // greps source. Overwritten each run (symgraph owns this file), like the shims above.
  const skillPath = skill;
  mkdirSync(dirname(skillPath), { recursive: true });
  writeFileSync(skillPath, skillTemplate());

  // Register the symgraph MCP server in the project's .mcp.json so Claude Code
  // exposes symgraph_find_code/symgraph_trace_calls/etc. as tools — the same keyed merge the
  // other hosts use (existing servers preserved; unparseable files skipped).
  const mcp = mergeJsonKey('claude', mcpTarget, 'mcpServers', serverEntry());

  // The same wiring again, one level up in `~/.claude`, because everything above
  // this line can be erased by a `.gitignore` and lost to `git worktree add`. See
  // hosts/claude-global.ts for the failure that motivates it. Gated on the same
  // flag `registerMcpConfigs` uses, so `--no-global` still means "nothing outside
  // this repo".
  const global = opts.global === false ? [] : installClaudeGlobal(opts.home ?? homedir());

  const built = buildGraphIfMissing(dir, opts);
  return { settingsPath, shims: [sl, hk], skill: skillPath, mcp, global, warnings, built };
}
