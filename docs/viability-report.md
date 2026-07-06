# Viability report: a standalone "nitpicker harness"

**Task:** assess whether nitpicker can become its own webapp that loads ANY target app inside it and
overlays the same feedback experience — so a developer runs `nitpicker <myapp>` as an external tool with
**zero nitpicker code in the target's codebase**, instead of vendoring it as a skill/dependency.

**Type:** research + design analysis. No code changes, no PR. All conclusions are grounded in the
nitpicker source (file:line references throughout) and in prior art (cited).

**Bottom line up front:** A standalone harness is **viable, but only in the *same-origin proxy* form** —
the harness must serve the target under its own origin and inject the overlay on the fly. A cross-origin
iframe shell cannot deliver nitpicker's two signature features (DOM screenshots, element→source). Even the
proxy harness has one hard, honest limit: **the `file:line:col` source stamp requires build-time
cooperation**, which a proxy cannot manufacture for an arbitrary already-built app. Everything else —
region+redbox, element→component/selector, chat/queue/sidecar — works with genuinely zero target code
once the frame is same-origin. This is exactly the architecture Lovable ships today (§5), so the design is
proven and the work is reusable groundwork for the future platform, not throwaway.

---

## 1. How nitpicker works today, and why same-origin is the load-bearing assumption

Every feature is powered by the overlay being **injected into the app**, sharing its origin, with full
synchronous DOM access. Concretely, from the code:

- **Mount is inside the app.** `react/dev-overlay.tsx:29` calls `Nitpicker.mount(...)` from a `"use client"`
  component the target renders in its own root layout. The overlay is not a separate frame — it *is* app
  code. `core/index.ts:29` constructs `Overlay`, which builds a shadow-DOM host on the app's `document`.

- **Region screenshot = rasterize the app's live DOM.** `core/region.ts:36` calls
  `html2canvas(document.body, …)`. html2canvas walks the DOM node-by-node and repaints it into a canvas
  in JS — it is *not* a screen capture. It therefore needs read access to `document.body` and every
  computed style and same-origin image under it. The red box is then composited in device-pixel space
  (`core/redbox.ts`, `region.ts:60 annotateRegion`).

- **Element pick = read the app's DOM + React internals.**
  - `core/elements.ts:122 baseDescriptor` reads `getBoundingClientRect`, `getAttribute`, `innerText`,
    walks `parentElement` to build a CSS selector (`elements.ts:66`).
  - `react/react-source.ts:27 fiberOf` reads the `__reactFiber$…` property **off the DOM node** and climbs
    `_debugOwner`/`return` (`react-source.ts:62`) for the component name.
  - `react/react-source.ts:75 sourceOf` reads the `data-nitpicker-source` attribute off the node/ancestors.

- **`data-nitpicker-source` is stamped at build time.** `next/nitpicker-source-plugin.cjs:14` is a Babel
  plugin that appends `data-nitpicker-source="file:line:col"` to every host JSX tag, wired into
  Turbopack/webpack via `next.config` (SKILL.md step 4). React 19 removed `_debugSource`, so this
  build-time stamp is the *only* reliable way to recover a source location from a click (DESIGN.md §5).

- **Chat/queue → sidecar.** `core/transport.ts:13,34` `fetch()`es a local sidecar; `server/index.ts:181`
  binds `127.0.0.1:5178` and sets permissive CORS (`Access-Control-Allow-Origin: *`, `index.ts:24`).

**The constraint:** the first four bullets are all **DOM operations on the same origin**. The browser's
Same-Origin Policy forbids a page from reading `iframe.contentDocument`, computed styles, or JS-attached
properties (`__reactFiber$…`) of a **cross-origin** framed document. So the moment the target lives in a
cross-origin iframe, *html2canvas, the selector builder, the fiber walk, and the source-attribute read all
throw or return nothing*. Only the sidecar leg (bullet 5) is origin-independent, because the sidecar
already allows `*` and the harness is the one making the request.

This is not a nitpicker quirk; it is the same wall every visual-feedback tool hits (§5).

---

## 2. The core constraint — precisely what survives cross-origin

Assume the naïve harness: `harness.app` renders `<iframe src="https://target.example">`. Target is a
different origin. What can the harness actually do?

