import react from "@vitejs/plugin-react";
import { resolve } from "node:path";
import { defineConfig, type Plugin } from "vite";

const API = process.env.API_ORIGIN ?? "http://127.0.0.1:8080";

/**
 * Dev-server routing that mirrors production (apps/server/src/http/static.ts):
 * `/` is the landing page, `/s/:key` the stage page, `/app/*` the dashboard.
 */
function pages(): Plugin {
  return {
    name: "lantern-pages",
    configureServer(server) {
      server.middlewares.use((req, _res, next) => {
        const url = req.url ?? "/";
        const path = url.split("?")[0] ?? "/";
        const query = url.includes("?") ? url.slice(url.indexOf("?")) : "";
        if (path === "/") req.url = `/landing.html${query}`;
        else if (path.startsWith("/s/")) req.url = `/stage.html${query}`;
        else if (path === "/app" || path.startsWith("/app/")) req.url = `/index.html${query}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), pages()],
  appType: "mpa",
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: API, changeOrigin: false },
      "/ws": { target: API, ws: true, changeOrigin: false },
      "/healthz": { target: API },
    },
  },
  build: {
    target: "es2022",
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: true,
    assetsInlineLimit: 0,
    rolldownOptions: {
      input: {
        app: resolve(import.meta.dirname, "index.html"),
        stage: resolve(import.meta.dirname, "stage.html"),
        landing: resolve(import.meta.dirname, "landing.html"),
      },
    },
  },
});
