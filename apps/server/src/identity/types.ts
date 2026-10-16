/** Who is making a request, as the identity provider sees them (ADR-0018). */
export interface Identity {
  externalId: string;
  email?: string | null;
  name?: string | null;
}

export interface IdentityProvider {
  readonly mode: "dev" | "clerk" | "workos";
  /** Returns the caller's identity, or null when unauthenticated. */
  resolve(request: Request): Promise<Identity | null>;
}
