# nitpicker-harness → "builder shell" — feasibility spike + phased build plan

**Author:** scout crewmate · **Date:** 2026-07-06 · **Deliverable:** report only (no PR, no branch)
**Worktree:** `~/.treehouse/nitpicker-harness-877c8e/1/nitpicker-harness` (detached HEAD @ `ddc7d32`, discarded at teardown)

---

## TL;DR — verdict

**The same-origin-iframe hybrid works. Build it.** Every load-bearing claim was proven in a real browser
(Chromium via Playwright) against a genuinely hydrated **Next 16.2 / React 19.2** app:

| # | Claim | Result | Evidence |
|---|-------|--------|----------|
| 1 | Parent shell reads a same-origin iframe's `contentDocument` (`elementFromPoint`, `getBoundingClientRect`, expando props) | ✅ | Tier-1 & Tier-2 evals |
| 1 | Parent runs the **React fiber walk** over an iframe node → component name | ✅ `"PricingCard"` | Tier-2 injected-shell eval |
| 1 | Parent runs **html2canvas** against an iframe element | ✅ 364×83 non-blank PNG | Tier-1 eval |
| 1 | Same-origin **breaks** when the iframe navigates cross-origin | ✅ `contentDocument === null` | Tier-1 eval |
| 2 | Chat/queue in the **parent** survive iframe SPA-nav, hard reload, even cross-origin nav — **zero extra work** | ✅ queue held at 1 across all three | Tier-1 eval |
| 3 | `file:line` provenance via a build-step source stamp (for builds we own) | ✅ `app/pricing-card.tsx:4:5`, readable from parent | Next 16 Turbopack + source loader |
| 4 | Highlight drawn from parent over iframe needs coordinate translation — and there's a clean way | ✅ + gotcha found & fixed | screenshots `tier1-highlight{,-fixed}.png` |
| 4 (Phase 4) | Parent-driven `contenteditable` on an iframe element → edit payload with exact source | ✅ `app/pricing-card.tsx:9:7` | Tier-2 edit eval |

**One critical, orthogonal finding (see §4):** the *current* harness proxy **breaks client hydration on
Next 16 / React 19.2** — the fiber walk (hence component name) returns nothing **through the proxy**,
while it works perfectly when the app is served directly. This is a **pre-existing regression**,
independent of the shell decision, and it is the **#1 prerequisite** for any element/component feature.
Provenance (`data-nitpicker-source`) is unaffected because it lives in the SSR HTML, not the client fiber.

**Does this replace `nh-persist-nav`?** **Yes.** With the queue in the parent shell, persistence across
iframe navigation is *structural* — proven, needs no localStorage. `nh-persist-nav` becomes unnecessary
**for the builder-shell path**. (Keep it only if you want unsent-state persistence for the legacy
"inject into the app frame" mode; see §7.)

---

## 1. What I built and ran (so this reproduces)

Two fixtures, both driven through Playwright/Chromium. Scratch lives under the session scratchpad
(`.../scratchpad/`), nothing committed.

### Tier-1 — isolated browser-capability proof (static, no framework)
`scratchpad/static-proof/server.mjs`: two Node HTTP servers —
- `:7801` serves `/shell` (parent), `/app` + `/app2` (same-origin iframe targets),
- `:7802` serves `/external` (a **genuinely cross-origin** page).

The shell parent holds the queue in a plain JS array, reads `iframe.contentDocument`, and draws a
highlight `<div>` in the parent positioned over an iframe element.

### Tier-2 — the real stack
- A real **Next 16.2.10 / React 19.2.4** app (`scratchpad/app`, `create-next-app`) with a distinctly
  named **client** component `PricingCard` (`app/pricing-card.tsx`) rendering host `<div data-testid>`,
  `<h2>`, `<button>`, plus an `/about` route for SPA nav.
- The vendored **source-stamp loader** wired into `next.config.ts` under `turbopack.rules` (dev-only),
  with `@babel/core` installed. This is exactly the opt-in described in `SKILL.md:126`.
- The **real harness** (`npm run start -- --target http://localhost:3000 --port 4000`) proxying it.
- A scratch **shell route** (`/__nitpicker-harness/shell`) I added to `src/proxy/server.ts` (reverted
  after) that serves a parent page embedding `<iframe src="/">` — same-origin with the harness.

