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
    lab.apply({ t: "speak", id: "c1", text: "Obrigado pelas rosas, pessoal do chat!", emotion: "happy", audioUrl: null, durationMs: 3000 });
    lab.apply({ t: "alert", kind: "gift", name: "mari", giftName: "Rose", count: 5, diamonds: 5 });
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

test("up next and the top likers show under the badge, and leave when emptied", async ({ page }) => {
  // The panel's top-left corner area, clear of the orb and the alerts.
  const lit = async () => {
    let n = 0;
    for (let y = 340; y <= 640; y += 12) for (let x = 84; x <= 420; x += 20) if (brightness(await probe(page, x, y)) > 450) n++;
    return n;
  };
  await page.evaluate(() => (window as any).__lab.frame(2));
  const before = await lit();
  await page.evaluate(() => {
    (window as any).__lab.hud(true);
    (window as any).__lab.frame(4);
  });
  expect(await lit(), "text in the panels").toBeGreaterThan(before + 8);
  expect((await page.evaluate(() => (window as any).__lab.telemetry())).error).toBeNull();
  // A vote takes the ranking card's place, then gives it back.
  await page.evaluate(() => {
    const lab = (window as any).__lab;
    lab.apply({ t: "vote", vote: { title: "Jogo do quadro final", options: ["Quiz", "Charadas", "Dedo mais rápido"], tally: [4, 1, 9] } });
    lab.frame(5);
    lab.apply({ t: "boost", boost: "double", by: "duda" });
    lab.frame(5.5);
  });
  expect((await page.evaluate(() => (window as any).__lab.telemetry())).error).toBeNull();
  await page.evaluate(() => {
    (window as any).__lab.apply({ t: "vote", vote: null });
    (window as any).__lab.frame(5.6);
  });
  await page.evaluate(() => {
    (window as any).__lab.hud(false);
    (window as any).__lab.frame(8);
  });
  expect(await lit(), "panels faded out").toBeLessThanOrEqual(before + 2);
});

test("the goals show top right, turn gold when one is reached, and leave when hidden", async ({ page }) => {
  // The goal panel's area: right of the title, above the alerts, clear of the orb.
  const area = async (match: (rgba: Rgba) => boolean) => {
    let n = 0;
    for (let y = 214; y <= 340; y += 8) for (let x = 728; x <= 1004; x += 12) if (match(await probe(page, x, y))) n++;
    return n;
  };
  const bright = (rgba: Rgba) => brightness(rgba) > 450;
  const gold = ([r, g, b]: Rgba) => r > 180 && g > 140 && b < 120;
  await page.evaluate(() => (window as any).__lab.frame(2));
  const before = await area(bright);
  await page.evaluate(() => {
    (window as any).__lab.goals(true);
    (window as any).__lab.frame(3);
  });
  expect(await area(bright), "goal text and bars").toBeGreaterThan(before + 8);
  const goldBefore = await area(gold);
  await page.evaluate(() => {
    (window as any).__lab.reachGoal();
    (window as any).__lab.frame(3.5);
  });
  expect(await area(gold), "the goal reached turns gold").toBeGreaterThan(goldBefore + 4);
  expect((await page.evaluate(() => (window as any).__lab.telemetry())).error).toBeNull();
  await page.evaluate(() => {
    (window as any).__lab.goals(false);
    (window as any).__lab.frame(6);
  });
  expect(await area(bright), "panel faded out").toBeLessThanOrEqual(before + 2);
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

test("broadcast capture reads the stage back as I420, top row first", async ({ page }) => {
  const W = 360;
  const H = 640;
  const result = await page.evaluate(
    async ([w, h]) => {
      const lab = (window as any).__lab;
      const frames: Uint8Array[] = [];
      const stop = lab.engine.startCapture({ width: w, height: h, onFrame: (f: Uint8Array) => frames.push(f.slice()) });
      // Readback is asynchronous: frames arrive a few draws later.
      for (let i = 0; i < 60 && frames.length < 3; i++) {
        lab.frame(2 + i / 30);
        await new Promise((r) => setTimeout(r, 15));
      }
      const stats = lab.engine.captureStats();
      stop();
      const frame = frames.at(-1)!;
      // Mean luma of an 8x8 block centred on a stage point (1080x1920 coordinates, y down).
      const luma = (sx: number, sy: number) => {
        const cx = Math.round((sx / 1080) * w);
        const cy = Math.round((sy / 1920) * h);
        let sum = 0;
        for (let y = cy - 4; y < cy + 4; y++) for (let x = cx - 4; x < cx + 4; x++) sum += frame[y * w + x]!;
        return sum / 64;
      };
      let [yMin, yMax, cMin, cMax] = [255, 0, 255, 0];
      for (let i = 0; i < w * h; i++) [yMin, yMax] = [Math.min(yMin, frame[i]!), Math.max(yMax, frame[i]!)];
      for (let i = w * h; i < frame.length; i++) [cMin, cMax] = [Math.min(cMin, frame[i]!), Math.max(cMax, frame[i]!)];
      return { count: frames.length, bytes: frame.length, orb: luma(540, 625), below: luma(540, 1920 - 625), yMin, yMax, cMin, cMax, stats };
    },
    [W, H] as const,
  );
  expect(result.count, "frames delivered").toBeGreaterThanOrEqual(3);
  expect(result.bytes).toBe(W * H * 1.5);
  // BT.709 limited range: luma 16-235, chroma 16-240.
  expect(result.yMin).toBeGreaterThanOrEqual(16);
  expect(result.yMax).toBeLessThanOrEqual(235);
  expect(result.cMin).toBeGreaterThanOrEqual(16);
  expect(result.cMax).toBeLessThanOrEqual(240);
  // The orb sits in the upper half; flipped rows would put it in the lower half.
  expect(result.orb - result.below, `orb ${result.orb} vs mirrored ${result.below}`).toBeGreaterThan(40);
  expect(result.stats.frames).toBeGreaterThanOrEqual(3);
  // Stopping hands drawing back to the canvas.
  await page.evaluate(() => (window as any).__lab.frame(5));
  expect(brightness(await probe(page, 540, 625))).toBeGreaterThan(300);
});
