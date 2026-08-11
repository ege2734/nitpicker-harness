You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Two related cleanups to nitpicker-harness that make its file:line support automatic and its public-facing story self-contained. Both are mostly docs/`SKILL.md` changes plus the auto-wiring logic. Read `SKILL.md`, `README.md`, and the Phase 3 source-stamp code (`vendor/nitpicker/next/nitpicker-source-loader.cjs` + `nitpicker-source-plugin.cjs`, and how `src/shell/entry.ts` surfaces `source`) first.

## A. Make `file:line` provenance work BY DEFAULT via the skill — silently
Phase 3 shipped the source-stamp loader but made it a manual, documented opt-in framed as a "drawback"/"one honest limit." Change that so file:line just works out of the box:
- Update `SKILL.md` so the harness setup playbook an AI agent follows **automatically wires the source-stamp loader** into an owned Next app's build config (the `turbopack.rules` + webpack-fallback wiring Phase 3 documented) as a **standard default step of setup** — not an optional extra. The agent following the skill should end up with file:line working without the human doing anything or being asked.
- Keep the **graceful degradation** already built in Phase 3: for an app whose build we don't control or that isn't Next/Turbopack, setup proceeds without the stamp and element-pick still returns component+selector+text+route with no error. The auto-wire step should detect-and-skip cleanly in that case, not fail.
- **Remove every user-facing mention that file:line is a limitation, drawback, caveat, or manual step** — in `README.md` especially (the "one honest limit"/`file:line:col` drawback section), and anywhere else user-facing. Do not replace it with a softened caveat; just present element-pick as returning source location. A brief internal code comment or a harness-local dev note is fine, but nothing a user reads should frame file:line as a gap or a thing they must configure.

## B. Stop referencing the standalone (archived) nitpicker repo
`ege2734/nitpicker` is archived and readers won't find or know it, so the harness should read as a self-contained project. Scrub user-facing references to the standalone nitpicker from `README.md`, `SKILL.md`, docs, and prose comments:
- Remove/replace phrasings like "reuses nitpicker's core/server/cli", links to `github.com/ege2734/nitpicker`, and "becomes nitpicker's canonical home when nitpicker is archived." Present the overlay/core as part of THIS project.
- The internal `vendor/nitpicker/` directory name can stay (it's not user-facing) — this is about prose/framing, not renaming working code. Use judgment; don't churn code, just the references and framing.

## Acceptance
- `SKILL.md` makes file:line auto-wiring the default; a fresh setup on an owned Next app yields `source: file:line:col` on element pick with **no manual step**, verified in a real browser (use `chrome-devtools-axi`, the session tool — do NOT hunt for a global chrome-devtools-mcp).
- A non-owned / non-Next app still degrades cleanly (no error, no source field).
- No user-facing doc mentions file:line as a limitation/manual step; no user-facing pointer to the archived standalone nitpicker.
- Injected-proxy mode still works; build + tests green.

Ship as one PR (nitpicker-harness is no-mistakes mode).

# Setup
You are in a disposable git worktree of nitpicker-harness, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/nh-fileline-default`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/nh-fileline-default.status'`
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
