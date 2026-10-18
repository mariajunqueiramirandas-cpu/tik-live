import { expect, test, type Page } from "@playwright/test";

/**
 * Game scenes, effects and gifts on the engine lab (ADR-0023), with the
 * manual clock. Pixel probes like engine.e2e.ts: each scene must draw its
 * own board in its own accent, the character must make room for it, and
 * nothing may report an error in telemetry.
 */
const LAB = "http://localhost:5199/lab.html?clock=manual&caption=0";

type Rgba = [number, number, number, number];

/** Accent per scene (packages/engine/src/game/model.ts PALETTES). */
const ACCENTS: Record<string, [number, number, number]> = {
  trivia: [0x9d, 0xb4, 0xff],
  poll: [0xff, 0x8c, 0xc0],
  scramble: [0xa6, 0xff, 0x8a],
  number: [0xff, 0xc6, 0x5c],
  truefalse: [0x6c, 0xf2, 0xcc],
  math: [0xe8, 0xf0, 0x7a],
  riddle: [0xc7, 0xa6, 0xff],
  fastest: [0xff, 0xe1, 0x4d],
  race: [0xff, 0xb1, 0x5c],
  wheel: [0xff, 0xd1, 0x5c],
  tug: [0xff, 0xe0, 0x8a],
  potato: [0xff, 0xb3, 0x47],
};

async function probe(page: Page, x: number, y: number): Promise<Rgba> {
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

/** Pixels in a stage rect (sampled every `step` px) that pass `test`. */
async function count(page: Page, rect: [number, number, number, number], step: number, kind: "bright" | "green" | "gold"): Promise<number> {
  return page.evaluate(
    ([[x0, y0, x1, y1], s, k]) => {
      const canvas = document.getElementById("stage") as HTMLCanvasElement;
      const gl = canvas.getContext("webgl2")!;
      const w = canvas.width;
      const h = canvas.height;
      const data = new Uint8Array(w * h * 4);
      gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, data);
      let n = 0;
      for (let y = y0; y < y1; y += s) {
        for (let x = x0; x < x1; x += s) {
          const px = Math.round((x / 1080) * w);
          const py = h - 1 - Math.round((y / 1920) * h);
          const i = (py * w + px) * 4;
          const [r, g, b] = [data[i]!, data[i + 1]!, data[i + 2]!];
          if (k === "bright" && r + g + b > 500) n++;
          if (k === "green" && g > 150 && g > r + 40 && g > b + 10) n++;
          if (k === "gold" && r > 180 && g > 140 && b < 120) n++;
        }
      }
      return n;
    },
    [rect, step, kind] as const,
  );
}

const near = ([r, g, b]: Rgba, [ar, ag, ab]: [number, number, number], tolerance = 70) =>
  Math.abs(r - ar) < tolerance && Math.abs(g - ag) < tolerance && Math.abs(b - ab) < tolerance;
const brightness = ([r, g, b]: Rgba) => r + g + b;

async function open(page: Page, query: string): Promise<void> {
  await page.goto(`${LAB}&${query}`);
  await page.evaluate(async () => {
    await (window as any).__lab.fontsReady();
    await (window as any).__lab.ready();
  });
}

const error = (page: Page) => page.evaluate(() => (window as any).__lab.telemetry().error);

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 540, height: 960 });
});

test("every game scene draws its board, in its own accent, under a smaller character", async ({ page }) => {
  await open(page, "bare");
  const scenes: string[] = await page.evaluate(() => (window as any).__lab.scenes);
  expect(scenes.length).toBeGreaterThanOrEqual(18);
  for (const name of scenes) {
    await open(page, `scene=${name}`);
    await page.evaluate(() => (window as any).__lab.frame(3));
    expect(await error(page), name).toBeNull();
    // The character moved up and shrank to make room: its body is near y 430.
    expect(brightness(await probe(page, 540, 410)), `${name}: character up top`).toBeGreaterThan(300);
    // The board has text and shapes.
    expect(await count(page, [100, 600, 980, 1440], 12, "bright"), `${name}: board content`).toBeGreaterThan(40);
    const kind = name.replace(/-(reveal|running|finish|boom)$|4$/, "");
    // No timer once bets close or a round is revealed, and none on the potato: its fuse is secret.
    if (/-(reveal|running|finish|boom)$/.test(name) || kind === "scoreboard" || kind === "podium" || kind === "potato") continue;
    // Open rounds: the timer bar (2/3 left) is in the scene's accent.
    expect(near(await probe(page, 200, 669), ACCENTS[kind]!), `${name}: timer in accent`).toBe(true);
  }
});

