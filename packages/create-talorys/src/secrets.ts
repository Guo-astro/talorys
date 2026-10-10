import { randomBytes } from "node:crypto";
import { hashPassword } from "@talorys/shared/crypto";
import { checkPasswordStrength } from "@talorys/shared/password-policy";

export const PASSWORD_SECRET = "OWNER_PASSWORD_HASH";
export const SESSION_SECRET = "SESSION_SECRET";
export const REQUIRED_SECRETS = [PASSWORD_SECRET, SESSION_SECRET] as const;

export function validatePassword(password: string | undefined): string | undefined {
  if (!password) return "Please enter a password.";
  return checkPasswordStrength(password) ?? undefined;
}

/** 256-bit random session key, base64url encoded. */
export function generateSessionSecret(): string {
  return randomBytes(32).toString("base64url");
}

/**
 * Builds the secret payload. The plaintext password is hashed locally with
 * PBKDF2-SHA256 and never leaves this machine.
 */
export async function buildOwnerSecrets(password: string, opts: { includeSessionSecret: boolean }): Promise<Record<string, string>> {
  const secrets: Record<string, string> = { [PASSWORD_SECRET]: await hashPassword(password) };
  if (opts.includeSessionSecret) secrets[SESSION_SECRET] = generateSessionSecret();
  return secrets;
}
