import { expect, test, type Page } from "@playwright/test";

/**
 * Rendering checks for the stage engine (ADR-0009) against the lab page,
 * with a manual clock so frames are deterministic. Pixel probes instead of
 * baseline images keep the checks stable across GPUs and font hinting.
 */
const LAB = "http://localhost:5199/lab.html?clock=manual";

type Rgba = [number, number, number, number];

async function probe(page: Page, x: number, y: number): Promise<Rgba> {
  // Stage coordinates (1080x1920, y down) to canvas pixels (y up).
  return page.evaluate(
    ([sx, sy]) => {
      const canvas = document.getElementById("stage") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2")!;
      const px = Math.round((sx / 1080) * canvas.width);
      const py = canvas.height - 1 - Math.round((sy / 1920) * canvas.height);
      const out = new Uint8Array(4);
      gl.readPixels(px, py, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, out);
      return [...out] as Rgba;
    },
    [x, y] as const,
  );
}

const brightness = ([r, g, b]: Rgba) => r + g + b;

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 960 });
  await page.goto(LAB);
  await page.evaluate(() => (window as any).__lab.fontsReady());
});

test("every emotion renders a face on the orb", async ({ page }) => {
  const emotions: string[] = await page.evaluate(() => [...(window as any).__lab.emotions]);
  let t = 1;
  for (const emotion of emotions) {
    t += 3;
    await page.evaluate(([e, time]) => {
      (window as any).__lab.emotion(e);
      (window as any).__lab.frame(time);
    }, [emotion, t] as const);
    // Above the eyes and below the brows: always inside the body, whatever the bob.
    const body = await probe(page, 540, 625);
    expect(brightness(body), `${emotion}: orb body is lit`).toBeGreaterThan(300);
    const telemetry = await page.evaluate(() => (window as any).__lab.telemetry());
    expect(telemetry.error).toBeNull();
  }
});

test("captions and alerts appear when the host speaks and gifts arrive", async ({ page }) => {
  await page.evaluate(() => {
    const lab = (window as any).__lab;
    lab.apply({ t: "speak", id: "c1", text: "Thank you for the roses, everyone in chat!", emotion: "happy", audioUrl: null, durationMs: 3000 });
    lab.apply({ t: "alert", kind: "gift", name: "maria", giftName: "Rose", count: 5, diamonds: 5 });
  });
  // The reveal starts once playback begins (a microtask later), so render separately.
  await page.evaluate(() => (window as any).__lab.frame(2.5));
  // Caption text sits below the orb; the gift alert at the upper right.
  let lit = 0;
  for (let x = 140; x <= 940; x += 20) if (brightness(await probe(page, x, 1110)) > 450) lit++;
  expect(lit, "caption pixels").toBeGreaterThan(2);
  let gold = 0;
  for (let x = 700; x <= 1010; x += 6) {
    const [r, g, b] = await probe(page, x, 392);
    if (r > 180 && g > 140 && b < 140) gold++;
  }
  expect(gold, "gold gift text").toBeGreaterThan(0);
});

test("the stage recovers from a lost GPU context", async ({ page }) => {
  await page.evaluate(() => (window as any).__lab.frame(2));
  expect(brightness(await probe(page, 540, 625))).toBeGreaterThan(300);
  await page.evaluate(async () => {
    const ext = (window as any).__lab.loseContext();
    await new Promise((r) => setTimeout(r, 100));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 300));
    (window as any).__lab.frame(3);
  });
  expect(brightness(await probe(page, 540, 625))).toBeGreaterThan(300);
  const telemetry = await page.evaluate(() => (window as any).__lab.telemetry());
  expect(telemetry.error).toBeNull();
});
