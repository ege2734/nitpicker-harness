You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Two UX refinements to the nitpicker overlay (`assets/nitpicker/core/overlay.ts`), from live dogfooding feedback. This is on top of the just-merged Cmd/Ctrl+Shift+X hotkey — keep that intact.

**Change 1 — do NOT auto-open the side chat panel when a mark is queued.**
Today, after a Region or Element selection and queuing a message, the right-side chat panel (`panel` / `panelOpen`, built by `buildPanel`) expands over the page. It should NOT. The panel must stay hidden/collapsed on enqueue. The user's ONLY feedback that the mark registered is the queue counter — the red badge (`badgeEl`) in the bottom dock bar — incrementing.
So: on every enqueue path (`enqueueRegion`, `enqueueElement`, and any other enqueue), update the badge/count via `renderQueue()` but do NOT set `panelOpen = true` or otherwise open/expand the panel. The panel should open ONLY when the user explicitly clicks the dock's feedback-queue button. Check `renderQueue()` and the enqueue methods for wherever the panel is being opened on queue and remove that.
Verify: after a Region or Element mark + Queue, the page stays fully visible (panel closed) and the badge count increments by one.

**Change 2 — snap back to Cursor after a completed Region mark.**
After a Region selection is captured and the message queued (`enqueueRegion` completes), automatically return to Cursor mode (`setMode("cursor")`), so the user is back to normal interaction after a successful screenshot+queue. This is the captain's explicit ask for the Region flow. Apply the same post-enqueue reset to the Element flow too for consistency, unless it degrades that flow — use judgment and note what you did.
Verify: after sending a region mark, the active mode is Cursor (dock shows Cursor active, page interactive).

**Keep intact:** the Cmd/Ctrl+Shift+X hotkey (freeze → Region), the dock mode buttons, and the per-selection "queue a message" card (`openCard`) where the user types the note before queuing — that card is how text is added and it stays. It is specifically the big right-side PANEL that must not auto-open on queue.

Add/adjust unit tests in `assets/nitpicker/tests/`: (a) an enqueue does not set `panelOpen` / does not open the panel; (b) a Region enqueue resets mode to `cursor`. Follow the existing test style. Update docs (`SKILL.md`, `README.md`, `CHANGELOG.md`) if any describe the panel-opening-on-queue behavior or the mode flow. Verify the behavior in a browser the same way the hotkey was verified earlier. Run all repo checks (typecheck, lint, vitest, build/verify) green before reporting done.

Acceptance: queuing a Region/Element mark leaves the side panel closed (only the badge counter increments); after a Region mark+queue the overlay returns to Cursor mode; hotkey + dock + per-mark card all still work; unit tests added; repo checks green.

# Setup
You are in a disposable git worktree of nitpicker, at a detached HEAD on a clean default branch.

**Verify isolation before anything else.** Run `pwd -P` and `git rev-parse --show-toplevel`; both must resolve to the disposable treehouse worktree you were launched in, typically a path under a `.treehouse/` pool, not the primary checkout firstmate operates from.
The path check is authoritative: `git rev-parse --git-dir` and `git rev-parse --git-common-dir` can help inspect the repo, but they do not prove you are outside the primary checkout.
If the top-level path is the primary checkout or not the worktree you were launched in, STOP - do not branch or commit here - append `blocked: launched in primary checkout, not an isolated worktree` to the status file and stop.

1. First action: create your branch: `git checkout -b fm/np-uxfix-h3`
2. Run `no-mistakes doctor`; if it reports the repo is not initialized here, run `no-mistakes init`.

# Rules
1. Never push to the default branch. Never merge a PR.
2. Stay inside this worktree; modify nothing outside it.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/np-uxfix-h3.status'`
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

---

## Change 3 (added by captain feedback) — make the region→card flow feel INSTANT

Live feedback: on the **dock Region path** (drag a box without the hotkey), there is a ~1–2s delay between releasing the drag and the queue card appearing. Diagnosis: in `onDragEnd`, the dock path calls `freezeAndCapture(rect)` which does `await captureRegion(...)` (the full-page rasterization) **before** `showQueueCard(...)`. So the expensive raster blocks the card. (The hotkey path is already fast because it rasterizes at key-press and only `annotateRegion`-crops on release — `captureFromFrozen`.)

Make the drag-Region flow feel instant. Two viable approaches — pick the one that stays correct and simplest:
- **(Preferred) Pre-rasterize early, crop on release** — mirror the hotkey path for the dock path: kick off the viewport rasterization as early as possible (on entering Region mode, or on `onDragStart`) into `frozenCanvas`, running async so it overlaps the user's drag; then `onDragEnd` just does the fast `annotateRegion` crop and opens the card immediately. By release, the raster is usually already done → card appears instantly.
- **(Alternative) Optimistic card** — open the queue card immediately on `onDragEnd` and run `captureRegion` in the background, attaching the blob/thumb to the item when it resolves (show a lightweight "capturing…" placeholder that fills in). The user types/queues without waiting.

Hard requirements:
- The card must appear effectively instantly (no perceptible wait) after the drag release.
- Do NOT regress the hotkey path's correctness — it must still capture the frozen press-time viewport (hover-only UI preserved).
- The queued screenshot must still be correct (right region, right pixels, red box burned in). If you go optimistic, guarantee the blob is attached before the item is actually sent.
- Handle the raster-fails case gracefully (the existing `capture failed:` path).
- Add a test or a clear in-browser verification that the card shows without waiting on the raster.

This is the highest-priority of the three changes — the flow feeling instant matters most.

---

## Change 1 — REVISED (supersedes the original Change 1 above): DOCK the chat pane, do not overlay

New captain feedback supersedes the original Change 1. Do NOT just suppress/hide the panel — instead make the chat pane a real DOCKED sidebar that reserves its own width, so the app reflows beside it and it never covers anything:

- The chat pane (queued-messages list + controls) is fixed to the RIGHT edge, full viewport height, with a real width (~320–360px). It must NOT overlay the app. Reserve its width so the host app reflows into the remaining space — e.g. set `document.body`/`documentElement` `margin-right` = pane width while shown, so the app renders in `viewportWidth − paneWidth`. Smooth transition on resize.
- **Default: pane SHOWN** (docked, reserving width) from mount.
- **Hide/show toggle** at the TOP-LEFT of the pane: hides it (collapse, remove the reserved margin → app full width) / shows it again, with the app dynamically resizing both ways. Persist state if trivial (localStorage), else default shown.
- **Enqueue:** queuing a mark just appends to the always-visible pane list (`renderQueue()`) + increments the badge — no overlay, no page coverage. This replaces the `panelOpen` overlay concept with the docked shown/hidden state, and resolves the original "panel covers the page" complaint.
- **Screenshots must exclude the pane:** region capture (both the dock-drag path and the Cmd/Ctrl+Shift+X freeze) must only ever capture the APP area (the reduced viewport where the host app renders), NEVER the chat pane. Constrain region selection to the app area (exclude the pane's reserved width) and ensure the raster/clip uses the app area, not the full window including the gutter.
- **Allowed fallback (captain-approved):** if the dynamic hide/show + reflow is too hard to do robustly, it's acceptable to have the pane ALWAYS shown (docked, reserving width) with no toggle. Non-negotiables: docked not overlay, app reflows beside it, screenshots never include the pane.

Changes 2 (snap to Cursor after a Region mark) and 3 (instant region→card flow) still stand. This revised Change 1 is now the largest piece — prioritize getting the docked, non-overlapping pane + screenshot-excludes-pane correct.
