import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.SYMGRAPH_MCP_NPX = '1';

import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { applyLegacyEnv } from '../src/util/env-compat.js';
import { migrateLegacyLayout } from '../src/util/legacy.js';
import { runRetract } from '../src/hosts/retract.js';

function fresh(): string {
  return mkdtempSync(join(tmpdir(), 'symgraph-legacy-'));
}

function write(dir: string, rel: string, body: string): string {
  const path = join(dir, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

// --------------------------------------------------------------------------
// GRAFT_* environment variables
// --------------------------------------------------------------------------

test('a GRAFT_* variable fills its unset SYMGRAPH_* twin', () => {
  const env: NodeJS.ProcessEnv = { GRAFT_MODEL: 'old-model', GRAFT_DIR: 'ctx' };
  assert.deepEqual(applyLegacyEnv(env).sort(), ['SYMGRAPH_DIR', 'SYMGRAPH_MODEL']);
  assert.equal(env.SYMGRAPH_MODEL, 'old-model');
  assert.equal(env.SYMGRAPH_DIR, 'ctx');
});

test('a SYMGRAPH_* variable wins over the GRAFT_* one, even when empty', () => {
  const env: NodeJS.ProcessEnv = { GRAFT_MODEL: 'old', SYMGRAPH_MODEL: 'new', GRAFT_NO_REFRESH: '1', SYMGRAPH_NO_REFRESH: '' };
  assert.deepEqual(applyLegacyEnv(env), []);
  assert.equal(env.SYMGRAPH_MODEL, 'new');
  assert.equal(env.SYMGRAPH_NO_REFRESH, '');
});

// --------------------------------------------------------------------------
// graft/ → symgraph/
// --------------------------------------------------------------------------

test('a graft-built graph/ and .graft/ move to the new names, ignore entries with them', () => {
  const d = fresh();
  write(d, join('graft', '.graph', 'wiring.json'), '{}');
  write(d, join('.graft', 'config.json'), '{"followSubmodules":true}');
  write(d, '.gitignore', "node_modules/\n# graft's local graph cache — regenerable, not committed (run `graft build`).\n/graft/\n/.graft/\n");
  write(d, '.ignore', '!graft/\ngraft/.cache/\ngraft/.graph/\n');
  migrateLegacyLayout(d);
  assert.ok(existsSync(join(d, 'symgraph', '.graph', 'wiring.json')));
  assert.ok(!existsSync(join(d, 'graft')));
  assert.ok(existsSync(join(d, '.symgraph', 'config.json')));
  assert.equal(
    readFileSync(join(d, '.gitignore'), 'utf8'),
    "node_modules/\n# symgraph's local graph cache — regenerable, not committed (run `symgraph build`).\n/symgraph/\n/.symgraph/\n",
  );
  assert.equal(readFileSync(join(d, '.ignore'), 'utf8'), '!symgraph/\nsymgraph/.cache/\nsymgraph/.graph/\n');
});

test('a source folder that happens to be called graft/ is never moved', () => {
  const d = fresh();
  write(d, join('graft', 'index.ts'), 'export {}\n');
  migrateLegacyLayout(d);
  assert.ok(existsSync(join(d, 'graft', 'index.ts')));
  assert.ok(!existsSync(join(d, 'symgraph')));
});

test('an existing symgraph/ is never overwritten by an old graft/', () => {
  const d = fresh();
  write(d, join('graft', '.graph', 'wiring.json'), '"old"');
  write(d, join('symgraph', '.graph', 'wiring.json'), '"new"');
  migrateLegacyLayout(d);
  assert.equal(readFileSync(join(d, 'symgraph', '.graph', 'wiring.json'), 'utf8'), '"new"');
  assert.ok(existsSync(join(d, 'graft')), 'left for uninstall rather than merged');
});

// --------------------------------------------------------------------------
// graft-era wiring is retracted, foreign wiring is not
// --------------------------------------------------------------------------

test('retraction removes graft-era wiring and keeps the user\'s own entries', () => {
  const d = fresh();
  const home = fresh();
  const mcp = write(d, '.mcp.json', JSON.stringify({ mcpServers: {
    graft: { command: 'npx', args: ['-y', '@nanonets/graft', 'mcp'] },
    other: { command: 'x' },
  } }));
  const settings = write(d, join('.claude', 'settings.json'), JSON.stringify({
    statusLine: { type: 'command', command: 'node "$CLAUDE_PROJECT_DIR/.claude/helpers/graft-statusline.cjs"' },
    hooks: { PostToolUse: [
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'node .claude/helpers/graft-hooks.cjs post-edit' }] },
      { matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] },
    ] },
    permissions: { allow: ['Bash(graft:*)', 'Bash(npm test)'] },
    footerLinksRegexes: ['graft/[\\w./-]+\\.md'],
  }));
  const hooksShim = write(d, join('.claude', 'helpers', 'graft-hooks.cjs'), '// shim\n');
  const statusShim = write(d, join('.claude', 'helpers', 'graft-statusline.cjs'), '// shim\n');
  const skill = write(d, join('.claude', 'skills', 'graft', 'SKILL.md'), '---\nname: graft\n---\n');
  const agents = write(d, 'AGENTS.md', '# Notes\n\n<!-- graft:start -->\nold\n<!-- graft:end -->\n');
  const grok = write(d, join('.grok', 'config.toml'), '[mcp_servers.graft]\ncommand = "graft"\nargs = ["mcp"]\n\n[mcp_servers.keep]\ncommand = "y"\n');

  runRetract(d, { apply: true, home, global: false });

  assert.deepEqual(JSON.parse(readFileSync(mcp, 'utf8')), { mcpServers: { other: { command: 'x' } } });
  assert.deepEqual(JSON.parse(readFileSync(settings, 'utf8')), {
    hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'my-linter' }] }] },
    permissions: { allow: ['Bash(npm test)'] },
  });
  for (const p of [hooksShim, statusShim, skill]) assert.ok(!existsSync(p), `${p} removed`);
  assert.equal(readFileSync(agents, 'utf8'), '# Notes\n');
  assert.equal(readFileSync(grok, 'utf8'), '[mcp_servers.keep]\ncommand = "y"\n');
});

