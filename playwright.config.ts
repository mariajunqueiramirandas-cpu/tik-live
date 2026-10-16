import { defineConfig, devices } from "@playwright/test";

/**
 * End-to-end tests (ADR-0017): the production web build served by the real
 * server (PGlite, scripted host, no paid providers), plus the engine lab on
 * the Vite dev server for rendering checks.
 */
const APP = "http://localhost:8099";
const LAB = "http://localhost:5199";

// Never reach paid providers from tests, whatever the developer's shell has.
const offline = {
  ANTHROPIC_API_KEY: "",
  ELEVENLABS_API_KEY: "",
  MP_ACCESS_TOKEN: "",
  MP_PLATFORM_ACCESS_TOKEN: "",
  MP_WEBHOOK_SECRET: "",
};

export default defineConfig({
  testDir: "e2e",
  testMatch: "**/*.e2e.ts",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["github"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: APP,
    trace: "retain-on-failure",
    ...devices["Desktop Chrome"],
    launchOptions: {
      args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist", "--autoplay-policy=no-user-gesture-required"],
      ...(process.env.PW_CHROMIUM_PATH ? { executablePath: process.env.PW_CHROMIUM_PATH } : {}),
    },
  },
  webServer: [
    {
      command: "bun apps/server/src/index.ts",
      url: `${APP}/readyz`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        ...offline,
        NODE_ENV: "development",
        PORT: "8099",
        PUBLIC_URL: APP,
        DATABASE_URL: "pglite://memory",
        WEB_DIST: "apps/web/dist",
        LOG_LEVEL: "warn",
      },
    },
    {
      command: "bunx vite --port 5199 --strictPort",
      cwd: "apps/web",
      url: `${LAB}/lab.html`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: { API_ORIGIN: APP },
    },
  ],
});
