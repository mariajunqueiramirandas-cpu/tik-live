import type { Context } from "hono";
import { HTTPException } from "hono/http-exception";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { ZodError } from "zod";
import type { Logger } from "../log";

/** The one error shape every endpoint returns (ADR-0003). */
export interface ProblemBody {
  error: { code: string; message: string; details?: unknown };
}

export class AppError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

export const notFound = (what = "That") => new AppError(404, "not_found", `${what} doesn't exist.`);
export const badRequest = (message: string, details?: unknown) => new AppError(400, "bad_request", message, details);

export function problem(c: Context, status: ContentfulStatusCode, code: string, message: string, details?: unknown) {
  const body: ProblemBody = { error: { code, message, ...(details === undefined ? {} : { details }) } };
  return c.json(body, status);
}

export function errorHandler(log: Logger) {
  return (err: Error, c: Context) => {
    if (err instanceof AppError) return problem(c, err.status, err.code, err.message, err.details);
    if (err instanceof ZodError) {
      return problem(c, 400, "invalid_input", "Some fields aren't valid.", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    }
    if (err instanceof HTTPException) {
      return problem(c, err.status as ContentfulStatusCode, "http_error", err.message || "Request failed.");
    }
    log.error(`unhandled error on ${c.req.method} ${c.req.path}`, err);
    return problem(c, 500, "internal", "Something went wrong on our side. Try again in a moment.");
  };
}
