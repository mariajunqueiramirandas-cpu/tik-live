import { createBrowserRouter, redirect, type LoaderFunctionArgs } from "react-router";
import { ApiError } from "./lib/api";
import { signInUrl } from "./lib/config";
import { modules } from "./lib/prefetch";
import { queries, queryClient } from "./lib/query";
import { NotFound, RouteError } from "./routes/errors";
import { Root, ShellFallback } from "./routes/root";

/**
 * Loaders only warm the query cache (instant when it's already warm), so
 * navigation feels immediate and components render from the cache.
 */
const ensure = <T,>(options: { queryKey: readonly unknown[]; queryFn: () => Promise<T> }) => queryClient.ensureQueryData(options);

function lazy<M extends { default: React.ComponentType }>(load: () => Promise<M>, loader?: (args: LoaderFunctionArgs) => Promise<unknown>) {
  return async () => {
    const mod = await load();
    return { Component: mod.default, ...(loader ? { loader } : {}) };
  };
}

const hostId = ({ params }: LoaderFunctionArgs) => params.id as string;

/** The signed-in user; someone who isn't signed in goes to this server's sign-in. */
async function requireMe() {
  try {
    return await ensure(queries.me());
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) {
      const url = signInUrl();
      if (url?.startsWith("/app/")) throw redirect(url);
      if (url) {
        location.assign(url);
        await new Promise(() => undefined); // navigating away
      }
    }
    throw error;
  }
}

export const router = createBrowserRouter([
  { path: "/app/sign-in/*", lazy: lazy(() => import("./routes/sign-in")) },
  {
    path: "/app",
    Component: Root,
    ErrorBoundary: RouteError,
    HydrateFallback: ShellFallback,
    loader: requireMe,
    children: [
      { index: true, lazy: lazy(modules.home, () => ensure(queries.channels())) },
      { path: "new", lazy: lazy(modules.newHost) },
      {
        path: "hosts/:id",
        ErrorBoundary: RouteError,
        lazy: lazy(modules.host, (args) => ensure(queries.channel(hostId(args)))),
        children: [
          { index: true, ErrorBoundary: RouteError, lazy: lazy(modules.studio) },
          { path: "character", ErrorBoundary: RouteError, lazy: lazy(modules.character) },
          { path: "safety", ErrorBoundary: RouteError, lazy: lazy(modules.safety) },
          { path: "setup", ErrorBoundary: RouteError, lazy: lazy(modules.setup) },
          { path: "analytics", ErrorBoundary: RouteError, lazy: lazy(modules.analytics, (args) => ensure(queries.sessions(hostId(args)))) },
        ],
      },
      { path: "billing", ErrorBoundary: RouteError, lazy: lazy(modules.billing, () => ensure(queries.billing())) },
      { path: "account", ErrorBoundary: RouteError, lazy: lazy(modules.account) },
      { path: "*", Component: NotFound },
    ],
  },
  { path: "*", loader: () => redirect("/app") },
]);
