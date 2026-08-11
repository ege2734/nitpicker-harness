# Next rapid-mode batch — sent-turn history in the builder chat pane

Same rapid protocol: implement on `fm/harness-overlay-cookie-c2`, keep `typecheck` + `vitest`
green, commit + push, report `done` with the new SHA, **skip /no-mistakes**. Builder-pane
(embedded live-agent mode) only; classic ShellChrome/feedback mode unchanged.

## Goal
Today the composer queue is a *staging* area: you stack messages + marks, hit ⌘↵ to flush,
and the queue clears — so the record of **what you sent** disappears. The captain wants the
standalone/embedded agent side panel to **retain every sent turn in an expandable, nice
format**, so they can scroll back and recall exactly what they sent the agent, screenshots
included.

## Do
1. **On flush (⌘↵), persist the sent batch as a "sent turn" entry in the chat history**, not
   just fire-and-clear. The user's turn should render in the chat transcript (interleaved
   with the agent's streamed reply, above/before that reply) as a rich entry — alongside the
   agent responses that already stream in.
2. **Each sent-turn entry is expandable**, reusing the queued-item UX you just built:
   - **Collapsed:** a compact summary line — e.g. the lead message text (truncated) + an item
     count / kind badges ("2 marks · 1 message").
   - **Expanded:** each item as it appears in the live queue today — the message text, and for
     each mark its note + red-boxed **region screenshot** (or element/edit descriptor:
     component / source `file:line` / selector / testid / tag).
   - The region screenshot in history keeps the **click-to-lightbox** full-screen behavior
     you just added.
3. **Screenshots must survive in history.** The live queue currently revokes object URLs on
   clear/flush — for history, retain what's needed to render them later. Prefer keeping the
   **thumbnail (`_thumb`)** for the always-visible history preview; keep the full-res (`_blob`)
   available for the lightbox where feasible. **Watch memory** — if retaining every full-res
   blob across a long session is heavy, keep thumbnails in history and either (a) keep full-res
   for the most recent N turns, or (b) note the tradeoff you chose. Don't leak object URLs;
   revoke on entry teardown, not on flush.
4. **Ordering & scope:** newest activity at the bottom (or match the existing chat scroll
   direction), history scrolls with the conversation, and this is the embedded live-agent pane
   (BuilderChrome). If the gateway `/history` endpoint already replays agent messages, the
   USER sent-turns are a client-side augmentation layered onto the same transcript — the marks/
   screenshots are client blobs and won't come back from the server, so retain them client-side
   for the session (persistence across reloads is a nice-to-have, not required now).

## ALSO — fix agent markdown rendering in the chat
The agent's streamed replies in the builder chat pane are **not rendering markdown** — they
show raw markup (e.g. `**bold**`, `- lists`, `` `code` ``, ```code fences```, headings) instead
of formatted output. Render the agent's assistant messages as **formatted markdown**:
- Headings, bold/italic, ordered/unordered lists, inline code, fenced code blocks (monospace
  block, ideally with basic syntax legibility), links, blockquotes, paragraphs/line breaks.
- **Stream-safe:** it must render correctly as tokens stream in (incremental/partial markdown
  shouldn't flicker or throw on an unterminated code fence).
- **Safe rendering:** sanitize — the agent output is untrusted-ish; no raw HTML injection / XSS.
  Use a small, dependency-light markdown renderer (or the harness's existing one if present);
  don't balloon the bundle.
- Scope: the **agent/assistant** messages in the embedded builder chat. The user's own sent
  text can stay plain (or lightly formatted) — the fix is the agent's replies reading as raw
  markdown. Classic feedback mode unchanged.

## ALSO — fix missing icons in region screenshots (icon-font tofu boxes)
Region capture screenshots render every icon as an empty box (□). Root cause (confirmed):
`@loom/ds` renders icons as a **self-hosted Phosphor icon web font** (`@font-face`, 3 weights,
see `packages/ds/src/styles-entry.css`). html2canvas-pro rasterizes a cloned document and the
Phosphor webfont isn't loaded/embedded in that clone at capture time, so every icon glyph falls
back to the missing-glyph box. Fix the capture (in `vendor/nitpicker/core/region.ts` and/or the
shared capture path) so icon-font glyphs render:
- **Await fonts before capturing:** `await document.fonts.ready` (and if needed explicitly
  `document.fonts.load(...)` the Phosphor weights) so the webfont is resolved before rasterizing.
- **Ensure html2canvas can use the font in its clone.** The capture runs over the same-origin
  proxied app, so the self-hosted woff2 is same-origin — but confirm html2canvas actually
  embeds the `@font-face`. If it still tofus, either enable **`foreignObjectRendering`** (SVG
  `<foreignObject>` uses the real loaded font stack — best for icon fonts; verify no taint/CORS
  regression and that the existing oklab/oklch handling still holds), OR inject the Phosphor
  `@font-face` as a **base64 data-URI font** via html2canvas's `onclone` hook so the glyphs are
  guaranteed present in the clone.
- Pick the cleanest that actually renders the icons; keep the html2canvas-pro oklab/oklch fix
  intact. This applies to region screenshots wherever they're captured (live queue, history).
- **Verify visually:** a region capture over the Loom shell chrome (Fork/Share/Deploy/Preview/
  Code/Plugins toolbar) shows the real icons, not □ boxes.

## Validate
Interaction/unit tests: (a) flushing a queue creates a sent-turn history entry carrying its
messages + marks; (b) the entry expands to show notes + region screenshot (thumb) and the
screenshot still opens the lightbox; (c) object URLs are not leaked (revoked on entry teardown,
not on flush) and the live-queue clear still works. Classic shell unchanged. Note the new SHA
so firstmate re-pins the dogfood.
