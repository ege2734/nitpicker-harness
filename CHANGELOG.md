# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Embedded-agent mode** — `nitpicker-harness <path-to-app>` owns the app's dev server (auto-detected
  `next dev` / `vite` / `react-scripts start` / `scripts.dev`, or an explicit `--dev-cmd` binding `$PORT`)
  and makes the side pane a **live agent you build with** (Claude Agent SDK in-process backend + SSE
  gateway, with a `claude-cli` spawn fallback) instead of an external `poll`-drained queue. Strictly
  additive: the feedback-proxy / builder-shell / sidecar / `poll` / Stop-hook paths are unchanged. Also
  exposed as the `startEmbeddedBuilder()` library (`src/index.ts`), with `@anthropic-ai/claude-agent-sdk`
  as an optional dependency and a `--no-agent` escape hatch to the classic sidecar sink.
- **Default builder-agent persona** — every embedded session runs the Loom builder system prompt
  (`LOOM_BUILDER_SYSTEM_PROMPT`) by default, shared by the standalone CLI and Loom's own in-app builder.
  Override per session with `--system-prompt <file>`, the `systemContext` option, or the
  `NITPICKER_HARNESS_SYSTEM_PROMPT` env var (explicit value wins over the env var, which wins over the
  default).
- **Builder-pane rapid-iteration UX** — the embedded builder pane gains a per-mark annotate popup (add a
  note and **Queue**, or Esc/Cancel to discard), persist-selection-until-commit (the red box + a dimmed
  preview backdrop stay up while annotating), the classic queue UX at parity (expandable queued marks with
  the red-boxed region screenshot, a full-screen lightbox, remove, and a count), a composer queueing model
  (**Enter** stages a message, **⌘/Ctrl+Enter** flushes the whole queue as one turn, **Shift+Enter**
  newlines), sent-turn history (flushed batches persist as expandable transcript entries above the reply),
  and sanitized, stream-safe **markdown** agent replies. Builder-pane only — the classic shell /
  feedback-proxy / sidecar / `poll` paths are unchanged.
- Open-source governance: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  Dependabot config, and CI/license badges in the README.

### Fixed
- **Runnable as a clean, no-dev dependency** — the package now ships **compiled JS in `dist/`** and runs
  it with plain `node`; there is no `tsx` at runtime. Previously the `bin` and sidecar ran the TypeScript
  source under `tsx` (a devDependency), so a production/git install crashed at startup with
  `Cannot find module .../tsx/dist/cli.mjs` (`ERR_PACKAGE_PATH_NOT_EXPORTED` under pnpm). `prepare`/`prepack`
  build `dist/` on install/publish; `esbuild`/`html2canvas` moved to devDependencies, leaving `http-proxy`
  as the only runtime dependency (the Claude Agent SDK stays an optional dynamic import). The consumer
  contract is unchanged (same CLI and `import … from "nitpicker-harness"`); `npm run verify-pack` guards it.
- **Region freeze no longer shifts the page** — `Overlay.appWidth()` now measures
  `documentElement.clientWidth` (viewport minus a classic scrollbar's gutter) instead of
  `window.innerWidth`, so the frozen-region clone lays out at the live content width. Only visible with
  classic (non-overlay) scrollbars; a no-op under 0-width overlay scrollbars.
- **Region selection visual persists while composing** — the dim bands + red outline now stay on screen
  after mouse-up until the queue card is committed or dismissed, so the framed region stays visible.
- **Region capture supports modern CSS colors** — the rasterizer swapped `html2canvas` → `html2canvas-pro`
  (an API-compatible drop-in fork), so `oklab()`/`oklch()`/`color()` values (reached via `color-mix()` and
  modern design tokens) no longer throw `Attempting to parse an unsupported color function oklab` mid-capture.
- **Icon fonts no longer rasterize as tofu boxes** — region screenshots taken from the builder/shell (which
  raster a *different* document than the ambient one via the `Env` seam) now embed the source document's
  `@font-face` bytes into the drawing document before capture (`embedFontsForCapture`), so self-hosted icon
  webfonts (e.g. `@loom/ds`'s Phosphor PUA glyphs) render instead of □.
- **Overlay suppression is mode-gated** — in embedded/builder mode the classic in-frame overlay is never
  injected (the builder pane is the sole UI), replacing an earlier per-request query flag that re-injected on
  redirects / SPA navigation. Classic feedback-proxy / shell mode injects exactly as before.

## [0.1.0]

Phase 1 — localhost dev proxy, Next.js reference target.

### Added
- **Same-origin reverse proxy** that fronts a target dev server and injects the feedback overlay into the
  streamed HTML, with zero overlay code in the target's repo.
- **Region screenshots** — drag a box; the live DOM is rasterized (html2canvas) with a red box burned in.
- **Element pick** — click a node to get its React component name (runtime fiber walk), a stable CSS
  selector, testid, text, role, rect, and route.
- **`file:line:col` source provenance** on owned Next builds via the dev-only `withNitpickerSource`
  `next.config` wrapper; degrades cleanly to component + selector + text + route without it.
- **Builder-shell mode** — a parent-hosted chat + queue over a same-origin `<iframe>` that survives any
  in-iframe navigation, plus inline click-to-edit text.
- **Sidecar + `poll` CLI** — batch feedback POSTs drained by a session-keyed sidecar.
- **Turn-end Stop hook** — parks on the sidecar's non-draining `/wait` at zero token cost and re-invokes
  an idle agent the instant a mark lands; the queue is durable, so marks are never lost.
- **HMR WebSocket forwarding** via a raw-socket tunnel (Next 16 / Turbopack verified).

[Unreleased]: https://github.com/ege2734/nitpicker-harness/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/ege2734/nitpicker-harness/releases/tag/v0.1.0
