# STOP validation — two live bugs in the region flow to fix first

The captain live-tested the synced overlay and found two real regressions from THIS iteration. Do NOT ship the current commit. **Abort the active no-mistakes run** (`no-mistakes axi abort --run <id>` — get the id from `no-mistakes axi status`), fix both bugs, re-verify against the captain's exact scenario, re-commit, and only then re-run /no-mistakes.

## Bug 1 — red box drawn in the wrong place (only one edge lands in frame)
The captain drew a Region box around a KPI/aggregate box in pocketwatcher; in the output, the red box is mispositioned — only one edge is visible. Root cause is almost certainly the pane-exclusion change (revised Change 1): the capture area became the APP area (viewport minus the docked pane width), but the coordinate math for the red box / dim bands / scale-check was not consistently moved into that same app-area space. Right now `region.ts` `rasterizeViewport` still uses `viewport = {w: window.innerWidth, h: window.innerHeight}` (the FULL viewport incl. the pane gutter), and `checkCaptureScale` compares against that full viewport — but the actual captured canvas excludes the pane. So the selection rect, the composited red box (`redbox.ts` `scaleRect`/`compositeRegion`), the captured canvas, and the scale-check must ALL agree on one coordinate space (the app area).

Fix: make the whole region pipeline consistent — the viewport/appArea dimensions used for rasterization, the selection-rect coordinates, the red-box + gray-band compositing, and `checkCaptureScale` must be in the same space so the red box tightly frames exactly the region the user dragged. If the pane reserves width on the right, the app area is `x∈[0, innerWidth − paneWidth)`; keep the selection constrained there and composite in that space.

**Verify concretely:** in the browser, with the pane shown, drag a Region box tightly around a specific KPI box; export/inspect the resulting PNG (and the panel thumbnail) and confirm the red box frames THAT box tightly and squarely (all four edges), not offset/clipped. Test with the pane both shown and hidden (different app widths), and near the right edge (adjacent to the pane).

## Bug 2 — the browser freezes at drag-start before you can draw
On the dock Region path, pressing the mouse to start drawing freezes the page ~1–2s before the user can draw. Cause: the "instant card" change rasterizes the screenshot at drag-start (or region-enter) synchronously, blocking the draw. That moved the lag from after-release to before-draw — still wrong.

Fix: **drawing the selection must be instant.** On the dock path, do NOT rasterize before/at drag-start. Let the user draw the selection rectangle on the LIVE page (the selection box is just an overlay rect — no freeze needed to draw it). Do the screenshot rasterization AFTER release, and make the queue card appear instantly via the optimistic approach: open the card immediately on mouseup with a lightweight "capturing…" placeholder, run the raster + red-box composite async, and fill in the thumbnail/blob when ready (guarantee the blob is attached before the item is actually sent). Net effect: instant to draw AND instant card, raster fully in the background.
- Keep the **hotkey path (Cmd/Ctrl+Shift+X)** freezing at key-press as-is — that freeze is required to preserve hover-only UI, and there is no drag-blocking there (the user isn't dragging when they press the key).

**Verify concretely:** click Region, press-and-hold to start drawing — the selection rectangle must follow the cursor immediately with no perceptible freeze; on release the card appears instantly; the screenshot (with correct red box from Bug 1) attaches within a moment.

## After both fixes
1. Run the repo checks green (typecheck, lint, vitest — add/adjust tests for the corrected red-box coordinate space if feasible).
2. Verify in a browser as best you can from your own worktree (a scratch harness / installed test app, the way you verified earlier). The final proof-in-the-real-app happens in pocketwatcher — that is a DIFFERENT worktree owned by another session, so do NOT write into it; firstmate will orchestrate that sync + real-app verification.
3. Commit the fixes on your branch, then append `done: region bugs fixed (red box framed correctly in app-area space + instant draw via optimistic card), <commit>, ready to re-sync` and STOP. Do NOT re-run /no-mistakes yet and do NOT touch any other worktree — firstmate will have the pocketwatcher session pull the fix, get the captain's re-test verdict, and then tell you to validate.

---

## Refinement to Bug 2 + a new feature (fresh captain feedback)

### Raster timing: generate the region screenshot at QUEUE, per mark, async
Refine the Bug 2 fix. On the DOCK path, rasterize the region screenshot when the user presses **Queue** in the card — NOT at drag-start, NOT at mouseup. Flow: drawing the selection is instant (live rect on the live page, no freeze); the card opens instantly on release with the message input; ONLY when the user commits with **Queue** do you rasterize THAT region asynchronously (non-blocking) and attach the blob to the queued item. A draw the user cancels (never queues) generates NO image — this is the point: don't rasterize marks that get discarded. Guarantee the blob is attached before "Send to agent" fires.
- **Do NOT defer to "Send to agent" time** unless you can guarantee each mark's page state is preserved from when it was drawn. The user may scroll/change the page between queuing and sending, and region coords are viewport-relative, so a send-time raster would capture the WRONG content. Queue-time per-mark is the correct latest-safe point. Do not capture stale state.
- **Hotkey path (Cmd/Ctrl+Shift+X) is exempt** — it must still rasterize/freeze at key-press to preserve the transient hover-only UI.

### New feature: click a queued item to view + edit
In the docked chat pane, make each queued item clickable. Clicking opens a popup/modal (shadow-DOM styled, consistent with the overlay) showing:
- the item's screenshot (region image with the red box) at the top,
- the queued message text below the screenshot,
- an editable text field to edit the message and save it back to that queued item (update in place).
Support close (Esc + a close button); allow removing the item from the popup too if easy. For element (non-screenshot) marks, show the element descriptor instead of a screenshot. Keep it simple.

These fold into the same iteration as Bug 1 (red box in app-area space) and the instant-draw fix. Report `done` with all of it, then STOP for firstmate to orchestrate the pocketwatcher re-sync + captain re-test (do NOT re-run /no-mistakes or touch pocketwatcher yourself).
