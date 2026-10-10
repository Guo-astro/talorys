import type { ChatMessage, Memory } from "@talorys/shared";
import type { MemoryRepository } from "../db/repositories/memories";
import { estimateTokens, type ModelMessage } from "../ai/provider";

const MAX_RELEVANT_MEMORIES = 8;
const ALWAYS_INCLUDE_PREFERENCES = 4;

/**
 * Selects a small set of memories relevant to the current message instead of
 * loading the whole memory store into the prompt: full-text matches first, plus
 * a few of the most recently updated preferences.
 */
export function selectRelevantMemories(repo: MemoryRepository, query: string): Memory[] {
  const selected = new Map<string, Memory>();
  for (const m of repo.search(query, MAX_RELEVANT_MEMORIES)) selected.set(m.id, m);
  for (const m of repo.list({ category: "preference", limit: ALWAYS_INCLUDE_PREFERENCES })) {
    if (selected.size >= MAX_RELEVANT_MEMORIES) break;
    selected.set(m.id, m);
  }
  return [...selected.values()];
}

export interface ContextWindow {
  messages: ModelMessage[];
  /** Messages that no longer fit and are not yet covered by the summary. */
  overflow: ChatMessage[];
}

/**
 * Fits the most recent messages into `maxTokens`, oldest dropped first.
 * Messages already covered by the conversation summary are never resent.
 */
export function buildContextWindow(history: ChatMessage[], maxTokens: number, summaryUpto: string | null): ContextWindow {
  const eligible = history.filter((m) => m.content.trim().length > 0 && (!summaryUpto || m.created_at > summaryUpto));
  const kept: ChatMessage[] = [];
  let used = 0;
  for (let i = eligible.length - 1; i >= 0; i--) {
    const m = eligible[i]!;
    const cost = estimateTokens(m.content) + 4;
    if (kept.length > 0 && used + cost > maxTokens) break;
    kept.unshift(m);
    used += cost;
  }
  // Models expect the conversation to start with a user turn.
  while (kept.length > 1 && kept[0]!.role !== "user") kept.shift();
  const overflow = eligible.slice(0, eligible.length - kept.length);
  return {
    messages: kept.map((m) => ({
      role: m.role,
      content: m.role === "assistant" ? m.content : m.content.slice(0, 16_000),
    })),
    overflow,
  };
}

/** Summarize only once enough history has overflowed, to avoid an AI call on every turn. */
export const SUMMARIZE_THRESHOLD = 8;

export function summarizationPrompt(previousSummary: string | null, overflow: ChatMessage[]): ModelMessage[] {
  const transcript = overflow.map((m) => `${m.role === "user" ? "Owner" : "Assistant"}: ${m.content.slice(0, 1500)}`).join("\n");
  return [
    {
      role: "user",
      content: `Update the running summary of a conversation between the owner and their assistant. Keep facts, decisions, open questions and commitments. Max 150 words.\n\nPrevious summary:\n${previousSummary ?? "(none)"}\n\nNew messages:\n${transcript}`,
    },
  ];
}
