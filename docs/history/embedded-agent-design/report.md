# hz-agent — the embedded-agent extension for nitpicker-harness

**Workstream:** hz-agent (nitpicker-harness deep-dive + side-pane-embedded-agent extension + the interface Loom uses to stand it up per app)
**Repo:** nitpicker-harness (read in place at a detached-HEAD worktree)
**Date:** 2026-07-06

---

## 0. TL;DR

Today the harness is a **transport**: it proxies a *running* app same-origin, injects an overlay that turns
clicks/drags/edits into structured `QueueItem`s, and ships those to a dumb **sidecar queue** that a
**separately-running** agent drains via `poll` (woken by a turn-end `stop-hook`). The agent is *outside* the
harness.

The extension pulls the agent *inside*. `nitpicker-harness <path-to-app>` becomes a mode where the harness
(a) **owns the app's dev server** (spawned from the path, framework auto-detected) and (b) hosts an
**embedded agent session in the side pane** that edits the app's source in place; the preview hot-reloads for
free because HMR already survives the proxy.

The design is **strictly additive** and reuses ~90% of what exists:

- **Proxy, injection, CSP relaxation, HMR tunnel, `Env` seam, geometry, the whole overlay interaction layer,
  `serializeItem`, the `/blob` image store** — reused verbatim.
- **New:** a swappable **`AppRuntime`** (owns the dev server), a vendor-agnostic **`AgentBackend`** interface
  (Claude Agent SDK as the reference backend), an **Agent Gateway** (SSE stream + message POST, mounted on the
  *existing* harness http server), a new **builder pane** (a sibling of the builder-shell that swaps the
  queue→sidecar sink for a live streaming transcript), and a **`startEmbeddedBuilder()` library entrypoint**
  Loom drives per app.
- **Untouched:** the sidecar queue, `/poll`, `/wait`, `/pending`, `stop-hook`, feedback-proxy overlay, and the
  builder-shell — so pocketwatcher + membership-management keep working byte-for-byte.

The single most important reuse: **the agent edits real source files → the app's own HMR reloads the iframe**.
No preview-refresh channel needs building; that's already proven (`AGENTS.md:109-118`).

---

## 1. What exists today (grounded in source)

### 1.1 The proxy (`src/proxy/`)

- `startHarness(opts: {target, port, session, endpoint})` (`server.ts:58`) creates an `http-proxy` with
  `selfHandleResponse` (`server.ts:66-74`), buffers `text/html`, rewrites absolute URLs + injects the overlay
  `<script>` (`server.ts:105-118`), relaxes framing/CSP (`inject.ts:219`), and pipes everything else through.
- Harness-internal routes are matched in the `createServer` handler *before* falling through to `proxy.web`
  (`server.ts:154-168`): `OVERLAY_PATH`, `SHELL_PATH`, `SHELL_JS_PATH`, `/__nitpicker-harness/health`. **This is
  the exact seam where the Agent Gateway routes will mount** — same origin, same server, no new port.
- HMR is a hand-rolled raw-socket upgrade tunnel (`server.ts:183-275`) that strips `Origin`
  (`server.ts:201`) — load-bearing for Turbopack (`AGENTS.md:109`). **This is why agent edits reflect live:**
  the dev server's HMR websocket is forwarded, so a file edit → HMR message → iframe updates. Reused as-is.

### 1.2 The overlay engine + interaction layer

- Two browser entries, both esbuild IIFEs served by the proxy: `src/overlay/entry.ts` (injected into the app,
  mounts the full `Nitpicker` overlay) and `src/shell/entry.ts` (the **parent-window** builder-shell chrome).
