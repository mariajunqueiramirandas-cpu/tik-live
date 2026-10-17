import type { RuntimeStatus } from "@tik-live/shared";
import { CircleAlert, Info, TriangleAlert } from "lucide-react";
import { useState, type CSSProperties, type ReactNode } from "react";
import { Copy, Check } from "lucide-react";
import { Button } from "./Button";
import s from "./display.module.css";
import c from "./controls.module.css";
import { cx } from "./cx";
import { toast } from "./toast-store";

/** A placeholder that only appears after 150 ms, so fast loads never flash. */
export function Skeleton({ width = "100%", height = 16, style, className }: { width?: number | string; height?: number | string; style?: CSSProperties; className?: string }) {
  return <span aria-hidden className={cx(s.skeleton, className)} style={{ display: "block", width, height, ...style }} />;
}

const STATUS: Record<RuntimeStatus, { label: string; tone?: "live" | "waiting" | "failed" }> = {
  stopped: { label: "Fora do ar" },
  starting: { label: "Iniciando", tone: "waiting" },
  standby: { label: "Aguardando a live", tone: "waiting" },
  live: { label: "Ao vivo", tone: "live" },
  stopping: { label: "Parando", tone: "waiting" },
  failed: { label: "Precisa de atenção", tone: "failed" },
};

export function statusLabel(status: RuntimeStatus): string {
  return STATUS[status].label;
}

export function Status({ status, children }: { status: RuntimeStatus; children?: ReactNode }) {
  const meta = STATUS[status];
  return (
    <span className={cx(s.status, meta.tone && s[meta.tone])}>
      <span className={s.dot} aria-hidden />
      {children ?? meta.label}
    </span>
  );
}

export function Empty({ title, children, action }: { title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <h2>{title}</h2>
      {children && <div>{children}</div>}
      {action}
    </div>
  );
}

export function Panel({ children, raised, className, style, as: As = "section", ...rest }: { children: ReactNode; raised?: boolean; className?: string; style?: CSSProperties; as?: "section" | "div" | "aside"; "aria-label"?: string; "aria-labelledby"?: string }) {
  return (
    <As className={cx(s.panel, raised && s.raised, className)} style={style} {...rest}>
      {children}
    </As>
  );
}

export function Banner({ tone = "info", title, children, action }: { tone?: "info" | "warn" | "error"; title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  const Icon = tone === "error" ? CircleAlert : tone === "warn" ? TriangleAlert : Info;
  return (
    <div className={cx(s.banner, tone === "warn" && s.bannerWarn, tone === "error" && s.bannerError)} role={tone === "error" ? "alert" : "status"}>
      <Icon aria-hidden />
      <div className={s.bannerBody}>
        <span className={s.bannerTitle}>{title}</span>
        {children && <p>{children}</p>}
      </div>
      {action}
    </div>
  );
}

export function CopyField({ value, label, id, ...aria }: { value: string; label: string; id?: string; "aria-describedby"?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Não deu para copiar", "Selecione o texto e copie manualmente.");
    }
  };
  return (
    <div className={c.copy}>
      <input id={id} className={c.input} value={value} readOnly onFocus={(e) => e.currentTarget.select()} aria-label={id ? undefined : label} {...aria} />
      <Button onClick={copy} icon={copied ? <Check aria-hidden /> : <Copy aria-hidden />} aria-live="polite">
        {copied ? "Copiado" : "Copiar"}
      </Button>
    </div>
  );
}
