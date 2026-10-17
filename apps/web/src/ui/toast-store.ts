import { errorMessage } from "../lib/api";

export type ToastTone = "info" | "success" | "error";

export interface ToastItem {
  id: number;
  tone: ToastTone;
  title: string;
  description?: string;
  action?: { label: string; run: () => void };
  durationMs: number;
}

type Listener = () => void;

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

function push(item: Omit<ToastItem, "id" | "durationMs"> & { durationMs?: number }): number {
  const id = nextId++;
  items = [...items.slice(-3), { durationMs: item.tone === "error" ? 8000 : 4000, ...item, id }];
  emit();
  return id;
}

/** A tiny external store so any module (mutations included) can raise a toast. */
export const toast = {
  info: (title: string, description?: string) => push({ tone: "info", title, ...(description ? { description } : {}) }),
  success: (title: string, description?: string) => push({ tone: "success", title, ...(description ? { description } : {}) }),
  error: (title: string, error?: unknown) => push({ tone: "error", title, ...(error !== undefined ? { description: errorMessage(error) } : {}) }),
  /** For reversible actions: "Deleted. Undo" instead of a confirm dialog. */
  undoable: (title: string, undo: () => void) => push({ tone: "info", title, action: { label: "Desfazer", run: undo }, durationMs: 6000 }),
  dismiss(id: number): void {
    items = items.filter((t) => t.id !== id);
    emit();
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  get: (): ToastItem[] => items,
};
