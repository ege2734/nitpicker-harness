---
name: nitpicker-harness
description: Point a same-origin proxy harness at a running web app's dev server and get the full feedback overlay — region screenshots, element→component/selector/source, chat/queue → sidecar — with ZERO overlay code installed into the target repo. Use when a developer wants to visually mark up an app you are building (or any local dev server) and batch that feedback to the AI coding session, but you do not want to (or cannot) modify the target's source or layout. Fronts the dev server, injects the overlay on the fly, proxies HMR. Localhost dev target (Next.js reference); the browser-extension + platform tiers are out of scope for Phase 1.
user-invocable: true
---

# nitpicker-harness

Give the developer the feedback overlay on **any running dev server** without touching their repo. The
harness is a reverse proxy: it fronts the target dev server under its **own** origin and rewrites the
streamed HTML to inject the overlay. Because the page is now same-origin with the overlay, region
screenshots, element→component/selector/**source**, the chat/queue, and the sidecar all work
**unmodified** — no install into the target, no layout edit.

Use this whenever you want the overlay on a running app: someone else's app, a repo you don't want to
touch, or an app you own and are actively developing. Element pick returns a full descriptor —
`component`, `selector`, `text`, `route`, and (for an owned Next build) exact `file:line:col`
`source`; the setup below wires the source location on automatically.

## Quickstart (the loop you run)

The target's dev server must already be running (e.g. `npm run dev` on `http://localhost:3000`).

```bash
# From this repo (or once published, `npx nitpicker-harness ...`):
npx nitpicker-harness --target http://localhost:3000
# → prints a harness URL, e.g. http://127.0.0.1:4000  (starts its own sidecar too)
```

Then:

1. **Wire source locations** (do this ONCE, up front, as a standard setup step — see "Turn on
   `file:line:col` source" below). If the target is a Next app you own, this makes element pick report the
   exact `file:line:col`; it **detects-and-skips cleanly** for any app you don't own or that isn't
   Next/Turbopack, so it's always safe to run first.
2. **Arm the driver** (do this ONCE, up front — see "Keep the agent driven" below). This is what makes
   feedback wake you even when you're idle between batches. Without it, marks the human sends after your
   turn ends just sit in the sidecar until you happen to poll again.
3. **Tell the human**: "Open **http://127.0.0.1:4000** and mark up the app with the bottom-center dock —
   drag a **Region** for a screenshot, click **Element** to pick a component, or type a message. Hit
   **Send to agent** when done." (The app renders exactly as at :3000, plus the dock.)
   - *Alternative — builder-shell mode:* point the human at
     **http://127.0.0.1:4000/__nitpicker-harness/shell** instead (the ready banner advertises both). The
     shell embeds the app in a same-origin iframe and keeps the chat + queue in a parent side-panel, so
     the queue **survives any in-iframe navigation** (SPA route change, reload, cross-origin excursion). A
     mode toolbar drives the full interactive layer from the parent — drag a **Region** for a screenshot,
     pick an **Element** for its component/selector, or use **Edit** to click a text node and edit it
     inline (Enter saves, Esc cancels), all read out of the iframe; it drains via the same `poll`.
4. **Drain the feedback** whenever the driver tells you to (or manually):

   ```bash
   npx nitpicker-harness poll --session nitpicker
   ```

Flags: `--port <n>` (harness port, default 4000), `--session <id>` (default `nitpicker`),
`--sidecar-port <n>` (default 5178), `--no-sidecar` (if you already run one), `--endpoint <url>`.

## Keep the agent driven (install the Stop hook) — the default, do this first

Feedback must **drive** you, not wait for you to remember to poll. `poll` (even `poll --watch`) only
delivers while you are actively running it; the moment a turn ends and you go idle, newly-queued marks
sit in the sidecar and nothing re-invokes you. The fix is a **turn-end Stop hook** that parks on the
sidecar with **zero token cost** and re-invokes you the instant a mark lands — the same "blocking watcher
+ turn-end trigger" pattern a supervisor uses to drive an idle worker.

Install it once by adding a `Stop` hook to `.claude/settings.json` (project or user scope):

```json
{
  "hooks": {
    "Stop": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "npx nitpicker-harness stop-hook --session nitpicker",
            "timeout": 3600
          }
        ]
      }
    ]
  }
}
```

- Match `--session` (and add `--endpoint http://127.0.0.1:<sidecar-port>` if you changed it) to how you
  launched the harness.
- The large `timeout` (seconds) is the wall-clock ceiling the harness stays *parked* on one idle stretch
  — the hook blocks on a long-poll for that whole window at no token cost, so make it as long as your
  session. When it does elapse with nothing pending, you simply go idle; the queue is durable, so the
  next turn re-arms and picks up anything that arrived meanwhile.

**How the loop runs, once armed:** you finish a turn → the Stop hook parks (blocked long-poll, zero
tokens) → the human hits **Send** → the hook wakes instantly and returns a `block` decision that
re-invokes you with "N feedback item(s) waiting — run `poll`" → you drain with `poll`, address every
item, and stop → the hook re-arms. It is a no-op (lets you idle) when nothing is pending, and **fails
open**: if the sidecar is down it never wedges your stop.

If your agent harness has no Stop-hook equivalent, fall back to running `poll --watch` in the
foreground as a first-class listening loop and keep it armed — but the Stop hook is strictly more
reliable because it survives your turns going idle.

Cheap manual signal if you ever want to check by hand: `npx nitpicker-harness pending --session nitpicker`
→ `{ "pending": <count> }` (never drains).

## What `poll` returns and how to act on each item

`poll` prints a batch of items and exits (re-run, or pass `--watch` to keep receiving). Act by `kind`:

- **region** — `item.image.path` is a **local PNG** with the red box already burned in and the rest
  dimmed. Open it with your image tool; `selectionRect` (CSS px) + `route`/`pageUrl` locate the area.
  Fix what's boxed.
- **element** — `item.element` carries an agent-grade descriptor: `component` (React name, from the
  runtime fiber walk), `source` (`file:line:col`, for an owned Next build — wired by the setup step),
  `selector` (short CSS path preferring testid/id/stable class), `testid`, `tag`, `role`, `text`, `rect`,
  plus `route`. Open `source` directly when present; otherwise grep with `component`/`selector`/`text` +
  `route` (both routes land you on the code).
- **text-edit** — an inline text edit from the builder-shell **Edit** mode. `poll` prints `source`
  (`file:line:col`), then `edit: "old" → "new"`, then `component` and `selector`. Patch the string in
  source: prefer `source` when present, else locate it by `component`/`selector`/`text` + `route`.
  `item.element` carries the same descriptor as an element mark.
- **message** — plain `text`, with `route`/`pageUrl` for context.

The queue survives a killed/re-issued poll (cleared only on actual delivery), so feedback is never lost
— just re-run `poll` if it dies before the human hits Send.

## Turn on `file:line:col` source (default setup step)

Element pick reports the exact `file:line:col` of the clicked node when the target is a Next app **you
own**. Wire it in as a standard part of setup — one dependency, one copied folder, one wrapped line in
`next.config`. It is **dev-only** (off in `next build`) and it **detects-and-skips cleanly**: an app you
don't control, or one that isn't Next/Turbopack, needs none of this and still returns
`component` + `selector` + `text` + `route` on every element pick. So run the three steps when the target
is an owned Next app; skip them (no error, nothing lost) otherwise.

**1. Add the one dependency the stamp needs** (the loader transforms JSX with Babel):

```bash
npm install --save-dev @babel/core   # in the TARGET app
```

**2. Copy the source-stamp folder into the target** (e.g. `<target>/nitpicker/next/`):

```bash
cp -R vendor/nitpicker/next <target>/nitpicker/next
```

**3. Wrap the target's `next.config` export** with `withNitpickerSource(...)` — one import, one wrap. It
composes with whatever config is already there (spreads `turbopack`/`webpack`, never clobbers), and works
for `.ts`, `.mjs`, `.js`, or `.cjs`:

```ts
// next.config.ts  (add the import + wrap the default export — that's the whole change)
import type { NextConfig } from "next";
import { withNitpickerSource } from "./nitpicker/next/with-nitpicker-source.cjs";

const nextConfig: NextConfig = {
  /* ...whatever was already here (may be {} for a fresh app)... */
};

