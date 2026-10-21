import { PRODUCT_NAME } from "@tik-live/shared";
import { CreditCard, Menu as MenuIcon, Plus, Search, UserRound, X } from "lucide-react";
import { Dialog as RadixDialog } from "radix-ui";
import { useEffect, useState } from "react";
import { Link, NavLink, Outlet, useLocation, useNavigation } from "react-router";
import { CommandPalette } from "../components/CommandPalette";
import { HostSwatch, LanternMark } from "../components/Brand";
import { prefetchProps } from "../lib/prefetch";
import { useChannels, useMe } from "../lib/query";
import { count } from "../lib/format";
import { Skeleton, Status, statusLabel } from "../ui/Display";
import { cx } from "../ui/cx";
import s from "./shell.module.css";

function HostList({ onNavigate }: { onNavigate?: () => void }) {
  const { data: channels, isPending } = useChannels();
  return (
    <nav aria-label="Seus apresentadores" className={s.hosts}>
      <p className={s.navHeading} id="hosts-heading">
        Apresentadores
      </p>
      {isPending ? (
        <div className={s.hostSkeletons}>
          <Skeleton height={36} />
          <Skeleton height={36} />
        </div>
      ) : (
        <ul role="list" aria-labelledby="hosts-heading" className={s.hostList}>
          {channels?.map((channel) => (
            <li key={channel.id}>
              <NavLink
                to={`/app/hosts/${channel.id}`}
                className={({ isActive }) => cx(s.hostLink, isActive && s.active)}
                onClick={onNavigate}
                viewTransition
                {...prefetchProps(`/app/hosts/${channel.id}`)}
              >
                <span className={cx(s.swatchWrap, channel.runtime.status === "live" && s.swatchLive)} data-square={channel.persona.look.character === "voice-line" || undefined}>
                  <HostSwatch look={channel.persona.look} size={24} />
                </span>
                <span className={s.hostName}>{channel.name}</span>
                {channel.runtime.status === "live" ? (
                  <span className={s.hostLive} aria-label={`Ao vivo, ${channel.runtime.viewers} assistindo`}>
                    {count(channel.runtime.viewers)}
                  </span>
                ) : channel.runtime.status !== "stopped" ? (
                  <Status status={channel.runtime.status}>
                    <span className="visually-hidden">{statusLabel(channel.runtime.status)}</span>
                  </Status>
                ) : null}
              </NavLink>
            </li>
          ))}
        </ul>
      )}
      <Link to="/app/new" className={s.newHost} onClick={onNavigate} {...prefetchProps("/app/new")}>
        <Plus aria-hidden /> Novo apresentador
      </Link>
    </nav>
  );
}

function SidebarContent({ onNavigate, onSearch }: { onNavigate?: () => void; onSearch: () => void }) {
  const { data: me } = useMe();
  return (
    <>
      <Link to="/app" className={s.brand} onClick={onNavigate} {...prefetchProps("/app")}>
        <LanternMark />
        <span>{PRODUCT_NAME}</span>
      </Link>
      <button type="button" className={s.search} onClick={onSearch}>
        <Search aria-hidden />
        <span>Ir para…</span>
        <kbd>{navigator.platform.includes("Mac") ? "⌘K" : "Ctrl K"}</kbd>
      </button>
      <HostList onNavigate={onNavigate} />
      <nav aria-label="Conta" className={s.footerNav}>
        <NavLink to="/app/billing" className={({ isActive }) => cx(s.footerLink, isActive && s.active)} onClick={onNavigate} {...prefetchProps("/app/billing")}>
          <CreditCard aria-hidden />
          <span>Plano e assinatura</span>
        </NavLink>
        <NavLink to="/app/account" className={({ isActive }) => cx(s.footerLink, isActive && s.active)} onClick={onNavigate} {...prefetchProps("/app/account")}>
          <UserRound aria-hidden />
          <span>Conta</span>
          {me?.devUser && <span className={s.dev}>Teste: {me.devUser}</span>}
        </NavLink>
      </nav>
    </>
  );
}

/** A thin bar at the top while a navigation takes longer than 150 ms. */
function NavigationProgress() {
  const navigation = useNavigation();
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (navigation.state === "idle") return setVisible(false);
    const timer = setTimeout(() => setVisible(true), 150);
    return () => clearTimeout(timer);
  }, [navigation.state]);
  return <div className={cx(s.progress, visible && s.progressOn)} role="progressbar" aria-hidden={!visible} aria-label="Carregando" />;
}

export function Root() {
  const [drawer, setDrawer] = useState(false);
  const [palette, setPalette] = useState(false);
  const location = useLocation();

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, []);

  // Move focus to the page on navigation so screen readers announce it.
  useEffect(() => {
    document.getElementById("main")?.focus({ preventScroll: true });
  }, [location.pathname]);

  return (
    <div className={s.shell}>
      <a href="#main" className={s.skip}>
        Pular para o conteúdo
      </a>
      <NavigationProgress />
      <aside className={s.sidebar}>
        <SidebarContent onSearch={() => setPalette(true)} />
      </aside>

      <header className={s.topbar}>
        <Link to="/app" className={s.brand}>
          <LanternMark />
          <span>{PRODUCT_NAME}</span>
        </Link>
        <RadixDialog.Root open={drawer} onOpenChange={setDrawer}>
          <RadixDialog.Trigger className={s.menuButton} aria-label="Abrir menu">
            <MenuIcon aria-hidden />
          </RadixDialog.Trigger>
          <RadixDialog.Portal>
            <RadixDialog.Overlay className={s.drawerOverlay} />
            <RadixDialog.Content className={s.drawer} aria-describedby={undefined}>
              <RadixDialog.Title className="visually-hidden">Menu</RadixDialog.Title>
              <RadixDialog.Close className={s.drawerClose} aria-label="Fechar menu">
                <X aria-hidden />
              </RadixDialog.Close>
              <SidebarContent
                onNavigate={() => setDrawer(false)}
                onSearch={() => {
                  setDrawer(false);
                  setPalette(true);
                }}
              />
            </RadixDialog.Content>
          </RadixDialog.Portal>
        </RadixDialog.Root>
      </header>

      <main id="main" className={s.main} tabIndex={-1}>
        <Outlet />
      </main>
      <CommandPalette open={palette} onOpenChange={setPalette} />
    </div>
  );
}

export function ShellFallback() {
  return (
    <div className={s.shell}>
      <aside className={s.sidebar}>
        <div className={s.brand}>
          <LanternMark />
          <span>{PRODUCT_NAME}</span>
        </div>
      </aside>
      <main className={s.main} />
    </div>
  );
}
