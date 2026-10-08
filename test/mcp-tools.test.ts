import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { TOOLS, callTool, canonicalToolName } from '../src/mcp/tools.js';

function builtRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

/** Three-deep call chain (compute -> sub -> add) so a `--depth`/`depth` param
 * has something to distinguish: depth 1 from `add` reaches only `sub`, the
 * default depth (2) also reaches `compute`. Same fixture shape as
 * test/graph-traverse-cli.test.ts's `impact -d` test. */
function chainRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-chain-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(
    join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\n' +
      'export function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n' +
      'export function compute(a: number, b: number): number {\n  return sub(a, b);\n}\n',
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

/** Graph lives in a NON-default dir (`<repo>/customgraph`, not `<repo>/symgraph`)
 * — exercises the `--dir` override threaded through to `contextDirFor`. */
function customDirRepo(): { repo: string; graphDir: string } {
  const d = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-customdir-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'math.ts'),
    'export function add(a: number, b: number): number {\n  return a + b;\n}\nexport function sub(a: number, b: number): number {\n  return add(a, -b);\n}\n');
  const graphDir = join(d, 'customgraph');
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d, '--dir', graphDir], { stdio: 'pipe' });
  return { repo: d, graphDir };
}

/** b.ts imports a.ts AND calls a function (`helper`) defined in a.ts. The
 * `imports` edge targets a.ts's FILE id; the `calls` edge targets `helper`'s
 * SYMBOL id — two different node ids, both "in" a.ts from a human's view. */
function fileScopeRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-filescope-'));
  mkdirSync(join(d, 'src'), { recursive: true });
  writeFileSync(join(d, 'src', 'a.ts'), 'export function helper(): number {\n  return 42;\n}\n');
  writeFileSync(
    join(d, 'src', 'b.ts'),
    "import { helper } from './a';\n\nexport function useB(): number {\n  return helper();\n}\n",
  );
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

/** Five top-level dirs, one file each — enough groups that a small `max_dirs`
 * actually drops some, so the `symgraph_repo_map` `max_dirs` arg has something to
 * prove it's wired through to `buildRepoMap`. */
function multiDirRepo(): string {
  const d = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-multidir-'));
  for (const dir of ['aaa', 'bbb', 'ccc', 'ddd', 'eee']) {
    mkdirSync(join(d, dir), { recursive: true });
    writeFileSync(join(d, dir, 'x.ts'), `export function ${dir}Fn(): number {\n  return 1;\n}\n`);
  }
  execFileSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', 'build', d], { stdio: 'pipe' });
  return d;
}

test('TOOLS lists the six tools with schemas', async () => {
  assert.deepEqual(TOOLS.map((t) => t.name), [
    'symgraph_find_code',
    'symgraph_file_api',
    'symgraph_check_freshness',
    'symgraph_trace_calls',
    'symgraph_find_all',
    'symgraph_repo_map',
  ]);
  for (const t of TOOLS) {
    assert.ok(t.description.length > 0);
    assert.equal((t.inputSchema as { type: string }).type, 'object');
  }
  // symgraph_trace_calls absorbed callees (direction) and blast radius (depth) — the
  // schema must document both flags.
  const callers = TOOLS.find((t) => t.name === 'symgraph_trace_calls')!;
  const props = (callers.inputSchema as { properties: Record<string, unknown> }).properties;
  assert.ok('direction' in props, 'symgraph_trace_calls schema should document `direction`');
  assert.ok('depth' in props, 'symgraph_trace_calls schema should document `depth`');
});

test('symgraph_find_code returns ranked hits for a built repo', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_find_code', { query: 'how do I add numbers' });
  assert.equal(r.isError, false);
  assert.match(r.text, /add/);
  assert.match(r.text, /src\/math\.ts/);
});

test('symgraph_find_code: `in` arg round-trips — narrows results to the prefix and is a soft isError on an unknown one', async () => {
  const d = builtRepo();
  const ok = await callTool(d, 'symgraph_find_code', { query: 'how do I add numbers', in: 'src' });
  assert.equal(ok.isError, false);
  assert.match(ok.text, /src\/math\.ts/);

  const miss = await callTool(d, 'symgraph_find_code', { query: 'how do I add numbers', in: 'nosuchdir' });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /nothing indexed under "nosuchdir\/"/);
  assert.match(miss.text, /or any path prefix/);
});

test('symgraph_check_freshness reports the wiring state', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_check_freshness', {});
  assert.equal(r.isError, false);
  assert.match(r.text, /graph check: OK/);
});

test('symgraph_trace_calls with depth names dependents of a file (blast radius)', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_trace_calls', { symbol: 'src/math.ts', depth: 2 });
  assert.equal(r.isError, false);
  assert.ok(r.text.length > 0);
});

test('unbuilt repo and unknown tool are soft errors', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-bare-'));
  const r1 = await callTool(bare, 'symgraph_trace_calls', { symbol: 'x.ts', depth: 2 });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /symgraph build/);
  const r2 = await callTool(bare, 'nope', {});
  assert.equal(r2.isError, true);
  assert.match(r2.text, /unknown tool/i);
});

