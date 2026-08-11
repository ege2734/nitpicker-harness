You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Implement **embedded-agent mode** in nitpicker-harness (Loom workstream **W1**): a mode where the side pane IS a live agent you build with, not an external `poll`-drained queue. This is **strictly additive** — the existing feedback-proxy / builder-shell / sidecar / `poll` / stop-hook paths must keep working byte-for-byte (pocketwatcher + membership-management depend on them).

**READ FIRST — the design is already written, implement to it:**
- `../embedded-agent-design/report.md` — the full design (AppRuntime, AgentBackend, Agent Gateway, InteractionLayer extraction, `startEmbeddedBuilder()`). **§7 lists the concrete `src/` changes; follow it.** Honor the locked decisions in `~/egeprojects/firstmate/data/loom-decisions.md`: **D7 (Claude Agent SDK in-process reference backend + SSE gateway; CLI-spawn fallback; reuse the `QueueItem`/`WireItem` mark schema verbatim, in-process for embedded, keep `poll` for headless)**.
- Ground in the repo: `README.md`, `AGENTS.md`, `src/cli.ts`, `src/proxy/{server,inject}.ts`, `src/shell/entry.ts`, `vendor/nitpicker/core/{types,transport}.ts`, `vendor/nitpicker/server/{index,store}.ts`.
- Context (do not edit): the Loom foundation already ships a `@loom/harness-bridge` TS package and `@loom/contracts` (`WireItem`, `AgentBackend`/`AgentSession`/`AgentEvent`, `AppRuntime`) at `~/egeprojects/firstmate/projects/loom/packages/`. Keep your interface shapes **compatible** with those names/types so Loom consumes this cleanly (Loom pins this repo as a dependency). If you must diverge from those types, append `needs-decision` and stop.

**Build (per hz-agent §7):**
1. `src/app/runtime.ts` — `AppRuntime` interface + `LocalRuntime` (detect dev command from `package.json`; `next`→`next dev`, `vite`→`vite`, else `scripts.dev`; explicit `--dev-cmd` wins, covering `uvicorn --reload`; spawn, poll readiness, surface crashes/status).
2. `src/agent/backend.ts` — vendor-agnostic `AgentBackend`/`AgentSession`/`AgentEvent` + `makeBackend(name)` registry.
3. `src/agent/claude-backend.ts` — **reference backend over the Claude Agent SDK, in-process** (maps to `AsyncIterable<AgentEvent>`), with a `claude -p --output-format stream-json` CLI-spawn fallback.
4. `src/agent/gateway.ts` — the **SSE Agent Gateway** mounted on the existing server via a new optional `mountExtra` hook in `startHarness` (`server.ts` ~154-168): routes `POST /__nitpicker-harness/agent/message`, `GET /stream` (SSE, `Last-Event-ID` resumable), `POST /interrupt`, `GET /history`. The gateway formats marks→prompt (element→source line, region→image block from the reused `/blob` path, text-edit→"change X to Y", message→note). Server-side authoritative transcript keyed by `sessionId`.
5. `src/shell/entry.ts` — extract the shared interaction code (mode toolbar, picker, drag, edit, geometry, `Env`→`QueueItem`) into a reusable `InteractionLayer` (behavior-preserving; guarded by the existing shell/geometry tests). `ShellChrome` keeps its sidecar sink; a new `BuilderChrome` swaps in the gateway sink + streaming transcript.
6. `src/builder/entry.ts` + `src/proxy/inject.ts:builderPage()` — a new `/__nitpicker-harness/build[.js]` pane (sibling of the shell), esbuild IIFE.
7. `src/cli.ts` — `nitpicker-harness <path-to-app>` (bare positional / `--app`) → embedded mode (`serveEmbedded`); `--no-agent` escape hatch; the existing `--target <url>` path unchanged.
8. `src/index.ts` — export `startEmbeddedBuilder()` (the library entrypoint Loom drives) + the interfaces. Add the chosen agent SDK dep + `exports` for the library surface.

**Auth/ports:** make gateway auth a parameter (bearer/signed session) — do NOT hardcode loopback-open for the Loom case; but a local default is fine for the CLI. Token via header/cookie, never query string.

**Validate (everything must build + test):** keep `npm run typecheck` + `vitest` green; add tests for the new gateway (marks→prompt formatting, SSE stream/resume), `LocalRuntime` dev-command detection, and the `InteractionLayer` extraction (the existing shell/geometry tests must still pass). Do NOT break existing sidecar/poll tests. A manual `nitpicker-harness <a-small-next-app>` sanity check is welcome but tests are the gate.

Scope discipline: implement the embedded mode + its interfaces + tests. Do NOT build Loom-side runtime/shell wiring here (that's W2/W3/W4). Update this repo's `AGENTS.md` with the new mode + the `startEmbeddedBuilder` contract. Report `done` when committed on `fm/w1-harness-embed-e1`; firstmate triggers /no-mistakes → PR → merge.

# Setup
You are in a disposable git worktree of nitpicker-harness, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/w1-harness-embed-e1`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/w1-harness-embed-e1.status'`
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
