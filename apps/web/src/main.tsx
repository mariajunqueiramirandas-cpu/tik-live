import "./styles/base.css";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider } from "react-router/dom";
import { loadAppConfig } from "./lib/config";
import { queryClient } from "./lib/query";
import { router } from "./router";
import { Toaster, TooltipProvider } from "./ui/Overlay";

async function start(): Promise<void> {
  const config = await loadAppConfig().catch(() => null);
  // Clerk's SDK keeps its session fresh, so it wraps the whole app; it's
  // only downloaded when this server uses Clerk.
  let Shell = ({ children }: { children: ReactNode }) => <>{children}</>;
  if (config?.authMode === "clerk" && config.clerkPublishableKey) {
    const { ClerkShell } = await import("./auth/clerk");
    const key = config.clerkPublishableKey;
    Shell = ({ children }) => <ClerkShell publishableKey={key}>{children}</ClerkShell>;
  }
  createRoot(document.getElementById("root") as HTMLElement).render(
    <StrictMode>
      <QueryClientProvider client={queryClient}>
        <Shell>
          <TooltipProvider>
            <RouterProvider router={router} />
            <Toaster />
          </TooltipProvider>
        </Shell>
      </QueryClientProvider>
    </StrictMode>,
  );
}

void start();
