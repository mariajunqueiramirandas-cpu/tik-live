import type { ButtonHTMLAttributes, ReactNode, Ref } from "react";
import { Link, type LinkProps } from "react-router";
import s from "./controls.module.css";
import { cx } from "./cx";

type Variant = "primary" | "secondary" | "ghost" | "danger" | "quietDanger";
type Size = "sm" | "md" | "lg";

interface Common {
  variant?: Variant;
  size?: Size;
  /** Leading icon. */
  icon?: ReactNode;
  /** Icon-only button: `label` becomes the accessible name. */
  iconOnly?: boolean;
}

export interface ButtonProps extends Common, ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  ref?: Ref<HTMLButtonElement>;
}

function classes({ variant = "secondary", size = "md", iconOnly }: Common, extra?: string, busy?: boolean): string {
  return cx(s.button, variant !== "secondary" && s[variant], size !== "md" && s[size], iconOnly && s.icon, busy && s.busy, extra);
}

export function Button({ variant, size, icon, iconOnly, busy, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button
      type={type}
      className={classes({ variant, size, iconOnly }, className, busy)}
      disabled={disabled}
      aria-busy={busy || undefined}
      {...rest}
    >
      {busy ? <span className={s.spinner} aria-hidden /> : icon}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
    </button>
  );
}

export interface ButtonLinkProps extends Common, LinkProps {}

export function ButtonLink({ variant, size, icon, iconOnly, className, children, ...rest }: ButtonLinkProps) {
  return (
    <Link className={classes({ variant, size, iconOnly }, className)} {...rest}>
      {icon}
      {iconOnly ? <span className="visually-hidden">{children}</span> : children}
    </Link>
  );
}
