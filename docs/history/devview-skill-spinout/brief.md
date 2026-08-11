You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task

Build the **dev feedback overlay as a standalone, installable Claude skill**, in this new `devview` repo. The overlay is already built, polished, and merged in the `membership-management` app; your job is to **generalize it into a portable skill** any React/Next repo can install, so a developer gets the same in-app visual-feedback-to-the-AI-session experience with no hand-wiring.

## Read first (the canonical, POLISHED source — read-only, do NOT modify it)

The proven implementation lives in the merged `membership-management` app (all three overlay modes + the dock polish are on its `main`). Extract and generalize from it:
- `~/egeprojects/firstmate/projects/membership-management/devview/` — the sidecar transport server + `poll` CLI + the dev-only source-stamp Babel plugin/loader (`devview/next/`).
- `.../src/devview/core/` — `@devview/core`: shadow-DOM dock (cursor / region / element / feedback-queue), region screenshot + red-box compositor, chat panel, transport client, element descriptor builder, and the **bottom-center, non-overlapping** dock layout (the latest polish).
- `.../src/devview/next/` — the React glue (`resolveElement`: fiber-walk component name + `data-devview-source` read).
- `.../src/components/dev-overlay.tsx` — the dev-only Next mount; `.../next.config.ts` — the dev-only source-stamp wiring (turbopack + webpack); `.../package.json` — deps (`html2canvas`) + `devview:*` scripts; `.../devview/README.md`.
- The design spec (architecture, the `@devview/core` split): `~/egeprojects/firstmate/data/devview-design-k4/report.md`.

## Deliverable: the `devview` repo as an installable skill

Lay the repo out as a self-contained Claude skill plus the portable assets it installs. Suggested structure (use your judgment, keep it clean):
- **`SKILL.md`** — the skill itself (front-matter + body), agent-facing, that when invoked *inside a target React/Next repo* installs the overlay end to end: add deps (`html2canvas`) + `devview:*` scripts; copy the portable assets in; mount the dev-only `<DevOverlay/>` in the app's root layout gated on `NODE_ENV !== "production"`; wire the dev-only `data-devview-source` source-stamp into the host's `next.config` for **both** turbopack and webpack (note the Next 16 "keep an empty `turbopack` key if you add `webpack`" gotcha); how to run it (sidecar + `poll --session <id>`); and how the AI session consumes feedback (region → local red-boxed PNG path; element → component/source/selector/text). Follow how firstmate's own skills are written in structure (front-matter, tight prose) — see `~/egeprojects/firstmate/.agents/skills/harness-adapters/` for the house style.
- **portable assets** (e.g. `assets/`) — the **generalized** `@devview/core` (framework-agnostic TS, no React import), the Next/React adapter (mount + `resolveElement` + source-stamp plugin/loader), and the sidecar server + `poll` CLI. Strip ALL `membership-management` coupling: session id is a caller-supplied parameter, no hard-coded app paths/imports. These are what the skill copies into a target repo.
- **`README.md`** — repo overview + a human quickstart (what it is, how to install into a repo, how to run).

## Verify portability before you PR (mandatory — not reading alone)

Prove "works in any React repo": in your worktree scratch space, scaffold a throwaway Next app (`npx create-next-app`), follow your own `SKILL.md` to install devview into it, run the sidecar + `next dev`, and confirm end-to-end that the overlay mounts dev-only, a region drag yields a red-boxed PNG delivered to a running `devview poll`, and the element picker records component/source. Use chrome-devtools-axi. **Remove the throwaway app before committing** — only the skill + assets + README get committed. Put the working evidence in the PR description.

# Setup
You are in a disposable git worktree of devview, at a detached HEAD on a clean default branch. The repo currently holds only a bare scaffold `README.md` on `main` — you'll flesh that README out and add all the skill content on your branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/devview-skill-w2`, and do ALL the work (SKILL.md + assets + fleshed-out README + a node `.gitignore`) there. `main` holds only the bare README scaffold, so your PR diff is the whole skill for the captain to review.

# Rules
1. Never push to the default branch (push only your `fm/devview-skill-w2` branch). Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/devview-skill-w2.status'`
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
This project ships **direct-PR**: you raise the PR yourself, without the no-mistakes pipeline.
The task is complete only when committed on your branch.
When it is implemented and committed, push your branch and open a PR with `gh-axi`, then append `done: PR {url}` to the status file and stop.
Do NOT run /no-mistakes. The captain reviews and merges the PR; firstmate relays it.
