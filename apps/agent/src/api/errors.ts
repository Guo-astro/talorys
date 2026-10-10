import type { ApiErrorBody, ApiErrorCode } from "@talorys/shared";
import type { ZodError } from "zod";

const STATUS: Record<ApiErrorCode, number> = {
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  VALIDATION_ERROR: 400,
  RATE_LIMITED: 429,
  AI_QUOTA_EXHAUSTED: 503,
  AI_UNAVAILABLE: 503,
  AI_LIMIT_REACHED: 429,
  CONFLICT: 409,
  NOT_CONFIGURED: 503,
  INTERNAL_ERROR: 500,
};

export class AppError extends Error {
  constructor(
    readonly code: ApiErrorCode,
    message: string,
    readonly details?: unknown,
    readonly headers?: Record<string, string>,
  ) {
    super(message);
    this.name = "AppError";
  }

  get status(): number {
    return STATUS[this.code];
  }

  toBody(): ApiErrorBody {
    return { error: { code: this.code, message: this.message, ...(this.details !== undefined ? { details: this.details } : {}) } };
  }
}

export class NotFoundError extends AppError {
  constructor(message = "Not found") {
    super("NOT_FOUND", message);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: unknown) {
    super("VALIDATION_ERROR", message, details);
  }

  static fromZod(error: ZodError): ValidationError {
    const issues = error.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    const first = issues[0];
    return new ValidationError(first ? `${first.path ? `${first.path}: ` : ""}${first.message}` : "Invalid input", issues);
  }
}

export function errorResponse(error: unknown): Response {
  const appError =
    error instanceof AppError ? error : new AppError("INTERNAL_ERROR", "Something went wrong. Your data is safe; please try again.");
  if (!(error instanceof AppError)) console.error("Unhandled error", error);
  return new Response(JSON.stringify(appError.toBody()), {
    status: appError.status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...appError.headers },
  });
}
