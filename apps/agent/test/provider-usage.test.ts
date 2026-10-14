import { describe, expect, it } from "vitest";
import { z } from "zod";
import { CloudflareWorkersAIProvider } from "../src/ai/workers-ai";
import { estimateTokens, type AgentEvent, type GenerateRequest, type ToolRequest, type Usage, usageOfFailure } from "../src/ai/provider";
import { AgentRunner } from "../src/agent/runner";
import { inAgent } from "./helpers";
import { MockAIProvider } from "../src/ai/mock";

const model = "@cf/meta/llama-3.1-8b-instruct";
const request: GenerateRequest = { system: "Keep answers short.", messages: [{ role: "user", content: "hello" }], maxOutputTokens: 100 };

function binding(run: (inputs: Record<string, unknown>) => Promise<unknown>): Ai {
  return { run: async (_model: string, inputs: Record<string, unknown>) => run(inputs) } as unknown as Ai;
}

function sse(events: unknown[], chunkSize = 0, prefix = ""): ReadableStream<Uint8Array> {
  const bytes = new TextEncoder().encode(prefix + events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join("") + "data: [DONE]\r\n\r\n");
  return new ReadableStream({
    start(controller) {
      if (chunkSize > 0) {
        for (let i = 0; i < bytes.length; i += chunkSize) controller.enqueue(bytes.slice(i, i + chunkSize));
      } else controller.enqueue(bytes);
      controller.close();
    },
  });
}

async function collect(events: AsyncIterable<AgentEvent>): Promise<AgentEvent[]> {
  const result: AgentEvent[] = [];
  for await (const event of events) result.push(event);
  return result;
}

const usageEvents = (events: AgentEvent[]) => events.flatMap((event) => event.type === "usage" ? [event.usage] : []);

function toolRequest(signal?: AbortSignal): ToolRequest {
  return {
    ...request,
    signal,
    tools: [{ name: "lookup", description: "Look up the owner's saved details", inputSchema: z.object({ query: z.string() }), execute: async () => ({ result: "tool result with useful saved details" }) }],
    maxIterations: 3,
    toolBudgetExhausted: () => false,
  };
}