test("reveals highlight the right answer and the scoreboard builds a podium", async ({ page }) => {
  for (const name of ["trivia-reveal", "truefalse-reveal", "scramble-reveal"]) {
    await open(page, `scene=${name}`);
    await page.evaluate(() => (window as any).__lab.frame(3));
    expect(await count(page, [84, 600, 996, 1440], 8, "green"), `${name}: green highlight`).toBeGreaterThan(20);
  }
  await open(page, "scene=scoreboard");
  await page.evaluate(() => (window as any).__lab.frame(3));
  expect(near(await probe(page, 540, 1120), [0xff, 0xd1, 0x5c], 60), "first place in gold").toBe(true);
});

test("the loop's podium keeps first place hidden until it's revealed", async ({ page }) => {
  await open(page, "scene=podium");
  await page.evaluate(() => (window as any).__lab.frame(3));
  expect(await error(page)).toBeNull();
  expect(near(await probe(page, 540, 1120), [0xff, 0xd1, 0x5c], 60), "first place still a question mark").toBe(false);
  await page.evaluate(() => {
    const lab = (window as any).__lab;
    lab.apply({ t: "game", scene: { kind: "podium", title: "Pódio geral", places: [{ name: "mari.souza", points: 1240 }, { name: "lu.desenha", points: 985 }, { name: "duda", points: 610 }], suspense: null } });
    lab.frame(4.5);
  });
  expect(near(await probe(page, 540, 1120), [0xff, 0xd1, 0x5c], 60), "first place in gold once revealed").toBe(true);
});

test("same-round updates stay in place, new rounds transition, null goes back to the show", async ({ page }) => {
  await open(page, "scene=poll");
  await page.evaluate(() => (window as any).__lab.frame(3));
  const timer = await probe(page, 200, 669);
  // A tally update: no entrance replays, the board is still fully there right after.
  await page.evaluate(() => {
    const lab = (window as any).__lab;
    lab.apply({ t: "game", scene: { kind: "poll", round: 2, rounds: 5, phase: "open", remainingMs: 17_000, durationMs: 30_000, question: "Pizza com abacaxi: sim ou não?", options: ["Sim, doce e salgado combinam", "Nunca, isso é um crime"], tally: [80, 20] } });
    lab.frame(3.05);
  });
  expect(near(await probe(page, 200, 669), [timer[0], timer[1], timer[2]], 30), "board stays put").toBe(true);
  // Back to the show: the board leaves and the character returns to the middle.
  await page.evaluate(() => {
    const lab = (window as any).__lab;
    lab.scene(null);
    lab.frame(6);
  });
  expect(near(await probe(page, 200, 669), [timer[0], timer[1], timer[2]], 30), "board gone").toBe(false);
  expect(brightness(await probe(page, 540, 625)), "character back in the middle").toBeGreaterThan(300);
  expect(await error(page)).toBeNull();
});

test("the board survives a lost GPU context", async ({ page }) => {
  await open(page, "scene=trivia");
  await page.evaluate(() => (window as any).__lab.frame(3));
  await page.evaluate(async () => {
    const ext = (window as any).__lab.loseContext();
    await new Promise((r) => setTimeout(r, 100));
    ext.restoreContext();
    await new Promise((r) => setTimeout(r, 300));
    (window as any).__lab.frame(3.5);
  });
  expect(near(await probe(page, 200, 669), ACCENTS.trivia!), "timer after restore").toBe(true);
  expect(await count(page, [100, 600, 980, 1440], 12, "bright"), "board text after restore").toBeGreaterThan(40);
  expect(await error(page)).toBeNull();
});

test("every effect and gift tier plays without errors; big gifts get a banner", async ({ page }) => {
  await open(page, "bare");
  const effects: string[] = await page.evaluate(() => (window as any).__lab.effects);
  let t = 1;
  for (const effect of effects) {
    t += 2;
    await page.evaluate(([e, time]) => {
      (window as any).__lab.fx(e);
      (window as any).__lab.frame(time);
    }, [effect, t] as const);
    expect(await error(page), effect).toBeNull();
  }
  await page.evaluate((time) => {
    (window as any).__lab.gift("galaxy");
    (window as any).__lab.frame(time + 1.2);
  }, t);
  expect(await count(page, [140, 900, 940, 1120], 8, "gold"), "gold banner").toBeGreaterThan(10);
  expect(await error(page)).toBeNull();
});
