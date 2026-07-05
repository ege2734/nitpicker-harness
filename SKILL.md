---
name: nitpicker-harness
description: Point a same-origin proxy harness at a running web app's dev server and get the full nitpicker feedback overlay — region screenshots, element→component/selector, chat/queue → sidecar — with ZERO nitpicker code installed into the target repo. Use when a developer wants to visually mark up an app you are building (or any local dev server) and batch that feedback to the AI coding session, but you do not want to (or cannot) modify the target's source, layout, or bundler config. Fronts the dev server, injects the overlay on the fly, proxies HMR. Localhost dev target (Next.js reference); the browser-extension + platform tiers are out of scope for Phase 1.
user-invocable: true
---

# nitpicker-harness

Give the developer the nitpicker feedback overlay on **any running dev server** without touching their
repo. The harness is a reverse proxy: it fronts the target dev server under its **own** origin and
rewrites the streamed HTML to inject `@nitpicker/core`. Because the page is now same-origin with the
overlay, region screenshots, element→component/selector, the chat/queue, and the sidecar all work
**unmodified** — no install into the target, no layout edit, no `next.config` change.

Use this instead of the `nitpicker` install skill when you want the overlay but must keep the target
repo pristine (someone else's app, a repo you don't want to touch, a quick one-off review).

## When to use vs. the `nitpicker` install skill

- **`nitpicker-harness` (this skill):** zero code in the target. You get region + element
  (component/selector/text/route) + chat + sidecar. Exact `file:line:col` source is an **opt-in** (one
  bundler-config line — see below), not the default.
- **`nitpicker` (install skill):** vendors the overlay into the target repo. Full parity **including**
  `file:line:col` source out of the box, plus prod-safety gates. Use it for an app you own and are
  actively developing.

## Quickstart (the loop you run)

The target's dev server must already be running (e.g. `npm run dev` on `http://localhost:3000`).

```bash
# From this repo (or once published, `npx nitpicker-harness ...`):
npx nitpicker-harness --target http://localhost:3000
# → prints a harness URL, e.g. http://127.0.0.1:4000  (starts its own sidecar too)
```

Then:

1. **Tell the human**: "Open **http://127.0.0.1:4000** and mark up the app with the bottom-center dock —
   drag a **Region** for a screenshot, click **Element** to pick a component, or type a message. Hit
   **Send to agent** when done." (The app renders exactly as at :3000, plus the dock.)
2. **Drain the feedback** (long-poll; run it as a background task and act on the batch it prints):

   ```bash
   npx nitpicker-harness poll --session nitpicker
   ```

Flags: `--port <n>` (harness port, default 4000), `--session <id>` (default `nitpicker`),
`--sidecar-port <n>` (default 5178), `--no-sidecar` (if you already run one), `--endpoint <url>`.

## What `poll` returns and how to act on each item

`poll` prints a batch of items and exits (re-run, or pass `--watch` to keep receiving). Act by `kind`:

- **region** — `item.image.path` is a **local PNG** with the red box already burned in and the rest
  dimmed. Open it with your image tool; `selectionRect` (CSS px) + `route`/`pageUrl` locate the area.
  Fix what's boxed.
- **element** — `item.element` carries an agent-grade descriptor: `component` (React name, from the
  runtime fiber walk — **works with zero target cooperation**), `selector` (short CSS path preferring
  testid/id/stable class), `testid`, `tag`, `role`, `text`, `rect`, plus `route`. `source`
  (`file:line:col`) is present **only** if the opt-in stamp is wired (below). Grep with
  `component`/`selector`/`text` + `route` when `source` is absent.
- **message** — plain `text`, with `route`/`pageUrl` for context.

The queue survives a killed/re-issued poll (cleared only on actual delivery), so feedback is never lost
— just re-run `poll` if it dies before the human hits Send.

## Opt-in: exact `file:line:col` source (the one thing that isn't free)

A proxy sees the dev server's already-compiled output, so it cannot manufacture source locations for an
arbitrary app. `component` + `selector` + `text` + `route` are the baseline and are enough to grep to
the code. To also get exact `file:line:col`, add the vendored dev-only stamp to the **target's** bundler
(this is the only target-side change, and it's one config block, no source edits):

- Copy `vendor/nitpicker/next/` into the target and wire `nitpicker-source-loader.cjs` into
  `next.config` under `turbopack.rules` / `webpack`, gated on `NODE_ENV !== "production"` (see
  `vendor/nitpicker/next/` and the original nitpicker SKILL for the exact snippet).

If you can add that line, prefer the full `nitpicker` install skill instead — it gives the same source
mapping plus prod-safety. The harness's sweet spot is **no target changes at all**.

## Verifying it works

1. `npx nitpicker-harness --target <dev-url>` → open the printed URL; the app renders and a
   bottom-center dock appears (check the console for `[nitpicker-harness] overlay mounted`).
2. Region-drag a box → the view freezes with a red box; **Queue** → **Send to agent** → a running
   `poll` prints the item with a local PNG path.
3. Element-click a node your components render → the queued item carries `component` + `selector`.

## Scope (Phase 1)

Localhost dev servers, reference target Next.js (App Router / React 19). The proxy handles HTML
injection, absolute-URL rewriting, framing/CSP relaxation, and HMR WebSocket forwarding. **Out of
scope** for Phase 1: the browser extension (for deployed / non-owned sites) and the platform layer.
Hard auth redirects to third-party IdPs and non-Next frameworks are known follow-ups.