const toolStep = [
  { choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", type: "function", function: { name: "lookup", arguments: '{"query":"hello"}' } }] } }] },
  { choices: [{ delta: {}, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, completion_tokens: 6 } },
];

describe("provider token provenance", () => {
  it("retains provider counts, cached input, and genuine reported zeroes", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => ({ response: "", usage: { prompt_tokens: 0, completion_tokens: 0, prompt_tokens_details: { cached_tokens: 4 } } })), model);
    expect((await provider.generate(request)).usage).toEqual({ model, billable: true, inputTokens: { reported: 0, estimated: 0 }, outputTokens: { reported: 0, estimated: 0 }, cachedInputTokens: 0 });
    const cached = new CloudflareWorkersAIProvider(binding(async () => ({ response: "ok", usage: { prompt_tokens: 20, completion_tokens: 2, prompt_tokens_details: { cached_tokens: 12 } } })), model);
    expect((await cached.generate(request)).usage.cachedInputTokens).toBe(12);
  });

  it("estimates only missing directions and includes generated reasoning", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => ({ choices: [{ message: { content: "answer", reasoning_content: "think through the answer" } }], usage: { prompt_tokens: 0 } })), model);
    const result = await provider.generate(request);
    expect(result.usage.inputTokens).toEqual({ reported: 0, estimated: 0 });
    expect(result.usage.outputTokens).toEqual({ reported: 0, estimated: estimateTokens("answerthink through the answer") });
    const missingInput = new CloudflareWorkersAIProvider(binding(async () => ({ response: "ok", usage: { completion_tokens: 0 } })), model);
    const usage = (await missingInput.generate(request)).usage;
    expect(usage.inputTokens.estimated).toBeGreaterThan(0);
    expect(usage.inputTokens.reported).toBe(0);
    expect(usage.outputTokens).toEqual({ reported: 0, estimated: 0 });
  });

  it("does not mistake absent generate usage for SDK-normalized zeroes", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => ({ response: "hello there" })), model);
    const usage = (await provider.generate(request)).usage;
    expect(usage.inputTokens.estimated).toBeGreaterThan(0);
    expect(usage.outputTokens).toEqual({ reported: 0, estimated: estimateTokens("hello there") });
  });

  it("preserves split SSE usage and does not overwrite a reported direction with a later partial snapshot", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => sse([
      { choices: [{ delta: { content: "hëllo" } }] },
      { usage: { prompt_tokens: 0, prompt_tokens_details: { cached_tokens: 0 } } },
      { choices: [{ delta: {}, finish_reason: "stop" }], usage: { completion_tokens: 3 } },
    ], 7)), model);
    const events = await collect(provider.stream(request));
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "hëllo" }]);
    expect(usageEvents(events)).toEqual([{ model, billable: true, inputTokens: { reported: 0, estimated: 0 }, outputTokens: { reported: 3, estimated: 0 }, cachedInputTokens: 0 }]);
  });

  it("retains reported usage after heartbeat traffic exceeds the observer buffer limit", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => sse([
      { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } },
    ], 0, ": keepalive\r\n\r\n".repeat(100_000))), model);
    const usages = usageEvents(await collect(provider.stream(request)));
    expect(usages).toEqual([{ model, billable: true, inputTokens: { reported: 20, estimated: 0 }, outputTokens: { reported: 3, estimated: 0 }, cachedInputTokens: 0 }]);
  });

  it("keeps answering with fallback usage after an oversized reasoning event", async () => {
    const reasoning = "x".repeat(1024 * 1024 + 32 * 1024);
    let prompt: Record<string, unknown> | undefined;
    const provider = new CloudflareWorkersAIProvider(binding(async (input) => {
      prompt = input;
      return sse([
        { choices: [{ delta: { reasoning_content: reasoning } }] },
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 3 } },
      ], 16 * 1024);
    }), model);
    const events = await collect(provider.stream(request));
    expect(events.filter((event) => event.type === "text")).toEqual([{ type: "text", delta: "done" }]);
    expect(usageEvents(events)).toEqual([{ model, billable: true,
      inputTokens: { reported: 0, estimated: estimateTokens(JSON.stringify({ messages: prompt!.messages, tools: prompt!.tools })) },
      outputTokens: { reported: 0, estimated: estimateTokens(reasoning + "done") }, cachedInputTokens: 0 }]);
  });

  it("emits additive completed-step usage without counting finish totals twice", async () => {
    let calls = 0;
    const inputs: Record<string, unknown>[] = [];
    const provider = new CloudflareWorkersAIProvider(binding(async (input) => {
      inputs.push(input);
      return sse(calls++ === 0 ? toolStep : [
        { choices: [{ delta: { reasoning_content: "reasoning for the reply" } }] },
        { choices: [{ delta: { content: "done" }, finish_reason: "stop" }] },
      ]);
    }), model);
    const usages = usageEvents(await collect(provider.generateWithTools(toolRequest())));
    expect(calls).toBe(2);
    expect(usages).toHaveLength(2);
    expect(usages[0]).toMatchObject({ inputTokens: { reported: 20, estimated: 0 }, outputTokens: { reported: 6, estimated: 0 } });
    expect(usages[1]).toMatchObject({ inputTokens: { reported: 0, estimated: estimateTokens(JSON.stringify({ messages: inputs[1]!.messages, tools: inputs[1]!.tools })) }, outputTokens: { reported: 0, estimated: estimateTokens("reasoning for the replydone") } });
  });

  it("includes tool-call output in a missing-usage step estimate", async () => {
    let calls = 0;
    const provider = new CloudflareWorkersAIProvider(binding(async () => sse(calls++ === 0 ? [toolStep[0], { choices: [{ delta: {}, finish_reason: "tool_calls" }] }] : [{ response: "done", usage: { prompt_tokens: 2, completion_tokens: 1 } }])), model);
    const usages = usageEvents(await collect(provider.generateWithTools(toolRequest())));
    expect(usages[0]!.outputTokens.reported).toBe(0);
    expect(usages[0]!.outputTokens.estimated).toBe(estimateTokens(JSON.stringify({ name: "lookup", input: { query: "hello" } })));
  });

  for (const completedSteps of [0, 2]) {
    it(`accounts for an aborted step after ${completedSteps} completed steps`, async () => {
      const abort = new AbortController();
      const inputs: Record<string, unknown>[] = [];
      const provider = new CloudflareWorkersAIProvider(binding(async (input) => {
        inputs.push(input);
        if (inputs.length <= completedSteps) return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${inputs.length}`, type: "function", function: { name: "lookup", arguments: '{"query":"hello"}' } }] } }] },
          toolStep[1],
        ]);
        const prefix = completedSteps ? "data: {\"usage\":{\"prompt_tokens\":0}}\r\n\r\n" : "";
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(prefix + 'data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\r\n\r\n'
              + 'data: {"choices":[{"delta":{"content":"partial"}}]}\r\n\r\n'));
          },
        });
      }), model);
      const events: AgentEvent[] = [];
      for await (const event of provider.generateWithTools(toolRequest(abort.signal))) {
        events.push(event);
        if (event.type === "text" && event.delta === "partial") abort.abort();
      }
      const usages = usageEvents(events);
      expect(usages).toHaveLength(completedSteps + 1);
      for (const usage of usages.slice(0, completedSteps)) {
        expect(usage.inputTokens).toEqual({ reported: 20, estimated: 0 });
        expect(usage.outputTokens).toEqual({ reported: 6, estimated: 0 });
      }
      const prompt = inputs.at(-1)!;
      expect(usages.at(-1)).toMatchObject({
        inputTokens: completedSteps ? { reported: 0, estimated: 0 }
          : { reported: 0, estimated: estimateTokens(JSON.stringify({ messages: prompt.messages, tools: prompt.tools })) },
        outputTokens: { reported: 0, estimated: estimateTokens("thinkingpartial") },
      });
    });
  }

  it("does not record a call when cancellation prevents the binding from starting", async () => {
    const abort = new AbortController();
    abort.abort();
    let calls = 0;
    const provider = new CloudflareWorkersAIProvider(binding(async () => {
      calls++;
      return sse([]);
    }), model);
    expect(usageEvents(await collect(provider.generateWithTools(toolRequest(abort.signal))))).toEqual([]);
    expect(calls).toBe(0);
  });

  it("retains reported directions and cache on an interrupted step", async () => {
    const abort = new AbortController();
    const provider = new CloudflareWorkersAIProvider(binding(async () => new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"usage":{"prompt_tokens":17,"completion_tokens":0,"prompt_tokens_details":{"cached_tokens":7}}}\r\n\r\n'
          + 'data: {"choices":[{"delta":{"content":"partial"}}]}\r\n\r\n'));
      },
    })), model);
    const events: AgentEvent[] = [];
    for await (const event of provider.stream({ ...request, signal: abort.signal })) {
      events.push(event);
      if (event.type === "text") abort.abort();
    }
    expect(usageEvents(events)).toEqual([{ model, billable: true, inputTokens: { reported: 17, estimated: 0 }, outputTokens: { reported: 0, estimated: 0 }, cachedInputTokens: 7 }]);
  });

  it("meters a step whose stream errors part-way before rethrowing", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => {
      const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: "partial answer" } }], usage: { prompt_tokens: 30 } })}\r\n\r\n`);
      let pulls = 0;
      // Errors on the read after the first chunk; erroring in start() would discard the queued chunk.
      return new ReadableStream({
        pull(controller) {
          if (pulls++ === 0) controller.enqueue(bytes);
          else controller.error(new Error("upstream connection reset"));
        },
      });
    }), model);
    const events: AgentEvent[] = [];
    await expect((async () => {
      for await (const event of provider.stream(request)) events.push(event);
    })()).rejects.toThrow();
    expect(usageEvents(events)).toEqual([{ model, billable: true, inputTokens: { reported: 30, estimated: 0 },
      outputTokens: { reported: 0, estimated: estimateTokens("partial answer") }, cachedInputTokens: 0 }]);
  });

  it("attaches the usage of a failed generate call to its error", async () => {
    const provider = new CloudflareWorkersAIProvider(binding(async () => {
      throw new Error("upstream 502");
    }), model);
    const error = await provider.generate(request).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    const usage = usageOfFailure(error);
    expect(usage?.inputTokens.reported).toBe(0);
    expect(usage?.inputTokens.estimated).toBeGreaterThan(0);
    expect(usage?.outputTokens).toEqual({ reported: 0, estimated: 0 });
  });

  for (const cancel of [false, true]) {
    it(`preserves a completed step when the next call ${cancel ? "is cancelled" : "fails"}`, async () => {
      let calls = 0;
      const abort = new AbortController();
      const inputs: Record<string, unknown>[] = [];
      const provider = new CloudflareWorkersAIProvider(binding(async (input) => {
        inputs.push(input);
        if (calls++ === 0) return sse(toolStep);
        if (cancel) abort.abort();
        throw new Error(cancel ? "AbortError" : "model not found");
      }), model);
      const events: AgentEvent[] = [];
      try {
        for await (const event of provider.generateWithTools(toolRequest(abort.signal))) events.push(event);
      } catch { /* The usage emitted before the failed step remains consumable. */ }
      expect(calls).toBe(2);
      const usages = usageEvents(events);
      expect(usages[0]).toEqual({ model, billable: true, inputTokens: { reported: 20, estimated: 0 }, outputTokens: { reported: 6, estimated: 0 }, cachedInputTokens: 0 });
      // The binding was entered before it failed or was aborted, so this call is metered even with no output.
      expect(usages).toHaveLength(2);
      expect(usages[1]).toEqual({ model, billable: true,
        inputTokens: { reported: 0, estimated: estimateTokens(JSON.stringify({ messages: inputs[1]!.messages, tools: inputs[1]!.tools })) },
        outputTokens: { reported: 0, estimated: 0 }, cachedInputTokens: 0 });
    });
  }

});

