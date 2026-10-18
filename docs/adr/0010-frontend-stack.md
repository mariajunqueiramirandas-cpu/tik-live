# ADR-0010: Frontend stack

**Status:** Proposed
**Date:** 2026-10-16
**Deciders:** Project owner

## Context

The dashboard is where creators design their host and run their stream. It
needs to feel native: instant navigation, no layout jumps, live data without
refreshes, solid keyboard and screen-reader support, and nothing that flickers
or loses input. It embeds the stage engine
([ADR-0009](0009-stage-engine.md)) for live previews. It also includes a
public landing page that should load fast and be indexable. The owner asked
for React.

## Decision

| Concern | Choice | Why |
|---|---|---|
| UI library | **React 19** | Owner's choice; concurrent rendering keeps typing responsive while live data streams in |
| Build | **Vite 8** (run under Bun) | Fast dev server; multi-entry build (dashboard and stage page) |
| Routing | **React Router 8**, data routers (`createBrowserRouter`), lazy routes | Route-level code splitting; loaders start fetching before components render |
| Server state | **TanStack Query 5** with the Hono RPC client | Caching, background refetch, optimistic mutations with rollback, dedupe |
| Live state | One studio WebSocket per open channel view, exposed through a `useSyncExternalStore` hook; snapshot patches update the store | Tear-free concurrent rendering; components subscribe to slices, so a stats tick doesn't re-render the transcript |
| UI primitives | **Radix UI** (dialog, dropdown, popover, tabs, tooltip, toast, switch, slider) | Correct focus management, keyboard support and ARIA; we only style them |
| Styling | Hand-written CSS: design tokens as custom properties in `tokens.css`, CSS Modules per component, cascade layers (`@layer reset, tokens, base, components, utilities`) | A bespoke visual identity (see [ADR-0011](0011-design-direction.md)), small CSS, no specificity fights |
| Forms | Controlled inputs with zod schemas from `packages/shared` | The same validation as the server; inline errors; no extra form library |
| Icons | `lucide-react`, tree-shaken | Consistent stroke icons |
| Charts | Small hand-written SVG components following the dataviz guidelines | Exactly the charts we need, themed, accessible, tiny |
| Fonts | Self-hosted with `@fontsource`, preloaded | No third-party requests; no layout shift (metric-matched fallbacks) |

### Making it feel native

- **Navigation:** lazy routes with **prefetch on hover and focus** (route code
  and the loader query), so most clicks render instantly. View Transitions
  for route changes where supported (short, subtle cross-fades), off under
  `prefers-reduced-motion`.
- **No spinners for fast operations:** skeletons appear only after 150 ms;
  placeholders reserve final dimensions, so nothing jumps.
- **Optimistic UI** for runtime commands, toggles and edits, with rollback
  and a toast on failure. Destructive actions get an undo toast instead of a
  confirm dialog where possible (channel delete still confirms).
- **Autosave** in the character editor: debounced saves with a visible saved
  state; edits update the embedded engine preview immediately (before saving).
- **Keyboard:** a command palette (`⌘K` / `Ctrl+K`) for navigation and
  actions. Studio shortcuts are shown in tooltips: `P` pause or resume, `S`
  focus the say box, `K` skip line. Every action is reachable without a mouse.
- **Connection awareness:** a quiet banner when the realtime socket is
  reconnecting; controls that need the server disable themselves rather than
  failing silently.
- **Error boundaries** per route and per panel: one failing panel never
  blanks the page.
- **Responsive:** the studio collapses to a single column on phones, with the
  kill switch always reachable.

### Landing page

Built from the same Vite project and **prerendered to static HTML at build
time** (a small build script using `react-dom/server`), then hydrated. The
hero runs the real engine in demo mode.

### Budgets

- First dashboard route: under 200 KB gzipped JS. The engine chunk loads
  lazily on routes that show a preview.
- Landing page: LCP under 2.0 s on a mid-range phone over 4G (lab measurement).
- These are targets. The build used to fail past them; that check was
  removed on 2026-10-18 at the owner's request.

## Options Considered

### Option A: React SPA with Vite, React Router, TanStack Query, Radix and hand-written CSS (chosen)

| Dimension | Assessment |
|---|---|
| Complexity | Medium |
| Cost | Free |
| Scalability | Scales to many routes with lazy loading |
| Team familiarity | High; owner asked for React |

**Pros:** Hono serves the SPA as static files (no Node SSR server to run);
excellent dev experience; accessible primitives; bespoke styling.
**Cons:** SEO only for the prerendered landing page (fine: the app is behind a login).

### Option B: Next.js or React Router framework mode (SSR)

| Dimension | Assessment |
|---|---|
| Complexity | High: a second server runtime next to Hono |
| Cost | More infrastructure |
| Scalability | Good |
| Team familiarity | High |

**Pros:** SSR everywhere; file-based routing.
**Cons:** duplicates the backend's job; the dashboard gains little from SSR;
deploy gets heavier.

### Option C: Tailwind CSS with a component kit (shadcn/ui)

| Dimension | Assessment |
|---|---|
| Complexity | Low |
| Cost | Free |
| Scalability | Good |
| Team familiarity | High |

**Pros:** fast to build.
**Cons:** pushes toward the recognizable default SaaS look the design
direction rejects; utility churn in JSX. (Radix underneath is the part we
keep.)

## Trade-off Analysis

The dashboard is an authenticated, realtime tool, so client rendering with
aggressive prefetching gives a more native feel than SSR round-trips. The
public landing page gets prerendering, which covers SEO without a second
server. Radix gives behavior and accessibility; our own CSS gives the look.

## Consequences

- Easier: one deployable (Hono serves everything); typed API calls end to end; consistent accessibility.
- Harder: we maintain our own design-system CSS (bounded by the tokens-first approach).
- Revisit: SSR only if marketing pages multiply.

## Action Items

1. [x] Scaffold `apps/web` (Vite multi-entry: `index.html`, `stage.html`), router, query client and RPC client.
2. [x] Build the design system: tokens, base styles, Radix-styled primitives (Button, Field, Dialog, Menu, Tabs, Toast, Switch, Slider, Tooltip).
3. [x] Build the studio store (`useSyncExternalStore`) and realtime hook with resync.
4. [x] Build the landing prerender script and size budgets in CI.
