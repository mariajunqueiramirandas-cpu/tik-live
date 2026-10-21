import { describe, expect, it } from "bun:test";
import { EMOTIONS } from "@tik-live/shared";
import { createRandom } from "../src/anim/random";
import { FaceController, facePose } from "../src/character/face";

const settle = (face: FaceController, seconds: number, amplitude = 0, start = 0) => {
  let t = start;
  while (t < start + seconds) {
    t += 1 / 60;
    face.update(1 / 60, t, amplitude);
  }
  return t;
};

describe("FaceController", () => {
  it("has a target for every emotion", () => {
    for (const emotion of EMOTIONS) {
      const face = new FaceController(createRandom(1));
      face.setEmotion(emotion);
      settle(face, 2);
      const values = [...face.state.eye, ...face.state.eye2, ...face.state.mouth, face.state.blush, face.state.desat];
      for (const v of values) expect(Number.isFinite(v)).toBe(true);
    }
  });

  it("morphs between expressions instead of switching", () => {
    const face = new FaceController(createRandom(1));
    settle(face, 2);
    face.setEmotion("sad");
    face.update(1 / 60, 2 + 1 / 60, 0);
    expect(face.state.eye2[1]).toBeLessThan(0.1); // brow barely started
    settle(face, 2, 0, 2.1);
    expect(face.state.eye2[1]).toBeGreaterThan(0.95);
    expect(face.state.mouth[1]).toBeLessThan(-0.6);
  });

  it("opens the mouth with the voice", () => {
    const face = new FaceController(createRandom(1));
    settle(face, 0.5, 0.8);
    expect(face.state.mouth[0]).toBeGreaterThan(0.7);
    settle(face, 0.5, 0, 0.5);
    expect(face.state.mouth[0]).toBeLessThan(0.05);
  });

  it("blinks on its own", () => {
    const face = new FaceController(createRandom(3));
    let blinked = false;
    let t = 0;
    while (t < 10) {
      t += 1 / 60;
      face.update(1 / 60, t, 0);
      if (face.state.eye2[3] > 0.9) blinked = true;
    }
    expect(blinked).toBe(true);
  });

  it("looks toward incoming gifts", () => {
    const face = new FaceController(createRandom(1));
    face.lookAt(0.7, -0.4, 5);
    settle(face, 1.5);
    expect(face.state.gaze[0]).toBeGreaterThan(0.6);
    expect(face.state.gaze[1]).toBeLessThan(-0.3);
  });
});

describe("new expressions", () => {
  it("makes confused, shy, sleepy, proud and pout clearly different from each other and from neutral", () => {
    const settled = (emotion: (typeof EMOTIONS)[number]) => {
      const face = new FaceController(createRandom(1));
      face.setEmotion(emotion);
      settle(face, 3);
      const s = face.state;
      return [...s.eye, ...s.eye2.slice(0, 3), ...s.mouth.slice(1), s.blush, s.desat, s.tilt, ...s.mood, ...s.gaze];
    };
    const names = ["neutral", "confused", "shy", "sleepy", "proud", "pout"] as const;
    const vectors = names.map(settled);
    for (let i = 0; i < names.length; i++) {
      for (let j = i + 1; j < names.length; j++) {
        const distance = Math.hypot(...vectors[i]!.map((v, k) => v - vectors[j]![k]!));
        expect(distance, `${names[i]} vs ${names[j]}`).toBeGreaterThan(0.6);
      }
    }
  });

  it("calms the voice line when sleepy and warms it when in love", () => {
    const mood = (emotion: (typeof EMOTIONS)[number]) => {
      const face = new FaceController(createRandom(1));
      face.setEmotion(emotion);
      settle(face, 3);
      return face.state.mood;
    };
    expect(mood("sleepy")[1]).toBeGreaterThan(0.9);
    expect(mood("sleepy")[0]).toBeLessThan(0.5);
    expect(mood("love")[3]).toBeGreaterThan(0.9);
    expect(mood("confused")[2]).toBeGreaterThan(0.9);
  });
});

describe("facePose", () => {
  it("is the settled expression with open eyes and a closed mouth", () => {
    for (const emotion of EMOTIONS) {
      const face = new FaceController(createRandom(1));
      face.setEmotion(emotion);
      settle(face, 4);
      const pose = facePose(emotion);
      expect(pose.eye2[3]).toBe(0);
      expect(pose.mouth[0]).toBe(0);
      expect(pose.eye[0]).toBeCloseTo(face.state.eye[0], 2);
      expect(pose.eye[2]).toBeCloseTo(face.state.eye[2], 2);
      expect(pose.mouth[1]).toBeCloseTo(face.state.mouth[1], 2);
      expect(pose.blush).toBeCloseTo(face.state.blush, 2);
      expect(pose.tilt).toBeCloseTo(face.state.tilt, 2);
    }
  });

  it("looks where the emotion rests its gaze", () => {
    expect(facePose("happy").gaze).toEqual([0, 0]);
    expect(facePose("thinking").gaze).toEqual([0.6, -0.7]);
  });
});
