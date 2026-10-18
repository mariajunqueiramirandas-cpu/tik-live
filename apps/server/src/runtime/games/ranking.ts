import type { GameScene, LoopRankingStatus } from "@tik-live/shared";
import type { Logger } from "../../log";
import type { GameCue, GameStage } from "./master";

export interface LoopRankingOptions {
  stage: GameStage;
  /** Whether the stage may play sounds for show moments. */
  sounds: () => boolean;
  /** The ranking or the reveal changed (for the studio). */
  onChange?: () => void;
  now?: () => number;
  log?: Logger;
}

type Step =
  /** The drumroll before a place is shown. The first one opens the podium. */
  | { phase: "suspense"; place: number }
  | { phase: "reveal"; place: number }
  /** Everyone's on the podium: the celebration before the stage goes back to the show. */
  | { phase: "done" };

interface PendingCue extends GameCue {
  phase: Step["phase"];
}

interface Reveal {
  /** The top three when the loop ended, first place first. */
  places: Array<{ name: string; points: number }>;
  steps: Step[];
  index: number;
  stepAt: number;
}

/** How long each step stays up at least (waiting for the host), and at most. */
const OPENING_MIN_MS = 6_000;
const SUSPENSE_MIN_MS = 4_000;
const REVEAL_MIN_MS = 5_000;
const DONE_MIN_MS = 12_000;
const STEP_MAX_MS: Record<Step["phase"], number> = { suspense: 15_000, reveal: 20_000, done: 30_000 };
const ORDINAL = ["", "first", "second", "third"] as const;
const LUGAR = ["", "1º", "2º", "3º"] as const;
const TITLE = "Pódio geral";

/**
 * The minigame ranking for one loop of the run of show (ADR-0028): every
 * point scored in any game adds up here, and once every segment has played,
 * the top three are revealed on stage one place at a time (third, second,
 * then first), each after a drumroll and a beat of suspense from the host.
 * Then the ranking starts over for the next loop.
 *
 * Like the game master, time moves forward in `tick`, and the host voices
 * each moment from a cue, so it never knows a name before it's on screen.
 */
export class LoopRanking {
  private readonly scores = new Map<string, { name: string; points: number; at: number }>();
  private games = 0;
  private reveal: Reveal | null = null;
  private cues: PendingCue[] = [];
  private readonly now: () => number;

  constructor(private readonly options: LoopRankingOptions) {
    this.now = options.now ?? Date.now;
  }

  /** Points someone scored in a game this loop. */
  add(id: string, name: string, points: number): void {
    if (points <= 0) return;
    const row = this.scores.get(id);
    if (row) {
      row.name = name;
      row.points += points;
    } else this.scores.set(id, { name, points, at: this.now() });
    this.options.onChange?.();
  }

  /** A game finished this loop. */
  gameFinished(): void {
    this.games += 1;
    this.options.onChange?.();
  }

  hasScores(): boolean {
    return this.scores.size > 0;
  }

  isRevealing(): boolean {
    return this.reveal !== null;
  }

  /** Everyone who scored, best first; a tie goes to who got there first. */
  rows(n = 10): Array<{ name: string; points: number }> {
    return [...this.scores.values()]
      .sort((a, b) => b.points - a.points || a.at - b.at)
      .slice(0, n)
      .map((row) => ({ name: row.name, points: row.points }));
  }

  status(): LoopRankingStatus {
    return { rows: this.rows(10), games: this.games, revealing: this.reveal !== null };
  }

  /**
   * The loop is over: starts revealing the podium. Returns false (and just
   * starts the next loop) when nobody scored.
   */
  startReveal(): boolean {
    if (this.reveal) return true;
    const places = this.rows(3);
    if (places.length === 0) {
      this.reset();
      return false;
    }
    const steps: Step[] = [];
    for (let place = places.length; place >= 1; place--) steps.push({ phase: "suspense", place }, { phase: "reveal", place });
    steps.push({ phase: "done" });
    this.reveal = { places, steps, index: 0, stepAt: this.now() };
    this.cues = [];
    this.options.log?.info(`loop over: revealing the podium (${places.length} place${places.length === 1 ? "" : "s"})`);
    this.enter(this.reveal);
    return true;
  }

  /** Ends a reveal now and starts the next loop (the stream ended, the creator stopped it). */
  stop(): void {
    if (this.reveal) this.finish();
    else this.reset();
  }

  /** Advances the reveal. `speechIdle` says the host finished talking. */
  tick(speechIdle: boolean): void {
    const reveal = this.reveal;
    if (!reveal) return;
    const step = reveal.steps[reveal.index] as Step;
    const shown = this.now() - reveal.stepAt;
    if ((shown >= this.minFor(step, reveal.index) && speechIdle && this.cues.length === 0) || shown >= STEP_MAX_MS[step.phase]) {
      if (reveal.index + 1 >= reveal.steps.length) {
        this.finish();
        return;
      }
      reveal.index += 1;
      reveal.stepAt = this.now();
      this.enter(reveal);
    }
  }

  /** The next podium moment for the host, oldest first. Taking it removes it. */
  takeCue(): GameCue | null {
    const cue = this.cues.shift();
    return cue ? { note: cue.note, line: cue.line, history: cue.history } : null;
  }