- The engine is parameterized over a DOM `Env {doc, win}` handle (`vendor/nitpicker/core/env.ts`) so one engine
  serves both the injected page (ambient globals) and the shell (the proxied iframe's `contentDocument`) —
  `AGENTS.md:153`. Element rects, the fiber walk, and html2canvas all target the iframe while the highlight
  renders in the parent.
- `src/shell/entry.ts`'s `ShellChrome` (`entry.ts:89`) is the reusable prize: a mode state machine
  (`cursor|region|element|edit`, `entry.ts:29`), the element picker (`enablePicker`, `entry.ts:260`), region
  drag→capture (`onDragEnd`, `entry.ts:373`), inline text edit (`beginEdit`, `entry.ts:464`), and `geometry.ts`'s
  §5 single-offset math. Every mark terminal produces a `QueueItem` (`enqueueElement` `entry.ts:440`,
  `enqueueRegion` `entry.ts:557`, `enqueueTextEdit` `entry.ts:539`).
- The **sink** is `ShellChrome.send()` (`entry.ts:614`): await pending region rasters, then
  `Transport.sendBatch()` → sidecar. **This is the one thing embedded mode replaces.**

### 1.3 The mark schema (the structured context, already built)

`QueueItem` (`core/types.ts:34`) already carries everything an agent needs:

- `element: ElementDescriptor` with `component`, `source` (`file:line:col`, owned-Next builds), `selector`,
  `testid`, `tag`, `role`, `text`, `rect` (`core/types.ts:21-30`).
- `image: {path, url, mime, hasRedBox, selectionRect}` — region PNG with the red box burned in; `path` is a
  local file the agent opens directly.
- `oldText`/`newText` for `text-edit`; `route`/`pageUrl`/`viewport`/`timestamp` on all.
- `serializeItem` (`core/types.ts:86`) strips client-only fields for the wire.

The source-stamp loader (`vendor/nitpicker/next/`) injects `data-nitpicker-source` **at compile time only** —
source files on disk stay clean (`with-nitpicker-source.cjs` header), so an embedded agent editing those files
never sees or clobbers the stamp, and the `source` file:line:col a pick returns points at a real editable line.

### 1.4 The sidecar + the external-agent contract

- Sidecar (`vendor/nitpicker/server/index.ts`) is a **separate process** spawned by the CLI
  (`cli.ts:47-54`, `startSidecar`). It's a minimal long-poll transport: `POST /blob` (`index.ts:90`),
  `POST /feedback` (`index.ts:68`), `GET /poll` (**drains**, `index.ts:102`), `GET /pending` (peek count + gen,
  `index.ts:233`), `GET /wait` (non-draining long-poll, `index.ts:156`).
- `SessionStore` (`store.ts:49`) is an in-memory FIFO per session; `drain()` is the *only* clear and bumps a
  `drains` generation only on real delivery (`store.ts:89-96`) — durability + the loop-guard for the driver.
- `poll` (`cli/poll.ts`) is the external agent's client; `stop-hook` (`src/hook.ts`) parks on `/wait` at zero
  token cost and returns `{"decision":"block"}` to re-invoke the idle agent (`hook.ts:84` `decideStopHook`).

**The load-bearing observation:** the sidecar is a *queue* — one-directional (browser→agent), batch-oriented,
destructive-drain. It is a **poor fit for bidirectional token streaming**, which is exactly what an embedded
chat needs. So embedded mode does **not** overload the sidecar for the agent channel; it adds a purpose-built
gateway and *reuses only the blob store* (images) from the sidecar. The queue path stays for backward compat.

---

## 2. The new embedded-agent mode

### 2.1 CLI surface

```
nitpicker-harness <path-to-app> [--dev-cmd "npm run dev"] [--target-port 3000]
                                [--port 4000] [--session <id>] [--agent claude|codex|...]
                                [--no-agent]        # fall back to feedback-proxy behavior over an owned server
```

- **Bare positional path** (or `--app <path>`) selects embedded mode. `main()` (`cli.ts:130`) branches: if
  `argv[0]` is not a known subcommand *and* not a `--flag`, treat it as an app path → `serveEmbedded(argv)`.
  The existing `--target <url>` path (`serve`, `cli.ts:76`) is unchanged; the two are mutually exclusive.
- `--no-agent` runs embedded's dev-server ownership but points the pane at the classic sidecar/poll sink — an
  escape hatch that keeps the door open for pocketwatcher-style external drivers even from a path.

### 2.2 Composition (what `serveEmbedded` wires)

```
serveEmbedded(path)
  ├─ runtime  = LocalRuntime({ appPath, devCommand?, targetPort? })
  ├─ target   = await runtime.start()          // spawn dev server, wait until it answers
  ├─ sidecar  = startSidecar(port)             // REUSED — only for /blob image storage in embedded mode
  ├─ agent    = makeBackend("claude", { cwd: appPath, sessionId })   // vendor-agnostic
  ├─ gateway  = new AgentGateway(agent, { sidecarBlobUrl })
  ├─ harness  = await startHarness({ target, port, session, endpoint,
  │                                  mountExtra: gateway.handler,      // NEW opt — see §3.2
  │                                  builderPane: true })
  └─ print URLs (proxy / builder pane), install SIGINT teardown (runtime.stop + agent.close + sidecar.kill)
```

Everything above `startHarness` is new; `startHarness` itself gains only a small **route-mount hook** (§3.2)
so the gateway's `/__nitpicker-harness/agent/*` routes and the new builder-pane bundle are served from the
existing server on the existing port.

### 2.3 Owning the app's dev server — `AppRuntime`

New module `src/app/runtime.ts`. The vision demands **LocalRuntime now, FleetRuntime later, same contract**
(loom-vision §Runtime). So the dev server is behind an interface, not a bare `spawn`:

```ts
export interface AppRuntime {
  /** Bring the app's dev server up; resolve once it answers HTTP. Returns the origin to proxy. */
  start(): Promise<{ targetUrl: string }>;
  stop(): Promise<void>;
  /** Live status for the pane's "server" indicator + crash surfacing. */
  onStatus(cb: (s: RuntimeStatus) => void): () => void;   // "starting"|"ready"|"crashed"|"stopped"
}

export interface LocalRuntimeOptions {
  appPath: string;
  devCommand?: string | string[];   // explicit override; else detectDevCommand()
  targetPort?: number;              // if the caller already knows/fixes the port
  env?: Record<string, string>;
}
```

`LocalRuntime` (mirrors `startSidecar`'s `spawn`, `cli.ts:47`):

1. `detectDevCommand(appPath)` — read `package.json`; map deps→command:
   `next`→`next dev`, `vite`→`vite`, `react-scripts`→`react-scripts start`, else `scripts.dev`. Return
   `{cmd, args, readyProbe}`. Explicit `--dev-cmd` always wins (covers non-Node stacks, e.g. FastAPI's
   `uvicorn --reload`, which loom-vision names as the default backend).
2. `spawn(cmd, args, {cwd: appPath, env})`, pipe stdout/stderr (surface to the pane, don't just `inherit`).
3. **Readiness** = poll `http://127.0.0.1:<port>` until a response (or scrape the framework's "Local: …" line
   for the port when `--target-port` is omitted). Only then resolve `start()`.
4. Crash handling: emit `crashed` on non-zero exit; the pane shows it and offers restart. (Dev servers rarely
   exit; HMR is the normal path.)

`FleetRuntime` (deferred, contract only): the container already runs the dev server, so `start()` just
resolves `{targetUrl}` from injected config and `stop()` is a no-op / hands back to the orchestrator. **This is
the arch-core LocalRuntime/FleetRuntime seam — coordination point, §7.**

---

## 3. The embedding contract

### 3.1 Channel choice: reuse the sidecar, or a new channel?

**Decision: new channel for the agent stream; reuse the sidecar's blob store for images.**

Rationale, from the source:

- The sidecar/`Transport` path is **browser→agent, batch, destructive-drain** (`store.drain`, `store.ts:89`).
  Token-by-token streaming is **agent→browser, incremental, resumable** — the inverse shape. Bending `/poll`
  into a duplex stream would break its exactly-once drain guarantee and the `drains`-generation loop-guard the
  stop-hook depends on (`hook.ts:92-98`). Not worth the regression risk when the queue path must stay intact
  for backward compat anyway.
- **Reuse what genuinely fits:** region PNGs already flow through `POST /blob` → temp file → local `path`
  (`index.ts:90`, `transport.ts:12`). The embedded agent runs on the **same machine/container**, so it reads
  that `path` directly. So embedded mode keeps `Transport.uploadBlob` for images and hands the agent the local
  path — zero new image plumbing.

### 3.2 The Agent Gateway (new, mounted on the existing server)

`startHarness` gains one optional param — a **route-mount hook** — so the gateway lives on the harness origin
(same-origin with the builder pane, no CSP dance, no extra port):

```ts
export interface HarnessOptions {
  /* ...existing... */
  /** Extra request handler tried before proxy.web falls through. Returns true if it handled the request. */
  mountExtra?: (req: IncomingMessage, res: ServerResponse) => boolean;
  /** Serve the embedded builder pane (/__nitpicker-harness/build[.js]) alongside the shell. */
  builderPane?: boolean;
}
```

Wired at `server.ts:154-168` (right where `SHELL_PATH` etc. are matched today):

```ts
if (opts.mountExtra?.(req, res)) return;      // agent gateway routes
```

Gateway routes (all under `/__nitpicker-harness/agent/`):

| Route | Verb | Purpose |
|---|---|---|
| `/agent/message` | POST | one user turn: `{ sessionId, text, marks: WireItem[] }` → starts a backend turn |
| `/agent/stream` | GET (SSE) | server-push `AgentEvent`s (tokens, tool-use, file_changed, turn_end); `Last-Event-ID` resumes |
| `/agent/interrupt` | POST | cancel the in-flight turn |
| `/agent/history` | GET | full transcript for pane rehydration on (re)load |

**Why SSE, not WebSocket:** SSE is one-way server push (exactly the stream shape), has **built-in reconnection
with `Last-Event-ID`** (free mid-turn resume across pane reloads), and needs no HTTP-upgrade handshake — the
harness already fought Turbopack's upgrade gate once for HMR (`server.ts:196-201`); no reason to invite that
again for our own channel. Upstream (`/message`, `/interrupt`) are plain POSTs. The one caveat — SSE's ~6
connections-per-origin cap — is a non-issue: one stream per pane.

### 3.3 Overlay affordances → structured agent context

The pane's "send" no longer POSTs to the sidecar queue; it packages the same `QueueItem`s (region/element/
text-edit/message) plus the typed message into an `AgentInput` and POSTs `/agent/message`. The gateway
**formats marks into the backend's input**:

- **element** → a context line: `` picked <Component> at `app/foo.tsx:11:7` (selector `[data-testid=…]`, text "…") on route /pricing ``
- **region** → an **image content block** from `image.path` (the red-boxed PNG) + `selectionRect` + route.
- **text-edit** → `` change text at `app/foo.tsx:11:7` from "Old" to "New" `` (the agent patches the string).
- **message** → the note verbatim, with route/pageUrl for context.

This is *the same descriptor* the external agent gets from `poll` today (`SKILL.md:106-125`); only the delivery
mechanism differs. `serializeItem` is reused unchanged. The gateway is where "marks → prompt" formatting lives,
so backends stay dumb.

### 3.4 Streaming turn output to the pane

`AgentEvent`s stream over SSE. The pane renders: an assistant bubble that appends `token` text; `tool_use`
events as collapsible "✎ Edited `app/foo.tsx`" / "▶ ran `npm test`" rows; `file_changed` optionally badges the
file. **The preview updates itself** — the agent wrote real files, the app's HMR (forwarded, `server.ts:183`)
reloads the iframe. The chat and the live preview stay in lockstep with zero preview-refresh code.

### 3.5 Session persistence across reloads/navigations

Two layers, both stronger than today's builder-shell:

1. **Iframe navigation** — already free (parent chrome survives any iframe nav; the whole point of builder-
   shell, `README.md:60-67`). The pane + agent state live in the parent window, untouched by iframe reloads.
2. **Parent reload / Loom re-serving the page** — today the builder-shell loses its in-heap queue on a parent
   reload. Embedded mode fixes this by making the **agent session server-side and authoritative** (in the
   gateway/backend, keyed by `sessionId`). On pane load: `GET /agent/history` rehydrates the transcript, then
   the pane opens the SSE stream with `Last-Event-ID` to resume any in-flight turn. The pane is a **view**; the
   session is server state. This is *required* for Loom (the container may re-serve the shell to a reconnecting
   user) and is a genuine upgrade over the current parent-heap-only model.

Transcript persistence: in-memory in the backend for a live session; optionally flushed to
`.nitpicker/sessions/<id>.jsonl` in the app repo (survives container restart, travels with the repo-per-app).
**Where the durable transcript lives is an arch-core control-plane decision — §7.**

---

## 4. Agent-backend abstraction (vendor-agnostic)

The harness is vendor-agnostic today (any agent that can run `poll` works). Preserve that. The backend is a
well-scoped interface; Claude/Codex/etc. slot in behind it.

```ts
export interface AgentBackend {
  /** Open (or resume) a session rooted at the app repo. */
  startSession(opts: AgentSessionOptions): Promise<AgentSession>;
}

export interface AgentSessionOptions {
  cwd: string;                 // the app repo path — the agent edits here
  sessionId: string;
  resume?: boolean;            // rehydrate prior transcript if the backend supports it
  systemContext?: string;      // harness-supplied: "you are the builder for this app; …"
  model?: string;
  auth?: AgentAuth;            // api key / oauth handle, injected by Loom (never hard-coded)
}

export interface AgentSession {
  readonly id: string;
  /** Run ONE turn. Streams events until turn_end. `interrupt()` cancels it. */
  send(input: AgentInput): AsyncIterable<AgentEvent>;
  interrupt(): Promise<void>;
  /** Transcript for rehydration (drives GET /agent/history). */
  history(): AgentMessage[];
  close(): Promise<void>;
}

export interface AgentInput {
  text?: string;
  marks?: WireItem[];          // serialized QueueItems (element/region/text-edit/message)
}

export type AgentEvent =
  | { type: "turn_start" }
  | { type: "token"; text: string }
  | { type: "tool_use"; name: string; input: unknown }     // Edit/Write/Bash/…
  | { type: "tool_result"; name: string; ok: boolean; summary?: string }
  | { type: "file_changed"; path: string }                 // pane badge; preview HMRs on its own
  | { type: "turn_end"; ok: boolean }
  | { type: "error"; message: string };
```

Notes:

- **`file_changed`** is what makes the chat↔preview link legible, but note the *reload* itself is free (HMR).
  The event is only for UI affordance ("editing app/foo.tsx").
- **Reference backend: the Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TypeScript). Its `query()`
  returns an async iterator of streamed messages with tool-use and permission hooks, and can run **in-process**
  (no separate CLI/poll) rooted at `cwd`. That maps almost 1:1 onto `AgentSession.send()` → `AsyncIterable<AgentEvent>`.
  It is the natural default given the harness is already Claude-Code-shaped (`stop-hook` etc.). **A
  `ClaudeCodeCliBackend` (spawn `claude -p --output-format stream-json --input-format stream-json`) is the
  fallback** when in-process isn't wanted. `CodexBackend` is analogous. **The concrete choice + SDK-vs-CLI is a
  stack-verify coordination point — §7.**
- The backend receives the app's tests/build as tools so it can **self-verify** (loom-vision's "everything must
  be validate-able"). The harness can additionally drive Playwright against the *proxied* app (same-origin,
  already true) to screenshot/assert headlessly — a self-verify loop. **Verification strategy is stack-verify's
  domain — §7.**

