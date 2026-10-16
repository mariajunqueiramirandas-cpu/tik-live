import type { AppConfig } from "./types";
import { api, call } from "./api";
import { keys, queryClient } from "./query";

/**
 * The server inlines its public config into the dashboard HTML (production);
 * the Vite dev server doesn't, so fetch it there. Either way it ends up in
 * the query cache so `useConfig()` never waits.
 */
export async function loadAppConfig(): Promise<AppConfig> {
  const inline = document.getElementById("lantern-config")?.textContent;
  let config: AppConfig | null = null;
  if (inline) {
    try {
      config = JSON.parse(inline) as AppConfig;
    } catch {
      config = null;
    }
  }
  config ??= await call(api.api.config.$get());
  queryClient.setQueryData(keys.config, config);
  return config;
}

export function appConfig(): AppConfig | undefined {
  return queryClient.getQueryData<AppConfig>(keys.config);
}

/** Sends someone who isn't signed in to the right place for this server's sign-in. */
export function signInUrl(returnTo = location.pathname + location.search): string | null {
  const config = appConfig();
  if (!config?.signInPath) return null;
  return `${config.signInPath}?returnTo=${encodeURIComponent(returnTo)}`;
}
