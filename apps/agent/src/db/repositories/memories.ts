import type { Memory, MemoryCategory } from "@talorys/shared";
import { type Database, ftsQuery, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

export class MemoryRepository {
  constructor(private readonly db: Database) {}

  list(opts: { category?: string; q?: string; limit?: number } = {}): Memory[] {
    if (opts.q) return this.search(opts.q, opts.limit ?? 100, opts.category);
    const params: unknown[] = [];
    let where = "";
    if (opts.category) {
      where = "WHERE category = ?";
      params.push(opts.category);
    }
    return this.db.all<Memory>(
      `SELECT * FROM tal_memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      opts.limit ?? 500,
    );
  }

  /** Full-text search with BM25 ranking; falls back to LIKE for queries without indexable terms. */
  search(q: string, limit = 10, category?: string): Memory[] {
    const match = ftsQuery(q);
    if (match) {
      return this.db.all<Memory>(
        `SELECT m.* FROM tal_memories_fts f JOIN tal_memories m ON m.rowid = f.rowid
         WHERE tal_memories_fts MATCH ? ${category ? "AND m.category = ?" : ""}
         ORDER BY bm25(tal_memories_fts) LIMIT ?`,
        ...(category ? [match, category, limit] : [match, limit]),
      );
    }
    return this.db.all<Memory>(
      `SELECT * FROM tal_memories WHERE content LIKE ? ESCAPE '\\' ${category ? "AND category = ?" : ""}
       ORDER BY updated_at DESC LIMIT ?`,
      ...(category ? [likePattern(q), category, limit] : [likePattern(q), limit]),
    );
  }

  get(id: string): Memory | null {
    return this.db.one<Memory>(`SELECT * FROM tal_memories WHERE id = ?`, id);
  }

  require(id: string): Memory {
    const m = this.get(id);
    if (!m) throw new NotFoundError("Memory not found");
    return m;
  }

  create(input: { content: string; category?: MemoryCategory; source?: Memory["source"] }): Memory {
    const content = input.content.trim();
    // Avoid storing exact duplicates; refresh the existing entry instead.
    const dup = this.db.one<Memory>(`SELECT * FROM tal_memories WHERE lower(content) = lower(?)`, content);
    if (dup) {
      const ts = now();
      this.db.run(`UPDATE tal_memories SET updated_at = ? WHERE id = ?`, ts, dup.id);
      return { ...dup, updated_at: ts };
    }
    const ts = now();
    const memory: Memory = {
      id: newId(),
      content,
      category: input.category ?? "other",
      source: input.source ?? "manual",
      created_at: ts,
      updated_at: ts,
    };
    this.db.run(
      `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
      memory.id, memory.content, memory.category, memory.source, memory.created_at, memory.updated_at,
    );
    return memory;
  }

  update(id: string, patch: { content?: string; category?: MemoryCategory }): Memory {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    this.db.run(
      `UPDATE tal_memories SET content = ?, category = ?, updated_at = ? WHERE id = ?`,
      next.content.trim(), next.category, next.updated_at, id,
    );
    return next;
  }

  delete(id: string): void {
    this.require(id);
    this.db.run(`DELETE FROM tal_memories WHERE id = ?`, id);
  }

  clear(): number {
    return this.db.run(`DELETE FROM tal_memories`).changes;
  }

  count(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_memories`)?.n ?? 0;
  }
}
