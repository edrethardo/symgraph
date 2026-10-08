import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { loadUserEnv, userEnvPath } from "../src/util/user-env.js";
import { resolveConfig } from "../src/ai/providers.js";
import { AnthropicChatModel, effortFromEnv } from "../src/ai/llm/anthropic.js";

function userFile(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), "symgraph-userenv-"));
  const path = join(dir, ".env");
  writeFileSync(path, body);
  return path;
}

// --------------------------------------------------------------------------
// ~/.symgraph/.env
// --------------------------------------------------------------------------

test("the user-level .env fills unset variables", () => {
  const env: NodeJS.ProcessEnv = {};
  const filled = loadUserEnv(env, userFile("SYMGRAPH_PROVIDER=anthropic\nSYMGRAPH_MODEL=claude-haiku-5-5\n"));
  assert.deepEqual(filled.sort(), ["SYMGRAPH_MODEL", "SYMGRAPH_PROVIDER"]);
  assert.equal(env.SYMGRAPH_PROVIDER, "anthropic");
});

test("the shell and the project .env win over the user-level .env", () => {
  // SYMGRAPH_MODEL from the shell; SYMGRAPH_PROVIDER reached via a project GRAFT_* line.
  const env: NodeJS.ProcessEnv = { SYMGRAPH_MODEL: "local-qwen", SYMGRAPH_PROVIDER: "openai" };
  loadUserEnv(env, userFile("SYMGRAPH_PROVIDER=anthropic\nSYMGRAPH_MODEL=claude-haiku-5-5\n"));
  assert.equal(env.SYMGRAPH_MODEL, "local-qwen");
  assert.equal(env.SYMGRAPH_PROVIDER, "openai");
});

test("a GRAFT_* line in the user-level .env still counts", () => {
  const env: NodeJS.ProcessEnv = {};
  loadUserEnv(env, userFile("GRAFT_MODEL=old\n"));
  assert.equal(env.SYMGRAPH_MODEL, "old");
});

test("a missing user-level .env is a no-op", () => {
  const env: NodeJS.ProcessEnv = {};
  assert.deepEqual(loadUserEnv(env, join(tmpdir(), "symgraph-no-such-dir", ".env")), []);
  assert.deepEqual(env, {});
});

test("SYMGRAPH_HOME moves the user-level .env", () => {
  assert.equal(userEnvPath({ SYMGRAPH_HOME: "/x/y" }), join("/x/y", ".env"));
});

// --------------------------------------------------------------------------
// Anthropic defaults: Haiku, ANTHROPIC_API_KEY, effort
// --------------------------------------------------------------------------

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => T): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  try {
    return fn();
  } finally {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  }
}

const CLEAN = {
  SYMGRAPH_PROVIDER: undefined,
  SYMGRAPH_MODEL: undefined,
  SYMGRAPH_API_KEY: undefined,
  SYMGRAPH_OPENROUTER_MODEL: undefined,
  OPENROUTER_API_KEY: undefined,
  ORCAROUTER_API_KEY: undefined,
  ORCAROUTER_MODEL: undefined,
  ANTHROPIC_API_KEY: undefined,
};

test("anthropic defaults to Haiku 5.5", () => {
  const c = withEnv({ ...CLEAN, SYMGRAPH_PROVIDER: "anthropic" }, () => resolveConfig());
  assert.equal(c.model, "claude-haiku-5-5");
});

test("anthropic takes ANTHROPIC_API_KEY when SYMGRAPH_API_KEY is unset", () => {
  const c = withEnv({ ...CLEAN, SYMGRAPH_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-a" }, () => resolveConfig());
  assert.equal(c.apiKey, "sk-a");
  const explicit = withEnv(
    { ...CLEAN, SYMGRAPH_PROVIDER: "anthropic", ANTHROPIC_API_KEY: "sk-a", SYMGRAPH_API_KEY: "sk-s" },
    () => resolveConfig(),
  );
  assert.equal(explicit.apiKey, "sk-s");
});

test("an openai-format provider never picks up ANTHROPIC_API_KEY", () => {
  const c = withEnv({ ...CLEAN, SYMGRAPH_PROVIDER: "openai", ANTHROPIC_API_KEY: "sk-a" }, () => resolveConfig());
  assert.equal(c.apiKey, undefined);
});

test("SYMGRAPH_EFFORT parses known levels and ignores the rest", () => {
  assert.equal(effortFromEnv({ SYMGRAPH_EFFORT: " Low " }), "low");
  assert.equal(effortFromEnv({ SYMGRAPH_EFFORT: "turbo" }), undefined);
  assert.equal(effortFromEnv({}), undefined);
});

function fakeAnthropic() {
  const box: { params?: any } = {};
  const client = {
    messages: {
      create: async (params: any) => (
        (box.params = params),
        { content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
      ),
    },
  } as unknown as Anthropic;
  return { client, box };
}

test("effort rides in output_config only when set", async () => {
  const on = fakeAnthropic();
  await new AnthropicChatModel({ apiKey: "x", model: "m", client: on.client, effort: "low" }).create({
    messages: [{ role: "user", content: "hi" }],
  });
  assert.deepEqual(on.box.params.output_config, { effort: "low" });

  const off = fakeAnthropic();
  await withEnv({ SYMGRAPH_EFFORT: undefined }, () =>
    new AnthropicChatModel({ apiKey: "x", model: "m", client: off.client }).create({
      messages: [{ role: "user", content: "hi" }],
    }),
  );
  assert.equal(off.box.params.output_config, undefined);
});
