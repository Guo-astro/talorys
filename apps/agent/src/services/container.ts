import type { Env } from "../env";
import { Database } from "../db/database";
import { TaskRepository } from "../db/repositories/tasks";
import { MemoryRepository } from "../db/repositories/memories";
import { NoteRepository, ProjectRepository } from "../db/repositories/notes";
import { ConversationRepository } from "../db/repositories/conversations";
import { AutomationRepository, NotificationRepository } from "../db/repositories/automations";
import { PendingActionRepository } from "../db/repositories/pending-actions";
import { SettingsService } from "./settings";
import { ActivityLog, UsageService } from "./usage";
import { AuthService } from "../auth/auth-service";
import { AutomationService, type Scheduler } from "../agent/scheduling";

/** All data services for the single owner, bound to one Durable Object's storage. */
export interface Services {
  db: Database;
  tasks: TaskRepository;
  memories: MemoryRepository;
  notes: NoteRepository;
  projects: ProjectRepository;
  conversations: ConversationRepository;
  automationsRepo: AutomationRepository;
  notifications: NotificationRepository;
  pendingActions: PendingActionRepository;
  settings: SettingsService;
  usage: UsageService;
  activity: ActivityLog;
  auth: AuthService;
  automations: AutomationService;
}

export function createServices(storage: DurableObjectStorage, env: Env, scheduler: Scheduler): Services {
  const db = new Database(storage);
  const settings = new SettingsService(db, {
    ...(env.TALORYS_DEFAULT_TIMEZONE ? { timezone: env.TALORYS_DEFAULT_TIMEZONE } : {}),
    ...(env.TALORYS_AGENT_NAME ? { agentName: env.TALORYS_AGENT_NAME } : {}),
  });
  const automationsRepo = new AutomationRepository(db);
  const notifications = new NotificationRepository(db);
  const activity = new ActivityLog(db);
  return {
    db,
    tasks: new TaskRepository(db),
    memories: new MemoryRepository(db),
    notes: new NoteRepository(db),
    projects: new ProjectRepository(db),
    conversations: new ConversationRepository(db),
    automationsRepo,
    notifications,
    pendingActions: new PendingActionRepository(db),
    settings,
    usage: new UsageService(db),
    activity,
    auth: new AuthService(db, settings, {
      passwordHash: env.OWNER_PASSWORD_HASH,
      password: env.OWNER_PASSWORD,
      sessionSecret: env.SESSION_SECRET,
    }),
    automations: new AutomationService(automationsRepo, settings, activity, scheduler),
  };
}
