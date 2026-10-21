import { describe, expect, it } from "bun:test";
import type { LiveEvent } from "@tik-live/shared";
import { InactivityWatch } from "../../src/runtime/inactivity";
import { normalizeAccessControl } from "../../src/runtime/sources/normalize";
import { sanitizeEvent } from "../../src/runtime/sources/sanitize";

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

const check = (captchaRecordId = "rec-1", verifyDurationInSec = 60) => ({ captchaRecordId, verifyDurationInSec });

describe("InactivityWatch", () => {
  it("opens a check with its deadline and reports it as current", () => {
    const c = clock();
    const watch = new InactivityWatch(c.now);
    const opened = watch.begin(check("rec-1", 60));
    expect(opened).toMatchObject({ captchaRecordId: "rec-1", verifyDurationInSec: 60, openedAt: 1_000_000, deadline: 1_060_000 });
    expect(watch.current()).toEqual(opened);
  });

  it("ignores a repeat of the open check", () => {
    const watch = new InactivityWatch(clock().now);
    watch.begin(check("rec-1"));
    expect(watch.begin(check("rec-1"))).toBeUndefined();
  });

  it("ignores a resent check that was already closed", () => {
    const c = clock();
    const watch = new InactivityWatch(c.now);
    watch.begin(check("rec-1"));
    watch.windowPassed();
    expect(watch.begin(check("rec-1"))).toBeUndefined();
    expect(watch.current()).toBeUndefined();
  });

  it("opens a new check once the record id is different", () => {
    const watch = new InactivityWatch(clock().now);
    watch.begin(check("rec-1"));
    expect(watch.begin(check("rec-2"))?.captchaRecordId).toBe("rec-2");
  });

  it("reports the stream ending inside the window as ended during the check", () => {
    const c = clock();
    const watch = new InactivityWatch(c.now);
    watch.begin(check("rec-1", 60));
    expect(watch.streamEnded(1_000_000 + 30_000)).toBe("ended_during_check");
    expect(watch.current()).toBeUndefined();
  });

  it("reports the stream ending after the window as window passed", () => {
    const c = clock();
    const watch = new InactivityWatch(c.now);
    watch.begin(check("rec-1", 60));
    expect(watch.streamEnded(1_000_000 + 61_000)).toBe("window_passed");
  });

  it("closes the check when its window passes", () => {
    const watch = new InactivityWatch(clock().now);
    watch.begin(check("rec-1"));
    expect(watch.windowPassed()).toBe("window_passed");
    expect(watch.current()).toBeUndefined();
  });

  it("does nothing when no check is open", () => {
    const watch = new InactivityWatch(clock().now);
    expect(watch.streamEnded(5)).toBeUndefined();
    expect(watch.windowPassed()).toBeUndefined();
  });
});

describe("normalizeAccessControl", () => {
  it("reads the captcha record and the time allowed", () => {
    const event = normalizeAccessControl({ common: {}, captcha: { captchaRecordId: "7301", roomId: "99", verifyDurationInSec: "120" } }, 5);
    expect(event).toEqual({ kind: "inactivity_check", at: 5, captchaRecordId: "7301", verifyDurationInSec: 120 });
  });

  it("drops an access-control message that carries no captcha", () => {
    expect(normalizeAccessControl({ common: {}, captcha: undefined })).toBeUndefined();
    expect(normalizeAccessControl({ common: {} })).toBeUndefined();
  });
});

describe("sanitizing an inactivity check", () => {
  const base = { kind: "inactivity_check", at: 1 } as const;

  it("keeps a well-formed check", () => {
    expect(sanitizeEvent({ ...base, captchaRecordId: "7301", verifyDurationInSec: 90 } as LiveEvent)).toEqual({
      kind: "inactivity_check",
      at: 1,
      captchaRecordId: "7301",
      verifyDurationInSec: 90,
    });
  });

  it("drops a check with no record id", () => {
    expect(sanitizeEvent({ ...base, captchaRecordId: "   ", verifyDurationInSec: 90 } as LiveEvent)).toBeUndefined();
  });

  it("caps an absurd window and falls back when it is missing", () => {
    const huge = sanitizeEvent({ ...base, captchaRecordId: "1", verifyDurationInSec: 1e9 } as LiveEvent);
    expect(huge).toMatchObject({ verifyDurationInSec: 3_600 });
    const missing = sanitizeEvent({ ...base, captchaRecordId: "1", verifyDurationInSec: undefined } as unknown as LiveEvent);
    expect(missing).toMatchObject({ verifyDurationInSec: 60 });
  });
});
