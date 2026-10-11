import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";
import { inAgent } from "./helpers";
import { createServices } from "../src/services/container";
import { invalidateSemanticCache, seedSemanticDefault, semanticExtensions } from "../src/semantic";
import { readSemanticConfig, SEMANTIC_CONFIG_KEY, writeSemanticConfig } from "../src/semantic/config";
import type { Env } from "../src/env";
import type { Scheduler } from "../src/agent/scheduling";

const withVar = (value?: string) => ({ ...(env as unknown as Env), TALORYS_SEMANTIC_DEFAULT: value }) as Env;

describe("installer semantic default seed", () => {
  beforeEach(async () => {
    await inAgent((agent) => {
      agent.services.settings.delete(SEMANTIC_CONFIG_KEY);
      invalidateSemanticCache(agent.services);
    });
  });

  it("enables the feature once when the key is absent and the var is on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      expect(seedSemanticDefault(s, withVar("on"))).toBe(true);
      expect(readSemanticConfig(s.settings, s.db)?.enabled).toBe(true);
      expect(s.activity.list().some((a) => a.type === "semantic.seeded")).toBe(true);
      expect(semanticExtensions(s, withVar("on"))).toBeDefined();
      expect(seedSemanticDefault(s, withVar("on"))).toBe(false);
    });
  });

  it("does nothing when the var is absent or not on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      expect(semanticExtensions(s, withVar(undefined))).toBeUndefined();
      expect(seedSemanticDefault(s, withVar("off"))).toBe(false);
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
    });
  });

  it("keeps a Settings off across a restart with the var still on", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      seedSemanticDefault(s, withVar("on"));
      writeSemanticConfig(s.settings, { enabled: false }, s.db);
      invalidateSemanticCache(s);

      // A restart builds fresh services over the same storage.
      const restarted = createServices((agent as unknown as { ctx: DurableObjectState }).ctx.storage, withVar("on"), {} as Scheduler);
      expect(semanticExtensions(restarted, withVar("on"))).toBeUndefined();
      expect(seedSemanticDefault(restarted, withVar("on"))).toBe(false);
      expect(readSemanticConfig(restarted.settings, restarted.db)?.enabled).toBe(false);
    });
  });

  it("never overwrites a corrupt stored key", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      s.db.run(`INSERT OR REPLACE INTO tal_settings (key, value, updated_at) VALUES (?, ?, ?)`, SEMANTIC_CONFIG_KEY, "{not json", new Date().toISOString());
      invalidateSemanticCache(s);
      expect(seedSemanticDefault(s, withVar("on"))).toBe(false);
      expect(s.db.one<{ value: string }>(`SELECT value FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY)?.value).toBe("{not json");
    });
  });

  it("does not seed or throw when the config read throws", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      const broken = { ...s, settings: { ...s.settings, getJson: () => { throw new Error("boom"); } } } as unknown as typeof s;
      expect(semanticExtensions(broken, withVar("on"))).toBeUndefined();
      expect(readSemanticConfig(s.settings, s.db)).toBeNull();
    });
  });
});