test('uninstall also removes a leftover graft/ cache, but not a graft/ source folder', () => {
  const cacheRepo = fresh();
  write(cacheRepo, join('graft', '.cache', 'x.json'), '{}');
  runRetract(cacheRepo, { apply: true, home: fresh(), global: false });
  assert.ok(!existsSync(join(cacheRepo, 'graft')));

  const srcRepo = fresh();
  write(srcRepo, join('graft', 'index.ts'), 'export {}\n');
  runRetract(srcRepo, { apply: true, home: fresh(), global: false });
  assert.ok(existsSync(join(srcRepo, 'graft', 'index.ts')));
});

test('init (exclude = every host) still removes the graft duplicates of what it rewrites', () => {
  const d = fresh();
  const mcp = write(d, '.mcp.json', JSON.stringify({ mcpServers: { graft: { command: 'graft', args: ['mcp'] } } }));
  runRetract(d, { apply: true, home: fresh(), global: false, cache: false, exclude: ['claude', 'agents'] });
  assert.ok(!existsSync(mcp), 'a .mcp.json holding only graft is deleted');
});

// --------------------------------------------------------------------------
// the graft bin
// --------------------------------------------------------------------------

test('the graft bin says it is now symgraph, on stderr, and runs the same CLI', () => {
  const r = spawnSync(process.execPath, ['--import', 'tsx', 'src/legacy-bin.ts', '--version'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /^graft is now symgraph — use `symgraph --version`$/m);
  assert.match(r.stdout, /\d+\.\d+\.\d+/);
});
