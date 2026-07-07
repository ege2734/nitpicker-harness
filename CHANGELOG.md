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
- Open-source governance: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  Dependabot config, and CI/license badges in the README.

### Fixed
- **Region freeze no longer shifts the page** — `Overlay.appWidth()` now measures
  `documentElement.clientWidth` (viewport minus a classic scrollbar's gutter) instead of
  `window.innerWidth`, so the frozen-region clone lays out at the live content width. Only visible with
  classic (non-overlay) scrollbars; a no-op under 0-width overlay scrollbars.
- **Region selection visual persists while composing** — the dim bands + red outline now stay on screen
  after mouse-up until the queue card is committed or dismissed, so the framed region stays visible.

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
