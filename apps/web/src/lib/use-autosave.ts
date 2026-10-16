import { useEffect, useRef, useState } from "react";

export type SaveState = "saved" | "dirty" | "saving" | "invalid" | "error";

/**
 * Debounced autosave (ADR-0010): saves `value` after `delayMs` of quiet
 * when `valid`, and reports a state for the "Saved" indicator. Flushes
 * pending edits when the component unmounts.
 */
export function useAutosave<T>({ value, valid, save, delayMs = 800 }: { value: T; valid: boolean; save: (value: T) => Promise<unknown>; delayMs?: number }): SaveState {
  const [state, setState] = useState<SaveState>("saved");
  const savedJson = useRef(JSON.stringify(value));
  const latest = useRef({ value, valid, save });
  latest.current = { value, valid, save };
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = () => {
    const { value: current, valid: ok, save: run } = latest.current;
    const json = JSON.stringify(current);
    if (!ok || json === savedJson.current) return;
    setState("saving");
    run(current).then(
      () => {
        savedJson.current = json;
        setState(JSON.stringify(latest.current.value) === json ? "saved" : "dirty");
      },
      () => setState("error"),
    );
  };

  useEffect(() => {
    const json = JSON.stringify(value);
    if (json === savedJson.current) {
      setState((s) => (s === "saving" ? s : "saved"));
      return;
    }
    if (!valid) {
      setState("invalid");
      return;
    }
    setState("dirty");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, delayMs);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, valid, delayMs]);

  // Save whatever is pending when leaving the page.
  useEffect(() => () => flush(), []);

  return state;
}
