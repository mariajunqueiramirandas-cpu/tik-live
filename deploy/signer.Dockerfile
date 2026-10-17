# The TikTok signer: headless Chromium on TikTok's own web page (ADR-0023).
# Build from the repository root: docker build -f deploy/signer.Dockerfile .

FROM oven/bun:1.4.2-slim AS build
WORKDIR /src
COPY package.json bun.lock bunfig.toml tsconfig.base.json ./
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
COPY apps/broadcaster/package.json apps/broadcaster/
COPY apps/signer/package.json apps/signer/
COPY packages/shared/package.json packages/shared/
COPY packages/engine/package.json packages/engine/
ENV PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
RUN bun install --frozen-lockfile
COPY . .
RUN bun run --filter @tik-live/signer build

# The Playwright image ships the Chromium that playwright-core 1.64.1 expects,
# and the fonts and libraries it needs. The signer opens one page and no video.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runtime
COPY --from=oven/bun:1.4.2-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
RUN echo '{"name":"signer-runtime","private":true,"dependencies":{"playwright-core":"1.64.1"}}' > package.json \
 && bun install --production \
 && chown -R pwuser:pwuser /app
COPY --from=build --chown=pwuser:pwuser /src/apps/signer/dist/ /app/dist/
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8091
USER pwuser
EXPOSE 8091
HEALTHCHECK --interval=20s --timeout=4s --start-period=40s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8091/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "dist/index.js"]
