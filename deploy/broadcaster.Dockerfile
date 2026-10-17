# The cloud broadcaster: headless Chrome + ffmpeg (ADR-0014, ADR-0020).
# Build from the repository root: docker build -f deploy/broadcaster.Dockerfile .

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
RUN bun run --filter @tik-live/broadcaster build

# The Playwright image ships the fonts the stage needs (color emoji for viewer
# names included) and Mesa's llvmpipe, which renders WebGL with AVX2 code.
# Google Chrome is added for its H.264 encoder: the stage encodes video in
# the page, which saves about a core per broadcast (ADR-0020). Without it,
# the bundled Chromium works too, sending raw frames to x264.
FROM mcr.microsoft.com/playwright:v1.64.1-noble AS runtime
ARG CHROME_DEB=https://dl.google.com/linux/direct/google-chrome-stable_current_amd64.deb
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg mesa-vulkan-drivers curl ca-certificates \
 && curl -fsSL "$CHROME_DEB" -o /tmp/chrome.deb \
 && apt-get install -y --no-install-recommends /tmp/chrome.deb \
 && rm -f /tmp/chrome.deb \
 && rm -rf /var/lib/apt/lists/*
COPY --from=oven/bun:1.4.2-slim /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /app
RUN echo '{"name":"broadcaster-runtime","private":true,"dependencies":{"playwright-core":"1.64.1"}}' > package.json \
 && bun install --production \
 && chown -R pwuser:pwuser /app
COPY --from=build --chown=pwuser:pwuser /src/apps/broadcaster/dist/ /app/dist/
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=8090 \
    FFMPEG_PATH=/usr/bin/ffmpeg \
    CHROMIUM_PATH=/opt/google/chrome/chrome
USER pwuser
EXPOSE 8090
HEALTHCHECK --interval=20s --timeout=4s --start-period=20s --retries=3 \
  CMD ["bun", "-e", "fetch('http://127.0.0.1:8090/healthz').then(r => process.exit(r.ok ? 0 : 1), () => process.exit(1))"]
CMD ["bun", "dist/index.js"]
