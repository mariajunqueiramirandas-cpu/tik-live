/** "pk_test_Zm9vLmNsZXJrLmFjY291bnRzLmRldiQ" → "https://foo.clerk.accounts.dev". */
export function clerkFrontendApi(publishableKey: string | undefined): string | null {
  const encoded = publishableKey?.replace(/^pk_(test|live)_/, "");
  if (!encoded) return null;
  try {
    const host = Buffer.from(encoded, "base64").toString("utf8").replace(/\$$/, "");
    return /^[a-z0-9.-]+$/i.test(host) ? `https://${host}` : null;
  } catch {
    return null;
  }
}