Commands and raw outputs are in the Appendix (§9).

---

## 2. Does the same-origin-iframe hybrid actually work? (spec Q1)

**Yes — fully.** The parent reads and manipulates the iframe's DOM with no `postMessage` bridge.

**Tier-1 (static), one eval returned:**
```
contentDocumentReadable: true
elementFromPoint_tag:     "DIV"        // parent called iframe's elementFromPoint
target_rect:              {x:60,y:367,w:364,h:83}   // getBoundingClientRect across the boundary
target_source_attr:       "app/page.tsx:12:5"       // read an attribute off the iframe node
canWriteExpando:          true         // parent SET node.__parentTouched and read it back
picked.route:             "/app"
queueLen:                 1
highlightShown:           "block"
```
The `canWriteExpando: true` line is the crux: **reading `node.__reactFiber$…` off an iframe element is
the exact same operation as reading any JS property off a same-origin object** — the SOP does not gate
it. This is why the whole nitpicker DOM toolkit ports across the boundary unchanged.

**Tier-2 (real hydrated React app), the decisive eval** (parent = `localhost:3000`, iframe src =
`localhost:3000`, i.e. a real same-origin shell around a hydrated app):
```
parentOrigin:                    "http://localhost:3000"
iframeSrcOrigin:                 "http://localhost:3000"
contentDocumentReadable:         true
fiberFoundFromParent:            true
componentNameFromParentFiberWalk:"PricingCard"        ← full fiber walk, from the parent
sourceAttrFromParent:            "app/pricing-card.tsx:4:5"
rectFromParent:                  {w:261,h:173}
```
The parent resolved the React component name **by walking the fiber of an iframe node** — the single
hardest same-origin DOM read nitpicker does — plus provenance and geometry, with zero bridge code.

**html2canvas from the parent over iframe content** (Tier-1):
```
ok:true  canvasW:364  canvasH:83  dataUrlPrefix:"data:image/png;base64,iVBORw0K"  nonBlank:true
```
html2canvas, loaded in the **parent**, rasterized an element whose `ownerDocument` is the iframe.
Same-origin lets it read computed styles cross-document; it produced a correct non-blank PNG.

**Where same-origin breaks** (Tier-1): after navigating the iframe to the cross-origin `:7802`:
```
crossOrigin: "contentDocument===null"     // Chromium returns null (WebKit/Firefox throw SecurityError)
queueAfterCrossNav: 1                      // ...but the parent queue is untouched
```
So the boundary holds exactly where SOP says: **any page the proxy serves under the harness origin is
readable; the instant the app itself navigates to a truly foreign origin, DOM tooling goes dark for that
page** (the highlight/pick/capture simply no-op), while the parent chrome survives. In the harness this
only happens if the app links out to a real external origin that the proxy isn't fronting — the same
class of case the current proxy already can't help with.

---

## 3. Persistence — is it structural? (spec Q2)

**Yes, and it's the strongest argument for the shell.** Tier-1 eval drove the iframe through three
navigation types while watching the parent-held queue:
```
queueBefore: 1
step nav → /app2 (real new document):  contentReadable:true,  queueAfterNav:1
step hard reload of iframe:            queueAfterReload:1
step nav → cross-origin :7802:         queueAfterCrossNav:1
```
The queue lives in the **parent window's** heap. Nothing an iframe does to its own document — client
nav, `location.reload()`, or even wandering cross-origin — touches the parent. **Persistence is free and
total; it requires no code.**

**Implication for `nh-persist-nav`:** that change existed to survive a *hard page reload* that reset the
in-page overlay's unsent chat/queue. In the shell, a "hard reload" is an **iframe** reload, and the
parent chrome doesn't reload with it. **The localStorage persistence change is unnecessary in the
builder-shell architecture** — the shell subsumes it structurally. (The one residual case — the user
hard-reloads the *whole shell tab* — is a normal "you're reloading the editor" reset, same as reloading
Lovable/v0; if you want to cover even that, a tiny parent-side `sessionStorage` snapshot is trivial and
still simpler than injecting persistence into the app frame.)

---

## 4. `file:line` provenance — and a critical orthogonal regression (spec Q3)