  hasCue(): boolean {
    return this.cues.length > 0;
  }

  /** The podium as the host may see it: only the places already on screen. */
  hostContext(): string | undefined {
    const reveal = this.reveal;
    if (!reveal) return undefined;
    const step = reveal.steps[reveal.index] as Step;
    const shown = this.shown(reveal);
    const lines = [`The podium of this loop's minigame ranking is being revealed on screen, from third place up.`];
    if (shown.length) lines.push(`Revealed so far: ${shown.map(({ place, row }) => `${LUGAR[place]} ${row.name} (${row.points} points)`).join(", ")}.`);
    if (step.phase === "suspense") lines.push(`Still hidden: ${ORDINAL[step.place]} place. Don't guess or name who it is.`);
    return lines.join("\n");
  }

  /** The loop's leaders for the host, while a game runs. */
  standings(): string | undefined {
    const top = this.rows(3);
    if (!top.length) return undefined;
    return `Ranking across every game this loop (revealed on a podium when all segments have played): ${top.map((row, i) => `${i + 1}. ${row.name} ${row.points}`).join(", ")}.`;
  }

  // ---- flow ------------------------------------------------------------------

  private minFor(step: Step, index: number): number {
    if (step.phase === "suspense") return index === 0 ? OPENING_MIN_MS : SUSPENSE_MIN_MS;
    return step.phase === "reveal" ? REVEAL_MIN_MS : DONE_MIN_MS;
  }

  private enter(reveal: Reveal): void {
    const step = reveal.steps[reveal.index] as Step;
    // A teaser the host didn't get to is old news once the next moment is on screen.
    this.cues = this.cues.filter((cue) => cue.phase === "reveal");
    const count = reveal.places.length;
    switch (step.phase) {
      case "suspense": {
        this.sound("drumroll");
        const opening = reveal.index === 0;
        const which = ORDINAL[step.place];
        this.cues.push({
          phase: "suspense",
          note: opening
            ? `Every segment of the show has played, so it's podium time: the ${count === 1 ? "champion" : `top ${count}`} of this loop's minigame ranking, all the games' points added up. Build it up with real drama in one or two short lines: drumroll, we start with ${which} place. Don't guess or name anyone.`
            : `Drumroll for ${which} place. Build the suspense in one short line${step.place === 1 ? ": this is the big one, the champion of the loop" : ""}. Don't guess or name anyone.`,
          line: opening ? `Fim do roteiro! Hora do pódio geral. Rufem os tambores… começando pelo ${LUGAR[step.place]} lugar!` : `E agora… o ${LUGAR[step.place]} lugar!`,
          history: opening ? "The loop ended; the podium of the minigame ranking is being revealed." : `Drumroll for ${which} place on the podium.`,
        });
        break;
      }
      case "reveal": {
        const row = reveal.places[step.place - 1] as { name: string; points: number };
        const champion = step.place === 1;
        if (champion) {
          this.sound("fanfare");
          this.options.stage.fx("fireworks", 3);
          this.options.stage.fx("confetti", 2);
        } else {
          this.sound("reveal");
          this.options.stage.fx(step.place === 2 ? "stars" : "sparkles", 1.5);
        }
        this.cues.push({
          phase: "reveal",
          note: champion
            ? `The champion of the loop, on screen now: ${row.name} with ${row.points} points! Crown them with everything you've got, then thank everyone who played and say the ranking starts over for the next loop.`
            : `${ORDINAL[step.place]} place, on screen now: ${row.name} with ${row.points} points. Congratulate them by name in one short line.`,
          line: champion ? `E quem leva o pódio geral é… ${row.name}, com ${row.points} pontos! Parabéns!` : `${LUGAR[step.place]} lugar: ${row.name}, com ${row.points} pontos!`,
          history: `Podium, ${ORDINAL[step.place]} place: ${row.name} (${row.points} points).`,
        });
        break;
      }
      case "done":
        this.sound("applause");
        break;
    }
    this.publish(reveal);
    this.options.onChange?.();
  }

  private finish(): void {
    this.reveal = null;
    this.cues = [];
    this.options.stage.game(null);
    this.reset();
  }

  private reset(): void {
    this.scores.clear();
    this.games = 0;
    this.options.onChange?.();
  }

  /** The places on screen at the current step, lowest first. */
  private shown(reveal: Reveal): Array<{ place: number; row: { name: string; points: number } }> {
    const out: Array<{ place: number; row: { name: string; points: number } }> = [];
    for (let i = 0; i <= reveal.index; i++) {
      const step = reveal.steps[i] as Step;
      if (step.phase === "reveal") out.push({ place: step.place, row: reveal.places[step.place - 1] as { name: string; points: number } });
    }
    return out;
  }

  private publish(reveal: Reveal): void {
    const step = reveal.steps[reveal.index] as Step;
    const places: Array<{ name: string; points: number } | null> = reveal.places.map(() => null);
    for (const { place, row } of this.shown(reveal)) places[place - 1] = row;
    const scene: GameScene = { kind: "podium", title: TITLE, places, suspense: step.phase === "suspense" ? step.place : null };
    this.options.stage.game(scene);
  }

  private sound(sound: Parameters<GameStage["sfx"]>[0]): void {
    if (this.options.sounds()) this.options.stage.sfx(sound);
  }
}
