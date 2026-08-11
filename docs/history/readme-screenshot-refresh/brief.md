You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Refresh the nitpicker README/media screenshots so they reflect the CURRENT overlay UX. The committed binaries under `docs/media/` (e.g. `chat-panel.png`, `region-redbox.png`, and any others referenced by `README.md` / `docs/DESIGN.md`) predate this session's work — they still show the old slide-over panel and the freeze-on-drag flow. The current overlay has: the **docked feedback pane** (reserves width on the right, hide/show toggle at its top-left), **instant region draw** with the red box framed correctly, the **click-a-queued-item view/edit modal**, and the `Cmd/Ctrl+Shift+X` freeze flow.

Steps:
1. Identify every committed screenshot referenced by the docs (`git grep` the README/DESIGN for `docs/media/`), and note what each is meant to show (dock, chat/feedback panel, region + red box, element hover).
2. Get the overlay running on a real app so you can capture accurate images. Easiest reliable path: install the current nitpicker into a small scratch Next app (via the skill / the assets under `assets/nitpicker/`), or reuse a running instance; drive a **headed/real Chrome** (via chrome-devtools-axi or Playwright) to render the app + overlay.
3. Re-capture each screenshot to match its original purpose but with the NEW UI — dock, the docked feedback pane, a region capture with the correctly-framed red box, an element-hover descriptor. Match the original dimensions/framing where it matters for the README layout.
4. Replace the binaries under `docs/media/`, verify the README/DESIGN still render correctly and no captions now contradict the images (update surrounding prose if a caption describes the old UI).
5. Commit and ship a PR.

Keep it proportionate — accurate, current screenshots that a reader trusts; you don't need pixel-perfection. Report which images you regenerated and how you captured them.

# Setup
You are in a disposable git worktree of nitpicker, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/np-screenshots`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/np-screenshots.status'`
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
