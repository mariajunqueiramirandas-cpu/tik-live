import type { AppConfig } from "../config";
import type { Identity, IdentityProvider } from "./types";

/** Placeholder until the provider adapter lands (ADR-0018, Phase 7). */
export class WorkOSIdentityProvider implements IdentityProvider {
  readonly mode = "workos" as const;

  constructor(_config: AppConfig) {
    throw new Error("AUTH_MODE=workos is not available in this build yet");
  }

  async resolve(_request: Request): Promise<Identity | null> {
    return null;
  }
}
