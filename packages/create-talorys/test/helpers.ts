import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { SelectChoice, Ui } from "../src/ui";
import { CancelledError } from "../src/errors";
import { Wrangler } from "../src/wrangler";
import { exec } from "../src/exec";
import type { FetchLike } from "../src/verify";

export const FAKE_WRANGLER = join(dirname(fileURLToPath(import.meta.url)), "fake-wrangler.mjs");

export interface FakeState {
  loggedIn: boolean;
  accounts: { id: string; name: string }[];
  workers: Record<string, Record<string, { secrets: Record<string, { length: number; prefix: string }>; migrations: unknown[]; workers_dev: boolean; vars: Record<string, string>; deploys: number; durableObjectData: string }>>;
  pages: Record<string, Record<string, { subdomain: string; deployments: number }>>;
  calls: { key: string; args: string[]; account: string }[];
  failNext: Record<string, string>;
  subdomainSuffix?: string;
}

export function makeSandbox(initial: Partial<FakeState> = {}) {
  const root = mkdtempSync(join(tmpdir(), "talorys-cli-test-"));
  const statePath = join(root, "cf-state.json");
  const state: FakeState = {
    loggedIn: true,
    accounts: [{ id: "acc1", name: "Personal Account" }],
    workers: {},
    pages: {},
    calls: [],
    failNext: {},
    ...initial,
  };
  writeFileSync(statePath, JSON.stringify(state));
  process.env.FAKE_CF_STATE = statePath;
  const templates = makeTemplates(root, "0.1.0");
  return {
    root,
    templates,
    dir: join(root, "talorys"),
    state: () => JSON.parse(readFileSync(statePath, "utf8")) as FakeState,
    update: (fn: (s: FakeState) => void) => {
      const s = JSON.parse(readFileSync(statePath, "utf8")) as FakeState;
      fn(s);
      writeFileSync(statePath, JSON.stringify(s));
    },
    wrangler: () => new Wrangler(exec, FAKE_WRANGLER),
  };
}

export function makeTemplates(root: string, version: string): string {
  const dir = join(root, `templates-${version}`);
  mkdirSync(join(dir, "agent"), { recursive: true });
  mkdirSync(join(dir, "web/dist"), { recursive: true });
  mkdirSync(join(dir, "web/functions/api"), { recursive: true });
  writeFileSync(join(dir, "version.json"), JSON.stringify({ version, built_at: "test" }));
  writeFileSync(join(dir, "agent/worker.js"), `export default {}; // ${version}`);
  writeFileSync(join(dir, "web/dist/index.html"), "<title>Talorys</title>");
  writeFileSync(join(dir, "web/functions/api/[[path]].ts"), "export const onRequest = () => new Response('ok');");
  return dir;
}

/** Scripted, non-TTY-free UI for tests. Answers are consumed in order. */
export class ScriptedUi implements Ui {
  readonly interactive: boolean;
  readonly log: string[] = [];
  readonly prompts: string[] = [];
  constructor(
    private readonly answers: unknown[] = [],
    interactive = true,
  ) {
    this.interactive = interactive;
  }
  private next<T>(message: string): T {
    this.prompts.push(message);
    if (this.answers.length === 0) throw new Error(`Unexpected prompt: ${message}`);
    const a = this.answers.shift();
    if (a === CANCEL) throw new CancelledError();
    return a as T;
  }
  intro(t: string) {
    this.log.push(`intro:${t}`);
  }
  info(m: string) {
    this.log.push(`info:${m}`);
  }
  warn(m: string) {
    this.log.push(`warn:${m}`);
  }
  success(m: string) {
    this.log.push(`success:${m}`);
  }
  note(m: string, t?: string) {
    this.log.push(`note:${t ?? ""}:${m}`);
  }
  outro(m: string) {
    this.log.push(`outro:${m}`);
  }
  error(m: string) {
    this.log.push(`error:${m}`);
  }
  async step<T>(title: string, fn: (u: (m: string) => void) => Promise<T>, done?: (r: T) => string) {
    try {
      const r = await fn(() => {});
      this.log.push(`step:✓ ${done ? done(r) : title}`);
      return r;
    } catch (e) {
      this.log.push(`step:✗ ${title}`);
      throw e;
    }
  }
  async text(message: string, opts: { initial?: string } = {}) {
    const v = this.next<string>(message);
    return v === "" ? (opts.initial ?? "") : v;
  }
  async password(message: string) {
    return this.next<string>(message);
  }
  async select<T>(message: string, choices: SelectChoice<T>[]) {
    const label = this.next<string>(message);
    const c = choices.find((x) => x.label === label);
    if (!c) throw new Error(`No choice ${label}`);
    return c.value;
  }
  async confirm(message: string) {
    return this.next<boolean>(message);
  }
}

export const CANCEL = Symbol("cancel");

export const STRONG_PASSWORD = "correct-horse-Battery-9";

/** Simulates a healthy (or unhealthy) deployed Talorys behind pages.dev. */
export function fakeSite(opts: { healthy?: boolean; failFirst?: number } = {}): FetchLike & { calls: string[] } {
  let failures = opts.failFirst ?? 0;
  const calls: string[] = [];
  const fn = (async (url: string) => {
    calls.push(url);
    if (failures > 0) {
      failures--;
      throw new Error("getaddrinfo ENOTFOUND");
    }
    const path = new URL(url).pathname;
    if (path === "/") return new Response("<!doctype html><title>Talorys</title>", { status: 200 });
    if (path === "/api/auth/session") return Response.json({ authenticated: false, configured: true });
    if (path === "/api/tasks") return Response.json({ error: { code: "UNAUTHORIZED" } }, { status: 401 });
    if (path === "/api/health") {
      return opts.healthy === false
        ? Response.json({ ok: false, storage: "ok", configured: { password: false, session_secret: false } }, { status: 503 })
        : Response.json({ ok: true, storage: "ok", schema_version: 1, configured: { password: true, session_secret: true } });
    }
    return new Response("not found", { status: 404 });
  }) as FetchLike & { calls: string[] };
  fn.calls = calls;
  return fn;
}
