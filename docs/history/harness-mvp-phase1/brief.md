You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Build the **Phase 1 MVP of nitpicker-harness**: a standalone same-origin proxy harness that lets a developer (or an AI agent) point at a running web app and get the full nitpicker feedback overlay — region screenshots, element→component/selector, chat/queue → sidecar — with **zero nitpicker code in the target's repo**. This is a brand-new repo (currently just a README).

**Read the design spec first — it is authoritative:** `../../viability-report.md` (the viability scout). Follow its §3a (same-origin proxy) and §6 Phase 1 recommendation. Key facts from it: the overlay must run **same-origin** with the target (SOP blocks cross-origin DOM), so the harness proxies the target under its own origin and injects the overlay on the fly. `@nitpicker/core` already mounts from any page via one `Nitpicker.mount()` call and imports no framework — it was built to be dropped in from outside.

**Reuse nitpicker's code — copy it in (do not depend back on the nitpicker repo):** copy `core/`, `server/`, `cli/`, and the React glue you need from the current nitpicker at `~/egeprojects/firstmate/projects/nitpicker/assets/nitpicker/` into this repo. nitpicker-harness will become the canonical home when nitpicker is archived, so it must be self-contained. (nitpicker's in-flight UI polish will be pulled in later — copy the current state now.)

**Build (Phase 1 MVP scope):**
1. A **Node reverse proxy** that fronts a target **localhost dev server** (start with a Next.js dev app as the reference target): pipe requests/responses, rewrite streamed HTML to inject `<script>` that calls `Nitpicker.mount({ session, endpoint })`, **proxy the HMR/websocket** so hot-reload survives, **rewrite absolute asset URLs** back through the proxy, and **strip `X-Frame-Options` + CSP `frame-ancestors`** (and relax the target's `script-src`/`connect-src`) so the page runs same-origin under the harness with the injected overlay able to reach the sidecar.
2. Serve the proxied+injected app under the **harness's own origin** so the overlay has full same-origin DOM access → region + element(selector/component) + chat/queue + sidecar all work unmodified.
3. Wire the **sidecar** (reuse nitpicker's `server/` + `cli/`): the injected overlay POSTs feedback; the `poll` CLI drains it for the agent. Keep the existing session-keyed contract.
4. **`file:line` source:** since the harness fronts the dev server, offer the source-stamp transform as an opt-in (document the one bundler-config line, or inject the transform at serve time if feasible). Do NOT block the MVP on it — component + selector + text + route are the baseline, exact source is the bonus.
5. A **CLI entry** to launch it, e.g. `nitpicker-harness --target http://localhost:3000` (then the developer opens the harness URL and marks up their app).
6. **The skill (`SKILL.md`)** so an AI agent can use this while developing a web app: "point nitpicker-harness at the dev server, then ask the human for feedback" — the agent-facing usage, mirroring nitpicker's SKILL.md but for the harness (no install into the target repo). Include an `npx`-style install if it fits the pattern.
7. Sensible repo hygiene: README (what it is, quickstart), package.json, tsconfig, tests for the proxy-injection + reused core, CI workflow, LICENSE, .gitignore.

**Verify concretely (this is the whole point):** run the harness against a real localhost dev app (a small Next.js app — you may scaffold a throwaway one, or point at pocketwatcher's frontend dev server if convenient) and confirm in a browser: the app renders through the harness, the overlay dock appears, a **Region screenshot** captures the app correctly, **Element pick** returns a component name + selector, and a queued message reaches the `poll` CLI. Screenshot/log the evidence.

**Scope discipline:** this is Phase 1 (localhost dev, proxy harness) — do NOT build the browser extension (explicitly out of scope) or the platform layer. Get a real, working, verified MVP; note clearly in the README/AGENTS what's done vs. deferred. It's fine for the first PR to be a solid MVP with follow-ups listed rather than every edge case (auth flows, non-Next frameworks) solved.

If a design decision is genuinely ambiguous or a product choice, append `needs-decision:` and stop; otherwise make the reasonable engineering call and keep moving.

# Setup
You are in a disposable git worktree of nitpicker-harness, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/nh-mvp-p1`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/nh-mvp-p1.status'`
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
