import { CheckCircle2, Info, TriangleAlert, X } from "lucide-react";
import { Dialog as RadixDialog, DropdownMenu, Toast, Tooltip as RadixTooltip } from "radix-ui";
import { useState, useSyncExternalStore, type ReactNode } from "react";
import { Button } from "./Button";
import { cx } from "./cx";
import s from "./overlay.module.css";
import { toast, type ToastItem } from "./toast-store";

export function Dialog({
  open,
  onOpenChange,
  title,
  description,
  children,
  actions,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={s.overlay} />
        <RadixDialog.Content className={s.dialog} {...(description ? {} : { "aria-describedby": undefined })}>
          <RadixDialog.Title className={s.dialogTitle}>{title}</RadixDialog.Title>
          <div className={s.dialogBody}>
            {description && <RadixDialog.Description>{description}</RadixDialog.Description>}
            {children}
          </div>
          {actions && <div className={s.dialogActions}>{actions}</div>}
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}

/** A confirm dialog for the few actions that can't be undone. */
export function Confirm({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  danger,
  onConfirm,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<unknown> | void;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => !busy && onOpenChange(next)}
      title={title}
      description={description}
      actions={
        <>
          <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancelar
          </Button>
          <Button
            variant={danger ? "danger" : "primary"}
            busy={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onConfirm();
                onOpenChange(false);
              } catch (error) {
                toast.error(`Não deu para ${confirmLabel.toLowerCase()}`, error);
              } finally {
                setBusy(false);
              }
            }}
          >
            {confirmLabel}
          </Button>
        </>
      }
    />
  );
}

export const Menu = {
  Root: DropdownMenu.Root,
  Trigger: DropdownMenu.Trigger,
  Content({ children, align = "end" }: { children: ReactNode; align?: "start" | "end" }) {
    return (
      <DropdownMenu.Portal>
        <DropdownMenu.Content className={s.menu} align={align} sideOffset={6}>
          {children}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    );
  },
  Item({ children, icon, danger, onSelect, disabled }: { children: ReactNode; icon?: ReactNode; danger?: boolean; onSelect: () => void; disabled?: boolean }) {
    return (
      <DropdownMenu.Item className={cx(s.menuItem, danger && s.menuDanger)} onSelect={onSelect} disabled={disabled}>
        {icon}
        {children}
      </DropdownMenu.Item>
    );
  },
  Separator() {
    return <DropdownMenu.Separator className={s.menuSeparator} />;
  },
};

export function Tooltip({ content, children, side = "top" }: { content: ReactNode; children: ReactNode; side?: "top" | "bottom" | "left" | "right" }) {
  return (
    <RadixTooltip.Root>
      <RadixTooltip.Trigger asChild>{children}</RadixTooltip.Trigger>
      <RadixTooltip.Portal>
        <RadixTooltip.Content className={s.tooltip} side={side} sideOffset={6}>
          {content}
        </RadixTooltip.Content>
      </RadixTooltip.Portal>
    </RadixTooltip.Root>
  );
}

export const TooltipProvider = ({ children }: { children: ReactNode }) => (
  <RadixTooltip.Provider delayDuration={350} skipDelayDuration={200}>
    {children}
  </RadixTooltip.Provider>
);

const ICONS = { info: Info, success: CheckCircle2, error: TriangleAlert } as const;

function ToastView({ item }: { item: ToastItem }) {
  const Icon = ICONS[item.tone];
  return (
    <Toast.Root
      className={cx(s.toast, s[item.tone])}
      duration={item.durationMs}
      type={item.tone === "error" ? "foreground" : "background"}
      onOpenChange={(open) => !open && toast.dismiss(item.id)}
    >
      <Icon className={s.toastIcon} aria-hidden />
      <div>
        <Toast.Title className={s.toastTitle}>{item.title}</Toast.Title>
        {item.description && <Toast.Description className={s.toastDescription}>{item.description}</Toast.Description>}
      </div>
      <div className={s.toastSide}>
        {item.action && (
          <Toast.Action altText={item.action.label} asChild>
            <Button size="sm" onClick={item.action.run}>
              {item.action.label}
            </Button>
          </Toast.Action>
        )}
        <Toast.Close asChild>
          <Button size="sm" variant="ghost" iconOnly icon={<X aria-hidden />}>
            Fechar
          </Button>
        </Toast.Close>
      </div>
    </Toast.Root>
  );
}

export function Toaster() {
  const items = useSyncExternalStore(toast.subscribe, toast.get, toast.get);
  return (
    <Toast.Provider swipeDirection="right" label="Notificações">
      {items.map((item) => (
        <ToastView key={item.id} item={item} />
      ))}
      <Toast.Viewport className={s.toasts} />
    </Toast.Provider>
  );
}
