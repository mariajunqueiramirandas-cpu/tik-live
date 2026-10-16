import { brotliCompressSync, constants, gzipSync } from "node:zlib";

/**
 * Response compression that doesn't depend on the reverse proxy: Caddy
 * compresses, Traefik (Dokploy) doesn't. Built assets come with .br/.gz
 * copies from the web build; HTML rendered at startup is compressed once.
 */
export type Encoding = "br" | "gzip";

/** The best encoding the client accepts, among those available. */
export function pickEncoding(acceptEncoding: string | undefined, available: readonly Encoding[] = ["br", "gzip"]): Encoding | null {
  if (!acceptEncoding) return null;
  const weights = new Map<string, number>();
  for (const part of acceptEncoding.toLowerCase().split(",")) {
    const [name, ...params] = part.trim().split(";");
    if (!name) continue;
    const q = params.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const weight = q ? Number(q.slice(2)) : 1;
    weights.set(name, Number.isFinite(weight) ? weight : 0);
  }
  let best: Encoding | null = null;
  let bestWeight = 0;
  for (const encoding of available) {
    const weight = weights.get(encoding) ?? weights.get("*") ?? 0;
    if (weight > bestWeight) {
      best = encoding;
      bestWeight = weight;
    }
  }
  return best;
}

/** A body kept in identity, Brotli and gzip forms. */
export interface CompressedBody {
  identity: Uint8Array<ArrayBuffer>;
  br: Uint8Array<ArrayBuffer>;
  gzip: Uint8Array<ArrayBuffer>;
}

/** Copies into a buffer of its own (zlib returns views into a shared pool). */
function owned(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(new ArrayBuffer(bytes.length));
  out.set(bytes);
  return out;
}

export function compressBody(text: string): CompressedBody {
  const identity = owned(new TextEncoder().encode(text));
  return {
    identity,
    br: owned(brotliCompressSync(identity, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })),
    gzip: owned(gzipSync(identity, { level: 9 })),
  };
}
