import { createClerkClient } from "@clerk/backend";
import { verifyWebhook } from "@clerk/backend/webhooks";
import { Hono } from "hono";
import type { AppConfig } from "../config";
import type { Database } from "../db/client";
import type { AppEnv } from "../http/env";
import { problem } from "../http/errors";
import type { Logger } from "../log";
import { deleteUser, getUserByExternalId, upsertUser } from "../repos/users";
import type { Identity, IdentityProvider } from "./types";
export { clerkFrontendApi } from "./clerk-key";

/** The slice of the Clerk SDK this adapter uses (a fake in tests). */
export interface ClerkLike {
  authenticateRequest(request: Request, options: { authorizedParties?: string[] }): Promise<{ isAuthenticated: boolean; toAuth(): { userId?: string | null } | null }>;
  users: {
    getUser(userId: string): Promise<{
      id: string;
      firstName: string | null;
      lastName: string | null;
      username: string | null;
      primaryEmailAddress?: { emailAddress: string } | null;
      emailAddresses?: Array<{ emailAddress: string }>;
    }>;
  };
}

export interface ClerkProviderOptions {
  client?: ClerkLike;
  /** For the user-sync webhook. */
  database?: Database["db"];
  onUserDeleted?: (userId: string) => Promise<void>;
  log?: Logger;
  now?: () => number;
}

const PROFILE_TTL_MS = 10 * 60_000;

/**
 * Clerk sign-in (ADR-0018): Clerk's session cookie is verified on each
 * request (and on WebSocket upgrades, which carry the same cookie); the
 * profile (email, name) is fetched once and cached for provisioning.
 */
export class ClerkIdentityProvider implements IdentityProvider {
  readonly mode = "clerk" as const;
  readonly signInPath = "/app/sign-in";
  private readonly client: ClerkLike;
  private readonly profiles = new Map<string, { at: number; email: string | null; name: string | null }>();
  private readonly now: () => number;

  constructor(
    private readonly config: AppConfig,
    private readonly options: ClerkProviderOptions = {},
  ) {
    this.client = options.client ?? (createClerkClient({ secretKey: config.CLERK_SECRET_KEY!, publishableKey: config.CLERK_PUBLISHABLE_KEY! }) as unknown as ClerkLike);
    this.now = options.now ?? Date.now;
  }

  async resolve(request: Request): Promise<Identity | null> {
    let state;
    try {
      state = await this.client.authenticateRequest(request, { authorizedParties: [this.config.publicOrigin] });
    } catch (err) {
      this.options.log?.warn("clerk authentication failed", { error: String(err) });
      return null;
    }
    if (!state.isAuthenticated) return null;
    const userId = state.toAuth()?.userId;
    if (!userId) return null;
    const profile = await this.profile(userId);
    return { externalId: `clerk|${userId}`, email: profile.email, name: profile.name };
  }

  private async profile(userId: string): Promise<{ email: string | null; name: string | null }> {
    const cached = this.profiles.get(userId);
    if (cached && this.now() - cached.at < PROFILE_TTL_MS) return cached;
    try {
      const user = await this.client.users.getUser(userId);
      const email = user.primaryEmailAddress?.emailAddress ?? user.emailAddresses?.[0]?.emailAddress ?? null;
      const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.username || null;
      const entry = { at: this.now(), email, name };
      this.profiles.set(userId, entry);
      return entry;
    } catch {
      // Profile lookup is a nicety; the user id alone is enough to proceed.
      return cached ?? { email: null, name: null };
    }
  }

  /** `POST /api/identity/clerk-webhook`: keeps names and emails current and deletes accounts with the Clerk user. */
  routes(): Hono<AppEnv> {
    return new Hono<AppEnv>().post("/api/identity/clerk-webhook", async (c) => {
      const secret = this.config.CLERK_WEBHOOK_SIGNING_SECRET;
      const db = this.options.database;
      if (!secret || !db) return problem(c, 404, "not_found", "Not configured.");
      let event;
      try {
        event = await verifyWebhook(c.req.raw, { signingSecret: secret });
      } catch {
        return problem(c, 401, "bad_signature", "Invalid signature.");
      }
      const id = (event.data as { id?: string }).id;
      if (!id) return c.json({ received: true });
      const externalId = `clerk|${id}`;
      this.profiles.delete(id);
      if (event.type === "user.deleted") {
        const user = await getUserByExternalId(db, externalId);
        if (user) {
          await this.options.onUserDeleted?.(user.id);
          await deleteUser(db, user.id);
        }
      } else if (event.type === "user.updated" || event.type === "user.created") {
        const data = event.data as { email_addresses?: Array<{ id: string; email_address: string }>; primary_email_address_id?: string | null; first_name?: string | null; last_name?: string | null };
        const email = data.email_addresses?.find((e) => e.id === data.primary_email_address_id)?.email_address ?? data.email_addresses?.[0]?.email_address ?? null;
        const name = [data.first_name, data.last_name].filter(Boolean).join(" ") || null;
        if (event.type === "user.updated" || (await getUserByExternalId(db, externalId))) await upsertUser(db, { externalId, email, name });
      }
      return c.json({ received: true });
    });
  }
}
