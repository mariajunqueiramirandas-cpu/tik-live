import type { AppType } from "@tik-live/server/app-type";
import { hc } from "hono/client";

/**
 * Typed API client (ADR-0003): request and response types come straight
 * from the Hono routes, so the dashboard and server can't drift apart.
 */
export const api = hc<AppType>(typeof location === "undefined" ? "http://localhost" : location.origin, {
  init: { credentials: "same-origin" },
});

export interface Problem {
  code: string;
  message: string;
  details?: unknown;
}

/** An API failure with the server's problem body (`{ error: { code, message } }`). */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

type JsonOf<R> = R extends { json(): Promise<infer T> } ? T : never;
/** The body of a successful response: drops error statuses and problem bodies. */
export type Success<R> = R extends { ok: false } ? never : Exclude<JsonOf<R>, { error: { code: string } }>;

/**
 * Awaits a client call and returns the success body, or throws `ApiError`
 * with the server's message. Network failures become a friendly message too.
 */
export async function call<R extends { ok: boolean; status: number; json(): Promise<unknown> }>(request: Promise<R>): Promise<Success<R>> {
  let res: R;
  try {
    res = await request;
  } catch {
    throw new ApiError(0, "network", "Não deu para falar com o servidor. Confira sua conexão e tente de novo.");
  }
  if (res.status === 204) return undefined as Success<R>;
  const body = (await res.json().catch(() => null)) as { error?: Problem } | null;
  if (!res.ok) {
    const problem = body?.error;
    throw new ApiError(res.status, problem?.code ?? "http_error", problem?.message ?? `A solicitação falhou (${res.status}).`, problem?.details);
  }
  return body as Success<R>;
}

export function errorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  if (error instanceof Error) return error.message;
  return "Algo deu errado.";
}
