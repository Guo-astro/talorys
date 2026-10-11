import type {
  Automation,
  AutomationRun,
  Conversation,
  ChatMessage,
  Memory,
  Note,
  Notification,
  Project,
  SessionInfo,
  Settings,
  Task,
  UsageReport,
} from "@talorys/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { errorMessage, useToast } from "./toast";

export const keys = {
  settings: ["settings"] as const,
  conversations: (q?: string) => ["conversations", q ?? ""] as const,
  conversation: (id: string) => ["conversation", id] as const,
  tasks: ["tasks"] as const,
  memories: (q?: string) => ["memories", q ?? ""] as const,
  notes: (q?: string) => ["notes", q ?? ""] as const,
  projects: ["projects"] as const,
  automations: ["automations"] as const,
  notifications: ["notifications"] as const,
  usage: ["usage"] as const,
  sessions: ["sessions"] as const,
  system: ["system"] as const,
};

export function useSettings() {
  return useQuery({ queryKey: keys.settings, queryFn: () => api<{ settings: Settings }>("/settings").then((r) => r.settings), staleTime: 60_000 });
}

/** Owner timezone with a safe fallback while settings load. */
export function useTimezone(): string {
  return useSettings().data?.timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
}

export function useConversations(q?: string) {
  return useQuery({
    queryKey: keys.conversations(q),
    queryFn: () => api<{ conversations: Conversation[] }>(`/conversations${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.conversations),
  });
}

export function useConversation(id: string | undefined) {
  return useQuery({
    queryKey: keys.conversation(id ?? ""),
    queryFn: () => api<{ conversation: Conversation; messages: ChatMessage[]; streaming?: boolean }>(`/conversations/${id}`),
    enabled: !!id,
    // A reply started elsewhere (another tab, or before a reload) is still generating: poll until it lands.
    refetchInterval: (query) => (query.state.data?.streaming ? 1500 : false),
  });
}

export function useTasks() {
  // Open and completed tasks are fetched separately so a long completed history can't push
  // open tasks past the page limit.
  return useQuery({
    queryKey: keys.tasks,
    queryFn: async () => {
      const [open, completed] = await Promise.all([
        api<{ tasks: Task[] }>("/tasks?status=open&limit=500"),
        api<{ tasks: Task[] }>("/tasks?view=completed&limit=200"),
      ]);
      return [...open.tasks, ...completed.tasks];
    },
  });
}

export function useMemories(q?: string) {
  return useQuery({
    queryKey: keys.memories(q),
    queryFn: () => api<{ memories: Memory[]; total: number }>(`/memories${q ? `?q=${encodeURIComponent(q)}` : ""}`),
    placeholderData: (prev) => prev,
  });
}

export function useNotes(q?: string) {
  return useQuery({
    queryKey: keys.notes(q),
    queryFn: () => api<{ notes: Note[] }>(`/notes${q ? `?q=${encodeURIComponent(q)}` : ""}`).then((r) => r.notes),
    placeholderData: (prev) => prev,
  });
}

export function useProjects() {
  return useQuery({ queryKey: keys.projects, queryFn: () => api<{ projects: Project[] }>("/projects").then((r) => r.projects) });
}

export function useAutomations() {
  return useQuery({
    queryKey: keys.automations,
    queryFn: () => api<{ automations: Automation[]; runs: AutomationRun[]; failed_runs: AutomationRun[]; timezone: string }>("/automations"),
    refetchInterval: 60_000,
  });
}

export function useNotifications() {
  return useQuery({
    queryKey: keys.notifications,
    queryFn: () => api<{ notifications: Notification[]; unread: number }>("/notifications"),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
  });
}

export function useUsage() {
  return useQuery({ queryKey: keys.usage, queryFn: () => api<UsageReport>("/usage") });
}

export function useSessions() {
  return useQuery({ queryKey: keys.sessions, queryFn: () => api<{ sessions: SessionInfo[] }>("/auth/sessions").then((r) => r.sessions) });
}

export function useSystemInfo() {
  return useQuery({
    queryKey: keys.system,
    queryFn: () =>
      api<{ version: string; deployed_version: string | null; installation_id: string | null; schema_version: number; ai_binding: boolean; ai_provider: string; environment: string }>("/system"),
  });
}

/**
 * Generic mutation with toast feedback and cache invalidation.
 */
export function useApiMutation<TVars, TResult = unknown>(
  fn: (vars: TVars) => Promise<TResult>,
  opts: { invalidate?: readonly (readonly unknown[])[]; success?: string | ((r: TResult) => string); onSuccess?: (r: TResult, v: TVars) => void } = {},
) {
  const qc = useQueryClient();
  const toast = useToast();
  return useMutation({
    mutationFn: fn,
    onSuccess: async (result, vars) => {
      await Promise.all((opts.invalidate ?? []).map((key) => qc.invalidateQueries({ queryKey: key as unknown[] })));
      if (opts.success) toast(typeof opts.success === "function" ? opts.success(result) : opts.success);
      opts.onSuccess?.(result, vars);
    },
    onError: (error) => toast(errorMessage(error), "error"),
  });
}
