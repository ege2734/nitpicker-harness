# docs

Background research and design rationale behind nitpicker-harness — the standalone same-origin proxy
that fronts a target dev server and injects the nitpicker feedback overlay with zero code in the target
repo.

- [**viability-report.md**](./viability-report.md) — the architecture/viability analysis. Why the
  harness must be a **same-origin proxy** (not a cross-origin iframe shell), grounded in the nitpicker
  source with `file:line` references, plus the one honest limit (`file:line:col` source stamping needs
  build-time cooperation). This is the design authority the code follows.
- [**competitive-landscape.md**](./competitive-landscape.md) — deep-research pass on prior art: is there
  an OSS dependency-free reverse-proxy harness giving an *external* agent both region-annotated
  screenshots and element→component→source? Verdict: largely whitespace. Landscape matrix + cited,
  adversarially-verified claims.
