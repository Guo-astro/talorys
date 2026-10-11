import { BACKUP_FORMAT, BACKUP_VERSION, type Backup, TALORYS_VERSION, backupSchema, scheduleSpecSchema } from "@talorys/shared";
import type { Services } from "./container";
import { ValidationError } from "../api/errors";

/** Builds a portable backup. Sessions, login attempts and credentials are never exported. */
export function exportData(s: Services): Backup {
  const db = s.db;
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exported_at: new Date().toISOString(),
    app_version: TALORYS_VERSION,
    data: {
      settings: s.settings.raw() as Record<string, unknown>,
      conversations: db.all(`SELECT id, title, summary, summary_upto, created_at, updated_at FROM tal_conversations ORDER BY created_at`),
      messages: db.all(`SELECT id, conversation_id, role, content, tools, status, error, created_at FROM tal_messages ORDER BY created_at`),
      memories: db.all(`SELECT * FROM tal_memories ORDER BY created_at`),
      tasks: db.all(`SELECT * FROM tal_tasks ORDER BY created_at`),
      notes: db.all(`SELECT * FROM tal_notes ORDER BY created_at`),
      projects: db.all(`SELECT * FROM tal_projects ORDER BY created_at`),
      automations: db
        .all<Record<string, unknown>>(`SELECT id, name, kind, message, schedule, enabled, created_at, updated_at FROM tal_automations`)
        .map((a) => ({ ...a, schedule: JSON.parse(String(a.schedule)), enabled: a.enabled === 1 })),
    },
  } as unknown as Backup;
}

export interface ImportSummary {
  conversations: number;
  messages: number;
  memories: number;
  tasks: number;
  notes: number;
  projects: number;
  automations: number;
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const strOrNull = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const pick = <T extends string>(v: unknown, allowed: readonly T[], fallback: T): T =>
  allowed.includes(v as T) ? (v as T) : fallback;

/**
 * Merges a backup into the current data inside one transaction. Records are
 * upserted by id, so importing the same backup twice is harmless and nothing
 * that exists only locally is deleted. Imported automations are re-armed afterwards.
 */
export async function importData(s: Services, raw: unknown): Promise<ImportSummary> {
  const parsed = backupSchema.safeParse(raw);
  if (!parsed.success) throw ValidationError.fromZod(parsed.error);
  const backup = parsed.data;
  if (backup.version > BACKUP_VERSION) {
    throw new ValidationError(`This backup was made by a newer Talorys (format v${backup.version}). Update Talorys first.`);
  }
  const d = backup.data;
  const db = s.db;
  const now = new Date().toISOString();

  const summary = db.transaction((): ImportSummary => {
    for (const p of d.projects) {
      db.run(
        `INSERT INTO tal_projects (id, name, description, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, description = excluded.description, status = excluded.status, updated_at = excluded.updated_at`,
        p.id, p.name, str(p.description), pick(p.status, ["active", "paused", "completed", "archived"], "active"), p.created_at, p.updated_at,
      );
    }
    const projectExists = (id: unknown) => typeof id === "string" && !!db.one(`SELECT 1 AS x FROM tal_projects WHERE id = ?`, id);
    for (const c of d.conversations) {
      db.run(
        `INSERT INTO tal_conversations (id, title, summary, summary_upto, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, updated_at = excluded.updated_at`,
        c.id, c.title, strOrNull(c.summary), strOrNull(c.summary_upto), c.created_at, c.updated_at,
      );
    }
    let messages = 0;
    for (const m of d.messages) {
      if (!db.one(`SELECT 1 AS x FROM tal_conversations WHERE id = ?`, m.conversation_id)) continue;
      db.run(
        `INSERT INTO tal_messages (id, conversation_id, role, content, tools, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO NOTHING`,
        m.id, m.conversation_id, m.role, m.content, typeof m.tools === "string" ? m.tools : JSON.stringify(m.tools ?? []),
        pick(m.status, ["complete", "error", "cancelled"], "complete"), strOrNull(m.error), m.created_at,
      );
      messages++;
    }
    for (const m of d.memories) {
      db.run(
        `INSERT INTO tal_memories (id, content, category, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET content = excluded.content, category = excluded.category, updated_at = excluded.updated_at`,
        m.id, m.content, pick(m.category, ["preference", "fact", "goal", "project", "habit", "person", "other"], "other"),
        "import", m.created_at, m.updated_at,
      );
    }
    for (const t of d.tasks) {
      db.run(
        `INSERT INTO tal_tasks (id, title, description, status, priority, due_at, project_id, created_at, updated_at, completed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, description = excluded.description, status = excluded.status,
           priority = excluded.priority, due_at = excluded.due_at, project_id = excluded.project_id, updated_at = excluded.updated_at,
           completed_at = excluded.completed_at`,
        t.id, t.title, str(t.description), pick(t.status, ["todo", "in_progress", "done"], "todo"),
        pick(t.priority, ["low", "medium", "high", "urgent"], "medium"), strOrNull(t.due_at),
        projectExists(t.project_id) ? t.project_id : null, t.created_at, t.updated_at, strOrNull(t.completed_at),
      );
    }
    for (const n of d.notes) {
      db.run(
        `INSERT INTO tal_notes (id, title, content, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, content = excluded.content, project_id = excluded.project_id, updated_at = excluded.updated_at`,
        n.id, n.title, n.content, projectExists(n.project_id) ? n.project_id : null, n.created_at, n.updated_at,
      );
    }
    let automations = 0;
    for (const a of d.automations) {
      const schedule = scheduleSpecSchema.safeParse(a.schedule);
      if (!schedule.success) continue;
      const kind = pick(a.kind, ["reminder", "task_digest", "agent_prompt"], "reminder");
      const enabled = a.enabled !== false;
      db.run(
        `INSERT INTO tal_automations (id, name, kind, message, schedule, enabled, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name = excluded.name, kind = excluded.kind, message = excluded.message,
           schedule = excluded.schedule, enabled = excluded.enabled, updated_at = excluded.updated_at`,
        a.id, a.name, kind, str(a.message), JSON.stringify(schedule.data), enabled ? 1 : 0, enabled ? "scheduled" : "paused",
        str(a.created_at, now), now,
      );
      automations++;
    }
    if (d.settings && Object.keys(d.settings).length > 0) {
      // Validated merge; invalid fields are rejected with a clear error.
      s.settings.update(d.settings as never);
    }
    return {
      conversations: d.conversations.length,
      messages,
      memories: d.memories.length,
      tasks: d.tasks.length,
      notes: d.notes.length,
      projects: d.projects.length,
      automations,
    };
  });

  // Arm (or disarm) imported schedules outside the data transaction (SDK schedules are separate rows).
  if (summary.automations > 0) await s.automations.rearmAll();
  s.activity.record("data.imported", `Imported backup from ${backup.exported_at}`);
  return summary;
}