---

## 5. How Loom stands this up per app (library/service, not just a CLI)

Loom drives the harness programmatically. Expose the composition as a library entrypoint; the CLI becomes a
thin wrapper (exactly the `serve()`→`startHarness()` relationship today, `cli.ts:104`).

```ts
export interface EmbeddedBuilderOptions {
  appPath: string;
  runtime?: AppRuntime;          // default LocalRuntime; Loom's container injects FleetRuntime
  agent: AgentBackend;           // Loom picks the vendor + injects auth
  proxyPort: number;
  sessionId: string;             // Loom's build-session id (repo-per-app keyed)
  auth?: GatewayAuth;            // bearer/signed-session gating the gateway + pane (see below)
  sidecarPort?: number;          // reused blob store; Loom assigns to avoid collisions
  log?: (m: string) => void;
}

export interface EmbeddedBuilder {
  url: string;                   // proxied app (feedback-proxy still available)
  builderUrl: string;            // the embedded builder pane Loom iframes/serves as its workspace
  session: AgentSession;
  close(): Promise<void>;
}

export async function startEmbeddedBuilder(opts: EmbeddedBuilderOptions): Promise<EmbeddedBuilder>;
```

- **Loom's builder workspace UI *is* this pane** (loom-vision §What Loom is). Loom either serves the harness's
  `/__nitpicker-harness/build` page directly, or — more likely — Loom's own frontend (ds-frontend, Loom Design
  System `builder` kit) renders the chat/preview chrome and talks to the **Agent Gateway HTTP contract**
  (§3.2) as the API. **The pane-vs-Loom-frontend boundary is a ds-frontend coordination point — §7.** Either
  way, the gateway routes are the stable contract; the DOM chrome is swappable.