### 4a. Provenance works for builds we own — confirmed end-to-end
The vendored dev-only source stamp is **`vendor/nitpicker/next/nitpicker-source-plugin.cjs:14`** (a Babel
plugin appending `data-nitpicker-source="path:line:col"` to every host JSX tag) driven by
**`nitpicker-source-loader.cjs`**. I wired it into the Next 16 app's `next.config.ts` under
`turbopack.rules` (dev-only), and it stamped correctly under Turbopack:
```
$ curl -s localhost:3000/ | grep -o 'data-nitpicker-source="app/pricing-card.tsx:[0-9:]*"'
data-nitpicker-source="app/pricing-card.tsx:4:5"   # PricingCard host <div>
data-nitpicker-source="app/pricing-card.tsx:9:7"   # its <h2>
data-nitpicker-source="app/pricing-card.tsx:10:7"  # its <button>
```
The attribute is read by **`vendor/nitpicker/react/react-source.ts:86 sourceOf()`**, which the parent
runs against iframe nodes (proven: `sourceAttrFromParent: "app/pricing-card.tsx:4:5"` in §2). Crucially,
**this attribute is in the SSR HTML and survives the proxy** (verified through `:4000`), so provenance
does not depend on client hydration.

**Honest scope:** this only works when **we control the target's build** (we add the loader to *their*
bundler). For an arbitrary external app the harness merely proxies, there is no stamp — `component +
selector + text + route` remain the baseline, exactly as `README.md:92` ("the one honest limit") states.
This is inherent, not a shell limitation.

### 4b. ⚠️ Critical: the current proxy breaks client hydration on Next 16 / React 19.2
While proving the fiber walk I found that **component-name resolution is currently broken *through the
harness proxy*** — a regression that exists today, independent of the shell. Controlled A/B:

| Served via | `__reactFiber$` on nodes? | Component name? |
|------------|---------------------------|-----------------|
| **Direct** `localhost:3000` | ✅ present (`__reactFiber$l5ik8f1v3ih`) | ✅ `"PricingCard"` |
| Proxy top-level `:4000` (overlay injected) | ❌ absent (only `__reactContainer$`, `__reactEvents$`) | ❌ none |
| Proxy `:4000` **no overlay inject** (`NH_NO_INJECT`) | ❌ absent | ❌ none |
| Proxy `:4000` **pure passthrough** (`NH_NO_INJECT` + `NH_NO_REWRITE`) | ❌ absent | ❌ none |

