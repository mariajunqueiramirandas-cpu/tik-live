# The Lantern app: API, realtime, channel runtimes and the built web app (ADR-0015).
# Build from the repository root: docker build -f deploy/app.Dockerfile .

FROM oven/bun:1.4.2-slim AS deps
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/broadcaster/package.json apps/broadcaster/
COPY apps/bridge/package.json apps/bridge/
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile

FROM deps AS build
COPY . .
# Vite builds the dashboard, stage page and prerendered landing page (and
# checks bundle budgets); Bun bundles the server into one file and
# cross-compiles the Windows Local Bridge Agent the dashboard hands out
# (ADR-0047; fetches Bun's Windows runtime, so the build needs network).
RUN bun run --filter @tik-live/web build && bun run --filter @tik-live/server build && bun run --filter @tik-live/bridge build

FROM oven/bun:1.4.2-slim AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8080 \
    WEB_DIST=/app/web \
    BRIDGE_EXE_PATH=/app/bridge/lantern-bridge.exe
WORKDIR /app
COPY --from=build /src/apps/server/dist/ /app/server/dist/
COPY --from=build /src/apps/server/drizzle/ /app/server/drizzle/
COPY --from=build /src/apps/web/dist/ /app/web/
COPY --from=build /src/apps/bridge/dist/lantern-bridge.exe /app/bridge/lantern-bridge.exe
USER bun
EXPOSE 8080
HEALTHCHECK --interval=15s --timeout=4s --start-period=30s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8080/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "server/dist/index.js"]
