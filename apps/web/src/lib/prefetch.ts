import { queryClient, queries } from "./query";

/**
 * Route modules, shared by the router (lazy routes) and hover prefetching,
 * so a click on a prefetched link renders without waiting (ADR-0010).
 */
export const modules = {
  home: () => import("../routes/home"),
  newHost: () => import("../routes/new-host"),
  host: () => import("../routes/host/layout"),
  studio: () => import("../routes/host/studio"),
  character: () => import("../routes/host/character"),
  safety: () => import("../routes/host/safety"),
  setup: () => import("../routes/host/setup"),
  analytics: () => import("../routes/host/analytics"),
  billing: () => import("../routes/billing"),
  account: () => import("../routes/account"),
};

const warmed = new Set<string>();

/** Starts loading a route's code and data when the pointer or focus lands on a link to it. */
export function prefetch(path: string): void {
  if (warmed.has(path)) return;
  warmed.add(path);
  setTimeout(() => warmed.delete(path), 10_000);
  const host = /^\/app\/hosts\/([^/]+)(?:\/([a-z]+))?/.exec(path);
  if (host) {
    const [, id, tab] = host as unknown as [string, string, string | undefined];
    void modules.host();
    void queryClient.prefetchQuery(queries.channel(id));
    switch (tab) {
      case "character":
        void modules.character();
        void queryClient.prefetchQuery(queries.voices());
        break;
      case "safety":
        void modules.safety();
        break;
      case "setup":
        void modules.setup();
        break;
      case "analytics":
        void modules.analytics();
        void queryClient.prefetchQuery(queries.sessions(id));
        break;
      default:
        void modules.studio();
    }
    return;
  }
  if (path === "/app") {
    void modules.home();
    void queryClient.prefetchQuery(queries.channels());
  } else if (path === "/app/new") void modules.newHost();
  else if (path === "/app/billing") {
    void modules.billing();
    void queryClient.prefetchQuery(queries.billing());
  } else if (path === "/app/account") void modules.account();
}

/** Props that prefetch a destination on hover and keyboard focus. */
export function prefetchProps(path: string) {
  return { onPointerEnter: () => prefetch(path), onFocus: () => prefetch(path) };
}
