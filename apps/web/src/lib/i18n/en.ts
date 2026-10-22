/**
 * English messages: the default language and the source of truth for message keys.
 * Other languages may leave keys out; missing keys fall back to these.
 *
 * Placeholders are written as {name}. A plural message is an object keyed by
 * Intl.PluralRules categories and always takes a {count} parameter.
 */
export const en = {
  "common.cancel": "Cancel",
  "common.close": "Close",
  "common.delete": "Delete",
  "common.dismiss": "Dismiss",
  "common.loading": "Loading",
  "common.retry": "Retry",
  "common.somethingWentWrong": "Something went wrong.",
  "common.unreachable": "Talorys is unreachable.",

  "nav.main": "Main",
  "nav.chat": "Chat",
  "nav.memory": "Memory",
  "nav.tasks": "Tasks",
  "nav.notes": "Notes",
  "nav.automations": "Automations",
  "nav.automationsShort": "Schedules",
  "nav.settings": "Settings",
  "nav.lock": "Lock",

  "notifications.title": "Notifications",
  "notifications.titleUnread": { other: "Notifications ({count} unread)" },
  "notifications.markAllRead": "Mark all as read",
  "notifications.empty": "No notifications",
  "notifications.emptyHint": "Reminders and automation results will appear here.",
  "notifications.delete": "Delete notification",

  "time.justNow": "just now",
  "time.inAMoment": "in a moment",

  "settings.language": "Language",
  "settings.languageHint": "Language of the app. Notifications sent by the server stay in English.",
  "settings.languageSystem": "Browser default ({language})",

  "login.tagline": "Your personal AI agent. Your own cloud.",
  "login.notConfigured": "This deployment has no owner password configured yet. Run {command} again to finish setup.",
  "login.password": "Password",
  "login.passwordPlaceholder": "Owner password",
  "login.showPassword": "Show password",
  "login.hidePassword": "Hide password",
  "login.unlock": "Unlock",
  "login.tryAgainIn": "Try again in {seconds}s",
  "login.rateLimited": "Too many attempts. For your security, sign-in is paused.",
  "login.failed": "Could not sign in.",
  "login.forgotPassword": "Forgot your password? Reset it from your computer with{lineBreak}{command}",
} as const;
