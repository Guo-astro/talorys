import type { ToolActivity } from "@talorys/shared";
import type { z } from "zod";
import type { Services } from "../services/container";

export type ToolPermission = "read" | "write" | "destructive";

export interface ToolContext {
  services: Services;
  timezone: string;
  /** "chat" for interactive turns; "scheduled" for automation runs (read-only + notify). */
  mode: "chat" | "scheduled";
  /** The owner's latest message, used to verify explicit confirmation for destructive actions. */
  ownerMessage: string;
}

export interface ToolDefinition<S extends z.ZodType = z.ZodType, R = unknown> {
  name: string;
  description: string;
  input: S;
  permission: ToolPermission;
  /** Max invocations of this tool in a single turn (in addition to the global budget). */
  maxCallsPerTurn?: number;
  /** Short human-readable label for the UI, e.g. "Adding task “Buy milk”". */
  label: (input: z.infer<S>) => string;
  execute: (input: z.infer<S>, ctx: ToolContext) => R | Promise<R>;
}

export function defineTool<S extends z.ZodType, R>(def: ToolDefinition<S, R>): ToolDefinition<S, R> {
  return def;
}

export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// Only affirmative replies count. Action verbs ("delete", "remove", ...) are excluded so the
// original request can't double as its own confirmation.
const CONFIRMATION_PATTERN = /\b(yes|yep|yeah|confirm(ed)?|go ahead|do it|sure|ok(ay)?|proceed)\b/i;
// Any negation or hesitation ("no, don't do it", "not sure", "wait") voids the confirmation.
const NEGATION_PATTERN = /\b(no|nope|not|never|don'?t|do not|wait|hold on|hold off)\b|n't\b/i;

function isExplicitConfirmation(message: string): boolean {
  return CONFIRMATION_PATTERN.test(message) && !NEGATION_PATTERN.test(message);
}

export interface ExecutorLimits {
  maxToolCalls: number;
}

/**
 * Executes tools for one agent turn with validation, permission checks,
 * a global call budget, per-tool caps and duplicate-call (loop) detection.
 */
export class ToolExecutor {
  private calls = 0;
  private readonly perTool = new Map<string, number>();
  private readonly signatures = new Map<string, number>();
  readonly activity: ToolActivity[] = [];

  constructor(
    private readonly tools: ToolDefinition[],
    private readonly ctx: ToolContext,
    private readonly limits: ExecutorLimits,
  ) {}

  get callCount(): number {
    return this.calls;
  }

  budgetExhausted(): boolean {
    return this.calls >= this.limits.maxToolCalls;
  }

  /** Tools permitted in this context. Scheduled runs never get write or destructive tools. */
  available(): ToolDefinition[] {
    if (this.limits.maxToolCalls <= 0) return [];
    return this.tools.filter((t) => this.ctx.mode === "chat" || t.permission === "read" || t.name === "notify_owner");
  }

  find(name: string): ToolDefinition | undefined {
    return this.available().find((t) => t.name === name);
  }

  async execute(name: string, rawInput: unknown): Promise<unknown> {
    const tool = this.find(name);
    if (!tool) throw new ToolError(`Tool "${name}" is not available.`);
    if (this.calls >= this.limits.maxToolCalls) {
      throw new ToolError("Tool call limit reached for this request. Answer the owner with the information you already have.");
    }
    const used = this.perTool.get(name) ?? 0;
    if (tool.maxCallsPerTurn !== undefined && used >= tool.maxCallsPerTurn) {
      throw new ToolError(`"${name}" was already used ${used} times in this request. Do not call it again.`);
    }
    const parsed = tool.input.safeParse(rawInput ?? {});
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      throw new ToolError(`Invalid input${issue ? ` at "${issue.path.join(".")}": ${issue.message}` : ""}.`);
    }
    const signature = `${name}:${stableStringify(parsed.data)}`;
    const repeats = this.signatures.get(signature) ?? 0;
    if (repeats >= 1) {
      throw new ToolError("This exact call was already made in this request. Use the earlier result instead of repeating it.");
    }
    if (tool.permission === "destructive") {
      const confirmed = (parsed.data as { confirmed?: boolean }).confirmed === true;
      if (!confirmed || !isExplicitConfirmation(this.ctx.ownerMessage)) {
        throw new ToolError(
          "This action is destructive. Ask the owner to explicitly confirm, then call again with confirmed: true after they agree.",
        );
      }
    }
    this.calls++;
    this.perTool.set(name, used + 1);
    this.signatures.set(signature, repeats + 1);
    return await tool.execute(parsed.data, this.ctx);
  }
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`;
}
