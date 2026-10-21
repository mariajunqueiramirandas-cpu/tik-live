import { readFile, writeFile } from "node:fs/promises";
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
  expect(html).toContain("Um apresentador que nunca sai do ar.");
  expect(html).toContain('id="lantern-prices"');
  expect(html).not.toContain("{{price:");

  const problems = watchConsole(page);
  await page.goto("/");
  await expect(page.getByRole("heading", { level: 1 })).toHaveText("Um apresentador que nunca sai do ar.");
  await expect(page.locator(".phone-canvas")).toHaveAttribute("data-ready", "true");
  // Scripted chat rises along the stage.
  await expect(page.locator(".chat-line").first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Preços" })).toBeVisible();
  expect(problems).toEqual([]);
});

test("create a host, go live in practice mode, pause, resume and stop", async ({ page }) => {
  const problems = watchConsole(page);
  await page.goto("/app");
  await page.getByRole("link", { name: "Novo apresentador" }).first().click();
  await expect(page.getByRole("heading", { name: "Criar apresentador" })).toBeVisible();
  await page.getByRole("radio", { name: /Pip/ }).click();
  await page.getByLabel("Nome").fill("E2E Pip");
  await page.getByRole("button", { name: "Criar apresentador" }).click();

  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  await expect(page.getByRole("heading", { level: 1, name: "E2E Pip" })).toBeVisible();
  await expect(page.getByText("E2E Pip está fora do ar")).toBeVisible();

  await page.getByRole("button", { name: "Entrar ao vivo" }).first().click();
  await expect(page.getByText("Ao vivo", { exact: true }).first()).toBeVisible();
  await expect(page.getByRole("heading", { name: "Jogos" })).toBeVisible();
  // The scripted host speaks; its lines show up in the room.
  const room = page.getByRole("log");
  await expect(room.getByText("E2E Pip", { exact: true }).first()).toBeVisible({ timeout: 20_000 });

  // Kill switch: the button flips at once and the host confirms.
  await page.getByRole("button", { name: "Pausar o apresentador" }).click();
  await expect(page.getByRole("button", { name: "Retomar o apresentador" })).toBeVisible();
  await expect(page.getByText("Pausado. Nada é dito até você retomar.")).toBeVisible();
  await page.keyboard.press("p");
  await expect(page.getByRole("button", { name: "Pausar o apresentador" })).toBeVisible();

  // Say something as the host.
  await page.getByLabel("Falar algo").fill("Olá do teste de ponta a ponta");
  await page.getByLabel("Falar algo").press("Enter");
  await expect(room.getByText("Olá do teste de ponta a ponta")).toBeVisible({ timeout: 20_000 });

  await page.getByRole("button", { name: "Parar o apresentador" }).click();
  await expect(page.getByRole("button", { name: "Entrar ao vivo" }).first()).toBeVisible();
  expect(problems).toEqual([]);
});

test("the character editor autosaves and the change sticks", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByLabel("Nome").fill("Teste do editor");
  await page.getByRole("button", { name: "Criar apresentador" }).click();
  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  const url = page.url();

  await page.getByRole("link", { name: "Personagem" }).click();
  await page.getByLabel("Em uma frase").fill("uma bolinha de teste bem cuidadosa");
  await expect(page.getByRole("status").filter({ hasText: /^Salvo$/ })).toBeVisible();
  await page.getByRole("tab", { name: "Visual" }).click();
  await page.getByRole("button", { name: "Brasa" }).click();
  await expect(page.getByRole("status").filter({ hasText: /^Salvo$/ })).toBeVisible();

  await page.getByRole("tab", { name: "Roteiro" }).click();
  const segment = page.getByRole("listitem").filter({ has: page.getByLabel("Minijogo") }).first();
  await segment.getByLabel("Minijogo").selectOption("riddle");
  await segment.getByLabel("Rodadas", { exact: true }).fill("3");
  await segment.getByLabel("Tema").fill("espaço");
  await expect(segment.getByLabel("Entre as rodadas, o apresentador…")).toBeVisible();
  await expect(page.getByRole("status").filter({ hasText: /^Salvo$/ })).toBeVisible();

  // Validation messages come from the shared pt-BR error map for zod. The production bundle
  // once dropped that module (it's only a side effect), and forms fell back to English.
  const minutes = segment.getByLabel("Minutos");
  const before = await minutes.inputValue();
  await minutes.fill("500");
  await expect(segment.getByText("Use um número até 120.")).toBeVisible();
  await minutes.fill(before);
  await expect(segment.getByText("Use um número até 120.")).toHaveCount(0);

  await page.goto(`${url}/character`);
  await expect(page.getByLabel("Em uma frase")).toHaveValue("uma bolinha de teste bem cuidadosa");
  await page.getByRole("tab", { name: "Roteiro" }).click();
  const saved = page.getByRole("listitem").filter({ has: page.getByLabel("Minijogo") }).first();
  await expect(saved.getByLabel("Minijogo")).toHaveValue("riddle");
  await expect(saved.getByLabel("Rodadas", { exact: true })).toHaveValue("3");
  await expect(saved.getByLabel("Tema")).toHaveValue("espaço");
});

