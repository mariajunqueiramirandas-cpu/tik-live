import { useEffect, useRef } from "react";

function typing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

/** Single-key shortcuts (studio: P, K, S) that never fire while typing. */
export function useHotkeys(map: Record<string, () => void>, enabled = true): void {
  const latest = useRef(map);
  latest.current = map;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey || typing(event.target)) return;
      if (document.querySelector("[role=dialog]")) return;
      const action = latest.current[event.key.toLowerCase()];
      if (action) {
        event.preventDefault();
        action();
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [enabled]);
}