- **Ports/session/auth are inputs**, not hard-coded 127.0.0.1 defaults. Today the harness binds loopback and is
  unauthenticated (fine for localhost). In a Loom container reachable by the platform, the gateway **must gate
  on a token** (bearer header or signed session cookie), and the sidecar's `session` string is *not* auth. Add
  `GatewayAuth` and reject unauthenticated `/agent/*`. The pane carries the token via cookie/`Authorization`,
  **not** the query string (unlike session/endpoint today, `inject.ts:32-34` — a token in a URL leaks in logs).
  **The auth model is shared with arch-core's control plane — §7.**
- **Idle→free** (loom-vision §Runtime): `AppRuntime` + `AgentSession` are both closable; `close()` tears down
  the dev server, the agent, and the sidecar. The control plane frees the container after idle.

---

## 6. Backwards compatibility (non-negotiable)

Everything is additive; nothing on the existing paths changes:

- `startHarness()` signature only **gains optional** `mountExtra`/`builderPane` (`server.ts:36`); omitted →
  behavior identical. The `--target <url>` CLI path (`cli.ts:76`) is untouched.
- **Sidecar, `/poll`, `/wait`, `/pending`, `store.drain` + `drains` generation, `stop-hook`, `poll` CLI** —
  all untouched. pocketwatcher + membership-management depend on these; embedded mode never routes through the
  queue (it uses the gateway), and it only *reuses* `/blob`. The `text-edit` harness-local delta and the
  `react-source.ts`/`/wait`/`/pending` deltas (`AGENTS.md:78-87`) are preserved.
