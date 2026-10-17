import { PRODUCT_NAME } from "@tik-live/shared";
import { lazy, Suspense, useEffect } from "react";
import { LanternMark } from "../components/Brand";
import { appConfig, signInUrl } from "../lib/config";
import { Skeleton } from "../ui/Display";
import s from "./sign-in.module.css";

const ClerkSignIn = lazy(() => import("../auth/clerk").then((m) => ({ default: m.ClerkSignIn })));

/** `/app/sign-in`: Clerk's sign-in form, or a hand-off to the provider's hosted page. */
export default function SignIn() {
  const mode = appConfig()?.authMode ?? "dev";
  useEffect(() => {
    if (mode === "dev") location.replace("/app");
    else if (mode === "workos") {
      const returnTo = new URLSearchParams(location.search).get("returnTo") ?? "/app";
      const url = signInUrl(returnTo);
      if (url) location.replace(url);
    }
  }, [mode]);
  return (
    <main className={s.page}>
      <div className={s.brand}>
        <LanternMark size={36} />
        <span>{PRODUCT_NAME}</span>
      </div>
      {mode === "clerk" ? (
        <Suspense fallback={<Skeleton width={400} height={420} />}>
          <ClerkSignIn />
        </Suspense>
      ) : (
        <p className={s.note}>Levando você para entrar…</p>
      )}
    </main>
  );
}
