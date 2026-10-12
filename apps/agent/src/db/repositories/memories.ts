import type { Memory, MemoryCategory, MemoryStatus } from "@talorys/shared";
import { type Database, ftsQuery, likePattern, newId, now } from "../database";
import { NotFoundError } from "../../api/errors";
import { stripUndefined } from "./tasks";

/** "current" = active or uncertain (everything except history). */
export type MemoryStatusFilter = "all" | "active" | "current" | "historical" | "review";

export interface MemoryReviewRow {
  id: string;
  memory_id: string;
  other_id: string;
  relationship: "contradiction" | "possible_update";
  reason: string;
  created_at: string;
}

/** SQL fragment for a status filter. "review" means flagged as uncertain or part of a pending conflict review. */
function statusWhere(status: MemoryStatusFilter | undefined, alias = ""): string {
  const col = `${alias}status`;
  const id = `${alias}id`;
  switch (status) {
    case "active":
      return `${col} = 'active'`;
    case "current":
      return `${col} != 'historical'`;
    case "historical":
      return `${col} = 'historical'`;
    case "review":
      return `(${col} = 'uncertain' OR ${id} IN (SELECT memory_id FROM tal_memory_reviews UNION SELECT other_id FROM tal_memory_reviews))`;
    default:
      return "1 = 1";
  }
}

export class MemoryRepository {
  constructor(private readonly db: Database) {}

  list(opts: { category?: string; q?: string; limit?: number; status?: MemoryStatusFilter } = {}): Memory[] {
    if (opts.q) return this.search(opts.q, opts.limit ?? 100, opts.category, opts.status);
    const params: unknown[] = [];
    let where = `WHERE ${statusWhere(opts.status)}`;
    if (opts.category) {
      where += " AND category = ?";
      params.push(opts.category);
    }
    return this.db.all<Memory>(
      `SELECT * FROM tal_memories ${where} ORDER BY updated_at DESC LIMIT ?`,
      ...params,
      opts.limit ?? 500,
    );
  }

  /**
   * Full-text search with BM25 ranking; falls back to LIKE for queries without indexable terms.
   * Without a status filter every lifecycle state is searched (the Memory page and older callers).
   */
  search(q: string, limit = 10, category?: string, status?: MemoryStatusFilter): Memory[] {
    const match = ftsQuery(q);
    const filter = statusWhere(status, "m.");
    if (match) {
      return this.db.all<Memory>(
        `SELECT m.* FROM tal_memories_fts f JOIN tal_memories m ON m.rowid = f.rowid
         WHERE tal_memories_fts MATCH ? AND ${filter} ${category ? "AND m.category = ?" : ""}
         ORDER BY bm25(tal_memories_fts) LIMIT ?`,
        ...(category ? [match, category, limit] : [match, limit]),
      );
    }
    return this.db.all<Memory>(
      `SELECT m.* FROM tal_memories m WHERE m.content LIKE ? ESCAPE '\\' AND ${filter} ${category ? "AND m.category = ?" : ""}
       ORDER BY m.updated_at DESC LIMIT ?`,
      ...(category ? [likePattern(q), category, limit] : [likePattern(q), limit]),
    );
  }

  get(id: string): Memory | null {
    return this.db.one<Memory>(`SELECT * FROM tal_memories WHERE id = ?`, id);
  }

  getMany(ids: string[]): Memory[] {
    if (ids.length === 0) return [];
    return this.db.all<Memory>(`SELECT * FROM tal_memories WHERE id IN (${ids.map(() => "?").join(",")})`, ...ids);
  }

  require(id: string): Memory {
    const m = this.get(id);
    if (!m) throw new NotFoundError("Memory not found");
    return m;
  }