test("the character's profile picture downloads as a square PNG of the orb", async ({ page }) => {
  await page.goto("/app/new");
  await page.getByLabel("Nome").fill("Foto da Lua");
  await page.getByRole("button", { name: "Criar apresentador" }).click();
  await expect(page).toHaveURL(/\/app\/hosts\/[^/]+$/);
  await page.getByRole("link", { name: "Personagem" }).click();
  await page.getByRole("tab", { name: "Visual" }).click();

  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Baixar foto de perfil" }).click()]);
  // Named after the character (the preset's, here), not the channel.
  expect(download.suggestedFilename()).toMatch(/^[a-z0-9-]+-foto-de-perfil\.png$/);
  const png = await readFile((await download.path()) as string);
  if (process.env.PORTRAIT_OUT) await writeFile(process.env.PORTRAIT_OUT, png);
  // PNG signature, then the IHDR chunk's width and height.
  expect(png.subarray(1, 4).toString()).toBe("PNG");
  expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([1080, 1080]);

  // The orb fills the middle (bright); the corners are the water (dark).
  const { center, corner } = await page.evaluate(async (bytes) => {
    const bitmap = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    const ctx = canvas.getContext("2d") as OffscreenCanvasRenderingContext2D;
    ctx.drawImage(bitmap, 0, 0);
    const sum = (x: number, y: number) => [...ctx.getImageData(x, y, 1, 1).data.slice(0, 3)].reduce((a, b) => a + b, 0);
    return { center: sum(400, 380), corner: sum(10, 10) };
  }, [...png]);
  expect(center).toBeGreaterThan(450);
  expect(corner).toBeLessThan(200);

  // A voice-only host has no character to picture.
  await page.getByRole("radio", { name: "Só voz" }).click();
  await expect(page.getByRole("button", { name: "Baixar foto de perfil" })).toHaveCount(0);
});

test("the stage page renders and connects", async ({ page, request }) => {
  const created = await request.post("/api/channels", { data: { name: "Teste do palco" }, headers: { origin: "http://localhost:8099" } });
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

test("the studio reloads the stage in OBS", async ({ page, context, request }) => {
  const created = await request.post("/api/channels", { data: { name: "Recarregar" }, headers: { origin: "http://localhost:8099" } });
  const { channel } = (await created.json()) as { channel: { id: string; stageUrl: string } };
  const stage = await context.newPage();
  await stage.goto(channel.stageUrl);
  await expect(stage.locator("#stage")).toBeVisible();

  await page.goto(`/app/hosts/${channel.id}`);
  const reload = page.getByRole("button", { name: "Recarregar palco no OBS" });
  await expect(reload).toBeEnabled();
  const reloaded = stage.waitForEvent("load");
  await reload.click();
  await expect(page.getByText("Palco recarregado no OBS")).toBeVisible();
  await reloaded;
  await expect(stage.locator("#stage")).toBeVisible();
  await stage.close();
});

test("unknown stage links explain themselves", async ({ request }) => {
  const res = await request.get("/s/not-a-real-key");
  expect(res.status()).toBe(404);
  expect(await res.text()).toContain("Copie o link atual no painel");
});
