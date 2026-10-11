import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { inAgent, loggedIn } from "./helpers";
import { ALL_TOOLS } from "../src/tools";
import { AgentRunner } from "../src/agent/runner";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import { deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData, semanticTableNames } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";
import type { Env } from "../src/env";

/** A provider that records each request and replies with fixed text. */
class RecordingProvider implements AIProvider {
  readonly id = "recording";
  calls: ToolRequest[] = [];
  async generate(_req: GenerateRequest) {
    return { text: "summary", usage: { inputTokens: 1, outputTokens: 1 } };
  }
  async *stream(req: GenerateRequest): AsyncIterable<AgentEvent> {
    yield* this.generateWithTools({ ...req, tools: [], maxIterations: 1, toolBudgetExhausted: () => true });
  }
  async *generateWithTools(req: ToolRequest): AsyncIterable<AgentEvent> {
    this.calls.push(req);
    yield { type: "text", delta: "Hello." };
    yield { type: "usage", usage: { inputTokens: 10, outputTokens: 5 } };
  }
}

const workerEnv = env as unknown as Env;

const toolShape = (req: ToolRequest) => req.tools.map((t) => ({ name: t.name, schema: z.toJSONSchema(t.inputSchema) }));

function resetSemantic(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

async function chatOnce(runner: AgentRunner, message: string) {
  for await (const _ of runner.chat({ message, signal: new AbortController().signal })) {
    // drain
  }
}

/** Runs the same chat turn and scheduled prompt through an upstream runner and a hooked one. */
async function compareRunners(s: Services, ext: ReturnType<typeof semanticExtensions>) {
  const upstream = new RecordingProvider();
  const hooked = new RecordingProvider();
  await chatOnce(new AgentRunner(s, upstream), "what tea do I like");
  await chatOnce(new AgentRunner(s, hooked, ext), "what tea do I like");
  await new AgentRunner(s, upstream).runScheduledPrompt("summarise my tea habits");
  await new AgentRunner(s, hooked, ext).runScheduledPrompt("summarise my tea habits");
  expect(hooked.calls).toHaveLength(2);
  for (const i of [0, 1]) {
    expect(hooked.calls[i]!.system).toBe(upstream.calls[i]!.system);
    expect(toolShape(hooked.calls[i]!)).toEqual(toolShape(upstream.calls[i]!));
  }
  expect(toolShape(hooked.calls[0]!).map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
  expect(upstream.calls[0]!.system).toContain("Prefers green tea in the morning");
}

async function memoriesEqualUpstream() {
  const expected = await inAgent((agent) => ({ memories: agent.services.memories.list({}), total: agent.services.memories.count() }));
  const c = await loggedIn();
  expect(await c.json("/api/memories")).toEqual(expected);
  const q = await inAgent((agent) => ({ memories: agent.services.memories.list({ q: "tea" }), total: agent.services.memories.count() }));
  expect(await c.json("/api/memories?q=tea")).toEqual(q);
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-03-04T10:00:00Z"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("semantic recall off", () => {
  it("off equals upstream for prompts, tools and /api/memories", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      resetSemantic(s);
      s.memories.create({ content: "Prefers green tea in the morning", category: "preference" });
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeUndefined();
      await compareRunners(s, ext);
      expect(semanticTableNames(s.db)).toEqual([]);
    });
    await memoriesEqualUpstream();
    await inAgent((agent) => expect(semanticTableNames(agent.services.db)).toEqual([]));
  });

  it("explicitly disabled is off", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemantic(s);
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);
      expect(semanticExtensions(s, workerEnv)).toBeUndefined();
    });
  });

  it("enabled placeholder still equals upstream ranking and tools", async () => {
    await inAgent(async (agent) => {
      const s = agent.services;
      resetSemantic(s);
      s.memories.create({ content: "Prefers green tea in the morning", category: "preference" });
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeDefined();
      expect(ext!.tools).toBe(ALL_TOOLS);
      await compareRunners(s, ext);
    });
    await memoriesEqualUpstream();
    await inAgent((agent) => resetSemantic(agent.services));
  });

  it("falls back to undefined when the extensions throw", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      resetSemantic(s);
      const spy = vi.spyOn(s.settings, "getJson").mockImplementation(() => {
        throw new Error("boom");
      });
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        expect(semanticExtensions(s, workerEnv)).toBeUndefined();
      } finally {
        spy.mockRestore();
        warn.mockRestore();
        invalidateSemanticCache(s);
      }
    });
  });
});
