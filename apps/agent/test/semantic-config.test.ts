import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { invalidateSemanticCache } from "../src/semantic";
import {
  DEFAULT_SEMANTIC_CONFIG,
  LEGACY_DEFAULT_MODEL,
  SEMANTIC_CONFIG_KEY,
  deleteSemanticConfig,
  readSemanticConfig,
  writeSemanticConfig,
} from "../src/semantic/config";
import { dropSemanticData } from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

/** Stores a raw (possibly corrupt) value under the config key. */
function storeRaw(s: Services, value: string) {
  s.db.run(
    `INSERT INTO tal_settings (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    SEMANTIC_CONFIG_KEY,
    value,
    new Date().toISOString(),
  );
}

const storedKeys = (s: Services) => Object.keys(s.settings.getJson<Record<string, unknown>>(SEMANTIC_CONFIG_KEY) ?? {}).sort();

describe("semantic config", () => {
  it("absent key reads as null", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
      expect(readSemanticConfig(s.settings)).toBeNull();
    });
  });

  it("ignores unknown fields from the fork's stored value", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, {
        enabled: true,
        model: "@cf/baai/bge-small-en-v1.5",
        maxEmbeddingsPerDay: 300,
        vectorFloor: { absolute: 0.6, relative: 0.2 },
        pastWeight: 0.5,
        maxPastInContext: 3,
      });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({
        enabled: true,
        model: "@cf/baai/bge-small-en-v1.5",
        maxEmbeddingsPerDay: 300,
        vectorFloor: { absolute: 0.6, relative: 0.2 },
      });
    });
  });

  it("defaults to bge-m3 and reads an untouched legacy bge-small default as the new defaults", async () => {
    expect(DEFAULT_SEMANTIC_CONFIG.model).toBe("@cf/baai/bge-m3");
    expect(DEFAULT_SEMANTIC_CONFIG.vectorFloor).toEqual({ absolute: 0.55, relative: 0.1 });
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      const legacy = { enabled: true, model: LEGACY_DEFAULT_MODEL, maxEmbeddingsPerDay: 300, vectorFloor: { absolute: 0.5, relative: 0.1 } };
      s.settings.setJson(SEMANTIC_CONFIG_KEY, legacy);
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true, maxEmbeddingsPerDay: 300 });
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toEqual(legacy);

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, model: LEGACY_DEFAULT_MODEL });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });

      const tuned = { ...legacy, vectorFloor: { absolute: 0.6, relative: 0.1 } };
      s.settings.setJson(SEMANTIC_CONFIG_KEY, tuned);
      expect(readSemanticConfig(s.settings, s.db)).toEqual(tuned);
      reset(s);
    });
  });

  it("fills missing fields from the defaults", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, vectorFloor: { absolute: 0.7 } });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({
        ...DEFAULT_SEMANTIC_CONFIG,
        enabled: true,
        vectorFloor: { absolute: 0.7, relative: DEFAULT_SEMANTIC_CONFIG.vectorFloor.relative },
      });
    });
  });

  it("invalid values read as the defaults, keeping a boolean enabled", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, maxEmbeddingsPerDay: -5, vectorFloor: { absolute: 7 } });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: "yes", model: "" });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, [1, 2]);
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });

      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: true, vectorFloor: "high" });
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: true });
    });
  });

  it("corrupt JSON is present, not absent", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      storeRaw(s, "{not json");
      expect(readSemanticConfig(s.settings, s.db)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, enabled: false });
      reset(s);
    });
  });

  it("writeSemanticConfig rejects invalid values and stores only the four fields", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(() => writeSemanticConfig(s.settings, { maxEmbeddingsPerDay: -1 })).toThrow();
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toBeNull();
      s.settings.setJson(SEMANTIC_CONFIG_KEY, { enabled: false, pastWeight: 0.5, maxPastInContext: 3 });
      const next = writeSemanticConfig(s.settings, { vectorFloor: { relative: 0.3 } }, s.db);
      expect(next).toEqual({
        ...DEFAULT_SEMANTIC_CONFIG,
        vectorFloor: { absolute: DEFAULT_SEMANTIC_CONFIG.vectorFloor.absolute, relative: 0.3 },
      });
      expect(storedKeys(s)).toEqual(["enabled", "maxEmbeddingsPerDay", "model", "vectorFloor"]);
      reset(s);
    });
  });

  it("PUT /api/semantic/config writes only the four fields", async () => {
    await inAgent((agent) => reset(agent.services));
    const c = await loggedIn();
    expect(await c.json("/api/semantic/config")).toEqual({ config: null, ever_enabled: false });

    const res = await c.call("/api/semantic/config", {
      method: "PUT",
      body: { maxEmbeddingsPerDay: 200, pastWeight: 0, maxPastInContext: 1, extra: "x" },
    });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { config: unknown }).config).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 });
    await inAgent((agent) => {
      const s = agent.services;
      expect(storedKeys(s)).toEqual(["enabled", "maxEmbeddingsPerDay", "model", "vectorFloor"]);
      expect(s.settings.getJson(SEMANTIC_CONFIG_KEY)).toEqual({ ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 });
    });
    expect(await c.json("/api/semantic/config")).toEqual({
      config: { ...DEFAULT_SEMANTIC_CONFIG, maxEmbeddingsPerDay: 200 },
      ever_enabled: true,
    });

    for (const bad of [{ enabled: "yes" }, { vectorFloor: { absolute: 2 } }, { model: "" }, { maxEmbeddingsPerDay: 1.5 }]) {
      const r = await c.call("/api/semantic/config", { method: "PUT", body: bad });
      expect(r.status).toBe(400);
    }
    await inAgent((agent) => reset(agent.services));
  });
});
