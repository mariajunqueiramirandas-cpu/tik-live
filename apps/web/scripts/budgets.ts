/**
 * Bundle budgets (ADR-0009, ADR-0010), checked after every build:
 * - stage page (engine + stage entry): under 60 KB gzipped;
 * - dashboard first load (entry + its static imports): under 200 KB gzipped;
 * - landing first load, before the engine chunk: under 120 KB gzipped.
 */
import path from "node:path";
import { gzipSync } from "node:zlib";

interface Chunk {
  file: string;
  imports?: string[];
  css?: string[];
  isEntry?: boolean;
  src?: string;
}

const dist = path.resolve(import.meta.dir, "../dist");
const manifest = (await Bun.file(path.join(dist, ".vite/manifest.json")).json()) as Record<string, Chunk>;

async function gz(file: string): Promise<number> {
  return gzipSync(new Uint8Array(await Bun.file(path.join(dist, file)).arrayBuffer()), { level: 9 }).length;
}

/** Entry chunk plus everything it imports statically (what loads before first paint). */
async function closure(key: string): Promise<number> {
  const seen = new Set<string>();
  const files = new Set<string>();
  const walk = (k: string) => {
    if (seen.has(k)) return;
    seen.add(k);
    const chunk = manifest[k];
    if (!chunk) return;
    files.add(chunk.file);
    for (const css of chunk.css ?? []) files.add(css);
    for (const dep of chunk.imports ?? []) walk(dep);
  };
  walk(key);
  let total = 0;
  for (const f of files) total += await gz(f);
  return total;
}

const budgets: Array<{ name: string; entry: string; limitKb: number }> = [
  { name: "Stage page", entry: "stage.html", limitKb: 60 },
  { name: "Dashboard first load", entry: "index.html", limitKb: 200 },
  { name: "Landing first load", entry: "landing.html", limitKb: 120 },
];

let failed = false;
for (const budget of budgets) {
  const size = (await closure(budget.entry)) / 1024;
  const ok = size <= budget.limitKb;
  failed ||= !ok;
  console.log(`${ok ? "ok  " : "OVER"} ${budget.name}: ${size.toFixed(1)} KB gzipped (budget ${budget.limitKb} KB)`);
}
if (failed) {
  console.error("A bundle budget was exceeded.");
  process.exit(1);
}
