import { ClerkProvider, SignIn, useClerk } from "@clerk/react";
import type { ReactNode } from "react";
import { useSearchParams } from "react-router";

/**
 * Clerk's React SDK, loaded only when the server runs AUTH_MODE=clerk
 * (ADR-0018). Styled with the deep-water tokens so sign-in looks like
 * Lantern, not a third-party page.
 */
const appearance = {
  variables: {
    colorPrimary: "#7CF5FF",
    colorBackground: "#181525",
    colorInputBackground: "#0A0912",
    colorText: "#F4F2FA",
    colorTextSecondary: "#ADA8C6",
    colorInputText: "#F4F2FA",
    colorDanger: "#FF6B6B",
    colorTextOnPrimaryBackground: "#062A30",
    borderRadius: "10px",
    fontFamily: '"Reddit Sans", "Reddit Fallback", system-ui, sans-serif',
  },
};

export function ClerkShell({ publishableKey, children }: { publishableKey: string; children: ReactNode }) {
  return (
    <ClerkProvider publishableKey={publishableKey} appearance={appearance} signInUrl="/app/sign-in" afterSignOutUrl="/">
      {children}
    </ClerkProvider>
  );
}

export function ClerkSignIn() {
  const [params] = useSearchParams();
  const returnTo = params.get("returnTo");
  const target = returnTo?.startsWith("/app") ? returnTo : "/app";
  return <SignIn routing="path" path="/app/sign-in" forceRedirectUrl={target} signUpForceRedirectUrl={target} />;
}

export function useClerkSignOut(): () => Promise<void> {
  const clerk = useClerk();
  return () => clerk.signOut({ redirectUrl: "/" });
}
