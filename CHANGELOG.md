# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- Open-source governance: `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, `SECURITY.md`, issue/PR templates,
  Dependabot config, and CI/license badges in the README.

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
