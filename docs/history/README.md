# Project history — the reasoning behind the code

This directory is the **archive of how nitpicker-harness was designed and built**: the architecture
studies, feasibility spikes, build plans, UX-fix rounds and the public-readiness audit that produced the
code in `src/` and `vendor/`. It was written between **2026-07-02 and 2026-07-07**, folded into the repo
afterwards so the "why" survives alongside the "what".

Nothing here is a how-to. For current usage read [`README.md`](../../README.md) and
[`SKILL.md`](../../SKILL.md); for the durable design invariants read [`AGENTS.md`](../../AGENTS.md).
Read these documents for **intent and trade-offs at the time of writing** — several describe limits that
were later removed (e.g. `file:line:col` source went from "one honest limit" to a default setup step).

## Start here

The two highest-value documents are **not** in this directory — they are the design authority the code
still follows, and they live one level up:

| Document | What it is |
|---|---|
| [`../viability-report.md`](../viability-report.md) | **The design authority.** Why the harness must be a *same-origin reverse proxy* rather than a cross-origin iframe shell, grounded in the overlay-engine source with `file:line` references. §3a and §6 are cited by nearly every build plan below. *(2026-07-05)* |
| [`../competitive-landscape.md`](../competitive-landscape.md) | **The prior-art scan.** Deep-research pass on whether an OSS dependency-free harness giving an external agent both region screenshots and element→component→source already existed. Verdict: largely whitespace. *(2026-07-05)* |

After those, the two documents that shaped everything since are
[`builder-shell-spike/report.md`](./builder-shell-spike/report.md) (the shell architecture + the phased
plan Phases 0–4 were built from) and
[`embedded-agent-design/report.md`](./embedded-agent-design/report.md) (the embedded-agent extension:
`AppRuntime`, `AgentBackend`, the Agent Gateway, `startEmbeddedBuilder()`).

## How to read these

Each subdirectory is one investigation. Most contain:

- **`brief.md`** — the assignment, written *to* an autonomous agent before the work started. It states the
  problem, the constraints, and what was already known. Written in the imperative, and it carries the
  boilerplate of the harness that dispatched it (branch/PR/status-file rules) — skim past that; the first
  two sections are the substance.
- **`report.md`** — the findings, written *after*. Where a directory has one, it is the primary document;
  the brief is context for what was asked.

