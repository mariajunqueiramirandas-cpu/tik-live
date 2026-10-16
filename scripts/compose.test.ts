import { describe, expect, it } from "bun:test";
import path from "node:path";

/**
 * The two deployments (deploy/compose.yaml with Caddy, compose.dokploy.yaml
 * behind Dokploy's Traefik) must run the same app, and the Dokploy file must
 * respect Dokploy's rules (ADR-0019).
 */
interface Service {
  image?: string;
  build?: { context: string; dockerfile?: string };
  environment?: Record<string, string>;
  ports?: unknown[];
  expose?: string[];
  volumes?: string[];
  networks?: string[] | Record<string, { aliases?: string[] } | null>;
  command?: string[];
  healthcheck?: unknown;
  deploy?: unknown;
  profiles?: string[];
}
interface Compose {
  services: Record<string, Service>;
  networks?: Record<string, { internal?: boolean } | null>;
}

const root = path.resolve(import.meta.dir, "..");
const load = async (file: string) => Bun.YAML.parse(await Bun.file(path.join(root, file)).text()) as Compose;
const vps = await load("deploy/compose.yaml");
const dokploy = await load("compose.dokploy.yaml");
const keys = (record: Record<string, unknown> | undefined) => Object.keys(record ?? {}).sort();

const envKeys = async (file: string) =>
  [...(await Bun.file(path.join(root, file)).text()).matchAll(/^#?\s?([A-Z][A-Z0-9_]+)=/gm)].map((m) => m[1] as string).sort();

function aliases(service: Service, network: string): string[] {
  const networks = service.networks;
  if (!networks || Array.isArray(networks)) return [];
  return networks[network]?.aliases ?? [];
}

describe("compose.dokploy.yaml", () => {
  it("leaves 80/443 to Dokploy's Traefik: no Caddy, no published ports", () => {
    expect(dokploy.services.caddy).toBeUndefined();
    for (const [name, service] of Object.entries(dokploy.services)) expect({ name, ports: service.ports }).toEqual({ name, ports: undefined });
    expect(dokploy.services.app?.expose).toEqual(["8080"]);
  });

  it("keeps data in named volumes, never in the checkout Dokploy re-clones", () => {
    for (const [name, service] of Object.entries(dokploy.services)) {
      for (const volume of service.volumes ?? []) {
        const source = volume.split(":")[0] as string;
        expect({ name, source, named: /^[a-z][a-z0-9_-]*$/.test(source) }).toEqual({ name, source, named: true });
      }
    }
  });

  it("reaches other services only through lantern-* aliases on the internal network", () => {
    expect(dokploy.networks?.internal?.internal).toBe(true);
    const declared = new Set(Object.values(dokploy.services).flatMap((s) => aliases(s, "internal")));
    expect([...declared].sort()).toEqual(["lantern-app", "lantern-broadcaster", "lantern-db", "lantern-tts"]);
    const app = dokploy.services.app?.environment ?? {};
    const hosts = [
      new URL((app.DATABASE_URL as string).replace(/\$\{[^}]+\}/g, "x")).hostname,
      new URL(app.BROADCASTER_URL as string).hostname,
      new URL(app.BROADCAST_STAGE_ORIGIN as string).hostname,
      new URL(app.POCKET_TTS_URL as string).hostname,
      new URL(dokploy.services.broadcaster?.environment?.STAGE_ORIGINS as string).hostname,
      dokploy.services.backup?.environment?.PGHOST as string,
    ];
    for (const host of hosts) expect(declared.has(host)).toBe(true);
  });

  it("trusts the proxy's X-Forwarded-For and serves HTTPS URLs", () => {
    const app = dokploy.services.app?.environment ?? {};
    expect(app.TRUST_PROXY).toBe("true");
    expect(app.PUBLIC_URL).toStartWith("https://");
  });
});

describe("the two deployments run the same app", () => {
  it("passes the same settings to every service", () => {
    for (const name of ["app", "db", "backup", "broadcaster", "tts"]) {
      expect({ name, env: keys(dokploy.services[name]?.environment) }).toEqual({ name, env: keys(vps.services[name]?.environment) });
    }
  });

  it("builds the same images and runs the database and broadcaster the same way", () => {
    for (const name of ["app", "broadcaster"]) {
      expect(dokploy.services[name]?.image).toBe(vps.services[name]?.image as string);
      expect(dokploy.services[name]?.build?.dockerfile).toBe(vps.services[name]?.build?.dockerfile as string);
    }
    for (const field of ["image", "command", "healthcheck"] as const) expect(dokploy.services.db?.[field]).toEqual(vps.services.db?.[field]);
    expect(dokploy.services.broadcaster?.deploy).toEqual(vps.services.broadcaster?.deploy);
    expect(dokploy.services.broadcaster?.profiles).toEqual(["broadcast"]);
    expect(dokploy.services.tts?.image).toBe(vps.services.tts?.image as string);
    for (const field of ["healthcheck", "deploy", "profiles"] as const) expect(dokploy.services.tts?.[field]).toEqual(vps.services.tts?.[field]);
    expect(aliases(vps.services.tts as Service, "internal")).toEqual(["lantern-tts"]);
  });

  it("documents the same variables in both env examples", async () => {
    const forDokploy = (await envKeys("deploy/dokploy.env.example")).filter((key) => key !== "COMPOSE_PROFILES");
    expect(forDokploy).toEqual(await envKeys("deploy/.env.example"));
  });
});