So it is **not** the overlay injection and **not** the absolute-URL rewrite — it reproduces with the
proxy doing nothing but piping bytes. The **only** console errors in every proxied run are repeated:
```
WebSocket connection to 'ws://127.0.0.1:4000/_next/webpack-hmr?id=…' failed:
  Connection closed before receiving a handshake response
```
React's runtime loads (the DevTools banner prints, `__reactContainer$`/`__reactEvents$` attach), but
per-node fibers are never attached — the signature of hydration that never walked the tree. **Leading
hypothesis:** the harness's HMR WebSocket forwarding fails against **Next 16 Turbopack** (`server.ts:152
server.on("upgrade")` → `proxy.ws`), and the failing dev socket stalls the Turbopack dev runtime before
hydration completes. (`README.md:112` claims HMR forwarding was verified — but that was against Next 15 /
webpack; Turbopack's HMR endpoint/protocol differs.) A secondary possible factor is that the proxy
**buffers** the entire streamed HTML (`server.ts:88–104`) and re-emits it with a fixed `content-length`,
collapsing Next's chunked RSC streaming.

**Why this matters for the plan:** the shell does **not** fix this — but it also isn't blocked by it for
most value (screenshots, selector, provenance, text-edit all work without the client fiber). Restoring
hydration is a **prerequisite specifically for the fiber-based component name**, and it must be fixed
regardless of architecture. It gets its own line item in Phase 0 below.

---

## 5. Coordinate/overlay mechanics — draw from parent, or inject inside? (spec Q4)

**Recommendation: keep the highlight/redbox overlay layer in the PARENT shell (a sibling of the iframe),
not injected inside the iframe.** Reasons:
- It's structurally cleaner: one overlay canvas that never reloads when the app navigates (same reason
  the chat is in the parent).
- It keeps the **app document pristine** — no injected nodes, no injected `<script>`, no
  `documentElement.style.marginRight` mutation. That matters because injecting into the app frame is a
  hydration-mismatch risk (and see §4b — we want the app frame as untouched as possible).
- The coordinate math is trivial **if you lay it out right**, which I proved.

**The gotcha I hit (and the fix), with screenshots:**
The naive translation "parent-overlay position = `iframe.getBoundingClientRect().left + elementRect.left`"
is **wrong** when the overlay layer is absolutely positioned inside the same container as the iframe. The
overlay's `offsetParent` already starts at the iframe's origin, so adding the frame's viewport offset
**double-counts** it. First screenshot (`tier1-highlight.png`) shows the red box shoved ~300px right of
the target.

**Clean rule (verified — `tier1-highlight-fixed.png` wraps the target perfectly):** make the highlight
layer a **sibling of the iframe inside a positioned wrapper whose box == the iframe's box**, then use the
element's **iframe-local** `getBoundingClientRect()` **directly** — no offset addition:
```js
// #stage { position: relative }  contains  <iframe> and <div id="hl">, both filling it
const r = iframeEl.getBoundingClientRect();       // iframe-local coords
hl.style.cssText = `left:${r.left}px; top:${r.top}px; width:${r.width}px; height:${r.height}px`;
```
If your layout ever puts the iframe at a non-zero offset within the overlay's `offsetParent` (e.g. a
toolbar strip above it), translate by the **iframe's offset within that `offsetParent`**, not by its
viewport rect. Region drag rects follow the same rule. (One caveat to honor in Phase 2: the iframe has
its **own scroll**; a parent overlay must read `iframe.contentWindow.scrollX/Y` and reposition on the
iframe's `scroll` event, since scrolling the iframe doesn't move the parent overlay.)

---

## 6. Recommended architecture (concrete shape)

```
Harness origin :4000
├── GET /__nitpicker-harness/shell        → the SHELL PAGE (parent window): chat + queue + toolbar +
│                                            <iframe src="/"> + parent-side overlay layer
├── GET /__nitpicker-harness/shell.js     → the shell bundle (chrome + the lifted overlay engine)
├── GET /  (and every app route)          → proxied target app, served into the iframe  (UNCHANGED proxy)
└── GET /__nitpicker-harness/overlay.js   → (legacy) in-frame overlay, kept for "feedback proxy" mode
```
- **Where the shell lives:** a new route on the harness origin (I prototyped `/__nitpicker-harness/shell`
  in `src/proxy/server.ts`). Same origin as the proxied app ⇒ the parent reads the iframe directly.
- **How the parent reaches the iframe:** `document.getElementById('frame').contentDocument` — no bridge.
  The lifted overlay engine takes a `doc`/`win` handle (the iframe's) instead of the ambient globals.
- **Overlay/chat split:** chat + queue + toolbar + highlight/redbox overlay all in the **parent**; the
  **app iframe stays code-free** (this is the big win vs. today's injection).
- **Provenance re-entry:** unchanged — the target's build stamps `data-nitpicker-source`; the parent's
  picker reads it off iframe nodes (`react-source.ts` reused verbatim).

This is the Lovable/v0/Webflow shape (parent chrome + iframe app), but with their `postMessage` bridge
**deleted** because the proxy makes the frame same-origin. That is the unique advantage the harness's
proxy buys us, and this spike confirms it is real.

---

## 7. What we lose / cost, and the mode question (spec Q5)

**The "zero code, works on ANY running app" superpower is retained — as a second mode.** The proxy is
unchanged; the shell is additive. Two modes:

| Mode | Target | Chat/queue | Overlay | Component | `file:line` |
|------|--------|-----------|---------|-----------|-------------|
| **Builder shell** (apps we own) | proxied app in parent's iframe | parent (persistent) | parent layer | fiber walk (after §4b fix) | ✅ build stamp |
| **Feedback proxy** (any external app) | proxied app, overlay injected in-frame | in-frame (today) | in-frame | fiber walk | ❌ (no stamp) |

**Recommendation: build the shell as a new default mode, keep the injected feedback-proxy as a fallback
`--mode inject` for arbitrary external apps.** Not a replacement — the injected mode is the only thing
that works when we *don't* control the target and just want feedback. The shell is strictly better
whenever we own the app (which is the whole "build a whole app" use case that motivated this spike).

**Cost vs. `nh-persist-nav`:** `nh-persist-nav` is a ~1-file localStorage change. The shell is a genuine
feature (new route, a shell bundle, lifting the overlay engine to take a target `doc`/`win`, parent-side
overlay geometry). **But** the shell *deletes the need* for `nh-persist-nav` (§3) and unlocks Phases 2–4.
Given the captain has committed to the full builder experience, the shell is the correct foundation and
`nh-persist-nav` should be **dropped** rather than shipped-then-discarded.

**What we genuinely lose / must watch:**
- Injecting nothing into the app frame is a feature, but the parent overlay must now track the iframe's
  **independent scroll** and resize (Phase 2 acceptance test covers it).
- The §4b hydration regression must be fixed for component names (Phase 0). Everything else ships without it.
- If an owned app legitimately navigates cross-origin mid-session (external OAuth), the overlay no-ops on
  that page until it returns — acceptable and unavoidable (SOP).

---

## 8. Phased build plan (dispatchable phase-by-phase)

Ordering rule: **Phase 0 → 1 → 2 → 3 → 4.** Phase 0 is a prerequisite only for the *component-name*
feature; Phases 1–2 (minus component name) do not depend on it, so 0 can run in parallel with 1.
"Files touched" are relative to the harness repo.

### Phase 0 — Fix proxy hydration / HMR on Next 16 Turbopack *(prerequisite for component name)*
- **Scope:** restore client hydration through the proxy so per-node React fibers attach (and HMR works).
  Diagnose the failing `_next/webpack-hmr` WebSocket upgrade under Turbopack; verify whether HTML
  buffering (`server.ts:88–104`) needs to become a streaming transform. Fix the ws forwarding
  (`server.ts:152`) and/or switch HTML handling to a pass-through stream that injects at the `</body>`
  boundary without collapsing chunked RSC.
- **Files:** `src/proxy/server.ts` (ws upgrade handling, response streaming), possibly `src/proxy/inject.ts`
  (make injection stream-friendly). Add a regression test under `tests/`.
- **Acceptance test:** with the harness proxying the Next 16 fixture, a browser at the proxied URL shows
  **zero HMR WebSocket errors**, `__reactFiber$…` is present on `[data-testid="pricing-Pro"]`, and the
  vendored `resolveReactElement` returns `component: "PricingCard"`. Editing `pricing-card.tsx` hot-reloads
  the proxied page. (A/B harness from §4b is the ready-made test rig.)
- **Depends on:** nothing. Can run in parallel with Phase 1.

### Phase 1 — The hybrid shell: persistent parent chat + queue, same-origin iframe, no bridge
- **Scope:** a shell page served from the harness origin that embeds `<iframe src="/">` and hosts the
  chat + queue in the **parent**. Lift the queue/chat/transport out of the in-page overlay into the shell.
  No element/overlay features yet — this phase is the frame + persistent chrome + send-to-sidecar.
- **Files:**
  - `src/proxy/server.ts` — add `GET /__nitpicker-harness/shell` (prototyped here) + `/shell.js`.
  - `src/shell/entry.ts` (new) — parent chrome: chat UI, queue state, `Send to agent` → sidecar POST
    (reuse `vendor/nitpicker/core/transport.ts`).
  - `src/shell/build.ts` (new, mirrors `src/overlay/build.ts`) — esbuild bundle for the shell.
  - Reuse `vendor/nitpicker/core/transport.ts`, `types.ts` (`serializeItem`), `server/` sidecar unchanged.
- **Acceptance test:** open `/__nitpicker-harness/shell`; type a message, queue it; navigate the iframe
  (SPA link **and** hard reload **and** a cross-origin excursion and back); confirm the queue count is
  unchanged throughout (structural persistence, §3); `Send to agent` drains via
  `nitpicker-harness poll --session <id>`. **Delete `nh-persist-nav` in this phase.**
- **Depends on:** nothing (Phase 0 independent). This is the foundation for 2–4.

### Phase 2 — Element selection, highlight overlay, region + element screenshots across the boundary
- **Scope:** lift the overlay *engine* (`vendor/nitpicker/core/overlay.ts`, `region.ts`, `redbox.ts`,
  `elements.ts`) so it operates on a **target `document`/`window` handle** (the iframe's) instead of the
  ambient globals, and renders its highlight/redbox layer in the **parent**. Wire element pick (selector +
  text + rect + route via `resolveReactElement`) and both region and element screenshots (html2canvas in
  the parent against iframe content). Component name arrives here **iff Phase 0 landed**; ship the rest
  regardless.
- **Files:**
  - `vendor/nitpicker/core/overlay.ts` + `region.ts` + `redbox.ts` — parameterize the ~50 `document.`/
    `window.` references (grep confirms they're all ambient today) to a passed-in `doc`/`win`. **Mark as a
    harness-local delta** in `vendor/nitpicker/README.md` (same discipline as the `react-source.ts` patch
    noted in `CLAUDE.md`), or introduce a small `Env` seam so upstream stays clean.
  - `src/shell/entry.ts` — mount the engine against `frame.contentWindow`/`.contentDocument`; add the
    parent overlay layer with the **iframe-local-rect** geometry rule from §5 + iframe scroll/resize
    listeners.
  - Reuse `elements.ts`, `react-source.ts` verbatim.
- **Acceptance test:** in the shell, pick `PricingCard`'s host div → queued item has correct `selector`,
  `text`, `rect`, `route`, and (post-Phase-0) `component: "PricingCard"`; the red highlight **exactly**
  overlays the element (regression-guard the double-offset bug, §5) including after the iframe is scrolled;
  a region drag produces a red-boxed PNG of the iframe content; `poll` drains both.
- **Depends on:** Phase 1 (shell + queue). Component name depends on Phase 0.

### Phase 3 — `file:line` provenance via re-added build-step source stamp (owned builds)
- **Scope:** make the source stamp a first-class, one-line opt-in for apps whose build we control, and
  have the parent picker surface it. The mechanism already exists and is proven (§4a) — this phase is
  packaging + docs + making the picker prefer `source` when present.
- **Files:**
  - `vendor/nitpicker/next/nitpicker-source-loader.cjs` + `nitpicker-source-plugin.cjs` — reused as-is.
  - `SKILL.md` / `README.md` — document the `turbopack.rules` (and webpack) wiring for the builder-shell
    mode (Next 16 Turbopack confirmed working here).
  - `src/shell/entry.ts` — ensure queued items include `source` (already returned by `resolveReactElement`;
    just surface it in the chat item and the wire payload).
- **Acceptance test:** with the loader wired into an owned app's `next.config`, picking an element yields
  `source: "app/pricing-card.tsx:9:7"` in the queued item and the drained `poll` payload; picking in an
  app **without** the loader degrades gracefully to `component + selector + text + route` (no error). Be
  explicit in docs that this is owned-build-only.
- **Depends on:** Phase 2 (element pick surface). Independent of Phase 0.

### Phase 4 — Inline `contenteditable` text editing relayed to source
- **Scope:** click-to-edit visible text directly in the iframe (parent sets `contenteditable` on the
  iframe node), capture the diff, and relay an **edit** item to the agent keyed by source location so the
  agent can patch the file. Proven feasible (§Q1/Q4 edit eval).
- **Files:**
  - `src/shell/entry.ts` — an "edit text" mode: on pick, `el.setAttribute('contenteditable','true')` on the
    iframe node, listen for `input`/blur, compute `{ source, selector, route, oldText, newText }`.
  - `vendor/nitpicker/core/types.ts` — add a `"text-edit"` `QueueItem.kind` (mirrors existing kinds).
  - `vendor/nitpicker/server/` — accept and store the new kind (additive; the sidecar is schema-light).
  - `vendor/nitpicker/cli/poll.ts` — render the edit item (source + old→new) for the agent.
  - Optional stretch: a text-node-precise source stamp (the current stamp is per host element, so an
    element with mixed children maps text edits to the element, not the exact text node — fine for v1).
- **Acceptance test:** in the shell, enter edit mode, change `PricingCard`'s `<h2>` text; a `text-edit`
  item is queued carrying `source: "app/pricing-card.tsx:9:7"`, `oldText: "Pro plan"`, and the new text;
  `poll` prints it in a form an agent can apply. Proven payload shape from this spike:
  ```json
  { "source":"app/pricing-card.tsx:9:7", "oldText":"Pro plan",
    "newText":"Pro plan — EDITED FROM PARENT", "selector":"h2", "route":"/" }
  ```
- **Depends on:** Phase 2 (pick) + Phase 3 (source, for a useful patch target). Text edit without a source
  stamp still works but only carries `selector + text` (less directly patchable).

**Ordering summary:** `0 ∥ 1` → `2` → `3` → `4`. Phase 1 is the safe first dispatch (self-contained,
deletes `nh-persist-nav`). Phase 0 should be dispatched alongside it because component-name (Phase 2) is
dead until it lands. Phases 3–4 are incremental once the pick surface (2) exists.

---

## 9. Appendix — commands & raw measurements

**Environment:** node v20.16.0, Next 16.2.10 (Turbopack), React 19.2.4, Chromium via Playwright MCP.

**Fixtures / servers:**
```
# Tier-1 static proof
node scratchpad/static-proof/server.mjs        # :7801 shell/app, :7802 cross-origin