- **The builder-shell (`/__nitpicker-harness/shell`) stays exactly as-is.** The embedded pane is a **new, distinct
  page** (`/__nitpicker-harness/build` + `build.js`) so the existing shell — and its consumers — are byte-
  identical. Shared hard code (mode toolbar, picker, drag, edit, geometry, `Env` reads → `QueueItem`) is
  extracted from `ShellChrome` into a reusable `InteractionLayer`; `ShellChrome` keeps its sidecar sink, the new
  `BuilderChrome` swaps in the gateway sink + streaming transcript. Extraction is behavior-preserving and
  regression-guarded by the existing `tests/shell-geometry.test.ts` + `tests/env-seam.test.ts`.
- **The feedback-proxy overlay** (`src/overlay/`) is unchanged and remains the fallback for apps we don't own.

---

## 7. `src/` / CLI changes required (concrete)

| Area | Change | Kind |
|---|---|---|
| `src/cli.ts` | `main()` (`:130`) branch: bare path / `--app` → `serveEmbedded()`. New `serveEmbedded()` mirroring `serve()` (`:76`). | additive |
| `src/app/runtime.ts` | **new** — `AppRuntime` interface, `LocalRuntime` (spawn+detect+readiness), `detectDevCommand()`. | new |
| `src/agent/backend.ts` | **new** — `AgentBackend`/`AgentSession`/`AgentEvent` interfaces + `makeBackend(name)` registry. | new |
| `src/agent/claude-backend.ts` | **new** — reference backend over the Claude Agent SDK (in-process) + CLI-spawn fallback. | new |
| `src/agent/gateway.ts` | **new** — SSE stream + `/message`/`/interrupt`/`/history`; marks→prompt formatting; reuses `/blob` for images; server-side transcript + `Last-Event-ID` resume. | new |
| `src/proxy/server.ts` | add optional `mountExtra`/`builderPane` to `HarnessOptions` (`:36`); call `mountExtra` before `proxy.web` (`:167`); serve `/build[.js]` when `builderPane`. | additive |
| `src/shell/entry.ts` | extract `InteractionLayer` from `ShellChrome` (`:89`); no behavior change. | refactor |
| `src/builder/entry.ts` + `build.ts` | **new** — `BuilderChrome`: reuse `InteractionLayer`, swap sink to `AgentGatewayClient` (POST /message + SSE), render streaming transcript. Esbuild IIFE like the shell. | new |
| `src/proxy/inject.ts` | **new** `builderPage(cfg)` (sibling of `shellPage`, `:43`) — same iframe stage, chat replaced by transcript; new `BUILD_PATH`/`BUILD_JS_PATH`. | additive |
| `src/index.ts` (lib) | **new** — export `startEmbeddedBuilder()` + the interfaces so Loom imports the library. | new |
| `package.json` | add the chosen agent SDK dep; `main`/`exports` for the library surface. | additive |

