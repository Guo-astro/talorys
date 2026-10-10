import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CliError } from "./errors";

export const MANIFEST_FILE = "talorys.json";

/**
 * Local installation manifest. Identifies the deployment across retries and
 * upgrades. Contains no secrets.
 */
export interface Manifest {
  manifest_version: 1;
  installation_id: string;
  account_id: string;
  account_name?: string;
  worker_name: string;
  pages_project_name: string;
  public_url: string | null;
  deployment_version: string | null;
  agent_name: string;
  timezone: string;
  status: "provisioning" | "deployed" | "failed";
  /** Completed steps, used to report progress when resuming. */
  steps: string[];
  created_at: string;
  updated_at: string;
}

export function manifestPath(dir: string): string {
  return join(dir, MANIFEST_FILE);
}

export function readManifest(dir: string): Manifest | null {
  const path = manifestPath(dir);
  if (!existsSync(path)) return null;
  let data: Manifest;
  try {
    data = JSON.parse(readFileSync(path, "utf8")) as Manifest;
  } catch {
    throw new CliError(`${path} is not valid JSON.`, "Restore it from a backup, or move it away to start a fresh installation.");
  }
  for (const key of ["installation_id", "account_id", "worker_name", "pages_project_name"] as const) {
    if (typeof data[key] !== "string" || !data[key]) {
      throw new CliError(`${path} is missing "${key}".`, "Restore the file, or move it away to start a fresh installation.");
    }
  }
  return { ...data, steps: Array.isArray(data.steps) ? data.steps : [] };
}

/** Atomic write (temp file + rename) so an interrupted run never leaves a corrupt manifest. */
export function writeManifest(dir: string, manifest: Manifest): void {
  const path = manifestPath(dir);
  const tmp = `${path}.tmp`;
  const data: Manifest = { ...manifest, updated_at: new Date().toISOString() };
  // Defensive: the manifest must never contain secrets.
  const serialized = JSON.stringify(data, null, 2);
  if (/pbkdf2-sha256\$|SESSION_SECRET|OWNER_PASSWORD/i.test(serialized)) {
    throw new Error("Refusing to write secrets into the manifest");
  }
  writeFileSync(tmp, `${serialized}\n`, { mode: 0o644 });
  renameSync(tmp, path);
}

export function markStep(dir: string, manifest: Manifest, step: string): Manifest {
  const next = { ...manifest, steps: manifest.steps.includes(step) ? manifest.steps : [...manifest.steps, step] };
  writeManifest(dir, next);
  return next;
}
