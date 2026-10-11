import type { Memory, MemoryCategory } from "@talorys/shared";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import golden from "./fixtures/recall-golden.json";
import { ALL_TOOLS } from "../src/tools";
import { AgentRunner } from "../src/agent/runner";
import { selectRelevantMemories } from "../src/agent/memory";
import { buildSystemPrompt } from "../src/agent/prompt";
import type { AgentEvent, AIProvider, GenerateRequest, ToolRequest } from "../src/ai/provider";
import { invalidateSemanticCache, semanticExtensions } from "../src/semantic";
import { deleteSemanticConfig, readSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import { NEWER_WINS_NOTE, createSemanticContext, hybridSearch } from "../src/semantic/recall";
import type { Services } from "../src/services/container";
import type { Env } from "../src/env";

// The test pool runs with TALORYS_ENV=development and TALORYS_MOCK_AI=1, so recall embeds with the mock.
const workerEnv = env as unknown as Env;

interface GoldenCase {
  id: string;
  gate: boolean;
  enabled: boolean;
  categoryVariants?: MemoryCategory[];
  memories: Pick<Memory, "content" | "category" | "source" | "created_at" | "updated_at">[];
  query: string;
  expect: { present: string[]; order?: string[]; datePrefix?: boolean; noVectorHits?: boolean };
}

const cases = golden.cases as GoldenCase[];

/** Clears memories and semantic state, pins the owner timezone to UTC and seeds `memories` with their timestamps. */
function seed(s: Services, memories: GoldenCase["memories"], enabled: boolean) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  s.memories.clear();
  s.settings.update({ timezone: "UTC" });
  memories.forEach((m, i) => {
    s.db.run(
      `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      `golden-${i}`, m.content, m.category, m.source, m.created_at, m.updated_at,
    );
  });
  if (enabled) writeSemanticConfig(s.settings, { enabled: true }, s.db);
  invalidateSemanticCache(s);
}

/** The memory lines `buildSystemPrompt` renders for `memories`, as `- [category] content`. */
function memoryBlock(memories: Memory[]): string[] {
  const prompt = buildSystemPrompt({ agentName: "Talorys", timezone: "UTC", now: new Date(0), autoMemory: false, memories });
  return prompt.split("\n").filter((l) => l.startsWith("- ["));
}

const lineFor = (lines: string[], needle: string) => lines.findIndex((l) => l.includes(needle));

const NOTE_LINE = `- [other] ${NEWER_WINS_NOTE}`;

/** Enabled blocks end with the newer-wins note once two or more memories are listed, and never carry it otherwise. */
function assertNote(c: GoldenCase, lines: string[]) {
  const memoryLines = lines.filter((l) => l !== NOTE_LINE);
  if (memoryLines.length >= 2) {
    expect(lines.at(-1), `${c.id}: newer-wins note is not the last line`).toBe(NOTE_LINE);
    expect(lines.length).toBe(memoryLines.length + 1);
  } else {
    expect(lines).not.toContain(NOTE_LINE);
  }
}

/** Replays one enabled case and returns the rendered memory block plus the vector hits of the query. */
async function replay(c: GoldenCase, memories: GoldenCase["memories"]) {
  return inAgent(async (a) => {
    const s = a.services;
    seed(s, memories, true);
    const ext = semanticExtensions(s, workerEnv);
    expect(ext).toBeDefined();
    const lines = memoryBlock(await ext!.selectMemories(c.query));
    const ctx = createSemanticContext(s, workerEnv, readSemanticConfig(s.settings, s.db)!);
    const vectorHits = (await hybridSearch(ctx, c.query, { limit: 50 })).filter((h) => h.cosine !== null);
    return { lines, vectorHits };
  });
}

function assertBlock(c: GoldenCase, memories: GoldenCase["memories"], lines: string[]) {
  for (const needle of c.expect.present) {
    expect(lineFor(lines, needle), `${c.id}: "${needle}" missing from\n${lines.join("\n")}`).toBeGreaterThanOrEqual(0);
  }
  const order = c.expect.order ?? [];
  for (let i = 1; i < order.length; i++) {
    expect(lineFor(lines, order[i - 1]!), `${c.id}: "${order[i - 1]}" not before "${order[i]}"`).toBeLessThan(lineFor(lines, order[i]!));
  }
  if (!c.expect.datePrefix) return;
  for (const needle of c.expect.present) {
    // The prefix is the updated_at day in the owner's timezone (UTC here), never created_at.
    const seeded = memories.find((m) => m.content.includes(needle))!;
    const line = lines[lineFor(lines, needle)]!;
    expect(line).toBe(`- [${seeded.category}] (saved ${seeded.updated_at.slice(0, 10)}) ${seeded.content}`);
  }
}

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

async function chatOnce(runner: AgentRunner, message: string) {
  for await (const _ of runner.chat({ message, signal: new AbortController().signal })) {
    // drain
  }
}

describe("golden recall replay", () => {
  it("holds eight cases with S-mountain informational only", () => {
    expect(cases).toHaveLength(8);
    expect(cases.find((c) => c.id === "S-mountain")?.gate).toBe(false);
  });

  for (const c of cases.filter((c) => c.gate && c.enabled)) {
    const variants = c.categoryVariants ?? [null];
    for (const category of variants) {
      const label = category ? `${c.id} (${category})` : c.id;
      it(`${label}: memory block matches the golden expectation`, async () => {
        // A category variant recategorises the case's first memory, the one under test.
        const memories = category ? c.memories.map((m, i) => (i === 0 ? { ...m, category } : m)) : c.memories;
        const { lines, vectorHits } = await replay(c, memories);
        assertBlock(c, memories, lines);
        assertNote(c, lines);
        if (c.expect.noVectorHits) expect(vectorHits, `${c.id}: vector hits passed the floor`).toEqual([]);
      });
    }
  }

  it("S-off: memories, tools and system prompt are upstream's", async () => {
    const c = cases.find((x) => x.id === "S-off")!;
    await inAgent(async (a) => {
      const s = a.services;
      seed(s, c.memories, false);
      const ext = semanticExtensions(s, workerEnv);
      expect(ext).toBeUndefined();

      const expected = memoryBlock(selectRelevantMemories(s.memories, c.query));
      assertBlock(c, c.memories, expected);
      for (const line of expected) expect(line).not.toContain("(saved ");
      expect(expected).not.toContain(NOTE_LINE);

      const upstream = new RecordingProvider();
      const hooked = new RecordingProvider();
      await chatOnce(new AgentRunner(s, upstream), c.query);
      await chatOnce(new AgentRunner(s, hooked, ext), c.query);
      expect(hooked.calls[0]!.system).toBe(upstream.calls[0]!.system);
      expect(hooked.calls[0]!.system).toContain(expected.join("\n"));
      expect(hooked.calls[0]!.tools.map((t) => t.name)).toEqual(ALL_TOOLS.map((t) => t.name));
    });
  });

  it("S-mountain: logs the selection without asserting it", async () => {
    const c = cases.find((x) => x.id === "S-mountain")!;
    const { lines, vectorHits } = await replay(c, c.memories);
    console.info(`[golden] S-mountain (gate: false) selected:\n${lines.join("\n") || "(none)"}\nvector hits: ${vectorHits.length}`);
  });
});
