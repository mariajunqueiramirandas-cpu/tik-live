import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gunzipSync, gzipSync } from "node:zlib";
import { pickEncoding } from "../../src/http/encoding";
import { startTestServer, type TestServer } from "../harness";

describe("pickEncoding", () => {
  it("prefers Brotli, honors q-values and wildcards, and refuses q=0", () => {
    expect(pickEncoding("gzip, deflate, br, zstd")).toBe("br");
    expect(pickEncoding("gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0, gzip")).toBe("gzip");
    expect(pickEncoding("br;q=0.5, gzip;q=0.8")).toBe("gzip");
    expect(pickEncoding("*")).toBe("br");
    expect(pickEncoding("identity")).toBeNull();
    expect(pickEncoding(undefined)).toBeNull();
    expect(pickEncoding("gzip, br", ["gzip"])).toBe("gzip");
  });
});

/**
 * The app compresses on its own, because Traefik (Dokploy) doesn't:
 * precompressed build assets, HTML rendered at startup, and API JSON.
 */
describe("response compression", () => {
  let dist: string;
  let server: TestServer;
  const script = `console.log(${JSON.stringify("lantern ".repeat(400))});`;

  // Bun's fetch decompresses by default; these tests look at the raw bytes.
  const raw = (pathname: string, acceptEncoding?: string) =>
    fetch(`${server.base}${pathname}`, { headers: acceptEncoding ? { "accept-encoding": acceptEncoding } : {}, decompress: false });

  beforeAll(async () => {
    dist = mkdtempSync(path.join(tmpdir(), "lantern-dist-"));
    mkdirSync(path.join(dist, "assets"));
    const filler = `<p>${"Lantern hosts your TikTok LIVE. ".repeat(80)}</p>`;
    writeFileSync(path.join(dist, "index.html"), `<!doctype html><html><head><title>app</title></head><body>${filler}</body></html>`);
    writeFileSync(path.join(dist, "landing.html"), `<!doctype html><html><head><!--lantern:head--></head><body>{{price:creator}}${filler}</body></html>`);
    writeFileSync(path.join(dist, "stage.html"), "<!doctype html><title>stage</title>");
    writeFileSync(path.join(dist, "assets", "app-abc123.js"), script);
    writeFileSync(path.join(dist, "assets", "app-abc123.js.br"), brotliCompressSync(script));
    writeFileSync(path.join(dist, "assets", "app-abc123.js.gz"), gzipSync(script));
    writeFileSync(path.join(dist, "assets", "small-abc123.js"), "console.log(1)");
    server = await startTestServer({ env: { WEB_DIST: dist } });
  });
  afterAll(async () => {
    await server.close();
    rmSync(dist, { recursive: true, force: true });
  });

  it("sends the precompressed copy the browser prefers", async () => {
    const br = await raw("/assets/app-abc123.js", "gzip, deflate, br");
    expect(br.headers.get("content-encoding")).toBe("br");
    expect(br.headers.get("vary")).toBe("Accept-Encoding");
    expect(br.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect(br.headers.get("cache-control")).toContain("immutable");
    expect(brotliDecompressSync(new Uint8Array(await br.arrayBuffer())).toString()).toBe(script);

    const gz = await raw("/assets/app-abc123.js", "gzip");
    expect(gz.headers.get("content-encoding")).toBe("gzip");
    expect(gunzipSync(new Uint8Array(await gz.arrayBuffer())).toString()).toBe(script);

    const plain = await raw("/assets/app-abc123.js");
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(plain.headers.get("vary")).toBe("Accept-Encoding");
    expect(await plain.text()).toBe(script);
  });

  it("sends files without compressed copies as they are", async () => {
    const res = await raw("/assets/small-abc123.js", "br, gzip");
    expect(res.headers.get("content-encoding")).toBeNull();
    expect(res.headers.get("vary")).toBeNull();
    expect(await res.text()).toBe("console.log(1)");
  });

  it("compresses the landing page and dashboard HTML after filling them in", async () => {
    const landing = await raw("/", "br");
    expect(landing.headers.get("content-encoding")).toBe("br");
    expect(landing.headers.get("content-type")).toContain("text/html");
    expect(landing.headers.get("content-security-policy")).toBeTruthy();
    const html = brotliDecompressSync(new Uint8Array(await landing.arrayBuffer())).toString();
    expect(html).toContain("R$");
    expect(html).toContain('id="lantern-prices"');

    const dashboard = await raw("/app/new", "gzip");
    expect(dashboard.headers.get("content-encoding")).toBe("gzip");
    expect(dashboard.headers.get("cache-control")).toBe("no-cache");
    expect(gunzipSync(new Uint8Array(await dashboard.arrayBuffer())).toString()).toContain('id="lantern-config"');

    const identity = await raw("/app/new");
    expect(identity.headers.get("content-encoding")).toBeNull();
    expect(await identity.text()).toContain('id="lantern-config"');
  });

  it("compresses API JSON over 1 KB", async () => {
    for (let i = 0; i < 2; i++) await server.json("/api/channels", { method: "POST", user: "big", json: { name: `Host ${i}` } });
    const res = await fetch(`${server.base}/api/channels`, { headers: { "accept-encoding": "gzip, br", "x-dev-user": "big" }, decompress: false });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-encoding")).toBe("gzip");
    const body = JSON.parse(gunzipSync(new Uint8Array(await res.arrayBuffer())).toString()) as { channels: unknown[] };
    expect(body.channels).toHaveLength(2);

    const plain = await fetch(`${server.base}/api/channels`, { headers: { "x-dev-user": "big" }, decompress: false });
    expect(plain.headers.get("content-encoding")).toBeNull();
    expect(((await plain.json()) as { channels: unknown[] }).channels).toHaveLength(2);
  });
});