Absolute machine paths were rewritten to `~/` on fold-in, and references between these documents were
repointed to their new locations. Some briefs still reference material that stayed outside this repo
(`loom-vision.md`, `loom-decisions.md`, other projects' reports) — those paths are left as written so the
reference is at least legible.

---

## Design studies & spikes

The investigations that decided architecture. Read these first.

| Document | Covers | When |
|---|---|---|
| [`viability-study/brief.md`](./viability-study/brief.md) | The assignment that produced [`../viability-report.md`](../viability-report.md): can nitpicker become a standalone harness pointed at *any* app, with zero code in the target repo? *(The report itself lives at `docs/viability-report.md` — it was committed there when Phase 1 landed.)* | 2026-07-05 |
| [`builder-shell-spike/`](./builder-shell-spike/) | **Feasibility spike + the phased build plan.** Should the harness be re-architected into a "builder shell" — persistent chat, browser-in-a-browser preview, element→source provenance — for *building* an app rather than annotating one? Verdict plus §4b hydration evidence, the §5 single-offset geometry rule, and the Phase 0–4 breakdown. In-browser proof included. | 2026-07-05 |
| [`embedded-agent-design/`](./embedded-agent-design/) | **The embedded-agent design.** Turning the side pane into a live agent you build with, rather than an external `poll`-drained queue: `AppRuntime`, `AgentBackend`, the SSE Agent Gateway, the `InteractionLayer` extraction, and the `startEmbeddedBuilder()` interface. §7 is the concrete `src/` change list W1 was implemented from. | 2026-07-06 |
| [`instant-capture-spike/`](./instant-capture-spike/) | **Spike: truly-instant region capture.** Can `Cmd/Ctrl+Shift+X` draw with zero visible freeze by cloning the DOM at keypress and deferring the html2canvas raster? Verdict: viable (~20 ms), preserves hover-only cards. Includes the three verification screenshots the report references. | 2026-07-05 |

## Build plans

Briefs that were implemented. Each states the intent behind a shipped feature.

| Document | Covers | When |
|---|---|---|
| [`harness-mvp-phase1/`](./harness-mvp-phase1/) | **Phase 1 MVP** — build the same-origin proxy harness from the viability report: proxy + injected overlay + sidecar, vendoring nitpicker's core rather than depending back on it. | 2026-07-05 |
| [`vendor-core-sync/`](./vendor-core-sync/) | Bring the vendored nitpicker core up to nitpicker `main` (docked pane, region fixes, region-speed work) **and** commit the viability + landscape research into `docs/`. | 2026-07-05 |
| [`reliable-feedback-driver/`](./reliable-feedback-driver/) | **The idle-agent problem** — marks that land after a turn ends sit undriven. The design brief behind the durable queue + `/wait` long-poll + Stop-hook driver. | 2026-07-05 |
| [`shell-phase0-hydration/`](./shell-phase0-hydration/) | **Phase 0** — fix client hydration and HMR through the proxy on Next 16 / Turbopack. Prerequisite for every element/component feature (no fibers, no component names). | 2026-07-06 |
| [`shell-phase1-hybrid-shell/`](./shell-phase1-hybrid-shell/) | **Phase 1** — the hybrid shell: proxied app in a same-origin iframe, chat + queue hoisted into the parent so persistence is structural. | 2026-07-06 |
| [`shell-phase2-elements/`](./shell-phase2-elements/) | **Phase 2** — the interactive layer: element pick, hover highlight, region + element screenshots, all driven from the parent via the `Env` seam. | 2026-07-06 |
| [`shell-phase3-provenance/`](./shell-phase3-provenance/) | **Phase 3** — `file:line:col` source provenance via the build-time stamp, surfaced by the picker, degrading cleanly where the build isn't owned. | 2026-07-06 |
| [`shell-phase4-inline-edit/`](./shell-phase4-inline-edit/) | **Phase 4 (finale)** — inline click-to-edit text in the preview, captured as a source-keyed `text-edit` mark. | 2026-07-06 |
| [`fileline-source-by-default/`](./fileline-source-by-default/) | Make `file:line` work **by default** via the skill (auto-wire the source-stamp loader) and stop framing it as a limitation in user-facing docs. | 2026-07-06 |
| [`embedded-agent-build/`](./embedded-agent-build/) | **W1 implementation brief** — build embedded-agent mode to the design above, strictly additively, keeping the feedback-proxy / shell / sidecar / `poll` paths byte-for-byte intact. | 2026-07-06 |
| [`builder-agent-persona/`](./builder-agent-persona/) | Give embedded mode a real builder-agent persona (a Lovable-style prompt retargeted to the Loom stack) and make it the overridable default. | 2026-07-07 |
| [`packaging-clean-install-fix/`](./packaging-clean-install-fix/) | **The `tsx`-at-runtime failure** — why a clean consumer install crashed, and the mandate to ship compiled `dist/` run by plain `node`. | 2026-07-07 |
| [`builder-double-ui-fix/`](./builder-double-ui-fix/) | The double-UI bug: the builder pane's iframe also got the classic overlay injected. Intent behind mode-gated injection. | 2026-07-07 |
| [`embed-bridge/`](./embed-bridge/) | **Cross-frame embed bridge** — let an external host drive the `InteractionLayer` over an iframe boundary and receive real marks, without same-origin access to the framed app. The "one harness, many hosts" enabler. | 2026-07-07 |

## UX reviews & fix rounds

Live-dogfooding feedback and the fixes it drove — mostly on the overlay's region/capture flow.

| Document | Covers | When |
|---|---|---|
| [`region-capture-hotkey/`](./region-capture-hotkey/) | Add `Cmd/Ctrl+Shift+X` to enter Region mode instantly, so hover-only UI (tooltips, hover cards) can be captured at all. | 2026-07-05 |
| [`overlay-ux-fixes/`](./overlay-ux-fixes/) | Two dogfooding refinements (don't auto-open the chat panel on enqueue; pane-aware capture), plus [`fix-region-bugs.md`](./overlay-ux-fixes/fix-region-bugs.md) — a mid-flight stop-and-fix for a mispositioned red box, the origin of the "one coordinate space" rule. | 2026-07-05 |
| [`region-instant-mode-switch/`](./region-instant-mode-switch/) | Make the whole region flow feel instant: click-without-drag cancels, and the mode switch stops blocking on the raster. | 2026-07-05 |
| [`region-mode-ux-fixes/`](./region-mode-ux-fixes/) | Two measured fixes: the ~1–2px page shift on entering freeze mode, and the selection visual vanishing on mouse-up instead of persisting until commit. | 2026-07-06 |
| [`builder-pane-ux-batches/`](./builder-pane-ux-batches/) | Three rapid-iteration batches on the builder pane: [queue UX](./builder-pane-ux-batches/steer-queue-ux-2.md) (screenshot lightbox, note editing), [sent-turn history](./builder-pane-ux-batches/steer-sent-history-3.md) (+ markdown replies), and [icon-font capture](./builder-pane-ux-batches/steer-icon-capture-verify-4.md) — the cross-document html2canvas tofu-box trap, with a real browser verification loop mandated after a blind fix failed. | 2026-07-07 |
| [`readme-screenshot-refresh/`](./readme-screenshot-refresh/) | Refresh the committed README/media screenshots to match the then-current overlay UX. | 2026-07-05 |

## Audits

| Document | Covers | When |
|---|---|---|
| [`public-readiness-audit/`](./public-readiness-audit/) | **Public-readiness audit before open-sourcing.** Full-history secrets/PII sweep (47 commits, 10 refs), the governance/docs/CI files added (CONTRIBUTING, CODE_OF_CONDUCT, SECURITY, issue templates, dependabot, CHANGELOG), and a go/no-go verdict with the one blocking history decision. Two PII values in this report were redacted on fold-in. | 2026-07-06 |

## Adjacent

| Document | Covers | When |
|---|---|---|
| [`devview-skill-spinout/`](./devview-skill-spinout/) | **Predecessor, not this repo.** The plan to ship the feedback overlay as a portable installable skill (`devview`) that a React/Next repo adds to itself. Kept because it is the road not taken: the harness exists precisely because the install-into-the-target model doesn't cover apps you don't own. | 2026-07-02 |

---

## Source-slug map

These documents were produced by dispatched agent jobs whose directories were internal slugs. The
mapping, for anyone correlating against branch names, PR titles or an in-document reference:

| Original slug | Here |
|---|---|
| `devview-skill-w2` | [`devview-skill-spinout/`](./devview-skill-spinout/) |
| `harness-builder-clean-c1` | [`builder-double-ui-fix/`](./builder-double-ui-fix/) |
| `harness-embed-bridge-l4a` | [`embed-bridge/`](./embed-bridge/) |
| `harness-overlay-cookie-c2` | [`builder-pane-ux-batches/`](./builder-pane-ux-batches/) |
| `harness-pkg-fix-h1` | [`packaging-clean-install-fix/`](./packaging-clean-install-fix/) |
| `hz-agent-h2` | [`embedded-agent-design/`](./embedded-agent-design/) |
| `loom-agent-persona-a1` | [`builder-agent-persona/`](./builder-agent-persona/) |
| `nh-fileline-default` | [`fileline-source-by-default/`](./fileline-source-by-default/) |
| `nh-go-public` | [`public-readiness-audit/`](./public-readiness-audit/) |
| `nh-mvp-p1` | [`harness-mvp-phase1/`](./harness-mvp-phase1/) |
| `nh-p0-hydration` | [`shell-phase0-hydration/`](./shell-phase0-hydration/) |
| `nh-p1-shell` | [`shell-phase1-hybrid-shell/`](./shell-phase1-hybrid-shell/) |
| `nh-p2-elements` | [`shell-phase2-elements/`](./shell-phase2-elements/) |
| `nh-p3-provenance` | [`shell-phase3-provenance/`](./shell-phase3-provenance/) |
| `nh-p4-inline-edit` | [`shell-phase4-inline-edit/`](./shell-phase4-inline-edit/) |
| `nh-region-ux` | [`region-mode-ux-fixes/`](./region-mode-ux-fixes/) |
| `nh-reliable-feedback` | [`reliable-feedback-driver/`](./reliable-feedback-driver/) |
| `nh-shell-spike` | [`builder-shell-spike/`](./builder-shell-spike/) |
| `nh-sync-latest` | [`vendor-core-sync/`](./vendor-core-sync/) |
| `np-fast-r6` | [`region-instant-mode-switch/`](./region-instant-mode-switch/) |
| `np-harness-s9` | [`viability-study/`](./viability-study/) — brief only; its report is [`../viability-report.md`](../viability-report.md) |
| `np-hotkey-x7` | [`region-capture-hotkey/`](./region-capture-hotkey/) |
| `np-instant-capture` | [`instant-capture-spike/`](./instant-capture-spike/) |
| `np-screenshots` | [`readme-screenshot-refresh/`](./readme-screenshot-refresh/) |
| `np-uxfix-h3` | [`overlay-ux-fixes/`](./overlay-ux-fixes/) |
| `research` | [`../competitive-landscape.md`](../competitive-landscape.md) — already committed here in 2026-07 |
| `w1-harness-embed-e1` | [`embedded-agent-build/`](./embedded-agent-build/) |