| Capability | Cross-origin iframe? | Why |
| --- | --- | --- |
| Read target DOM / selectors / text / rects | ❌ | SOP blocks `iframe.contentDocument`. `elements.ts` can't run against the target. |
| React component name (fiber walk) | ❌ | `__reactFiber$…` lives on the target's DOM nodes; unreadable cross-origin. |
| `data-nitpicker-source` file:line | ❌ | Attribute isn't there (no build stamp) **and** unreadable anyway. |
| html2canvas region screenshot | ❌ | Needs to walk the iframe's DOM; SOP blocks it. Returns blank/tainted. |
| Screenshot via **screen capture** pixels | ⚠️ possible, degraded | `getDisplayMedia()` captures *pixels*, not DOM, so it sidesteps SOP — but it needs a per-capture user permission prompt, captures the whole tab/window, and Region Capture (`cropTo`) can only crop to a DOM box in the **harness's own** tree, not selectively into the iframe. You get an approximate picture, no element data. |
| Element interaction via `postMessage` | ⚠️ only if the app cooperates | The harness can `postMessage` into the iframe, but a listener must exist inside the target to answer — i.e. the target must embed a nitpicker agent. That is *injection again*, which defeats "zero code in target". |
| Chat / queue / message items | ✅ | Purely harness-side; `transport.ts` POSTs to the sidecar, which already allows `*` CORS. |
| Sidecar delivery to the agent | ✅ | Unchanged; origin-independent. |

**So a pure cross-origin shell degrades nitpicker to: freeform text notes + a permission-gated,
element-blind screen-capture screenshot.** It loses the two things that make nitpicker nitpicker
(precise DOM screenshots and element→source). This is the crux the rest of the report designs around.

