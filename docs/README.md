# docs

Background research and design rationale behind nitpicker-harness — the standalone same-origin proxy
that fronts a target dev server and injects the feedback overlay with zero code in the target repo.

> These are historical design/research notes, written during the initial viability study. They predate
> the current setup flow — e.g. `file:line:col` source is now wired on as a standard setup step (see
> [SKILL.md](../SKILL.md#turn-on-filelinecol-source-default-setup-step)), not the build-time caveat the
> report frames it as. Read them for the *why*, not the current how-to.

- [**viability-report.md**](./viability-report.md) — the architecture/viability analysis. Why the
  harness must be a **same-origin proxy** (not a cross-origin iframe shell), grounded in the overlay
  engine source with `file:line` references, plus how `file:line:col` source stamping leans on build-time
  cooperation. This is the design authority the code follows.
- [**competitive-landscape.md**](./competitive-landscape.md) — deep-research pass on prior art: is there
  an OSS dependency-free reverse-proxy harness giving an *external* agent both region-annotated
  screenshots and element→component→source? Verdict: largely whitespace. Landscape matrix + cited,
  adversarially-verified claims.