export default withNitpickerSource(nextConfig);
```

Restart `next dev` after wiring (the loader is applied at compile time). `withNitpickerSource` turns on
the dev-only source-stamp loader under both Turbopack (`turbopack.rules`) and webpack
(`config.module.rules`) — the **same** bundler-agnostic `.cjs` for both — gated on
`NODE_ENV !== "production"`, so `next build` is returned untouched. The loader stamps
`data-nitpicker-source="file:line:col"` onto host JSX only (never components, never `node_modules`); any
file it can't parse passes through unstamped rather than breaking the dev build, and the picker prefers
`source` when the attribute is present. Once wired, `source` rides both the builder-shell chat item and
the drained `poll` payload (e.g. `source: "app/pricing-card.tsx:11:7"`). Regression-tested in
`tests/source-stamp.test.ts`; confirmed end-to-end under Next 16 / Turbopack through the proxy.

> **If you can't restart or don't own the build:** skip this section. Element pick still returns
> `component` + `selector` + `text` + `route`, which is enough to grep straight to the code.

## Verifying it works

1. `npx nitpicker-harness --target <dev-url>` → open the printed URL; the app renders and a
   bottom-center dock appears (check the console for `[nitpicker-harness] overlay mounted`).
2. Region-drag a box → the view freezes with a red box; **Queue** → **Send to agent** → a running
   `poll` prints the item with a local PNG path.
3. Element-click a node your components render → the queued item carries `component` + `selector` (plus
   `source: file:line:col` once the source step above is wired on an owned Next app).

## Scope (Phase 1)

Localhost dev servers, reference target Next.js (App Router / React 19). The proxy handles HTML
injection, absolute-URL rewriting, framing/CSP relaxation, and HMR WebSocket forwarding. **Out of
scope** for Phase 1: the browser extension (for deployed / non-owned sites) and the platform layer.
Hard auth redirects to third-party IdPs and non-Next frameworks are known follow-ups.