# Tier-2 real app + harness
(cd scratchpad/app && PORT=3000 npm run dev)    # Next 16 dev, source loader wired in next.config.ts
npm run start -- --target http://localhost:3000 --port 4000 --sidecar-port 5178
# A/B env toggles I added to server.ts (reverted after): NH_NO_INJECT=1, NH_NO_REWRITE=1
```

**Provenance under Turbopack (SSR HTML, survives proxy):**
```
$ curl -s localhost:3000/ | grep -o 'data-nitpicker-source="app/page.tsx:5:5"'   → present
$ curl -s 127.0.0.1:4000/ | grep -o 'data-nitpicker-harness="overlay"'           → present (injected)
$ curl -s 127.0.0.1:4000/ | grep -o 'data-nitpicker-source="app/page.tsx:5:5"'   → present (survives proxy)
```

**Hydration A/B (§4b), `[data-testid="pricing-Pro"]`:**
```
direct  localhost:3000  → keys ["__reactFiber$l5ik8f1v3ih","__reactProps$…"]  component "PricingCard"
proxy   :4000 (inject)  → keys []                                             component none
proxy   :4000 NH_NO_INJECT            → keys []                               component none
proxy   :4000 NH_NO_INJECT+NH_NO_REWRITE (pure passthrough) → keys []         component none
only console errors on all proxied runs: repeated `_next/webpack-hmr` WS "Connection closed before handshake"
```

**Same-origin shell over a hydrated app (§2 decisive eval):**
`{ contentDocumentReadable:true, fiberFoundFromParent:true, componentNameFromParentFiberWalk:"PricingCard",
   sourceAttrFromParent:"app/pricing-card.tsx:4:5" }`

**Persistence (§3):** `queueBefore:1 → afterNav:1 → afterReload:1 → afterCrossNav:1`

**Cross-origin break (§Q1):** iframe→:7802 ⇒ `contentDocument===null`, parent queue still `1`.

**html2canvas from parent (§Q1):** `ok:true, 364×83, nonBlank:true`.

**Coordinate fix (§5):** `tier1-highlight.png` (naive: box +300px off) vs `tier1-highlight-fixed.png`
(iframe-local rect: exact). Both in the worktree root.

**Phase-4 edit mechanic (§Q4):** parent set `contenteditable` on iframe `<h2>`, edited it, produced
`{source:"app/pricing-card.tsx:9:7", oldText:"Pro plan", newText:"Pro plan — EDITED FROM PARENT",
selector:"h2", route:"/"}`.

**Key source references (harness repo @ `ddc7d32`):**
- `src/proxy/server.ts:69–105` — proxyRes HTML buffering (Phase-0 streaming candidate); `:152` ws upgrade.
- `src/proxy/inject.ts:34 injectOverlay`, `:108 relaxSecurityHeaders`.
- `src/overlay/entry.ts` / `build.ts` — the overlay bundle pattern the shell bundle mirrors.
- `vendor/nitpicker/core/overlay.ts` — ~50 ambient `document.`/`window.` refs to parameterize (Phase 2).
- `vendor/nitpicker/react/react-source.ts:31 fiberOf`, `:73 componentName`, `:86 sourceOf` — reused as-is.
- `vendor/nitpicker/next/nitpicker-source-{plugin,loader}.cjs` — the build stamp (Phase 3).
- `vendor/nitpicker/core/types.ts:33 QueueItem` — add `"text-edit"` kind (Phase 4).
