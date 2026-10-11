import { z } from "zod";
import type { Database } from "../db/database";
import type { SettingsService } from "../services/settings";
import { ValidationError } from "../api/errors";
import { ensureSemanticSchema } from "./migrations";

/** `tal_settings` key holding the semantic recall config. Absent means never enabled. */
export const SEMANTIC_CONFIG_KEY = "semantic.recall";

export const semanticConfigSchema = z.object({
  enabled: z.boolean(),
  model: z.string().trim().min(1).max(200),
  maxEmbeddingsPerDay: z.number().int().min(0).max(10_000),
  vectorFloor: z.object({
    absolute: z.number().min(0).max(1),
    relative: z.number().min(0).max(1),
  }),
});

export type SemanticConfig = z.infer<typeof semanticConfigSchema>;

export const DEFAULT_SEMANTIC_CONFIG: SemanticConfig = {
  enabled: false,
  model: "@cf/baai/bge-small-en-v1.5",
  maxEmbeddingsPerDay: 500,
  vectorFloor: { absolute: 0.5, relative: 0.1 },
};

/** A partial update; fields outside the four config fields are stripped. */
export const semanticConfigPatchSchema = semanticConfigSchema
  .extend({ vectorFloor: semanticConfigSchema.shape.vectorFloor.partial() })
  .partial();

export type SemanticConfigPatch = z.input<typeof semanticConfigPatchSchema>;

const defaults = (enabled = false): SemanticConfig => ({
  ...DEFAULT_SEMANTIC_CONFIG,
  vectorFloor: { ...DEFAULT_SEMANTIC_CONFIG.vectorFloor },
  enabled,
});

const defined = <T extends object>(obj: T): Partial<T> =>
  Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined)) as Partial<T>;

/**
 * Returns the stored config merged over the defaults, or null when the key is absent
 * (the feature was never enabled). Unknown fields, such as the fork's `pastWeight`,
 * are ignored. A present but invalid value reads as the defaults, keeping `enabled`
 * when it is a boolean. Pass `db` to tell an unparseable stored value from an absent key.
 */
export function readSemanticConfig(settings: SettingsService, db?: Database): SemanticConfig | null {
  const stored = settings.getJson<unknown>(SEMANTIC_CONFIG_KEY);
  if (stored === null) {
    const present = db?.one(`SELECT key FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY) ?? null;
    return present ? defaults() : null;
  }
  if (typeof stored !== "object" || Array.isArray(stored)) return defaults();
  const partial = stored as Record<string, unknown>;
  const enabled = typeof partial.enabled === "boolean" ? partial.enabled : false;
  const floor = partial.vectorFloor;
  const parsed = semanticConfigSchema.safeParse({
    ...DEFAULT_SEMANTIC_CONFIG,
    ...partial,
    vectorFloor: {
      ...DEFAULT_SEMANTIC_CONFIG.vectorFloor,
      ...(floor && typeof floor === "object" && !Array.isArray(floor) ? floor : {}),
    },
  });
  return parsed.success ? parsed.data : defaults(enabled);
}

/** The config a patch would produce, without storing it. Throws ValidationError on invalid values. */
export function mergeSemanticConfig(current: SemanticConfig | null, patch: SemanticConfigPatch): SemanticConfig {
  const parsedPatch = semanticConfigPatchSchema.safeParse(patch);
  if (!parsedPatch.success) throw ValidationError.fromZod(parsedPatch.error);
  const base = current ?? defaults();
  const { vectorFloor, ...rest } = parsedPatch.data;
  const parsed = semanticConfigSchema.safeParse({
    ...base,
    ...defined(rest),
    vectorFloor: { ...base.vectorFloor, ...defined(vectorFloor ?? {}) },
  });
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  return parsed.data;
}

/**
 * Validates a patch and stores the resulting config (only the four config fields).
 * With `db`, enabling creates the schema before the key is written, so a failed
 * migration never records the feature as on.
 */
export function writeSemanticConfig(settings: SettingsService, patch: SemanticConfigPatch, db?: Database): SemanticConfig {
  const next = mergeSemanticConfig(readSemanticConfig(settings, db), patch);
  if (db && next.enabled) ensureSemanticSchema(db);
  settings.setJson(SEMANTIC_CONFIG_KEY, next);
  return next;
}

/** Removes the config key, returning the feature to its never-enabled state. */
export function deleteSemanticConfig(settings: SettingsService): void {
  settings.delete(SEMANTIC_CONFIG_KEY);
}