No change to: sidecar (`vendor/nitpicker/server/*`), `poll`, `hook.ts`, `overlay/*`, `next/*`, `transport.ts`,
`types.ts` (marks reused verbatim — though a shared `WireItem` type export is convenient).

---

## 8. Data-flow (embedded turn, end to end)

```
user types in pane + has queued a region/element mark
   │  POST /__nitpicker-harness/agent/message { sessionId, text, marks:[WireItem…] }
   ▼
Agent Gateway  ── formats marks → prompt (element→source line; region→image block from /blob path;
   │                                        text-edit→"change X to Y"; message→note)
   │  AgentSession.send({text, marks})  →  AsyncIterable<AgentEvent>
   ▼
AgentBackend (Claude Agent SDK, cwd = app repo)
   │  edits app/foo.tsx (Edit tool)                     ── streams: token, tool_use, file_changed, turn_end
   ▼                                                        │
app dev server (owned by LocalRuntime) sees the file change │  SSE ▲ (Last-Event-ID resumable)
   │  HMR websocket (forwarded, Origin-stripped) ──────────▶│
   ▼                                                        ▼
proxied iframe hot-reloads  ◀── same-origin ──  builder pane renders transcript + live preview in lockstep
```

The user then marks up the *new* result and iterates — the build loop closes visually, in one pane.

