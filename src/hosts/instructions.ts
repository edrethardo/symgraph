/**
 * The one canonical Symgraph instruction block, rendered into each host's
 * native format. Content changes happen HERE only; renderers just wrap it.
 */

export function instructionBody(): string {
  return `## Symgraph — repo context graph

This repo is indexed in \`symgraph/\`: small linked markdown nodes that explain each
system and carry exact file:line spans, kept in sync with the code through git.

For ANY task here — understanding how something works, finding where code lives,
or scoping a change — get context from the graph before grepping or opening
source files. Re-ask freely (it's cheap) and reuse literal identifiers you
already have (symbol, error string, file name) as the query. New to this repo?
Run \`symgraph map\` first — a token-budgeted orientation (dir clusters, hubs,
hotspots), no LLM, no key.

- Run \`symgraph ask "<your question>" --source\` → ranked nodes with the relevant
  code spans inlined (each hit's ≤8-line crux by default; \`--full\` for whole
  definitions when the crux isn't enough). Match the tool to the task shape:
  for understanding or editing, the top node IS the answer — cite its
  \`covers:\` file:line spans and edit straight from \`--source\`. For
  exhaustive tasks ("every occurrence / every caller of this pattern"), ranked
  results are top-N, not complete — run \`symgraph grep "<literal>"\` instead
  (exhaustive over indexed files, grouped by enclosing symbol), falling back
  to raw \`grep -rn\` for unindexed files: docs, configs, and any language
  \`symgraph build\` reported as \`skipped:\` (no parser) — code in those languages
  is invisible to the symbol tools, so a zero-hit result there is a coverage
  gap, not an answer.
- \`symgraph skeleton <file>\` → every definition's signature + span, ~10× cheaper
  than reading the file; use it to skim an API surface.
- \`symgraph callers <symbol>\` gives precomputed, exact edges — who calls this.
  Add \`--direction out\` for what it calls, or \`--depth N\` to walk
  transitively for the full blast radius. For structural questions, skip
  ranking and use this directly.
- Or browse: \`symgraph/INDEX.md\` lists every node; follow the links.
- Monorepos and folders of multiple repos rank fairly across sub-projects —
  hits carry \`[scope/]\` labels naming which one they're from. Narrow with
  \`symgraph ask "<task>" --in <scope>/\` once you know where you're working.

If a returned span is truncated ("+N more lines"), open the file at that exact
range before finalizing. Only open source files when a node genuinely lacks a
needed detail, and then at the exact file:line the node points to — never
re-read whole files.

After big code changes, refresh the graph with \`symgraph build\` (deterministic,
no API key, $0).`;
}

export function cursorRule(): string {
  return `---
description: Use the Symgraph context graph in symgraph/ before exploring source
alwaysApply: true
---
${instructionBody()}
`;
}

export function kiroSteering(): string {
  return `---
inclusion: always
---
${instructionBody()}
`;
}

export function windsurfRule(): string {
  return `${instructionBody()}
`;
}
