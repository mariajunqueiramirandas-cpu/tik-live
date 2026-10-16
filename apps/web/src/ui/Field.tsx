import { X } from "lucide-react";
import { useId, useState, type InputHTMLAttributes, type KeyboardEvent, type ReactNode, type Ref, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";
import { Slider as RadixSlider, Switch as RadixSwitch, ToggleGroup } from "radix-ui";
import s from "./controls.module.css";
import { cx } from "./cx";

interface FieldProps {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  optional?: boolean;
  /** Shows "12/60" when set. */
  count?: { value: number; max: number };
  children: (props: { id: string; "aria-describedby"?: string; "aria-invalid"?: boolean }) => ReactNode;
  className?: string;
}

/** Label, control, hint and error, wired together for screen readers. */
export function Field({ label, hint, error, optional, count, children, className }: FieldProps) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [errorId, hintId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx(s.field, className)}>
      <div className={s.labelRow}>
        <label className={s.label} htmlFor={id}>
          {label} {optional && <span className={s.optional}>Optional</span>}
        </label>
        {count && (
          <span className={s.counter} aria-live="polite">
            {count.value}/{count.max}
          </span>
        )}
      </div>
      {children({ id, ...(describedBy ? { "aria-describedby": describedBy } : {}), ...(error ? { "aria-invalid": true } : {}) })}
      {error && (
        <p id={errorId} className={s.error}>
          {error}
        </p>
      )}
      {hint && (
        <p id={hintId} className={s.hint}>
          {hint}
        </p>
      )}
    </div>
  );
}

export function Input({ className, ref, ...rest }: InputHTMLAttributes<HTMLInputElement> & { ref?: Ref<HTMLInputElement> }) {
  return <input ref={ref} className={cx(s.input, className)} {...rest} />;
}

export function PrefixedInput({ prefix, className, ...rest }: InputHTMLAttributes<HTMLInputElement> & { prefix: string }) {
  return (
    <div className={s.prefixed}>
      <span className={s.prefix} aria-hidden>
        {prefix}
      </span>
      <input className={cx(s.input, className)} {...rest} />
    </div>
  );
}

export function TextArea({ className, ref, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { ref?: Ref<HTMLTextAreaElement> }) {
  return <textarea ref={ref} className={cx(s.input, className)} {...rest} />;
}

export function Select({ className, children, ...rest }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select className={cx(s.input, className)} {...rest}>
      {children}
    </select>
  );
}

export function Switch({
  label,
  hint,
  checked,
  onChange,
  disabled,
}: {
  label: ReactNode;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className={s.switchRow}>
      <div className={s.field}>
        <label className={s.label} htmlFor={id}>
          {label}
        </label>
        {hint && <p className={s.hint}>{hint}</p>}
      </div>
      <RadixSwitch.Root id={id} className={s.switch} checked={checked} onCheckedChange={onChange} disabled={disabled}>
        <RadixSwitch.Thumb className={s.thumb} />
      </RadixSwitch.Root>
    </div>
  );
}

export function Segmented<T extends string>({
  value,
  options,
  onChange,
  label,
}: {
  value: T;
  options: ReadonlyArray<{ value: T; label: ReactNode }>;
  onChange: (value: T) => void;
  label: string;
}) {
  return (
    <ToggleGroup.Root
      type="single"
      className={s.segmented}
      value={value}
      aria-label={label}
      onValueChange={(next) => {
        if (next) onChange(next as T);
      }}
    >
      {options.map((option) => (
        <ToggleGroup.Item key={option.value} value={option.value} className={s.segment}>
          {option.label}
        </ToggleGroup.Item>
      ))}
    </ToggleGroup.Root>
  );
}

export function Slider({ value, min, max, step = 1, onChange, label }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void; label: string }) {
  return (
    <RadixSlider.Root className={s.slider} value={[value]} min={min} max={max} step={step} onValueChange={([v]) => onChange(v ?? value)} aria-label={label}>
      <RadixSlider.Track className={s.track}>
        <RadixSlider.Range className={s.range} />
      </RadixSlider.Track>
      <RadixSlider.Thumb className={s.sliderThumb} aria-label={label} />
    </RadixSlider.Root>
  );
}

/**
 * A list of short strings edited as chips: Enter or comma adds, Backspace
 * on an empty input removes the last one.
 */
export function Chips({
  id,
  values,
  onChange,
  placeholder,
  max,
  maxLength,
  ...aria
}: {
  id?: string;
  values: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  max: number;
  maxLength: number;
  "aria-describedby"?: string;
}) {
  const [draft, setDraft] = useState("");
  const add = () => {
    const text = draft.trim().slice(0, maxLength);
    if (!text || values.length >= max) return;
    if (!values.some((v) => v.toLowerCase() === text.toLowerCase())) onChange([...values, text]);
    setDraft("");
  };
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      add();
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <div className={s.chips} onClick={(e) => (e.currentTarget.querySelector("input") as HTMLInputElement | null)?.focus()}>
      {values.map((value, i) => (
        <span key={`${value}-${i}`} className={s.chip}>
          <span className={s.chipText}>{value}</span>
          <button type="button" className={s.chipRemove} onClick={() => onChange(values.filter((_, j) => j !== i))} aria-label={`Remove "${value}"`}>
            <X aria-hidden />
          </button>
        </span>
      ))}
      <input
        id={id}
        className={s.chipInput}
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onKeyDown={onKeyDown}
        onBlur={add}
        placeholder={values.length >= max ? `That's the limit (${max})` : placeholder}
        disabled={values.length >= max}
        maxLength={maxLength}
        {...aria}
      />
    </div>
  );
}

export function ColorField({ id, value, onChange, label }: { id?: string; value: string; onChange: (hex: string) => void; label: string }) {
  const [draft, setDraft] = useState(value);
  const [focused, setFocused] = useState(false);
  const shown = focused ? draft : value;
  return (
    <div className={s.color}>
      <span className={s.swatch} style={{ background: value }}>
        <input type="color" value={value.toLowerCase()} onChange={(e) => onChange(e.target.value.toUpperCase())} aria-label={`${label}: pick a color`} />
      </span>
      <input
        id={id}
        className={s.input}
        value={shown}
        spellCheck={false}
        maxLength={7}
        onFocus={() => {
          setDraft(value);
          setFocused(true);
        }}
        onBlur={() => setFocused(false)}
        onChange={(e) => {
          const next = e.target.value.startsWith("#") ? e.target.value : `#${e.target.value}`;
          setDraft(next);
          if (/^#[0-9a-fA-F]{6}$/.test(next)) onChange(next.toUpperCase());
        }}
      />
    </div>
  );
}