---

## 9. What the vision may have overlooked / risks

- **Concurrency: marking while the agent is mid-turn.** The user can pick/drag while the agent is editing (and
  HMR is churning the iframe). Need a turn model: queue marks during an active turn and let the user "send" as a
  follow-up, or allow interrupt (`/agent/interrupt`). The mark descriptors may reference a DOM that the in-flight
  edit is about to replace — `source` file:line:col is the stable anchor; selectors may go stale. Recommend:
  marks are *appended* to the compose box and only sent on an explicit turn boundary.
- **Auth is a real gap, not a detail.** The harness is loopback + unauthenticated today (session string is not
  auth). Loom is multi-user with containers the platform reaches. The gateway *must* authenticate or a build
  session is hijackable. This needs to be designed with arch-core, not bolted on.
- **Repo-per-app + git commits.** loom-vision makes every app a GitHub repo (version control). The agent edits
  files but nothing commits turns. A **git seam** (commit-per-turn, or per-accepted-change) belongs somewhere —
  likely an `AgentBackend` capability or a harness post-turn hook. Undesigned in the current harness. Arch-core.
- **Non-Node / FastAPI backends.** loom-vision's default backend is FastAPI. `detectDevCommand` must cover
  `uvicorn --reload` etc., and a Loom app may have *two* runtimes (frontend dev server + backend). The harness
  proxies **one** target origin. Multi-process apps need either a compose-style runtime that fronts one and
  reverse-proxies the API, or the harness proxying only the frontend with the API on its own path. Flag for
  arch-core's Backend abstraction.
- **`patterns` vs `plugins`.** Out of hz-agent's lane, but the embedded agent is the natural producer/consumer
  of both (it scaffolds patterns; it wires plugins). The gateway's marks→prompt formatter is where plugin
  context (enabled plugins, their schemas) would be injected — worth a hook now even if unused.
