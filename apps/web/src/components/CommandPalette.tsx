import { BarChart3, CreditCard, Home, Mic2, Plus, Radio, Settings2, ShieldCheck, Sparkles, UserRound } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useMemo, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { prefetch } from "../lib/prefetch";
import { useChannels } from "../lib/query";
import s from "./palette.module.css";
import { cx } from "../ui/cx";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: ReactNode;
  to: string;
}

/** ⌘K / Ctrl+K: jump anywhere without the mouse (ADR-0010). */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { data: channels } = useChannels();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);

  const commands = useMemo<Command[]>(() => {
    const list: Command[] = [
      { id: "home", label: "Your hosts", icon: <Home aria-hidden />, to: "/app" },
      { id: "new", label: "Create a new host", icon: <Plus aria-hidden />, to: "/app/new" },
    ];
    for (const c of channels ?? []) {
      list.push(
        { id: `${c.id}-studio`, label: `${c.name}: studio`, hint: "Run the show", icon: <Radio aria-hidden />, to: `/app/hosts/${c.id}` },
        { id: `${c.id}-character`, label: `${c.name}: character`, hint: "Personality, voice and look", icon: <Sparkles aria-hidden />, to: `/app/hosts/${c.id}/character` },
        { id: `${c.id}-safety`, label: `${c.name}: safety`, icon: <ShieldCheck aria-hidden />, to: `/app/hosts/${c.id}/safety` },
        { id: `${c.id}-setup`, label: `${c.name}: setup`, hint: "TikTok, OBS and the stage link", icon: <Settings2 aria-hidden />, to: `/app/hosts/${c.id}/setup` },
        { id: `${c.id}-analytics`, label: `${c.name}: analytics`, icon: <BarChart3 aria-hidden />, to: `/app/hosts/${c.id}/analytics` },
      );
    }
    list.push(
      { id: "billing", label: "Plan and billing", icon: <CreditCard aria-hidden />, to: "/app/billing" },
      { id: "account", label: "Account", icon: <UserRound aria-hidden />, to: "/app/account" },
      { id: "voice", label: "Choose a voice", hint: "In the character editor", icon: <Mic2 aria-hidden />, to: channels?.[0] ? `/app/hosts/${channels[0].id}/character?tab=voice` : "/app/new" },
    );
    return list;
  }, [channels]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    const words = q.split(/\s+/);
    return commands.filter((c) => words.every((w) => `${c.label} ${c.hint ?? ""}`.toLowerCase().includes(w)));
  }, [commands, query]);

  const go = (command: Command | undefined) => {
    if (!command) return;
    onOpenChange(false);
    setQuery("");
    void navigate(command.to, { viewTransition: true });
  };

  const current = Math.min(active, Math.max(0, results.length - 1));

  return (
    <RadixDialog.Root
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setQuery("");
      }}
    >
      <RadixDialog.Portal>
        <RadixDialog.Overlay className={s.overlay} />
        <RadixDialog.Content className={s.palette} aria-describedby={undefined}>
          <RadixDialog.Title className="visually-hidden">Go to</RadixDialog.Title>
          <input
            className={s.input}
            autoFocus
            placeholder="Type a host or a page"
            value={query}
            role="combobox"
            aria-expanded
            aria-controls="palette-results"
            aria-activedescendant={results[current] ? `cmd-${results[current].id}` : undefined}
            onChange={(e) => {
              setQuery(e.target.value);
              setActive(0);
            }}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") {
                e.preventDefault();
                setActive((current + 1) % Math.max(1, results.length));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setActive((current - 1 + results.length) % Math.max(1, results.length));
              } else if (e.key === "Enter") {
                e.preventDefault();
                go(results[current]);
              }
            }}
          />
          <ul id="palette-results" role="listbox" className={s.results}>
            {results.length === 0 && <li className={s.empty}>Nothing matches “{query}”.</li>}
            {results.map((command, i) => (
              <li
                key={command.id}
                id={`cmd-${command.id}`}
                role="option"
                aria-selected={i === current}
                className={cx(s.result, i === current && s.current)}
                onPointerMove={() => {
                  setActive(i);
                  prefetch(command.to);
                }}
                onClick={() => go(command)}
              >
                {command.icon}
                <span className={s.label}>{command.label}</span>
                {command.hint && <span className={s.hint}>{command.hint}</span>}
              </li>
            ))}
          </ul>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