Prior art confirms the wall exactly. html2canvas's own docs: *"html2canvas does not magically circumvent
any browser content policy restrictions… rendering cross-origin content requires a proxy to get the
content to the same origin"* ([html2canvas](https://github.com/niklasvh/html2canvas)). Marker.io's
help center says the widget **cannot capture "iframes from external websites without the iframe snippet"**
and tells customers to use the **browser extension or native (getDisplayMedia) rendering** for
cross-origin content ([Marker.io](https://help.marker.io/en/articles/6282853-widget-screenshot-tips-limitations)).

---

## 3. Architecture options and trade-offs

### 3a. Same-origin proxy harness — the viable path

**Idea:** the harness doesn't just frame the target; it **proxies** it under the harness's *own* origin
(`https://harness.local/proxy/…`), rewrites the streamed HTML to inject `<script>` mounting
`@nitpicker/core`, and (ideally) injects the Babel source-stamp transform at serve time. Because the
iframe now shares the harness origin, the browser lets the injected overlay touch the DOM → **full feature
parity with zero source-tree edits in the target**.

This is feasible and is a well-trodden pattern (script injection into proxied HTML is the bread and butter
of mitmproxy/HTTPToolkit-style tools —
[mitmproxy](https://docs.mitmproxy.org/stable/concepts/modes/),
[HTTPToolkit](https://httptoolkit.com/blog/javascript-mitm-proxy-mockttp/)). nitpicker is unusually
well-suited to it because **`@nitpicker/core` already runs from any page with a single `Nitpicker.mount()`
call and imports no framework** (`core/index.ts:9`, DESIGN.md §2 "NO React import"). The overlay was
built to be dropped in from the outside.

**The hard parts, honestly:**

1. **Proxying an arbitrary app is a real reverse proxy, not a one-liner.** You must handle: asset URLs
   (absolute `https://target/...` links are *not* auto-rewritten — a known mitmproxy gotcha —
   [mitmproxy reverse mode](https://2qwesgdhjuiytyrjhtgdbf.readthedocs.io/en/latest/features/reverseproxy.html));
   client-side routing (SPA `pushState` to paths the proxy must map back); cookies/auth (SameSite, domain
   rewriting, login flows on third-party origins that will now see a different `Origin`); and **WebSockets
   / HMR** — a dev server's hot-reload socket must be proxied too or the DX breaks. These are solvable but
   are the bulk of the effort.

2. **Injecting the source-stamp transform at serve time is the genuine limiter.** The overlay `<script>`
   is trivial to inject into any HTML. The `data-nitpicker-source` attribute is **not** — it is produced
   by a Babel pass over the target's `.tsx` *before* bundling (`nitpicker-source-plugin.cjs`). A proxy
   sees only the *output* of the target's bundler (often minified, always already-compiled). It cannot
   retroactively add stamps to code it didn't build. Two sub-cases:
   - **Localhost dev server you control the toolchain of:** you *can* get the stamp, but only by getting
     the transform into *their* bundler — i.e. one `next.config`/`vite.config` line. That is no longer
     strictly "zero code" (it's one config line, no source edits). Alternatively the harness runs the dev
     server itself (Lovable-style, §5) — full control, but then the harness owns the toolchain, not just a
     proxy.
   - **Deployed / already-built site:** stamps are impossible. `file:line` is simply unavailable; you fall
     back to selector + component-name + text + route (which `elements.ts` + `react-source.ts` still
     produce — see below).

3. **CSP / framing headers.** A target may send `X-Frame-Options: DENY` or CSP `frame-ancestors 'none'`,
   which blocks framing. A proxy can **strip/rewrite those response headers** (that's the standard bypass —
   [content-security-policy.com](https://content-security-policy.com/frame-ancestors/),
   [Requestly](https://requestly.com/blog/bypass-iframe-busting-header/)), and since the proxy re-serves
   under its own origin it can drop them freely. Note modern browsers honor CSP `frame-ancestors` over
   `X-Frame-Options` when both are present, so the proxy must handle both. The target's *own* CSP
   (`script-src`, `connect-src`) must also be relaxed so the injected overlay script runs and can `fetch`
   the sidecar.

4. **Component name survives with genuinely zero cooperation.** Worth calling out: the **fiber walk needs
   no build step** — `react-source.ts:62 componentName` reads runtime React internals off same-origin DOM
   nodes. So in a same-origin proxy, `component` is recoverable from an unmodified React app. Only the
   `source` field needs the build stamp. That materially softens limitation (2): even without stamps you
   get component + selector + text + route, which SKILL.md already treats as the agent's fallback grep
   path.

**Which classes of target this handles:**

| Target class | Framing | Overlay+DOM (region/element/selector/component) | `file:line` source |
| --- | --- | --- | --- |
| **Localhost dev server, toolchain accessible** | ✅ (own origin) | ✅ full | ✅ *if* one bundler-config line added (or harness runs the dev server) |
| **Localhost dev server, no toolchain touch** | ✅ | ✅ full | ❌ selector/component fallback |
| **Deployed site you own** | ✅ (proxy strips CSP) | ✅ full | ❌ (already built, minified) |
| **Deployed site you don't own** | ✅ technically | ✅ full | ❌ + legal/ToS + auth/cookie friction |

### 3b. Cross-origin iframe with degraded features (no proxy)

The "just frame it" shell. Per §2 it offers: freeform message items, and a `getDisplayMedia`-based
screenshot (permission prompt each time, whole-tab pixels, red box composited in harness pixel space using
the selection rect the harness *does* own). No element pick, no component, no source, no DOM selector.
**Verdict:** a legitimate lowest-common-denominator fallback for genuinely un-proxyable targets, but not a
product on its own — it throws away nitpicker's differentiators. Useful as the *degraded tier* the proxy
harness falls back to when proxying fails (CSP too hostile, auth too complex).

### 3c. Browser-extension model

A content script injected by an extension runs **in the page's own context with full same-origin DOM
access** on *any* site — deployed or localhost — with no proxy at all. This is precisely what Marker.io,
BugHerd, and Userback ship as their answer to cross-origin
([Marker.io extension FAQ](https://help.marker.io/en/articles/6501657-browser-extensions-faqs);
[BugHerd Chrome store](https://chromewebstore.google.com/detail/bugherd-visual-feedback-b/popigpemobhbfkhnnkllkjgkaabedgpb)).
An extension could load `@nitpicker/core` unchanged and get region + element + selector + component on any
page. Trade-offs vs the proxy harness:

- ✅ No proxy, no URL-rewriting, no CSP surgery, works on deployed sites, works cross-site.
- ✅ Region screenshot can even use the extension's `tabs.captureVisibleTab` for true pixels.
- ❌ Still **no `file:line` source** — an extension can't add a build-time transform either (same limit as
  3a case 2). Component/selector/text remain.
- ❌ Distribution/install friction (store review, per-browser builds, enterprise policy), and it's a
  different product shape from "a webapp you point at your app".
- ❌ Manifest V3 constraints on injecting/modifying page CSP.

**Verdict:** the strongest option for **non-owned / deployed** targets, and complementary to — not a
replacement for — the proxy harness aimed at **localhost dev**. A mature product might ship both (as
Marker.io does: widget SDK *and* extension).

### 3d. Keep injection, make it trivial

The current vendored/skill model is *already* the right answer for **apps you own and are actively
developing** — which is nitpicker's stated target (Next.js App Router, React 18/19). Injection gives full
parity including `file:line`, with prod-safety gates (DESIGN.md §6) a proxy can't match. The install is
already close to one command via the skill. The harness is **not needed to make owned-app usage better**;
it is needed to reach **non-owned / non-React / can't-touch-the-build** targets — which is exactly the
"future iframe-harness adapter for Streamlit / non-owned apps" the SKILL.md already anticipates (SKILL.md
line 22, DESIGN.md §7). So: keep the skill as the flagship for owned apps; add a harness for the
non-owned frontier. They are not competitors.

---

## 4. Feature-by-feature matrix

| Feature | Skill (today, injected) | 3a Same-origin proxy | 3b X-origin iframe | 3c Extension |
| --- | --- | --- | --- | --- |
| **Region screenshot + red box** | ✅ html2canvas on same-origin DOM | ✅ same (frame is same-origin) | ⚠️ `getDisplayMedia` pixels only, permission prompt, whole-tab | ✅ html2canvas or `captureVisibleTab` |
| **Element → CSS selector / testid / text / role / rect** | ✅ `elements.ts` | ✅ same | ❌ SOP | ✅ content script |
| **Element → React component name** | ✅ fiber walk | ✅ fiber walk (no build needed) | ❌ | ✅ fiber walk |
| **Element → `file:line:col` source** | ✅ build stamp | ⚠️ only w/ bundler-config line or harness-run dev server; else ❌ | ❌ | ❌ (no build access) |
| **Chat / queue / message** | ✅ | ✅ | ✅ | ✅ |
| **Sidecar delivery (long-poll)** | ✅ | ✅ (CORS `*` already) | ✅ | ✅ |
| **Zero code in target** | ❌ (that's the point of the harness) | ✅* (*one bundler line if you want source) | ✅ | ✅ (but install an extension) |
| **Works on deployed / non-owned** | ❌ | ⚠️ proxy+auth friction | ⚠️ text+pixels only | ✅ |

Key insight the matrix makes visible: **the same-origin proxy recovers every feature except `file:line`**,
and `file:line` is the *only* feature that fundamentally needs build-time cooperation — a wall shared by
every dependency-free option.

---

## 5. Prior art

- **Lovable Visual Edits — the proxy-harness model at platform scale (the strongest precedent).** Lovable
  serves each project from its **own isolated Node container** ("over 4,000 instances on fly.io… each
  running an isolated Node.js environment containing a complete copy of the application code") and shows a
  **same-origin sandboxed iframe** preview. Clicking a DOM element "instantly trace[s] it back to the exact
  JSX," because **a custom Vite plugin assigns each JSX component a unique stable ID at compile time**, and
  the source is synced into the browser as a Babel/SWC AST for editing
  ([Lovable: How we built Visual Edits](https://lovable.dev/blog/visual-edits)). This is *precisely*
  nitpicker's architecture — same-origin iframe + a build-time JSX stamp for element→source — validated in
  production. The open-source **`lovable-tagger`** Vite plugin "adds `data-component-id` attributes to
  JSX/TSX components" ([npm](https://www.npmjs.com/package/lovable-tagger)) — a direct analogue of
  `data-nitpicker-source`. Their answer to same-origin: **they serve the app, so it's always same-origin,
  and they own the build, so the stamp is free.** That is the harness's endgame.

- **Marker.io / BugHerd / Userback — visual feedback on the customer's own site via an *embedded widget*.**
  All three work by the site owner adding a script to their *own* pages (same-origin by construction), then
  html2canvas-rendering the DOM. For content they *can't* reach same-origin (cross-origin iframes, WebGL,
  video), they explicitly fall back to a **browser extension** or **native `getDisplayMedia` capture**
  ([Marker.io widget limits](https://help.marker.io/en/articles/6282853-widget-screenshot-tips-limitations);
  [Marker.io extension FAQ](https://help.marker.io/en/articles/6501657-browser-extensions-faqs)). BugHerd
  markets "pin feedback on any live site… no code changes, no browser extension" — which works because the
  *reviewer* loads a version with BugHerd's script, i.e. injection at the owner's layer
  ([BugHerd](https://bugherd.com/visual-feedback-tool)). None of them solve element→**source file** — they
  operate on non-owned marketing/staging sites where there is no source to map to. nitpicker's source
  mapping is a differentiator that *only* exists when you control the build.

- **StackBlitz WebContainers — same-origin by running the whole toolchain in-browser.** Node runs in the
  browser via WASM + a Service Worker networking stack; each project gets its own origin and the preview is
  same-origin to the editor ([StackBlitz: Introducing WebContainers](https://blog.stackblitz.com/posts/introducing-webcontainers/)).
  Because StackBlitz owns the dev server, it can inject anything — same structural advantage as Lovable.
  Requires SharedArrayBuffer + cross-origin isolation (COOP/COEP), a real constraint on browser support.

- **Screen Capture / Region Capture / Element Capture APIs** — the browser's sanctioned path to
  cross-origin pixels. `getDisplayMedia()` + `cropTo()` (Region Capture) crops a captured tab to a DOM
  box, and Element Capture restricts to a DOM subtree — but both crop to the **capturer's own** DOM, and
  carry a permission prompt and privacy caveats about content drawn on top
  ([MDN Screen Capture](https://developer.mozilla.org/en-US/docs/Web/API/Screen_Capture_API);
  [Chrome Region Capture](https://developer.chrome.com/docs/web-platform/region-capture)). This is the
  ceiling for the no-proxy cross-origin screenshot in 3b.

- **mitmproxy / HTTPToolkit — HTML script-injection proxies.** Injecting a `<script>` into proxied HTML
  responses is a standard, mature technique; the known sharp edge is that absolute URLs and redirects in
  the body are not auto-rewritten
  ([mitmproxy](https://docs.mitmproxy.org/stable/concepts/modes/);
  [HTTPToolkit](https://httptoolkit.com/blog/javascript-mitm-proxy-mockttp/)). This is the engine of the
  3a proxy harness.

**Synthesis of prior art:** everyone who overlays feedback on arbitrary apps resolves same-origin one of
three ways — (a) get the owner to embed a widget, (b) ship a browser extension, or (c) *serve the app
yourself* (Lovable/StackBlitz). And *no one* recovers `file:line` source without controlling the build.
nitpicker's harness sits squarely in family (c), and the file:line limit is industry-universal, not a
nitpicker shortcoming.

---

## 6. Recommendation

**Is a dependency-free standalone harness viable? Yes — as a same-origin proxy harness — with one honest
carve-out: `file:line:col` source is not achievable dependency-free on an already-built app.** Everything
else (region+redbox, element→selector/component, text, route, chat, sidecar) is fully achievable with zero
source edits once the frame is same-origin, because `@nitpicker/core` was designed to mount from any page
and the fiber walk needs no build step.

**Recommended architecture: 3a (same-origin proxy), with 3c (extension) as a companion for deployed
targets, converging on platform-layer injection (§5 Lovable model) as the endgame.**

**Phased path:**

1. **Phase 1 — Proxy harness for localhost dev apps.** A small Node reverse proxy that pipes the target's
   dev server, rewrites streamed HTML to inject `<script>Nitpicker.mount({session, endpoint})</script>`,
   proxies the HMR websocket, rewrites absolute asset URLs, and strips `X-Frame-Options`/CSP so the
   harness can frame it same-origin. Ships region + element(selector/component) + chat/sidecar with **zero
   target code**. `file:line` is offered as an **opt-in one-liner** (add the existing Babel loader to the
   target's `next.config`/`vite.config`) — clearly labeled as the one thing that isn't free. This reuses
   `core/`, `server/`, `cli/` unchanged; the only new code is the proxy + injection glue. Effort:
   **moderate** — days-to-low-weeks for a solid MVP; the long tail is proxy edge cases (auth, absolute
   URLs, SPA routing, websockets), not nitpicker itself.

2. **Phase 2 — Browser extension for deployed / non-owned targets.** Content script mounts `@nitpicker/core`
   on any page; region via `captureVisibleTab`, element/selector/component via same-origin DOM. No
   `file:line`. Reaches the sites the proxy can't (hard auth, hostile CSP, third-party). Effort:
   **moderate**, mostly packaging/store friction rather than new nitpicker logic.

3. **Phase 3 — Platform-layer injection (the future builder platform, §4 of the task).** When the platform
   serves every app (Lovable-style), it *is* the harness: it injects the overlay **and** the source-stamp
   transform uniformly at the serve/build layer, so `file:line` comes back for free and universally. The
   proxy harness of Phase 1 is the single-app precursor of this — same injection seam, same overlay, same
   sidecar contract. Nothing about Phases 1–2 is throwaway; they de-risk the injection + same-origin +
   redbox math that the platform will reuse. The `resolveElement` seam (DESIGN.md §7) is already the
   pluggable point where per-framework component/source recovery slots in.

**Key risks / unknowns:**

- **Proxy fidelity** on real apps: auth redirects to third-party IdPs, `SameSite` cookies, service
  workers registered by the target, and absolute-URL assets are the failure modes. Prototype against 2–3
  real dev servers early (a Next app, a Vite React app, a non-React app like Streamlit) before committing.
- **The `file:line` gap** must be messaged honestly, not hidden. It is a fundamental limit shared by every
  dependency-free tool (§5). Frame it as: "point at any running app → screenshots + component + selector
  for free; add one config line (or use the skill) to also get exact source lines."
- **CSP/header stripping** is fine for owned/dev targets; for non-owned deployed sites it edges into
  ToS/legal territory — scope Phase 1/2 to *your own* apps.
- **`getDisplayMedia` UX** (permission prompt per capture) makes the pure cross-origin fallback (3b) feel
  clunky; treat it strictly as a last resort, not a headline path.

**What is fundamentally not achievable dependency-free:** exact `file:line:col` source on an app whose
build you don't control. Every option in this report hits that wall; it is a property of shipped
JavaScript, not of nitpicker. Component name + selector + text + route remain as the (already-designed)
fallback, and are enough for an agent to grep to the code.

---

## Appendix — evidence trail

Files read (grounding):
- `SKILL.md` (install contract; line 22 = the anticipated iframe-harness adapter)
- `docs/DESIGN.md` (§2 component map, §5 element-source recovery, §6 prod-safety, §7 extension seam)
- `assets/nitpicker/react/dev-overlay.tsx:29` — overlay mounts *inside* the app
- `assets/nitpicker/core/index.ts:9,29` — framework-agnostic `Nitpicker.mount()` from any page
- `assets/nitpicker/core/region.ts:32-48` — `html2canvas(document.body)` needs same-origin DOM
- `assets/nitpicker/core/elements.ts:66,122` — DOM-based selector/descriptor
- `assets/nitpicker/react/react-source.ts:27,62,75` — fiber walk (runtime) + `data-nitpicker-source` read
- `assets/nitpicker/next/nitpicker-source-plugin.cjs:14` — build-time stamp (the piece a proxy can't add)
- `assets/nitpicker/core/transport.ts:13,34` + `assets/nitpicker/server/index.ts:24,181` — sidecar, CORS `*`, `127.0.0.1`

Prior-art sources (all cited inline above):
Lovable Visual Edits; lovable-tagger (npm); Marker.io widget limits + extension FAQ; BugHerd; html2canvas
README; MDN Screen Capture / Region Capture; Chrome Region Capture; StackBlitz WebContainers; mitmproxy;
HTTPToolkit; content-security-policy.com frame-ancestors; Requestly iframe-busting bypass.
