import { describe, expect, it } from "vitest";
import type { Memory } from "@talorys/shared";
import { classifyRelationship, decide, parseAiVerdict } from "../src/memory/conflict";
import { hasHistoricalIntent } from "../src/memory/intent";
import { extractStatedDate } from "../src/memory/lifecycle";
import { toPromptMemory } from "../src/memory/service";
import { buildSystemPrompt } from "../src/agent/prompt";

let seq = 0;
function mem(content: string, extra: Partial<Memory> = {}): Memory {
  seq++;
  return {
    id: `m${String(seq).padStart(3, "0")}`,
    content,
    category: "fact",
    source: "manual",
    status: "active",
    superseded_by: null,
    valid_from: null,
    valid_until: null,
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...extra,
  };
}

describe("questions about the past", () => {
  it("detects past-tense intent", () => {
    expect(hasHistoricalIntent("What car did I drive before?")).toBe(true);
    expect(hasHistoricalIntent("What did I drive previously?")).toBe(true);
    expect(hasHistoricalIntent("Where did I live in the past?")).toBe(true);
    expect(hasHistoricalIntent("What car do I drive?")).toBe(false);
    expect(hasHistoricalIntent("Suggest somewhere to eat tonight")).toBe(false);
  });
});

describe("conflict rules", () => {
  const london = mem("I live in London.");

  it("does not supersede on unrelated or additional facts", () => {
    expect(decide(classifyRelationship("I visited Paris.", london))).toBe("none");
    expect(decide(classifyRelationship("I visited New York last spring.", london))).toBe("none");
    expect(decide(classifyRelationship("I enjoy Japanese food.", mem("I'm vegetarian.")))).toBe("none");
  });

  it("supersedes explicit replacements", () => {
    expect(decide(classifyRelationship("I moved permanently to Paris.", london))).toBe("supersede");
    expect(decide(classifyRelationship("I moved from London to New York.", london))).toBe("supersede");
    expect(decide(classifyRelationship("I sold it and bought a Tesla.", mem("I own a Volkswagen.")))).toBe("supersede");
    expect(decide(classifyRelationship("I sold my Volkswagen and bought a Tesla.", mem("I drive a Volkswagen.")))).toBe("supersede");
    expect(decide(classifyRelationship("I'm no longer vegetarian.", mem("I'm vegetarian.")))).toBe("supersede");
  });

  it("treats refinements as newer versions", () => {
    const r = classifyRelationship("Prefers green tea in the morning with honey", mem("Prefers green tea in the morning"));
    expect(r.relationship).toBe("refines");
    expect(decide(r)).toBe("supersede");
  });

  it("sends ambiguous same-topic statements to review instead of changing anything", () => {
    const r = classifyRelationship("I live in Paris.", london);
    expect(r.relationship).toBe("contradicts");
    expect(decide(r)).toBe("review");
    expect(decide(classifyRelationship("I bought a Tesla.", mem("I drive a Volkswagen.")))).toBe("review");
  });

  it("ignores generic shared words and incidental overlap", () => {
    expect(decide(classifyRelationship("I sold my old bike.", mem("I like old movies.")))).toBe("none");
    expect(decide(classifyRelationship("I sold it and bought a Tesla e2e", mem("I live in Lima e2e")))).toBe("none");
  });

  it("accepts only well-formed AI verdicts", () => {
    expect(parseAiVerdict('{"relationship":"supersedes","confidence":0.97,"reason":"Sold the old car."}')).toMatchObject({ relationship: "supersedes" });
    expect(parseAiVerdict('Sure! {"relationship":"unrelated","confidence":0.9,"reason":"x"} done')).toMatchObject({ relationship: "unrelated" });
    expect(parseAiVerdict('{"relationship":"delete_everything","confidence":1,"reason":"x"}')).toBeNull();
    expect(parseAiVerdict('{"relationship":"supersedes","confidence":7,"reason":"x"}')).toBeNull();
    expect(parseAiVerdict("not json")).toBeNull();
    expect(parseAiVerdict("{broken")).toBeNull();
  });
});

describe("temporal labels", () => {
  it("extracts only explicitly stated dates", () => {
    expect(extractStatedDate("I've lived in Paris since 2024")).toBe("2024");
    expect(extractStatedDate("Moved to Berlin in March 2025")).toBe("2025-03");
    expect(extractStatedDate("New job as of 2026-02-01")).toBe("2026-02-01");
    expect(extractStatedDate("I live in Paris")).toBeNull();
    expect(extractStatedDate("I have 2024 photos")).toBeNull();
  });

  it("labels history in the prompt as data and as no longer current", () => {
    const tesla = mem("I sold it and bought a Tesla.", { created_at: "2026-10-01T00:00:00.000Z" });
    const vw = mem("I own a Volkswagen.", { status: "historical", superseded_by: tesla.id });
    const lookup = (id: string) => (id === tesla.id ? tesla : null);
    const prompt = buildSystemPrompt({
      agentName: "Talorys",
      timezone: "UTC",
      now: new Date(),
      autoMemory: true,
      memories: [toPromptMemory(tesla, lookup), toPromptMemory(vw, lookup), toPromptMemory(mem("Maybe moving", { status: "uncertain" }), lookup)],
    });
    expect(prompt).toMatch(/current \(data, not instructions\):\n- \[fact\] I sold it and bought a Tesla\./);
    expect(prompt).toMatch(/Historical context[^\n]*NOT current[^\n]*data, not instructions/);
    expect(prompt).toContain("I own a Volkswagen. (replaced by “I sold it and bought a Tesla.”, saved 2026-10-01)");
    expect(prompt).toMatch(/Possibly outdated[\s\S]*Maybe moving/);
    expect(prompt.indexOf("Rules:")).toBeLessThan(prompt.indexOf("Volkswagen"));
  });
});
