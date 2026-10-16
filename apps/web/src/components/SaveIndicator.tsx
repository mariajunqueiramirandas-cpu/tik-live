import { Check, CircleAlert, LoaderCircle } from "lucide-react";
import type { SaveState } from "../lib/use-autosave";
import s from "./save-indicator.module.css";
import { cx } from "../ui/cx";

const TEXT: Record<SaveState, string> = {
  saved: "Saved",
  dirty: "Saving soon",
  saving: "Saving",
  invalid: "Not saved: fix the highlighted fields",
  error: "Couldn't save. Your edits are kept here; try again.",
};

export function SaveIndicator({ state }: { state: SaveState }) {
  const Icon = state === "saved" ? Check : state === "invalid" || state === "error" ? CircleAlert : LoaderCircle;
  return (
    <span className={cx(s.indicator, s[state])} role="status" aria-live="polite">
      <Icon aria-hidden className={cx(s.icon, (state === "saving" || state === "dirty") && s.spin)} />
      {TEXT[state]}
    </span>
  );
}
