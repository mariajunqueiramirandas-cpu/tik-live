import { expect, test, type Page } from "@playwright/test";

/** Fails the test on any page error or console error (except expected network noise). */
function watchConsole(page: Page): string[] {
  const problems: string[] = [];
  page.on("pageerror", (err) => problems.push(`pageerror: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !/Failed to load resource/.test(msg.text())) problems.push(`console: ${msg.text()}`);
  });
  return problems;
}

test("the landing page is prerendered and the demo runs", async ({ page, request }) => {
  const html = await (await request.get("/")).text();
  expect(html).toContain("A host that never logs off.");
  expect(html).toContain('id="lantern-prices"');
  expect(html).not.toContain("{{price:");

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("A host that never logs off.");
  await expect(page.locator(".phone-canvas")).toHaveAttribute("data-ready", "true");
  // Scripted chat rises along the stage.
  await expect(page.locator(".chat-line").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Pricing" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("create a host, go live in practice mode, pause, resume and stop", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/app");
  await page.getByRole("link", { name: "New host" }).first().click();
  await expect(page.getByRole("heading", { name: "Create a host" })).toBeVisible();
  await page.getByRole("radio", { name: /Pip/ }).click();
  await page.getByLabel("Name").fill("E2E Pip");
  await page.getByRole("button", { name: "Create host" }).click();

  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Pip" })).toBeVisible();
  await expect(page.getByText("E2E Pip is off air")).toBeVisible();

  await page.getByRole("button", { name: "Go live" }).first().click();
  await expect(page.getByText("Live", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Games" })).toBeVisible();
  // The scripted host speaks; its lines show up in the room.
  const room = page.getByRole("log");
  await expect(room.getByText("E2E Pip", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // Kill switch: the button flips at once and the host confirms.
  await page.getByRole("button", { name: "Pause the host" }).click();
  await expect(page.getByRole("button", { name: "Resume the host" })).toBeVisible();
  await expect(page.getByText("Paused. Nothing is said until you resume.")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.getByRole("button", { name: "Pause the host" })).toBeVisible();

  // Say something as the host.
  await page.getByLabel("Say something").fill("Hello from the end-to-end test");
  await page.getByLabel("Say something").press("Enter");
  await expect(room.getByText("Hello from the end-to-end test")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Stop the host" }).click();
  await expect(page.getByRole("button", { name: "Go live" }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("the character editor autosaves and the change sticks", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByLabel("Name").fill("Editor test");
  await page.getByRole("button", { name: "Create host" }).click();
  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  const url = page.url();

  await page.getByRole("link", { name: "Character" }).click();
  await page.getByLabel("In one line").fill("a very careful test orb");
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();
  await page.getByRole("tab", { name: "Look" }).click();
  await page.getByRole("button", { name: "Ember" }).click();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  await page.getByRole("tab", { name: "Show" }).click();
  const segment = page.getByRole("listitem").filter({ has: page.getByLabel("Minigame") }).first();
  await segment.getByLabel("Minigame").selectOption("riddle");
  await segment.getByLabel("Rounds", { exact: true }).fill("3");
  await segment.getByLabel("Topic").fill("space");
  await expect(segment.getByLabel("Between rounds, the host…")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: "Saved" })).toBeVisible();

  await page.goto(`${url}/character`);
  await expect(page.getByLabel("In one line")).toHaveValue("a very careful test orb");
  await page.getByRole("tab", { name: "Show" }).click();
  const saved = page.getByRole("listitem").filter({ has: page.getByLabel("Minigame") }).first();
  await expect(saved.getByLabel("Minigame")).toHaveValue("riddle");
  await expect(saved.getByLabel("Rounds", { exact: true })).toHaveValue("3");
  await expect(saved.getByLabel("Topic")).toHaveValue("space");
});

test("the stage page renders and connects", async ({ page, request }) => {
  const created = await request.post("/api/channels", { data: { name: "Stage test" }, headers: { origin: "http://localhost:8099" } });
  expect(created.ok()).toBe(true);
  const { channel } = (await created.json()) as { channel: { stageUrl: string } };
  const problems = watchConsole(page);
  await page.setViewportSize({ width: 540, height: 960 });
  await page.goto(channel.stageUrl);
  await expect(page.locator("#stage")).toBeVisible();
  await expect(page.locator("#notice")).toBeHidden();
  const pixel = await page.evaluate(
    () =>
      new Promise<number[]>((resolve) =>
        requestAnimationFrame(() => {
          const canvas = document.getElementById("stage") as HTMLCanvasElement;
          const gl = canvas.getContext("webgl2")!;
          const out = new Uint8Array(4);
          gl.readPixels(canvas.width / 2, Math.round(canvas.height * 0.625), 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
          resolve([...out]);
        }),
      ),
  );
  // The character is drawn at the stage's upper middle: bright, not background.
  expect(pixel[0]! + pixel[1]! + pixel[2]!).toBeGreaterThan(200);
  expect(problems).toEqual([]);
});

test("unknown stage links explain themselves", async ({ request }) => {
  const res = await request.get("/s/not-a-real-key");
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain("Copy the current link from the dashboard");
});
