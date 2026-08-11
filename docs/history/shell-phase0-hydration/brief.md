You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Builder-shell **Phase 0** (see the full plan + evidence in `../builder-shell-spike/report.md`, esp. §4b and the Phase 0 section — read it first): fix the harness proxy so client hydration and HMR work through it on **Next 16 / React 19.2 (Turbopack)**. Right now the proxy breaks client hydration — per-node React fibers never attach, so the vendored fiber walk can't resolve component names. This is the #1 prerequisite for every element/component feature and it must be fixed regardless of the shell architecture.

**Scope:** Restore client hydration through the proxy so per-node React fibers attach AND HMR works. Diagnose the failing `_next/webpack-hmr` WebSocket upgrade under Turbopack. Verify whether the current HTML buffering (`src/proxy/server.ts:88-104`) needs to become a streaming pass-through transform that injects at the `</body>` boundary WITHOUT collapsing chunked RSC payloads. Fix the ws forwarding (`src/proxy/server.ts:152`) and/or switch HTML handling to a streaming injector.

**Files:** `src/proxy/server.ts` (ws upgrade handling, response streaming), possibly `src/proxy/inject.ts` (make injection stream-friendly). Add a regression test under `tests/`.

**Acceptance test (this is the bar — verify in a real browser, chrome-devtools-axi or Playwright):** with the harness proxying a Next 16 fixture app, a browser at the proxied URL shows **zero HMR WebSocket errors**, `__reactFiber$…` is present on a rendered element (e.g. `[data-testid="pricing-Pro"]`), and the vendored `resolveReactElement` returns the real component name (e.g. `component: "PricingCard"`). Editing a source file hot-reloads the proxied page. The A/B test rig described in report §4b is the ready-made harness for this. Build a minimal Next 16 fixture if the repo lacks one (keep it small, under `tests/` fixtures).

**Important context:** this bug currently degrades element-pick component-name resolution for the already-migrated Next 16 apps (pocketwatcher, membership-management) run through the harness, so fixing it also repairs their overlay. Keep the existing proxy/injection behavior for non-broken cases intact; this is a correctness fix, not a rewrite.

Ship as one PR (nitpicker-harness is no-mistakes mode). This can run in parallel with Phase 1; if you touch `src/proxy/server.ts` regions that Phase 1 also edits, rebase at validation.

# Setup
You are in a disposable git worktree of nitpicker-harness, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/nh-p0-hydration`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/nh-p0-hydration.status'`
   States: working, needs-decision, blocked, done, failed.
   Each append wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on (setup done, bug reproduced, fix implemented, validation passed) and the
   needs-decision/blocked/done/failed states. No step-by-step FYI progress lines;
   firstmate reads your pane for that.
5. If you hit the same obstacle twice, append `blocked: {why}` and stop; firstmate will help.
6. If a decision belongs to a human (product choices, destructive actions, ask-user findings),
   append `needs-decision: {summary of options}` and stop. Firstmate will reply with the decision.

# Project memory
If `AGENTS.md` or `CLAUDE.md` already exists, or if this task produced durable project-intrinsic knowledge, run `~/egeprojects/firstmate/bin/fm-ensure-agents-md.sh .` in the worktree.
If this task produced durable project-intrinsic knowledge, record it in `AGENTS.md` as part of your change.
Keep it proportionate: skip `AGENTS.md` edits for trivial tasks that produced no durable project knowledge.

# Definition of done
The task is complete only when committed on your branch.
When you believe it is complete, append `done: {summary}` to the status file and stop.
Firstmate will then instruct you to run /no-mistakes to validate and ship a PR.

You drive no-mistakes by responding to its gates, not by implementing fixes.
Follow the no-mistakes guidance for the mechanics: it loads when you invoke /no-mistakes, and `no-mistakes axi run --help` plus the `help` lines in each `axi` response are authoritative and version-matched to the installed binary.
Do not hand-edit, commit, or fix findings yourself while a run is active - the pipeline applies every fix.

Two firstmate-specific rules layer on top of that guidance:
- ask-user findings are not yours to answer: escalate to firstmate (rule 6) and stop.
  When the decision comes back, feed it to the gate with `no-mistakes axi respond` and let the pipeline apply it - do not route the question to "the user" or implement the fix yourself.
- Avoid `--yes`: the captain, not you, owns the ask-user decisions it would silently auto-resolve.

After /no-mistakes reports CI green, append `done: PR {url} checks green` and stop. You are finished.
