/**
 * Tracks TikTok's inactivity check for the LIVE on air: when TikTok asks the
 * host to confirm they're there, how long they have, and how it ended.
 *
 * We never see whether the host answered. The check is answered in TikTok
 * LIVE Studio, and TikTok doesn't send us the result. So the only outcomes we
 * can name are "the stream ended while the check was open" and "the window
 * passed". The second one doesn't say whether the host verified in time.
 */

export interface InactivityCheck {
  captchaRecordId: string;
  verifyDurationInSec: number;
  /** Epoch ms when we received the check. */
  openedAt: number;
  /** Epoch ms when TikTok's window closes, as far as we know. */
  deadline: number;
}

export type InactivityOutcome = "ended_during_check" | "window_passed";

/** Recently closed record ids, so a resent message doesn't open the same check again. */
const RECENT_LIMIT = 20;

export class InactivityWatch {
  private open: InactivityCheck | undefined;
  private readonly recent: string[] = [];

  constructor(private readonly now: () => number = Date.now) {}

  /** The check now open, if any. */
  current(): InactivityCheck | undefined {
    return this.open;
  }

  /** Opens a check. Returns it when it's new; undefined for a repeat of one already seen. */
  begin(event: { captchaRecordId: string; verifyDurationInSec: number }): InactivityCheck | undefined {
    if (this.open?.captchaRecordId === event.captchaRecordId || this.recent.includes(event.captchaRecordId)) return undefined;
    const openedAt = this.now();
    this.open = {
      captchaRecordId: event.captchaRecordId,
      verifyDurationInSec: event.verifyDurationInSec,
      openedAt,
      deadline: openedAt + event.verifyDurationInSec * 1000,
    };
    return this.open;
  }

  /** The stream ended at `at`: closes any open check and says whether it was still in its window. */
  streamEnded(at: number): InactivityOutcome | undefined {
    if (!this.open) return undefined;
    const outcome: InactivityOutcome = at <= this.open.deadline ? "ended_during_check" : "window_passed";
    this.close();
    return outcome;
  }

  /** The window's timer fired: closes the open check. */
  windowPassed(): InactivityOutcome | undefined {
    if (!this.open) return undefined;
    this.close();
    return "window_passed";
  }

  private close(): void {
    if (!this.open) return;
    this.recent.push(this.open.captchaRecordId);
    if (this.recent.length > RECENT_LIMIT) this.recent.shift();
    this.open = undefined;
  }
}
