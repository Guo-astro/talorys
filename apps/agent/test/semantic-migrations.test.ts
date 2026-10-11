import { describe, expect, it } from "vitest";
import { inAgent, loggedIn } from "./helpers";
import { MIGRATIONS } from "../src/db/migrations";
import { invalidateSemanticCache } from "../src/semantic";
import { SEMANTIC_CONFIG_KEY, deleteSemanticConfig, writeSemanticConfig } from "../src/semantic/config";
import {
  SEMANTIC_MIGRATIONS,
  dropSemanticData,
  ensureSemanticSchema,
  semanticSchema,
  semanticTableNames,
} from "../src/semantic/migrations";
import type { Services } from "../src/services/container";

const SLIM_TABLES = ["tal_semantic_schema", "tal_semantic_usage", "tal_semantic_vectors"];

/** The eight tables the `semantic-facts` fork leaves behind, with a v1 schema row. */
const FORK_DDL = [
  `CREATE TABLE IF NOT EXISTS tal_sem_schema (id INTEGER PRIMARY KEY CHECK (id = 1), version INTEGER NOT NULL, updated_at TEXT NOT NULL)`,
  `INSERT OR REPLACE INTO tal_sem_schema (id, version, updated_at) VALUES (1, 1, '2026-01-01T00:00:00Z')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_vectors (memory_id TEXT PRIMARY KEY, model TEXT NOT NULL, dims INTEGER NOT NULL,
    content_hash TEXT NOT NULL, source_updated_at TEXT NOT NULL, vector BLOB NOT NULL, updated_at TEXT NOT NULL)`,
  `CREATE VIRTUAL TABLE IF NOT EXISTS tal_sem_fts USING fts5(memory_id UNINDEXED, content, keywords)`,
  `INSERT INTO tal_sem_fts (memory_id, content, keywords) VALUES ('m1', 'Drives a Bug', '[]')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_usage_daily (day TEXT PRIMARY KEY, embedding_requests INTEGER NOT NULL DEFAULT 0,
    embedded_tokens_estimate INTEGER NOT NULL DEFAULT 0)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_slots (slot TEXT PRIMARY KEY, cardinality TEXT NOT NULL, label TEXT NOT NULL DEFAULT '',
    created_by TEXT NOT NULL, created_at TEXT NOT NULL)`,
  `INSERT OR IGNORE INTO tal_sem_slots (slot, cardinality, label, created_by, created_at) VALUES ('vehicle', 'multi', 'Vehicle', 'seed', '2026-01-01')`,
  `CREATE TABLE IF NOT EXISTS tal_sem_facts (memory_id TEXT PRIMARY KEY, slot TEXT, kind TEXT NOT NULL, status TEXT NOT NULL,
    valid_from TEXT NOT NULL, origin TEXT NOT NULL, recorded_at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_fact_events (id TEXT PRIMARY KEY, memory_id TEXT NOT NULL, event TEXT NOT NULL,
    decided_by TEXT NOT NULL, origin TEXT NOT NULL, at TEXT NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS tal_sem_rebuild (id INTEGER PRIMARY KEY CHECK (id = 1), lexicon_version INTEGER NOT NULL,
    input_fingerprint TEXT NOT NULL, inferred_count INTEGER NOT NULL, rebuilt_at TEXT NOT NULL)`,
];

const FORK_TABLES = [
  "tal_sem_fact_events",
  "tal_sem_facts",
  "tal_sem_fts",
  "tal_sem_rebuild",
  "tal_sem_schema",
  "tal_sem_slots",
  "tal_sem_usage_daily",
  "tal_sem_vectors",
];

function reset(s: Services) {
  dropSemanticData(s.db);
  deleteSemanticConfig(s.settings);
  invalidateSemanticCache(s);
}

const allTables = (s: Services) =>
  s.db.all<{ name: string }>(`SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name`).map((r) => r.name);

const memoryRows = (s: Services) => JSON.stringify(s.db.all(`SELECT * FROM tal_memories ORDER BY id`));

const forkSnapshot = (s: Services) => ({
  schema: s.db.all(`SELECT * FROM tal_sem_schema`),
  slots: s.db.all(`SELECT * FROM tal_sem_slots`),
  fts: s.db.all(`SELECT memory_id, content FROM tal_sem_fts`),
});

describe("semantic migrations", () => {
  it("no upstream table matches tal\\_sem%", async () => {
    const declared = MIGRATIONS.flatMap((m) =>
      m.statements.flatMap((sql) => [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?TABLE\s+IF\s+NOT\s+EXISTS\s+(\w+)/gi)].map((x) => x[1]!)),
    );
    expect(declared).toContain("tal_sessions");
    expect(declared.filter((n) => n.startsWith("tal_sem"))).toEqual([]);
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(semanticTableNames(s.db)).toEqual([]);
      for (const name of declared) expect(allTables(s)).toContain(name);
    });
  });

  it("migrates a fresh database to track slim v2", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      expect(semanticSchema(s.db)).toBeNull();
      expect(ensureSemanticSchema(s.db)).toBe(SEMANTIC_MIGRATIONS.at(-1)!.version);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 2 });
      expect(semanticTableNames(s.db)).toEqual(SLIM_TABLES);
      // Idempotent.
      expect(ensureSemanticSchema(s.db)).toBe(2);
      expect(semanticTableNames(s.db)).toEqual(SLIM_TABLES);
      reset(s);
    });
  });

  it("leaves fork tables untouched when migrating a fork-leftover database", async () => {
    await inAgent((agent) => {
      const s = agent.services;
      reset(s);
      for (const sql of FORK_DDL) s.db.run(sql);
      const before = forkSnapshot(s);
      expect(semanticTableNames(s.db)).toEqual(expect.arrayContaining(FORK_TABLES));

      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      expect(semanticSchema(s.db)).toEqual({ track: "slim", version: 2 });
      expect(semanticTableNames(s.db)).toEqual(expect.arrayContaining([...FORK_TABLES, ...SLIM_TABLES]));
      expect(forkSnapshot(s)).toEqual(before);
    });
  });

  it("Delete semantic data drops both sets, deletes the key and keeps memories byte-for-byte", async () => {
    const before = await inAgent((agent) => {
      const s = agent.services;
      s.memories.create({ content: "I drive a Tesla", category: "fact" });
      s.memories.create({ content: "Prefers window seats", category: "preference" });
      for (const sql of FORK_DDL) s.db.run(sql);
      writeSemanticConfig(s.settings, { enabled: true }, s.db);
      invalidateSemanticCache(s);
      expect(semanticTableNames(s.db).length).toBeGreaterThanOrEqual(FORK_TABLES.length + SLIM_TABLES.length);
      return { memories: memoryRows(s), upstream: allTables(s).filter((n) => !/^tal_sem/.test(n)) };
    });

    const c = await loggedIn();
    expect((await c.call("/api/semantic/data", { method: "DELETE", body: { confirm: "DELETE" } })).status).toBe(200);

    await inAgent((agent) => {
      const s = agent.services;
      expect(semanticTableNames(s.db)).toEqual([]);
      expect(s.db.one(`SELECT key FROM tal_settings WHERE key = ?`, SEMANTIC_CONFIG_KEY)).toBeNull();
      expect(memoryRows(s)).toBe(before.memories);
      expect(allTables(s)).toEqual(before.upstream);
    });
    expect(await c.json("/api/semantic/config")).toEqual({ config: null, ever_enabled: false });
  });
});