  /** Creates a memory. An identical current memory is refreshed instead of duplicated. */
  create(input: { content: string; category?: MemoryCategory; source?: Memory["source"]; valid_from?: string | null }): Memory & { duplicate?: boolean } {
    const content = input.content.trim();
    const dup = this.db.one<Memory>(
      `SELECT * FROM tal_memories WHERE lower(content) = lower(?) AND status != 'historical' ORDER BY updated_at DESC LIMIT 1`,
      content,
    );
    if (dup) {
      const ts = now();
      this.db.run(`UPDATE tal_memories SET updated_at = ? WHERE id = ?`, ts, dup.id);
      return { ...dup, updated_at: ts, duplicate: true };
    }
    const ts = now();
    const memory: Memory = {
      id: newId(),
      content,
      category: input.category ?? "other",
      source: input.source ?? "manual",
      status: "active",
      superseded_by: null,
      valid_from: input.valid_from ?? null,
      valid_until: null,
      created_at: ts,
      updated_at: ts,
    };
    this.db.run(
      `INSERT INTO tal_memories (id, content, category, source, status, superseded_by, valid_from, valid_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      memory.id, memory.content, memory.category, memory.source, memory.status, null, memory.valid_from, null,
      memory.created_at, memory.updated_at,
    );
    return memory;
  }

  update(id: string, patch: { content?: string; category?: MemoryCategory }): Memory {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(patch), updated_at: now() };
    next.content = next.content.trim();
    this.db.run(
      `UPDATE tal_memories SET content = ?, category = ?, updated_at = ? WHERE id = ?`,
      next.content, next.category, next.updated_at, id,
    );
    return next;
  }

  /** Low-level lifecycle write. Callers (MemoryLifecycle) enforce relationship rules. */
  setLifecycle(
    id: string,
    fields: { status?: MemoryStatus; superseded_by?: string | null; valid_from?: string | null; valid_until?: string | null },
  ): Memory {
    const existing = this.require(id);
    const next = { ...existing, ...stripUndefined(fields), updated_at: now() };
    this.db.run(
      `UPDATE tal_memories SET status = ?, superseded_by = ?, valid_from = ?, valid_until = ?, updated_at = ? WHERE id = ?`,
      next.status, next.superseded_by, next.valid_from, next.valid_until, next.updated_at, id,
    );
    return next;
  }

  /** Memories that were replaced by `id`. */
  predecessors(id: string): Memory[] {
    return this.db.all<Memory>(`SELECT * FROM tal_memories WHERE superseded_by = ? ORDER BY created_at`, id);
  }

  /**
   * Permanently deletes a memory, its conflict reviews, and links from other memories
   * (which keep their status). Semantic vectors are removed by MemoryHistoryService.
   */
  delete(id: string): void {
    this.require(id);
    this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_memory_reviews WHERE memory_id = ? OR other_id = ?`, id, id);
      this.db.run(`UPDATE tal_memories SET superseded_by = NULL WHERE superseded_by = ?`, id);
      this.db.run(`DELETE FROM tal_memories WHERE id = ?`, id);
    });
  }

  clear(): number {
    return this.db.transaction(() => {
      this.db.run(`DELETE FROM tal_memory_reviews`);
      // rowsWritten would also count full-text index writes; report memories only.
      const n = this.count();
      this.db.run(`DELETE FROM tal_memories`);
      return n;
    });
  }

  count(status?: MemoryStatusFilter): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_memories WHERE ${statusWhere(status)}`)?.n ?? 0;
  }

  // ---------- Conflict reviews ----------

  createReview(input: { memory_id: string; other_id: string; relationship: MemoryReviewRow["relationship"]; reason: string }): MemoryReviewRow {
    const existing = this.db.one<MemoryReviewRow>(
      `SELECT * FROM tal_memory_reviews WHERE memory_id = ? AND other_id = ?`,
      input.memory_id, input.other_id,
    );
    if (existing) return existing;
    const row: MemoryReviewRow = { id: newId(), ...input, reason: input.reason.slice(0, 300), created_at: now() };
    this.db.run(
      `INSERT INTO tal_memory_reviews (id, memory_id, other_id, relationship, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
      row.id, row.memory_id, row.other_id, row.relationship, row.reason, row.created_at,
    );
    return row;
  }

  listReviews(limit = 50): MemoryReviewRow[] {
    return this.db.all<MemoryReviewRow>(`SELECT * FROM tal_memory_reviews ORDER BY created_at DESC LIMIT ?`, limit);
  }

  getReview(id: string): MemoryReviewRow | null {
    return this.db.one<MemoryReviewRow>(`SELECT * FROM tal_memory_reviews WHERE id = ?`, id);
  }

  deleteReview(id: string): void {
    this.db.run(`DELETE FROM tal_memory_reviews WHERE id = ?`, id);
  }

  reviewCount(): number {
    return this.db.one<{ n: number }>(`SELECT count(*) AS n FROM tal_memory_reviews`)?.n ?? 0;
  }
}
