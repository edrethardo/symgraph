import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillTemplate } from '../src/claude/skill-template.js';

test('skill template is a well-formed SKILL.md', () => {
  const src = skillTemplate();
  assert.ok(src.startsWith('---\n'), 'starts with YAML frontmatter');
  assert.match(src, /^name: symgraph$/m, 'declares name: symgraph');
  assert.match(src, /^description:/m, 'has a description');
  const body = src.split(/\n---\n/)[1] ?? '';
  assert.ok(body.trim().length > 0, 'has a non-empty body');
  assert.match(body, /symgraph ask/, 'body tells the agent to use `symgraph ask`');
  assert.match(body, /every occurrence/i, 'body teaches the exhaustive-task grep rule');
  assert.match(body, /symgraph callers/, 'body teaches the callers command');
  assert.match(body, /--direction out/, 'body teaches callees via --direction out');
  assert.match(body, /--depth/, 'body teaches blast radius via --depth');
  assert.match(body, /truncated/i, 'body tells the agent to follow up on truncated spans');
  assert.match(body, /symgraph grep/, 'body routes sweeps to symgraph grep');
  assert.match(body, /symgraph map/, 'body tells the agent to orient with symgraph map before exploring');
  assert.match(body, /\[scope\/\]/, 'body teaches the [scope/] label on multi-scope hits');
  assert.match(body, /--in <scope>\//, 'body teaches narrowing with ask --in <scope>/');
  assert.match(body, /answered from the index/i, 'body references the usage marker');
  assert.doesNotMatch(body, /tokens saved/i, 'no tokens-saved claim anywhere in the skill');
  assert.match(body, /🌱 symgraph · 3 calls/, 'body shows the one-line usage tally to close a turn with');
});
