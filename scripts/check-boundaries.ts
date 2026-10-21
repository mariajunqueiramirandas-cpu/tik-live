/**
 * Import boundaries between workspaces (ADR-0004). Fails with the offending
 * file and import when a package reaches somewhere it shouldn't:
 * - packages never import apps; the engine only uses shared;
 * - the web app may use server code for types only (the RPC AppType);
 * - the server, web app, broadcaster and bridge never import each other's code.
 */
import { Glob } from "bun";

type Rule = { from: string; deny: RegExp; unlessTypeOnly?: boolean; why: string };

const RULES: Rule[] = [
  { from: "packages/shared/", deny: /^@tik-live\/(?!shared$)/, why: "shared depends on nothing else in the repo" },
  { from: "packages/engine/", deny: /^@tik-live\/(?!shared$)/, why: "the engine only depends on shared" },
  { from: "packages/", deny: /^(\.\.\/)+apps\//, why: "packages never import apps" },
  { from: "apps/web/", deny: /^@tik-live\/(server|broadcaster|bridge)(\/|$)/, unlessTypeOnly: true, why: "the web app uses server code for types only" },
  { from: "apps/server/", deny: /^@tik-live\/(web|engine|broadcaster|bridge)(\/|$)/, why: "the server doesn't import the web app, engine, broadcaster or bridge" },
  { from: "apps/broadcaster/", deny: /^@tik-live\/(server|web|engine|bridge)(\/|$)/, why: "the broadcaster talks to the app over HTTP only" },
  { from: "apps/bridge/", deny: /^@tik-live\/(server|web|engine|broadcaster)(\/|$)/, why: "the local bridge agent talks to the app over WebSocket only" },
];

const IMPORT = /(?:^|\n)\s*(import|export)\s+(type\s+)?[^;'"]*?\bfrom\s+["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;

const problems: string[] = [];
for (const pattern of ["apps/*/src/**/*.{ts,tsx}", "apps/*/test/**/*.ts", "packages/*/src/**/*.ts", "packages/*/test/**/*.ts", "apps/web/scripts/**/*.{ts,tsx}"]) {
  for await (const file of new Glob(pattern).scan(".")) {
    const text = await Bun.file(file).text();
    for (const match of text.matchAll(IMPORT)) {
      const typeOnly = Boolean(match[2]);
      const target = match[3] ?? match[4] ?? "";
      for (const rule of RULES) {
        if (!file.startsWith(rule.from) || !rule.deny.test(target)) continue;
        if (rule.unlessTypeOnly && typeOnly && match[4] === undefined) continue;
        problems.push(`${file}: imports "${target}" (${rule.why})`);
      }
    }
  }
}

if (problems.length) {
  console.error(`Import boundary violations:\n${problems.map((p) => `  ${p}`).join("\n")}`);
  process.exit(1);
}
console.log("ok   import boundaries");
