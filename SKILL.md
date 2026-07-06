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

1. **Arm the driver** (do this ONCE, up front — see "Keep the agent driven" below). This is what makes
   feedback wake you even when you're idle between batches. Without it, marks the human sends after your
   turn ends just sit in the sidecar until you happen to poll again.
2. **Tell the human**: "Open **http://127.0.0.1:4000** and mark up the app with the bottom-center dock —
   drag a **Region** for a screenshot, click **Element** to pick a component, or type a message. Hit
   **Send to agent** when done." (The app renders exactly as at :3000, plus the dock.)
   - *Alternative — builder-shell mode:* point the human at
     **http://127.0.0.1:4000/__nitpicker-harness/shell** instead (the ready banner advertises both). The
     shell embeds the app in a same-origin iframe and keeps the chat + queue in a parent side-panel, so
     the queue **survives any in-iframe navigation** (SPA route change, reload, cross-origin excursion). A
     mode toolbar drives the full interactive layer from the parent — drag a **Region** for a screenshot,
     pick an **Element** for its component/selector, or use **Edit** to click a text node and edit it
     inline (Enter saves, Esc cancels), all read out of the iframe; it drains via the same `poll`.
3. **Drain the feedback** whenever the driver tells you to (or manually):

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
  runtime fiber walk — **works with zero target cooperation**), `selector` (short CSS path preferring
  testid/id/stable class), `testid`, `tag`, `role`, `text`, `rect`, plus `route`. `source`
  (`file:line:col`) is present **only** if the opt-in stamp is wired (below). Grep with
  `component`/`selector`/`text` + `route` when `source` is absent.
- **text-edit** — an inline text edit from the builder-shell **Edit** mode. `poll` prints `source`
  (`file:line:col`, only when the opt-in stamp is wired), then `edit: "old" → "new"`, then `component`
  and `selector`. Patch the string in source: prefer `source` when present, else locate it by
  `component`/`selector`/`text` + `route`. `item.element` carries the same descriptor as an element mark.
- **message** — plain `text`, with `route`/`pageUrl` for context.

The queue survives a killed/re-issued poll (cleared only on actual delivery), so feedback is never lost
— just re-run `poll` if it dies before the human hits Send.

## Opt-in: exact `file:line:col` source (owned-build-only)

A proxy sees the dev server's already-compiled output, so it cannot manufacture source locations for an
arbitrary app. `component` + `selector` + `text` + `route` are the baseline and are enough to grep to
the code — **apps without the stamp work exactly as before, just without `file:line`.** For an app whose
build you **control**, you can also get exact `file:line:col` by wiring the vendored dev-only stamp into
the **target's** `next.config`. This is the only target-side change — one config block, no source edits —
and it feeds `source` into both the builder-shell chat item and the drained `poll` payload.

**One-line wiring** (copy `vendor/nitpicker/next/` into the target, e.g. `<target>/nitpicker/next/`):

```ts
// next.config.ts  — dev-only source stamp for the nitpicker element picker (owned build only)
import type { NextConfig } from "next";
import path from "node:path";

const dev = process.env.NODE_ENV !== "production";
const loader = path.resolve("./nitpicker/next/nitpicker-source-loader.cjs");

const nextConfig: NextConfig = {
  ...(dev && {
    // Turbopack (`next dev` default in Next 15/16). Glob → loader; DON'T set `as`/`type` — the loader
    // returns tsx/jsx unchanged, so let Turbopack keep the file's native pipeline (an `as: "*.tsx"`
    // makes it re-append the extension → "Can't resolve ./foo.tsx.tsx").
    turbopack: {
      rules: {
        "*.tsx": { loaders: [loader] },
        "*.jsx": { loaders: [loader] },
      },
    },
    // Fallback for `next dev --webpack`. (`next build` sets NODE_ENV=production, so the stamp is off there.)
    webpack(config) {
      config.module.rules.push({ test: /\.[jt]sx$/, exclude: /node_modules/, use: [loader] });
      return config;
    },
  }),
};

export default nextConfig;
```

The loader is bundler-agnostic — the **same** `.cjs` runs under Turbopack `turbopack.rules` and webpack
`module.rules`. It stamps `data-nitpicker-source="file:line:col"` onto host JSX only (never components,
never `node_modules`), and any file it can't parse passes through unstamped rather than breaking the dev
build. Confirmed under Next 16 / Turbopack; regression-tested in `tests/source-stamp.test.ts`.

Prefer the full `nitpicker` install skill if you can — it gives the same source mapping plus prod-safety
gates. The harness's sweet spot is still **no target changes at all**; this stamp is the one opt-in for
teams who own the build and want `file:line` back.

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
