/**
 * Writes Brotli (.br) and gzip (.gz) copies of the built text assets, so the
 * server can send compressed files without compressing per request and
 * without relying on the reverse proxy (Traefik under Dokploy doesn't
 * compress; Caddy does). Runs after prerender.
 */
import path from "node:path";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { Glob } from "bun";

const dist = path.resolve(import.meta.dir, "../dist");
const COMPRESSIBLE = new Set([".js", ".css", ".html", ".svg", ".json", ".txt", ".webmanifest"]);
const MIN_BYTES = 1024;

let files = 0;
let before = 0;
let after = 0;
for await (const relative of new Glob("**/*").scan({ cwd: dist, dot: false })) {
  if (!COMPRESSIBLE.has(path.extname(relative))) continue;
  const full = path.join(dist, relative);
  const data = new Uint8Array(await Bun.file(full).arrayBuffer());
  if (data.length < MIN_BYTES) continue;
  const br = brotliCompressSync(data, {
    params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: data.length },
  });
  const gz = gzipSync(data, { level: 9 });
  // Only keep a copy that actually saves bytes.
  if (br.length < data.length * 0.9) await Bun.write(`${full}.br`, br);
  if (gz.length < data.length * 0.9) await Bun.write(`${full}.gz`, gz);
  files += 1;
  before += data.length;
  after += br.length;
}
console.log(`ok   Precompressed ${files} files: ${(before / 1024).toFixed(0)} KB → ${(after / 1024).toFixed(0)} KB with Brotli`);
