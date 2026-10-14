import type { Limits, UsageCounters } from "@talorys/shared";
import type { Database } from "../db/database";
import type { Usage } from "../ai/provider";
import { estimateConsumption } from "../ai/pricing";

type Counter = "ai_requests" | "tool_calls" | "scheduled_ai_runs" | "ai_errors";

const modelCounterColumns = [
  "input_tokens_reported", "output_tokens_reported",
  "input_tokens_estimated", "output_tokens_estimated", "embedding_requests",
  "neurons_estimate", "cost_usd_estimate", "priced_calls", "unpriced_calls", "mock_calls",
] as const;
const recordModelUsageSql = `
  INSERT INTO tal_model_usage_daily (day, model, billable, ${modelCounterColumns.join(", ")})
  VALUES (?, ?, ?, ${modelCounterColumns.map(() => "?").join(", ")})
  ON CONFLICT(day, model, billable) DO UPDATE SET
    ${modelCounterColumns.map((column) => `${column} = ${column} + excluded.${column}`).join(", ")}`;

/** App-local token provenance and persisted consumption estimates, not account billing. */
export class UsageService {
  constructor(private readonly db: Database) {}

  static day(date = new Date()): string {
    return date.toISOString().slice(0, 10);
  }

  increment(counters: Partial<Record<Counter, number>>, date = new Date()): void {
    const day = UsageService.day(date);
    this.db.run(`INSERT INTO tal_usage_daily (day) VALUES (?) ON CONFLICT(day) DO NOTHING`, day);
    for (const [key, amount] of Object.entries(counters) as [Counter, number][]) {
      if (!amount) continue;
      // Column names come from the closed Counter union above, never from input.
      this.db.run(`UPDATE tal_usage_daily SET ${key} = ${key} + ? WHERE day = ?`, Math.round(amount), day);
    }
  }

  /** One additive model call. Rates are applied now, never when a report is read. */
  record(usage: Usage, day = UsageService.day(), kind: "chat" | "embedding" = "chat"): void {
    const estimate = estimateConsumption(usage);
    this.db.run(
      recordModelUsageSql,
      day, usage.model, usage.billable,
      usage.inputTokens.reported, usage.outputTokens.reported,
      usage.inputTokens.estimated, usage.outputTokens.estimated,
      kind === "embedding" ? 1 : 0, estimate?.neurons ?? 0, estimate?.costUsd ?? 0,
      estimate ? 1 : 0, usage.billable && !estimate ? 1 : 0, usage.billable ? 0 : 1,
    );
  }

  today(): UsageCounters {
    const day = UsageService.day();
    return this.sum(day, day);
  }

  lastDays(days: number): UsageCounters {
    const start = new Date(Date.now() - (days - 1) * 86400_000);
    return this.sum(UsageService.day(start), UsageService.day());
  }

  private dailyRow(day: string): Record<string, number | null> | null {
    return this.db.one<Record<string, number | null>>(
      `SELECT ai_requests, input_tokens, output_tokens, tool_calls, scheduled_ai_runs, ai_errors
       FROM tal_usage_daily WHERE day = ?`,
      day,
    );
  }

  private sum(from: string, to: string): UsageCounters {
    const row = this.db.one<Record<string, number | null>>(
      `SELECT sum(ai_requests) AS ai_requests, sum(input_tokens) AS input_tokens, sum(output_tokens) AS output_tokens,
              sum(tool_calls) AS tool_calls, sum(scheduled_ai_runs) AS scheduled_ai_runs, sum(ai_errors) AS ai_errors
       FROM tal_usage_daily WHERE day >= ? AND day <= ?`,
      from, to,
    );
    const metered = this.db.one<Record<string, number | null>>(
      `SELECT sum(input_tokens_reported) AS input_tokens_reported, sum(output_tokens_reported) AS output_tokens_reported,
              sum(input_tokens_estimated) AS input_tokens_estimated, sum(output_tokens_estimated) AS output_tokens_estimated,
              sum(embedding_requests) AS embedding_requests, sum(neurons_estimate) AS neurons_estimate,
              sum(cost_usd_estimate) AS cost_usd_estimate, sum(priced_calls) AS priced_calls,
              sum(unpriced_calls) AS unpriced_calls, sum(mock_calls) AS mock_calls,
              sum(input_tokens_legacy) AS input_tokens_legacy
       FROM tal_model_usage_daily WHERE day >= ? AND day <= ?`,
      from, to,
    );
    const pricedCalls = metered?.priced_calls ?? 0;
    return {
      ai_requests: row?.ai_requests ?? 0,
      input_tokens_reported: metered?.input_tokens_reported ?? 0,
      output_tokens_reported: metered?.output_tokens_reported ?? 0,
      input_tokens_estimated: metered?.input_tokens_estimated ?? 0,
      output_tokens_estimated: metered?.output_tokens_estimated ?? 0,
      input_tokens_legacy: (row?.input_tokens ?? 0) + (metered?.input_tokens_legacy ?? 0),
      output_tokens_legacy: row?.output_tokens ?? 0,
      tool_calls: row?.tool_calls ?? 0,
      scheduled_ai_runs: row?.scheduled_ai_runs ?? 0,
      ai_errors: row?.ai_errors ?? 0,
      embedding_requests: metered?.embedding_requests ?? 0,
      neurons_estimate: pricedCalls > 0 ? metered?.neurons_estimate ?? 0 : null,
      cost_usd_estimate: pricedCalls > 0 ? metered?.cost_usd_estimate ?? 0 : null,
      priced_calls: pricedCalls,
      unpriced_calls: metered?.unpriced_calls ?? 0,
      mock_calls: metered?.mock_calls ?? 0,
    };
  }

  canUseAi(limits: Limits): boolean {
    return this.requestsToday() < limits.maxAiRequestsPerDay;
  }

  remainingAi(limits: Limits): number {
    return Math.max(0, limits.maxAiRequestsPerDay - this.requestsToday());
  }

  private requestsToday(): number {
    return this.dailyRow(UsageService.day())?.ai_requests ?? 0;
  }

  /** Counts one more model call if the daily budget allows it; false means stop. */
  reserveAi(limits: Limits): boolean {
    if (!this.canUseAi(limits)) return false;
    this.increment({ ai_requests: 1 });
    return true;
  }

  canRunScheduledAi(limits: Limits): boolean {
    const row = this.dailyRow(UsageService.day());
    return (row?.scheduled_ai_runs ?? 0) < limits.maxScheduledAiRunsPerDay
      && (row?.ai_requests ?? 0) < limits.maxAiRequestsPerDay;
  }

  /** Counts one scheduled run and its first model call if both budgets allow it; false means skip. */
  reserveScheduledAi(limits: Limits): boolean {
    if (!this.canRunScheduledAi(limits)) return false;
    this.increment({ ai_requests: 1, scheduled_ai_runs: 1 });
    return true;
  }
}

export class ActivityLog {
  constructor(private readonly db: Database) {}

  record(type: string, summary: string): void {
    this.db.run(
      `INSERT INTO tal_activity (id, type, summary, created_at) VALUES (?, ?, ?, ?)`,
      crypto.randomUUID(), type, summary.slice(0, 500), new Date().toISOString(),
    );
    this.db.run(`DELETE FROM tal_activity WHERE id NOT IN (SELECT id FROM tal_activity ORDER BY created_at DESC LIMIT 1000)`);
  }

  list(limit = 50): { id: string; type: string; summary: string; created_at: string }[] {
    return this.db.all(`SELECT * FROM tal_activity ORDER BY created_at DESC LIMIT ?`, limit);
  }
}
