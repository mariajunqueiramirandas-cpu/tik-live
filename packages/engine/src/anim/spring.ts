/**
 * A damped spring integrated in fixed substeps, so motion looks identical at
 * 30, 60 or 144 fps and can be retargeted mid-flight without a jump
 * (ADR-0009: springs, not tweens, for anything interruptible).
 */
export interface SpringConfig {
  stiffness: number;
  damping: number;
}

export const SPRINGS = {
  /** Expressions and colors: smooth, no overshoot. */
  gentle: { stiffness: 120, damping: 22 },
  /** UI elements arriving: quick with a little life. */
  snappy: { stiffness: 260, damping: 24 },
  /** The character's bounce: visibly springy. */
  bouncy: { stiffness: 180, damping: 9 },
  /** Mouth and audio-driven values: fast, tightly damped. */
  quick: { stiffness: 700, damping: 48 },
  /** HUD pops (an alert landing, a countdown's last seconds): a quick overshoot that settles fast. */
  pop: { stiffness: 380, damping: 15 },
} satisfies Record<string, SpringConfig>;

const STEP = 1 / 120;

export class Spring {
  value: number;
  velocity = 0;
  target: number;

  constructor(
    value: number,
    private readonly config: SpringConfig = SPRINGS.gentle,
  ) {
    this.value = value;
    this.target = value;
  }

  /** Advances by `dt` seconds. */
  step(dt: number): number {
    let remaining = Math.min(dt, 0.1);
    while (remaining > 1e-6) {
      const h = Math.min(STEP, remaining);
      const force = -this.config.stiffness * (this.value - this.target) - this.config.damping * this.velocity;
      this.velocity += force * h;
      this.value += this.velocity * h;
      remaining -= h;
    }
    return this.value;
  }

  /** Jumps to a value with no motion (e.g. initial state). */
  snap(value: number): void {
    this.value = value;
    this.target = value;
    this.velocity = 0;
  }

  impulse(velocity: number): void {
    this.velocity += velocity;
  }

  settled(epsilon = 1e-3): boolean {
    return Math.abs(this.value - this.target) < epsilon && Math.abs(this.velocity) < epsilon;
  }
}

/** A fixed-length vector of springs sharing one config (colors, face parameters). */
export class SpringVector {
  readonly springs: Spring[];

  constructor(values: readonly number[], config: SpringConfig = SPRINGS.gentle) {
    this.springs = values.map((v) => new Spring(v, config));
  }

  setTarget(values: readonly number[]): void {
    values.forEach((v, i) => {
      const spring = this.springs[i];
      if (spring) spring.target = v;
    });
  }

  snap(values: readonly number[]): void {
    values.forEach((v, i) => this.springs[i]?.snap(v));
  }

  step(dt: number): void {
    for (const spring of this.springs) spring.step(dt);
  }

  get(i: number): number {
    return this.springs[i]?.value ?? 0;
  }
}