- **Self-verify without a human.** The pane shows the human the result, but headless self-verify (loom-vision:
  "agents build/iterate without a human in the loop") needs the harness to drive Playwright against the proxied
  app and feed pass/fail back to the agent. The same-origin proxy makes this trivial (Playwright already works,
  per `AGENTS.md:176`) — but it's unbuilt. Stack-verify.
- **`document.currentScript` config timing** (`AGENTS.md:91`) applies to the new `build.js` entry too — read
  config synchronously at module load, same as `src/shell/entry.ts:767`.

---

## 10. DECISIONS FOR THE CAPTAIN

1. **Agent channel: new SSE gateway vs. overloading the sidecar.**
   *Options:* (a) **new SSE gateway, reuse `/blob` for images (recommended)** — clean duplex-shaped streaming,
   keeps the queue's exactly-once drain + stop-hook loop-guard intact for backward compat; (b) extend the
   sidecar `/poll` into a duplex stream — risks the `drains`-generation invariant pocketwatcher depends on.
   **Recommend (a).**

2. **Reference agent backend + in-process vs CLI-spawn.** *Options:* (a) **Claude Agent SDK, in-process
   (recommended)** — cleanest map to `AsyncIterable<AgentEvent>`, no separate poll, harness is already
   Claude-shaped; (b) spawn `claude -p --output-format stream-json` (CLI); (c) Codex/other. **Recommend (a) as
   default with (b) as fallback; coordinate the final vendor with stack-verify.**

3. **Auth model for the gateway + pane.** *Options:* (a) **bearer token / signed session injected by Loom,
   `/agent/*` rejects unauthenticated (recommended for any non-loopback deploy)**; (b) keep loopback-only +
   unauthenticated (fine for the current-machine dev iteration, unsafe for the fleet). **Recommend (a); shared
   decision with arch-core's control plane.** Token rides a cookie/header, never the query string.

4. **Durable transcript location.** *Options:* (a) in-memory only (lost on container restart); (b) **`.nitpicker/
   sessions/<id>.jsonl` in the app repo (recommended)** — travels with repo-per-app, survives restart; (c) an
   external control-plane store. **Recommend (b) for now; reconcile with arch-core's control-plane state.**

5. **The pane: harness-served page vs Loom-frontend rendering the gateway API.** *Options:* (a) harness serves
   `/__nitpicker-harness/build` (fastest to ship, self-contained); (b) **Loom's frontend (LDS `builder` kit)
   renders the chrome and consumes the gateway HTTP contract (recommended long-term)** — the gateway routes are
   the stable seam, the DOM is swappable. **Recommend shipping (a) first, designing toward (b); coordinate the
   boundary with ds-frontend.**

6. **Multi-runtime apps (frontend + FastAPI backend).** *Options:* (a) harness proxies only the frontend, API
   on its own origin/path; (b) a compose-style `AppRuntime` that fronts one and reverse-proxies the other.
   **Needs arch-core's Backend abstraction to settle first; flag, don't decide in hz-agent.**

7. **Git-per-turn.** Should the harness commit after each turn / each accepted change (repo-per-app + version
   control), and is that an `AgentBackend` capability or a harness post-turn hook? **Recommend a harness post-
   turn git seam (optional, off by default); coordinate with arch-core.**

---

## Appendix — commands run

- Read (this worktree): `README.md`, `AGENTS.md` (==`CLAUDE.md`), `SKILL.md`, `package.json`,
  `src/cli.ts`, `src/hook.ts`, `src/proxy/{server,inject}.ts`, `src/overlay/{entry,build}.ts`,
  `src/shell/entry.ts`, `vendor/nitpicker/core/{transport,types}.ts`,
  `vendor/nitpicker/server/{index,store}.ts`, `vendor/nitpicker/cli/poll.ts`,
  `vendor/nitpicker/next/with-nitpicker-source.cjs` (head).
- `ls` of `vendor/nitpicker/{core,next,tests}`, `tests/` — confirmed the `Env` seam (`core/env.ts`),
  geometry + env-seam tests, and the source-stamp trio.
- `node --version` → `v20.16.0` (note: builder E2E via chrome-devtools-mcp needs ≥20.19, `AGENTS.md:176`).
- No code changed; this is a scout report.
```