test('symgraph_trace_calls round-trips a caller on the built fixture', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_trace_calls', { symbol: 'add' });
  assert.equal(r.isError, false);
  assert.match(r.text, /add · function · src\/math\.ts:/);
  assert.match(r.text, /calls ← sub \(src\/math\.ts:/);
});

test('symgraph_trace_calls: qualified/--in narrowing still resolves through the shared resolver', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_trace_calls', { symbol: 'add', in: 'src' });
  assert.equal(r.isError, false);
  assert.match(r.text, /calls ← sub/);
  // `in` is a path prefix: an unindexed one is a caller mistake, reported as such.
  const miss = await callTool(d, 'symgraph_trace_calls', { symbol: 'add', in: 'nowhere' });
  assert.equal(miss.isError, true);
  assert.match(miss.text, /nothing indexed under "nowhere\//);
});

test('symgraph_trace_calls direction:out round-trips a callee, and reports a loud note when there are none', async () => {
  const d = builtRepo();
  const callee = await callTool(d, 'symgraph_trace_calls', { symbol: 'sub', direction: 'out' });
  assert.equal(callee.isError, false);
  assert.match(callee.text, /calls → add \(src\/math\.ts:/);

  // `add` calls nothing, so its callees are empty — must be a loud note, not silence.
  const empty = await callTool(d, 'symgraph_trace_calls', { symbol: 'add', direction: 'out' });
  assert.equal(empty.isError, false);
  assert.match(empty.text, /no indexed callees/);
  assert.match(empty.text, /symgraph grep "add"/);
});

test('symgraph_trace_calls: unknown symbol / missing symbol are soft isErrors', async () => {
  const d = builtRepo();
  const r1 = await callTool(d, 'symgraph_trace_calls', { symbol: 'noSuchSymbolAnywhere' });
  assert.equal(r1.isError, true);
  assert.match(r1.text, /no symbol "noSuchSymbolAnywhere" in the graph/);
  assert.match(r1.text, /check spelling|symgraph build/);

  const r2 = await callTool(d, 'symgraph_trace_calls', {});
  assert.equal(r2.isError, true);
  assert.match(r2.text, /requires a symbol/);
});

test('symgraph_trace_calls: depth param is honored (depth 2 reaches further than depth 1)', async () => {
  const d = chainRepo();
  const shallow = await callTool(d, 'symgraph_trace_calls', { symbol: 'add', depth: 1 });
  assert.equal(shallow.isError, false);
  assert.match(shallow.text, /← sub \(/);
  assert.doesNotMatch(shallow.text, /compute/);

  const deeper = await callTool(d, 'symgraph_trace_calls', { symbol: 'add', depth: 2 });
  assert.equal(deeper.isError, false);
  assert.match(deeper.text, /← sub \(/);
  assert.match(deeper.text, /\[depth 1\]/);
  assert.match(deeper.text, /← compute \(/);
  assert.match(deeper.text, /\[depth 2\]/);
});

test('symgraph_trace_calls depth>1 on a file aggregates dependents that call into a symbol the file defines, not just file-level imports', async () => {
  const d = fileScopeRepo();
  const r = await callTool(d, 'symgraph_trace_calls', { symbol: 'src/a.ts', depth: 2 });
  assert.equal(r.isError, false);
  // Walking only the FILE node's incoming edges would find b.ts via `imports`
  // but drop it via `calls`, since a `calls` edge targets the SYMBOL id
  // (`src/a.ts#helper`), never the FILE id. edgeWalk aggregates over both.
  assert.match(r.text, /imports ← b\.ts \(src\/b\.ts/);
  assert.match(r.text, /calls ← useB \(src\/b\.ts/);
});

test('symgraph_trace_calls: unknown symbol is a soft isError with the check-spelling message', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_trace_calls', { symbol: 'noSuchSymbolAnywhere', depth: 2 });
  assert.equal(r.isError, true);
  assert.match(r.text, /no symbol "noSuchSymbolAnywhere" in the graph/);
  assert.match(r.text, /check spelling/);
});

test('symgraph_find_all round-trips a hit on the built fixture, grouped by enclosing symbol', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_find_all', { pattern: 'add' });
  assert.equal(r.isError, false);
  assert.match(r.text, /"add" — \d+ hits? in \d+ symbols? across \d+ files? \(searched \d+ indexed files\)/);
  assert.match(r.text, /src\/math\.ts/);
});

test('symgraph_find_all: no hits is a soft (non-error) result with the loud fallback note', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_find_all', { pattern: 'noSuchPatternAnywhere' });
  assert.equal(r.isError, false);
  assert.match(r.text, /no hits for "noSuchPatternAnywhere"/);
  assert.match(r.text, /retry symgraph grep/);
});

test('symgraph_find_all: missing pattern and unbuilt repo are soft errors', async () => {
  const d = builtRepo();
  const r1 = await callTool(d, 'symgraph_find_all', {});
  assert.equal(r1.isError, true);
  assert.match(r1.text, /requires a pattern/);

  const bare = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-grep-bare-'));
  const r2 = await callTool(bare, 'symgraph_find_all', { pattern: 'add' });
  assert.equal(r2.isError, true);
  assert.match(r2.text, /symgraph build/);
});

test('symgraph_repo_map round-trips a repo orientation on the built fixture', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_repo_map', {});
  assert.equal(r.isError, false);
  assert.match(r.text, /^\[symgraph\] answered from the index[^\n]*\n\nrepo map — \d+ files · \d+ symbols · \d+ edges/);
  assert.match(r.text, /src/);
  assert.match(r.text, /hotspots:/);
});

test('symgraph_repo_map: unbuilt repo is a soft isError with the no-graph message', async () => {
  const bare = mkdtempSync(join(tmpdir(), 'symgraph-mcptools-map-bare-'));
  const r = await callTool(bare, 'symgraph_repo_map', {});
  assert.equal(r.isError, true);
  assert.match(r.text, /symgraph build/);
});

test('symgraph_repo_map: max_dirs arg is honored — the MCP escape hatch for dropped dirs', async () => {
  const d = multiDirRepo();

  const capped = await callTool(d, 'symgraph_repo_map', { max_dirs: 1 });
  assert.equal(capped.isError, false);
  assert.match(capped.text, /\+4 more directories not shown/);

  const raised = await callTool(d, 'symgraph_repo_map', { max_dirs: 10 });
  assert.equal(raised.isError, false);
  assert.doesNotMatch(raised.text, /more directories? not shown/);
});

test('callTool honors a dirOverride for a graph built in a non-default dir', async () => {
  const { repo, graphDir } = customDirRepo();

  // With the override pointing at the actual graph location, tools find it.
  const check = await callTool(repo, 'symgraph_check_freshness', {}, graphDir);
  assert.equal(check.isError, false);
  assert.match(check.text, /graph check: OK/);

  const callers = await callTool(repo, 'symgraph_trace_calls', { symbol: 'add' }, graphDir);
  assert.equal(callers.isError, false);
  assert.match(callers.text, /calls ← sub \(src\/math\.ts:/);

  // Without the override, tools fall back to the default `<repo>/symgraph`,
  // which doesn't exist here — must report no graph, not silently succeed.
  const noOverride = await callTool(repo, 'symgraph_trace_calls', { symbol: 'add' });
  assert.equal(noOverride.isError, true);
  assert.match(noOverride.text, /symgraph build/);
});

test('symgraph_file_api returns signatures for a file, errors on unknown file', async () => {
  const d = builtRepo();
  const r = await callTool(d, 'symgraph_file_api', { file: 'src/math.ts' });
  assert.equal(r.isError, false);
  assert.match(r.text, /symgraph skeleton — src\/math\.ts/);
  assert.match(r.text, /function add {2}function add\(a: number, b: number\): number/);
  const miss = await callTool(d, 'symgraph_file_api', { file: 'src/nope.ts' });
  assert.equal(miss.isError, true);
});

// ── the rename: new names advertised, old names still answered ──
// A tool name is an API. The rename exists because a host that defers symgraph's
// schemas shows the model the names ALONE, so they have to describe themselves —
// but skills, saved prompts and other people's scripts still say the old ones.
const RENAMES: Record<string, string> = {
  symgraph_ask: 'symgraph_find_code',
  symgraph_grep: 'symgraph_find_all',
  symgraph_callers: 'symgraph_trace_calls',
  symgraph_skeleton: 'symgraph_file_api',
  symgraph_map: 'symgraph_repo_map',
  symgraph_check: 'symgraph_check_freshness',
};

test('TOOLS advertises exactly the six new names — the roster does not grow', () => {
  assert.deepEqual([...TOOLS.map((t) => t.name)].sort(), Object.values(RENAMES).sort());
});

test('every old tool name still resolves to its replacement', () => {
  for (const [old, neu] of Object.entries(RENAMES)) {
    assert.equal(canonicalToolName(old), neu, `${old} → ${neu}`);
  }
  assert.equal(canonicalToolName('symgraph_find_code'), 'symgraph_find_code', 'new names pass through');
  assert.equal(canonicalToolName('nope'), 'nope', 'unknown names are left alone for the error path');
});

test('an old name dispatches for real, not just in the alias map', async () => {
  const d = builtRepo();
  const viaOld = await callTool(d, 'symgraph_ask', { query: 'how do I add numbers' });
  const viaNew = await callTool(d, 'symgraph_find_code', { query: 'how do I add numbers' });
  assert.equal(viaOld.isError, false);
  assert.match(viaOld.text, /add/);
  assert.equal(viaOld.text, viaNew.text, 'the alias is the same call, not a near-miss');

  // …including the one tool whose behaviour depends on its name being recognised:
  // symgraph_check_freshness must not trigger a pre-query rebuild, or it would always
  // report the graph it just fixed.
  const check = await callTool(d, 'symgraph_check', {});
  assert.equal(check.isError, false);
  assert.ok(!check.text.startsWith('[symgraph] refreshed'), 'old check name still skips the refresh');
});
