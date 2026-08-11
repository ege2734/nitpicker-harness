# Next rapid-mode batch — builder queue/chat UX (3 items)

Same rapid-iteration protocol as before: implement on `fm/harness-overlay-cookie-c2`,
keep `typecheck` + `vitest` green, commit + push, report `done` with the new SHA, and
**skip /no-mistakes** (firstmate batches the gate later). Classic ShellChrome must stay
unchanged unless a change is the identical one-line seam; these are builder-pane features.

## 1. Full-screen the region screenshot from an expanded queued mark
When a queued mark is expanded and shows its red-boxed region screenshot, clicking the
screenshot opens it **full-screen / lightbox** (the full captured image at max size, over a
dim backdrop; Esc or click-backdrop closes). Today the thumbnail is the end of the road —
add the zoom. Reuse the existing `_blob`/`_thumb` region capture; the lightbox shows the
full-resolution blob, not the thumbnail. Keep object-URL revocation correct (don't leak the
full-size URL).

## 2. Enter-to-save when editing an already-queued message
In an expanded queued item, the note is live-editable. Make **Enter commit the edit**
(save the edited note back onto the queued item) and collapse/confirm, mirroring the
original nitpicker's save/remove affordances on a queued item. Shift+Enter = newline within
the note; Esc = cancel the edit and restore the prior note. The existing remove/dismiss
(the × ) stays. Net: an already-queued message is editable and Enter-saves, just like the
classic overlay.

## 3. Chat-panel queueing model: Enter = queue, Cmd/Ctrl+Enter = flush
Change the builder chat composer's submit semantics so the composer can stage messages into
the SAME queue the marks use:
- **Enter** (in the chat composer, no mark active) → **queue** the typed text as a queued
  item (a standalone "message" mark in the queue rail), clear the composer, do NOT send to
  the agent yet. This lets the user stack several messages/marks before sending.
- **Cmd+Enter** (macOS) / **Ctrl+Enter** (other) → **flush the queue**: send everything
  currently queued — typed messages AND region/element/edit marks, in queue order — to the
  agent as one turn, then clear the queue.
- Shift+Enter stays newline.
- Keep the existing mark→queue flow intact; a typed message is just another queue item kind.
- Update the composer placeholder/hint to teach the model, e.g. "Enter to queue · ⌘↵ to send".
- If nothing is queued and the user hits Cmd+Enter with text in the composer, treat it as
  queue-then-flush (send that one message) so a single quick message still works in one gesture.

**Open judgment call (decide + note it in your `done`):** how a queued typed-message and a
queued mark combine when flushed — I expect them concatenated in order into the one turn's
message (marks carrying their file:line/region context as today). If a cleaner grouping is
obvious, use it and say what you chose.

**Validate:** unit/interaction tests for (1) screenshot click → lightbox open/close, (2)
Enter saves an edited queued note + Esc cancels, (3) Enter queues from the composer without
sending, Cmd/Ctrl+Enter flushes the whole queue to the agent, Shift+Enter newlines. Classic
shell composer behavior unchanged. Note the new SHA so firstmate re-pins the dogfood.
