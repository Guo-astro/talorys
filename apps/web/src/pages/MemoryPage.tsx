import { useEffect, useMemo, useState } from "react";
import { MEMORY_CATEGORIES, type Memory, type MemoryCategory } from "@talorys/shared";
import { Brain, Pencil, Plus, Search, Trash2 } from "lucide-react";
import { Badge, Button, ConfirmDialog, Dialog, EmptyState, ErrorNotice, Input, Label, PageHeader, Select, Spinner, Textarea } from "../components/ui";
import { keys, useApiMutation, useMemories } from "../hooks/queries";
import { api } from "../lib/api";
import { relativeTime } from "../lib/utils";

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "Preferences",
  fact: "Facts",
  goal: "Goals",
  project: "Projects",
  habit: "Habits",
  person: "People",
  other: "Other",
};

export default function MemoryPage() {
  const [q, setQ] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const t = setTimeout(() => setDebounced(q.trim()), 250);
    return () => clearTimeout(t);
  }, [q]);
  const { data, isLoading, error, refetch } = useMemories(debounced || undefined);
  const [editing, setEditing] = useState<Memory | "new" | null>(null);
  const [deleting, setDeleting] = useState<Memory | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<MemoryCategory, Memory[]>();
    for (const m of data?.memories ?? []) {
      const list = map.get(m.category) ?? [];
      list.push(m);
      map.set(m.category, list);
    }
    return MEMORY_CATEGORIES.filter((c) => map.has(c)).map((c) => [c, map.get(c)!] as const);
  }, [data]);

  const remove = useApiMutation((id: string) => api(`/memories/${id}`, { method: "DELETE" }), {
    invalidate: [["memories"]],
    success: "Memory deleted",
    onSuccess: () => setDeleting(null),
  });

  return (
    <div className="mx-auto w-full max-w-3xl px-4 py-8 md:px-8">
      <PageHeader
        title="Memory"
        description={
          <>
            What Talorys knows about you. Only the most relevant memories are shared with the AI in each conversation.
            {data ? ` ${data.total} saved.` : ""}
          </>
        }
        actions={
          <Button onClick={() => setEditing("new")}>
            <Plus className="h-4 w-4" /> Add memory
          </Button>
        }
      />
      <div className="relative mb-6">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-fg-subtle" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search memories" className="pl-9" aria-label="Search memories" />
      </div>

      {error ? (
        <ErrorNotice error={error} onRetry={() => void refetch()} />
      ) : isLoading ? (
        <div className="flex justify-center py-16">
          <Spinner />
        </div>
      ) : grouped.length === 0 ? (
        <EmptyState
          icon={<Brain className="h-9 w-9" />}
          title={debounced ? "No matching memories" : "Nothing remembered yet"}
          action={!debounced && <Button variant="outline" onClick={() => setEditing("new")}>Add your first memory</Button>}
        >
          {debounced ? "Try a different search." : 'Tell Talorys things like "Remember that I prefer morning meetings", or add them here.'}
        </EmptyState>
      ) : (
        <div className="space-y-8">
          {grouped.map(([category, items]) => (
            <section key={category}>
              <h2 className="mb-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                {CATEGORY_LABELS[category]} <span className="ml-1 normal-case tracking-normal">· {items.length}</span>
              </h2>
              <ul className="divide-y divide-border rounded-xl border border-border bg-surface">
                {items.map((m) => (
                  <li key={m.id} className="group flex items-start gap-3 px-4 py-3">
                    <div className="min-w-0 flex-1">
                      <p className="text-[15px] leading-6">{m.content}</p>
                      <p className="mt-0.5 text-xs text-fg-subtle">
                        {m.source === "agent" ? "Learned in chat" : m.source === "import" ? "Imported" : "Added manually"} · {relativeTime(m.updated_at)}
                      </p>
                    </div>
                    <div className="flex shrink-0 gap-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 md:focus-within:opacity-100">
                      <Button variant="ghost" size="icon" onClick={() => setEditing(m)} aria-label="Edit memory">
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button variant="ghost" size="icon" onClick={() => setDeleting(m)} aria-label="Delete memory">
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      <MemoryEditor memory={editing} onClose={() => setEditing(null)} />
      <ConfirmDialog
        open={!!deleting}
        title="Forget this memory?"
        message={<>Talorys will no longer remember: “{deleting?.content}”</>}
        confirmLabel="Forget"
        onCancel={() => setDeleting(null)}
        onConfirm={() => deleting && remove.mutate(deleting.id)}
        loading={remove.isPending}
      />
    </div>
  );
}

function MemoryEditor({ memory, onClose }: { memory: Memory | "new" | null; onClose: () => void }) {
  const [content, setContent] = useState("");
  const [category, setCategory] = useState<MemoryCategory>("other");
  useEffect(() => {
    if (memory && memory !== "new") {
      setContent(memory.content);
      setCategory(memory.category);
    } else {
      setContent("");
      setCategory("preference");
    }
  }, [memory]);
  const save = useApiMutation(
    () =>
      memory === "new"
        ? api("/memories", { method: "POST", body: { content, category } })
        : api(`/memories/${(memory as Memory).id}`, { method: "PATCH", body: { content, category } }),
    { invalidate: [["memories"], keys.memories()], success: "Memory saved", onSuccess: onClose },
  );
  return (
    <Dialog
      open={!!memory}
      onClose={onClose}
      title={memory === "new" ? "Add memory" : "Edit memory"}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={() => save.mutate(undefined)} loading={save.isPending} disabled={!content.trim()}>
            Save
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <div>
          <Label htmlFor="memory-content">What should Talorys remember?</Label>
          <Textarea id="memory-content" rows={3} value={content} onChange={(e) => setContent(e.target.value)} maxLength={2000} autoFocus placeholder="Prefers concise answers" />
        </div>
        <div>
          <Label htmlFor="memory-category">Category</Label>
          <Select id="memory-category" value={category} onChange={(e) => setCategory(e.target.value as MemoryCategory)}>
            {MEMORY_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABELS[c]}
              </option>
            ))}
          </Select>
        </div>
        <Badge tone="accent">Stored only in your Cloudflare account</Badge>
      </div>
    </Dialog>
  );
}
