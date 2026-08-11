You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Add a global keyboard shortcut to nitpicker that **immediately triggers Region (screenshot) mode** — so a user can capture hover-only UI (chart hover-cards, tooltips, menus that vanish on mouse-move) that today is impossible to screenshot because reaching for the Region button in the dock dismisses the transient element.

**Shortcut:** `Cmd+Shift+X` on macOS / `Ctrl+Shift+X` elsewhere (detect via `e.metaKey || e.ctrlKey`, `e.shiftKey`, and `e.key.toLowerCase() === "x"`). `preventDefault()` so it doesn't collide with the browser.

**Where:** the overlay already owns a document-level keydown handler (`assets/nitpicker/core/overlay.ts`: `onKeydown`, registered at line ~86 with capture=true; it already handles `Escape → setMode("cursor")`) and a `setMode(mode: Mode)` state machine (line ~176). Wire the new shortcut into `onKeydown`.

**The critical requirement — freeze on keypress to preserve hover state.** The entire reason for this feature is capturing hover-only content. So pressing the hotkey must **snapshot/freeze the current rendered viewport at the moment of the keypress** (before the user moves the mouse to drag a selection box), so a tooltip/hover-card that is visible at press-time is preserved in the frozen image the user then draws their region box on. Inspect how Region mode currently freezes the view and runs `captureRegion` (region.ts + overlay.ts around lines 176–271): if freezing currently happens on drag-start or drag-end, you must move the freeze to happen immediately when the hotkey activates Region mode, so the hovered state is captured. Verify concretely against a real hover-card (a Cobalt-design chart hover tooltip is the motivating case): hover an element that only shows on hover, press the hotkey, confirm the frozen snapshot still shows it, then drag a box and confirm the exported PNG contains the hover-card.

Also:
- Keep the existing dock Region button and drag/capture behavior working exactly as before (the hotkey is an additional fast path into the same Region mode).
- The hotkey must work regardless of current mode (cursor/region/element) and regardless of focus (document-level, capture phase), including while hovering over app content.
- Add a unit test in `assets/nitpicker/tests/` asserting the hotkey activates Region mode (and, if feasible, that the freeze happens on activation). Follow the existing test style.
- Update the docs: `SKILL.md` and `README.md` (and the overlay's own help/tooltips if they enumerate the modes) to document the `Cmd/Ctrl+Shift+X` shortcut and its hover-capture purpose. Update `CHANGELOG.md` (Keep a Changelog) under an Unreleased/next entry.
- Run the repo's own checks (typecheck, lint, vitest, build/verify) green before reporting done.

Acceptance: pressing `Cmd/Ctrl+Shift+X` anywhere instantly enters Region mode with the viewport frozen at press-time so hover-only UI is captured; dock Region still works; unit test added; docs + changelog updated; all repo checks green.

# Setup
You are in a disposable git worktree of nitpicker, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/np-hotkey-x7`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/np-hotkey-x7.status'`
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
