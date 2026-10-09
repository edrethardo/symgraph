import { test } from "node:test";
import assert from "node:assert/strict";
import { ChatCruxSummarizer, MAX_TARGETS_PER_CALL, matchIds } from "../src/ai/crux.js";
import type { NodeRef } from "../src/ai/crux.js";
import type { ChatModel, ChatRequest, ChatResponse } from "../src/ai/llm/types.js";

const ref = (id: string): NodeRef => ({ id, kind: "function", signature: null, startLine: 1, endLine: 1 });

/** Answers every target listed in the request, with ids shaped by `echo`. */
class EchoModel implements ChatModel {
  readonly label = "fake:echo";
  calls: number[] = [];
  constructor(private echo: (id: string) => string = (id) => id) {}
  async create(req: ChatRequest): Promise<ChatResponse> {
    const user = req.messages.find((m) => m.role === "user")!.content;
    const ids = [...user.matchAll(/^- id=(\S+)/gm)].map((m) => m[1]);
    this.calls.push(ids.length);
    const symbols = ids.map((id) => ({ id: this.echo(id), summary: `does ${id}`, crux_start: 0, crux_end: 0 }));
    return {
      text: "",
      toolCalls: [{ id: "t", name: "record_symbols", args: { symbols } }],
      usage: { input: 0, output: 0, cacheRead: 0, cacheCreate: 0 },
      stopReason: "tool_use",
      assistant: { role: "assistant", content: "" },
    };
  }
}

test("a file with many targets is asked in batches and every target comes back", async () => {
  const model = new EchoModel();
  const n = MAX_TARGETS_PER_CALL * 2 + 5;
  const nodes = Array.from({ length: n }, (_, i) => ref(`a.py#f${i}`));
  const out = await new ChatCruxSummarizer(model).describeFile({ path: "a.py", source: "x\n", nodes });
  assert.deepEqual(model.calls, [MAX_TARGETS_PER_CALL, MAX_TARGETS_PER_CALL, 5]);
  assert.equal(new Set(out.map((o) => o.id)).size, n);
});

test("an id echoed with the rest of the target line maps back to the target", async () => {
  const model = new EchoModel((id) => `${id} | file | lines L1-L37`);
  const s = new ChatCruxSummarizer(model);
  const out = await s.describeFile({ path: "src/a.h", source: "x\n", nodes: [ref("src/a.h")] });
  assert.deepEqual(out.map((o) => o.id), ["src/a.h"]);
  assert.equal(s.lastMiss, null);
});

test("matchIds strips an id= prefix and leaves unknown ids alone", () => {
  const nodes = [ref("a.ts#run")];
  const got = matchIds(
    [
      { id: "id=a.ts#run", summary: "s", crux_start: 0, crux_end: 0 },
      { id: "b.ts#other", summary: "s", crux_start: 0, crux_end: 0 },
    ],
    nodes,
  );
  assert.deepEqual(got.map((g) => g.id), ["a.ts#run", "b.ts#other"]);
});
