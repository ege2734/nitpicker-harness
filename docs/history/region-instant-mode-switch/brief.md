You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Three region-mode fixes to the nitpicker overlay (`assets/nitpicker/core/overlay.ts` + `region.ts`), from live captain feedback. The overarching goal: **the entire region flow must feel absolutely INSTANT** — no perceptible latency to switch modes or to start drawing.

**Fix 1 — click (no drag) in Region mode returns to Cursor.** If the user is in Region mode and just clicks without dragging (mousedown→mouseup with no meaningful movement, i.e. below the existing tiny-rect threshold in `onDragEnd`), treat it as a cancel: `setMode("cursor")` (and clear any drag state), instead of staying armed in Region. Same outcome as cancelling Region.

**Fixes 2 & 3 — kill the freeze/latency on `Cmd/Ctrl+Shift+X` (same root cause).**
Symptoms the captain reports: (2) pressing the hotkey takes ~0.5s to visibly switch to Region mode; (3) if you press it and immediately click-drag, nothing renders for ~1s, then the gray-dim bands + selection rectangle appear all at once. Strong hypothesis: the hotkey path rasterizes the whole viewport with **html2canvas synchronously on the keypress** (the "freeze" snapshot in `region.ts`), which blocks the main thread for ~0.5–1s — so neither the mode-switch UI nor the drag overlays can paint until it finishes.

**FIRST diagnose, with real measurement** (do not fix blind):
- Reproduce against a **realistic, content-heavy app** (pocketwatcher-scale DOM — html2canvas is slow in proportion to DOM size; a trivial app won't reproduce it). Easiest: use the just-shipped **nitpicker-harness** to point at pocketwatcher's frontend dev server, OR install nitpicker into a heavy test app. Test in a **headed / real Chrome** (matches the captain's experience), via `chrome-devtools-axi` and/or Playwright.
- Instrument with `performance.mark`/`performance.now` at: hotkey keydown → `setMode("region")` → mode-UI painted → raster start → raster end → first drag-band render. Capture a Chrome performance trace to see exactly what blocks the main thread. Confirm (or correct) the html2canvas-on-keypress hypothesis and report the numbers.

**FIX so the flow is instant:**
- The **mode switch** paints immediately on keypress — `setMode("region")` + the armed UI must render on the very next frame, never gated on the raster.
- **Drawing is instant** — the gray-dim bands and the selection rectangle are live CSS/DOM overlays that track the mouse on the live page with ZERO dependency on the snapshot; the user sees the rectangle the instant they drag.
- The viewport **snapshot runs fully in the background** (off the critical path of mode-switch and draw). It is only needed to compose the final screenshot; swap the frozen canvas in when ready.
- **Preserve correctness:** `Cmd/Ctrl+Shift+X` must STILL capture the transient hover-only UI (hover-cards/tooltips) in the final screenshot — that is the whole point of the hotkey — and the red box + selection must stay accurate. Do not regress that to gain speed.
- If profiling shows html2canvas is unavoidably main-thread-blocking even when backgrounded (so the drag still stutters during the ~1s), investigate mitigations — start the raster on the next frame after the mode-UI + first drag frames paint; chunk/yield; reduce scale/scope; or an alternative capture — but never at the cost of hover-card preservation. If a genuine correctness/speed tradeoff is unavoidable, stop and append `needs-decision` with the options + measured costs.

**VERIFY with before/after numbers:** measure keydown→Region-visible and mousedown→first-rectangle-rendered latencies before and after; target instant (sub-frame / no perceptible wait) for the mode switch and the draw, with the raster off the critical path. Put the measured numbers in your `done` report. Add/adjust unit tests where feasible. Run the repo's checks (typecheck, lint, vitest, build) green.

Scope note: this lands in **regular nitpicker** (fast iteration); it will be ported to nitpicker-harness later in one pass, so don't touch the harness. Acceptance: click-without-drag exits Region to Cursor; the hotkey switches mode and lets you draw with no perceptible latency; the hover-card is still captured correctly; measured before/after latencies included; checks green.

# Setup
You are in a disposable git worktree of nitpicker, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/np-fast-r6`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/np-fast-r6.status'`
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
