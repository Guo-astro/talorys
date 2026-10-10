import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { type Exec, type ExecOptions, type ExecResult, exec as defaultExec } from "./exec";
import { CliError, explainWranglerFailure } from "./errors";

export interface CloudflareAccount {
  id: string;
  name: string;
}

export interface WhoAmI {
  loggedIn: boolean;
  authType?: string;
  email?: string;
  accounts: CloudflareAccount[];
}

export interface PagesProject {
  name: string;
  domains: string[];
}

/** Locates the Wrangler CLI shipped as a dependency of create-talorys. */
export function resolveWranglerBin(): string {
  if (process.env.TALORYS_WRANGLER_BIN) return process.env.TALORYS_WRANGLER_BIN;
  const require = createRequire(import.meta.url);
  const pkgPath = require.resolve("wrangler/package.json");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { bin: string | Record<string, string> };
  const bin = typeof pkg.bin === "string" ? pkg.bin : (pkg.bin.wrangler ?? Object.values(pkg.bin)[0]!);
  return join(dirname(pkgPath), bin);
}

/** Extracts the JSON document from CLI output that may contain warnings around it. */
export function parseJsonOutput<T>(stdout: string): T {
  const trimmed = stdout.trim();
  try {
    return JSON.parse(trimmed) as T;
  } catch {
    // Try each line that begins a JSON document (warnings such as "[WARNING]" may precede it).
    const lines = trimmed.split("\n");
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*[[{]/.test(lines[i]!)) continue;
      try {
        return JSON.parse(lines.slice(i).join("\n")) as T;
      } catch {
        for (let j = lines.length; j > i; j--) {
          try {
            return JSON.parse(lines.slice(i, j).join("\n")) as T;
          } catch {
            /* keep trying shorter spans */
          }
        }
      }
    }
    throw new Error("No JSON in output");
  }
}

/**
 * Typed wrapper around the Wrangler CLI. All calls use argument arrays and
 * disable telemetry. Secrets are passed through stdin only.
 */
export class Wrangler {
  accountId: string | null = null;

  constructor(
    private readonly execFn: Exec = defaultExec,
    private readonly bin: string = resolveWranglerBin(),
  ) {}

  private run(args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    return this.execFn(process.execPath, [this.bin, ...args], {
      ...opts,
      env: {
        WRANGLER_SEND_METRICS: "false",
        WRANGLER_HIDE_BANNER: "true",
        FORCE_COLOR: "0",
        ...(this.accountId ? { CLOUDFLARE_ACCOUNT_ID: this.accountId } : {}),
        ...opts.env,
      },
    });
  }

  private async runOk(action: string, args: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    const result = await this.run(args, { timeoutMs: 5 * 60_000, ...opts });
    if (result.code !== 0) throw explainWranglerFailure(action, `${result.stderr}\n${result.stdout}`);
    return result;
  }

  async version(): Promise<string> {
    const r = await this.run(["--version"], { timeoutMs: 60_000 });
    if (r.code !== 0) throw new CliError("The bundled Wrangler CLI could not start.", "Reinstall with `npx create-talorys@latest`.");
    return r.stdout.trim().split("\n").pop()!.trim();
  }

  async whoami(): Promise<WhoAmI> {
    const r = await this.run(["whoami", "--json"], { timeoutMs: 60_000 });
    if (r.code !== 0) return { loggedIn: false, accounts: [] };
    try {
      const parsed = parseJsonOutput<WhoAmI>(r.stdout);
      return { ...parsed, accounts: parsed.accounts ?? [] };
    } catch {
      return { loggedIn: false, accounts: [] };
    }
  }

  /** Opens Cloudflare's OAuth flow in the browser (interactive). */
  async login(): Promise<void> {
    const r = await this.run(["login"], { interactive: true, timeoutMs: 10 * 60_000 });
    if (r.code !== 0) {
      throw new CliError("Cloudflare login did not complete.", "Re-run the installer and approve access in the browser window that opens.");
    }
  }

  async workerExists(name: string): Promise<boolean> {
    const r = await this.run(["deployments", "list", "--name", name, "--json"], { timeoutMs: 120_000 });
    if (r.code === 0) return true;
    const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (out.includes("10007") || out.includes("not found") || out.includes("does not exist")) return false;
    throw explainWranglerFailure("Checking the Worker", `${r.stderr}\n${r.stdout}`);
  }

  async listSecrets(workerName: string): Promise<string[]> {
    const r = await this.run(["secret", "list", "--name", workerName, "--format", "json"], { timeoutMs: 120_000 });
    if (r.code !== 0) {
      const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
      if (out.includes("10007") || out.includes("not found")) return [];
      throw explainWranglerFailure("Reading Worker secret names", `${r.stderr}\n${r.stdout}`);
    }
    return parseJsonOutput<{ name: string }[]>(r.stdout).map((s) => s.name);
  }

  /** Uploads secrets via stdin so values never touch disk or process arguments. */
  async putSecrets(workerName: string, secrets: Record<string, string>): Promise<void> {
    await this.runOk("Storing Cloudflare secrets", ["secret", "bulk", "--name", workerName], { input: JSON.stringify(secrets) });
  }

  async deployWorker(configPath: string): Promise<{ versionId: string | null }> {
    const r = await this.runOk("Deploying the agent Worker", ["deploy", "--config", configPath]);
    const versionId = r.stdout.match(/Current Version ID:\s*([0-9a-f-]{36})/i)?.[1] ?? null;
    return { versionId };
  }

  async listPagesProjects(): Promise<PagesProject[]> {
    const r = await this.runOk("Listing Pages projects", ["pages", "project", "list", "--json"], { timeoutMs: 120_000 });
    const rows = parseJsonOutput<Record<string, string>[]>(r.stdout);
    return rows.map((row) => ({
      name: row["Project Name"] ?? "",
      domains: (row["Project Domains"] ?? "")
        .split(",")
        .map((d) => d.trim())
        .filter(Boolean),
    }));
  }

  async createPagesProject(name: string, cwd: string, compatibilityDate: string): Promise<void> {
    await this.runOk(
      "Creating the Pages project",
      ["pages", "project", "create", name, "--production-branch", "main", "--compatibility-date", compatibilityDate],
      { cwd },
    );
  }

  async deployPages(cwd: string, projectName: string, outputDir: string): Promise<{ deploymentUrl: string | null }> {
    const r = await this.runOk(
      "Deploying Cloudflare Pages",
      ["pages", "deploy", outputDir, "--project-name", projectName, "--branch", "main", "--commit-dirty=true", "--commit-message", "Talorys deploy"],
      { cwd, timeoutMs: 10 * 60_000 },
    );
    const deploymentUrl = r.stdout.match(/https:\/\/[a-z0-9.-]+\.pages\.dev/i)?.[0] ?? null;
    return { deploymentUrl };
  }

  /** Non-inference check that a Workers AI model exists in the catalog. */
  async modelAvailable(model: string): Promise<boolean | null> {
    const r = await this.run(["ai", "models", "schema", model], { timeoutMs: 120_000 });
    if (r.code === 0) return true;
    const out = `${r.stderr}\n${r.stdout}`.toLowerCase();
    if (out.includes("not found") || out.includes("no such model") || out.includes("invalid model")) return false;
    return null; // Unknown (e.g. missing AI read scope); not fatal.
  }
}
