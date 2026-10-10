import { PROJECT_STATUSES } from "@talorys/shared";
import { z } from "zod";
import { defineTool, ToolError } from "./registry";

export const noteTools = [
  defineTool({
    name: "create_note",
    description: "Save a Markdown note for the owner (ideas, meeting notes, reference information).",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      title: z.string().min(1).max(300),
      content: z.string().max(20_000),
      project: z.string().max(200).optional(),
    }),
    label: (i) => `Saving note “${i.title}”`,
    execute: (i, ctx) => {
      let projectId: string | null = null;
      if (i.project) {
        const p = ctx.services.projects.resolve(i.project);
        if (!p) throw new ToolError(`Project "${i.project}" does not exist.`);
        projectId = p.id;
      }
      const note = ctx.services.notes.create({ title: i.title, content: i.content, project_id: projectId });
      ctx.services.activity.record("note.created", `Agent created note “${note.title}”`);
      return { created: { id: note.id, title: note.title } };
    },
  }),
  defineTool({
    name: "search_notes",
    description: "Full-text search over the owner's notes. Returns titles and short excerpts.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ query: z.string().min(1).max(200) }),
    label: (i) => `Searching notes for “${i.query}”`,
    execute: (i, ctx) => ({
      results: ctx.services.notes.search(i.query, 8).map((n) => ({ id: n.id, title: n.title, excerpt: n.content.slice(0, 400) })),
    }),
  }),
  defineTool({
    name: "read_note",
    description: "Read the full content of a note by id.",
    permission: "read",
    maxCallsPerTurn: 3,
    input: z.object({ id: z.string().min(1) }),
    label: () => `Reading a note`,
    execute: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      return { id: note.id, title: note.title, content: note.content.slice(0, 8000) };
    },
  }),
  defineTool({
    name: "update_note",
    description: "Replace a note's title and/or content, or append text to it.",
    permission: "write",
    maxCallsPerTurn: 3,
    input: z.object({
      id: z.string().min(1),
      title: z.string().min(1).max(300).optional(),
      content: z.string().max(20_000).optional(),
      append: z.string().max(10_000).optional(),
    }),
    label: () => `Updating a note`,
    execute: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      const content = i.append ? `${i.content ?? note.content}\n\n${i.append}` : i.content;
      const updated = ctx.services.notes.update(note.id, { title: i.title, content });
      return { updated: { id: updated.id, title: updated.title } };
    },
  }),
  defineTool({
    name: "delete_note",
    description: "Permanently delete a note. Destructive: ask the owner to confirm first, then call with confirmed: true.",
    permission: "destructive",
    maxCallsPerTurn: 2,
    input: z.object({ id: z.string().min(1), confirmed: z.boolean().optional() }),
    label: () => `Deleting a note`,
    execute: (i, ctx) => {
      const note = ctx.services.notes.get(i.id);
      if (!note) throw new ToolError("Note not found.");
      ctx.services.notes.delete(note.id);
      return { deleted: note.title };
    },
  }),
];

export const projectTools = [
  defineTool({
    name: "list_projects",
    description: "List the owner's projects.",
    permission: "read",
    maxCallsPerTurn: 2,
    input: z.object({}),
    label: () => `Checking projects`,
    execute: (_i, ctx) => ({
      projects: ctx.services.projects.list().map((p) => ({ id: p.id, name: p.name, status: p.status, description: p.description.slice(0, 200) })),
    }),
  }),
  defineTool({
    name: "create_project",
    description: "Create a lightweight project to group tasks and notes.",
    permission: "write",
    maxCallsPerTurn: 2,
    input: z.object({
      name: z.string().min(1).max(200),
      description: z.string().max(2000).optional(),
      status: z.enum(PROJECT_STATUSES).optional(),
    }),
    label: (i) => `Creating project “${i.name}”`,
    execute: (i, ctx) => {
      const existing = ctx.services.projects.resolve(i.name);
      if (existing) return { existing: { id: existing.id, name: existing.name } };
      const p = ctx.services.projects.create(i);
      return { created: { id: p.id, name: p.name } };
    },
  }),
];