describe("runner additive usage", () => {
  it("persists completed and interrupted SDK steps in the SQLite ledger", async () => {
    await inAgent(async (agent) => {
      const abort = new AbortController();
      const inputs: Record<string, unknown>[] = [];
      const provider = new CloudflareWorkersAIProvider(binding(async (input) => {
        inputs.push(input);
        if (inputs.length <= 2) return sse([
          { choices: [{ delta: { tool_calls: [{ index: 0, id: `call_${inputs.length}`, type: "function", function: { name: "lookup", arguments: JSON.stringify({ query: `query_${inputs.length}` }) } }] } }] },
          toolStep[1],
        ]);
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"reasoning_content":"thinking"}}]}\r\n\r\n'
              + 'data: {"choices":[{"delta":{"content":"partial"}}]}\r\n\r\n'));
          },
        });
      }), model);
      const runner = new AgentRunner(agent.services, provider, {
        selectMemories: async () => [],
        tools: [{ name: "lookup", description: "Look up saved details", input: z.object({ query: z.string() }), permission: "read", label: () => "Looking up details", execute: () => ({ result: "saved details" }) }],
      });
      const before = agent.services.usage.today();
      const events = [];
      for await (const event of runner.chat({ message: "hello", signal: abort.signal })) {
        events.push(event);
        if (event.type === "text" && event.delta === "partial") abort.abort();
      }
      const after = agent.services.usage.today();
      const prompt = inputs[2]!;
      expect(inputs).toHaveLength(3);
      expect(after.priced_calls - before.priced_calls).toBe(3);
      expect(after.input_tokens_reported - before.input_tokens_reported).toBe(40);
      expect(after.output_tokens_reported - before.output_tokens_reported).toBe(12);
      expect(after.input_tokens_estimated - before.input_tokens_estimated).toBe(estimateTokens(JSON.stringify({ messages: prompt.messages, tools: prompt.tools })));
      expect(after.output_tokens_estimated - before.output_tokens_estimated).toBe(estimateTokens("thinkingpartial"));
      expect(after.ai_errors - before.ai_errors).toBe(0);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "cancelled", content: "partial" } });
    });
  });

  it("retains nonbillable mock usage for only the output streamed before abort", async () => {
    await inAgent(async (agent) => {
      const abort = new AbortController();
      const before = agent.services.usage.today();
      let text = "";
      const events = [];
      for await (const event of new AgentRunner(agent.services, new MockAIProvider(0))
        .chat({ message: "hello", signal: abort.signal })) {
        events.push(event);
        if (event.type === "text") {
          text += event.delta;
          abort.abort();
        }
      }
      const after = agent.services.usage.today();
      expect(after.output_tokens_estimated - before.output_tokens_estimated).toBe(estimateTokens(text));
      expect(after.mock_calls - before.mock_calls).toBe(1);
      expect(after.priced_calls).toBe(before.priced_calls);
      expect(after.neurons_estimate).toBe(before.neurons_estimate);
      expect(events.at(-1)).toMatchObject({ type: "done", message: { status: "cancelled", content: text } });
    });
  });

  for (const ending of ["complete", "error", "cancelled"] as const) {
    it(`records completed usage once when a turn ends ${ending}`, async () => {
      await inAgent(async (agent) => {
        const abort = new AbortController();
        const usage: Usage = { model, billable: true, inputTokens: { reported: 12, estimated: 0 }, outputTokens: { reported: 0, estimated: 4 }, cachedInputTokens: 0 };
        const provider = {
          id: "scripted", model, billable: true,
          generate: async () => ({ text: "summary", usage }),
          stream: async function* () {},
          generateWithTools: async function* (): AsyncIterable<AgentEvent> {
            yield { type: "usage", usage };
            yield { type: "usage", usage: { ...usage, inputTokens: { reported: 18, estimated: 0 }, outputTokens: { reported: 0, estimated: 9 } } };
            yield { type: "text", delta: "done" };
            if (ending === "error") throw new Error("model not found");
            if (ending === "cancelled") abort.abort();
          },
        };
        const before = agent.services.usage.today();
        const events = [];
        for await (const event of new AgentRunner(agent.services, provider).chat({ message: "hi", signal: abort.signal })) events.push(event);
        const after = agent.services.usage.today();
        expect(after.input_tokens_reported - before.input_tokens_reported).toBe(30);
        expect(after.output_tokens_estimated - before.output_tokens_estimated).toBe(13);
        expect(after.input_tokens_estimated - before.input_tokens_estimated).toBe(0);
        expect(after.priced_calls - before.priced_calls).toBe(2);
        expect(events.at(-1)).toMatchObject({ type: "done", message: { status: ending } });
      });
    });
  }
});
