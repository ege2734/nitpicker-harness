# Nitpicker-Harness — Competitive Landscape (deep research)

**Question:** Has anyone built, as open source, a standalone dependency-free reverse-proxy *harness* you point at ANY running web app that gives an **external** AI coding agent BOTH drag-region annotated screenshots AND click-to-pick element → component → source:file:line:col + stable CSS selector?

**Method:** deep-research pass (mid-2026) — 5 search angles → 17 sources fetched → 72 claims → 25 verified with 3-vote adversarial checks (23 confirmed, 2 refuted).

**Companion doc:** the architecture/viability analysis lives alongside this file at
[`docs/viability-report.md`](./viability-report.md).

---

## Verdict: largely whitespace — we'd be first

The exact combination does **not** clearly exist as OSS. The field splits into two camps and **every** player is missing at least one leg. The intersection **{dependency-free harness} ∩ {region-annotated screenshots} ∩ {element→component→source} ∩ {feeds an *external* agent}** is unoccupied.

## Landscape matrix

| Tool | Dep-free harness (any app) | Region + annotated shot | Element → component → source | Feeds *external* agent | Open source |
|---|:--:|:--:|:--:|:--:|:--:|
| **nitpicker-harness (us)** | ✓ | ✓ | ✓ | ✓ | ~ (private now) |
| Stagewise (AGPL, 6.5k★, YC) | ✓ | ~ | ~ | ~ (own IDE) | ✓ |
| dev-inspector-mcp (MIT) | ✗ | ✓ | ✓ | ✓ | ✓ |
| Frontman (AGPL, 605★) | ✗ | ✗ | ✓ | ~ (own edits) | ✓ |
| React Grab (React only) | ✗ | ✗ | ✓ deep | ✗ (copy-paste) | ✓ |
| ui-ticket-mcp | ✗ | ✗ | ~ selector | ✓ | ✗ (CC BY-NC) |
| chrome-devtools-mcp · BrowserTools | ✗ | ✗ (shot only) | ✗ | ✓ | ✓ |
| Marker.io · BugHerd · Userback | ✗ | ✓ | ✗ | ✗ (humans) | ✗ |
| Bolt Visual Inspector · Lovable · v0 | ✗ (in-platform) | ~ | ✓ | ✗ (own agent) | ✗ |
| Vision\|Pipe (desktop) | ✗ | ✓ +voice | ✗ | ✓ | ✓ |

(✓ full · ~ partial/shallow/conditional · ✗ absent)

## Two camps — neither is our thing

**Camp 1 — deep element→source, but INJECTED into the codebase (wrong form).** All install into the target's build:
- **dev-inspector-mcp** (MIT) — most complete: click/drag → source+component+styles+screenshot → agents over MCP/ACP. `unplugin` build-tool plugin.
- **Frontman** (AGPL, 605★) — click → natural language → real source edits via the fiber tree. Dev-server plugin.
- **React Grab** (React Scan author) — deepest element→source resolver. React-only npm dev-dep, aimed at human copy-paste.
- **ui-ticket-mcp** — selector/styles/DOM → MCP. In-app web component; CC BY-NC (non-commercial, not OSI).

**Camp 2 — the harness/proxy form, but only ONE, and it's diverging.**
- **Stagewise** (AGPL-3.0, ~6.5k★, YC S25) is the *only* project using our form: `npx stagewise@latest` starts a proxy and injects a toolbar into any running app, no dependency in the target. **But** it's repositioning as a standalone *"Agentic IDE"* with its own built-in agent + console/debugger, and its element→source is shallower. Becoming a competitor IDE, not a thin harness feeding *your* agent.

## Our wedge

- **vs Stagewise (nearest on form):** a thin harness that feeds the agent you already run (Claude Code/Cursor) rather than its own IDE; deeper element→source; true region-annotated (red-box) screenshots; and — for the platform — dynamic injection with code never in the user's repo.
- **vs dev-inspector-mcp / Frontman (nearest on depth):** they require installing into the target's build; we point at *any* running app with zero target code, and pair the deep resolution *with* annotated region screenshots in one tool.
- **Validation:** the research independently flagged that *our own nitpicker is "the injected form of exactly this concept"* — so `nitpicker-harness` is precisely the missing dependency-free version. The Phase-1 MVP already runs end-to-end.

## Adjacent (not the same)

- **Human bug trackers** (Marker.io/BugHerd/Userback) — annotated shots → Jira/Linear/humans; no element→source, no AI agent.
- **In-platform editors** (Bolt Visual Inspector, Lovable, v0) — click-to-edit but proprietary and married to their own hosted agent.
- **Browser-automation MCPs** (chrome-devtools-mcp, BrowserTools) — feed agents screenshots/DOM/logs; no element→source, no annotation, explicitly not a proxy.
- **Vision|Pipe** — screenshot+voice → markdown for any LLM; desktop app, no element picking / web DOM introspection.

## Caveats

- "Open source" is loose: Stagewise & Frontman are AGPL-3.0 (copyleft — commercial implications); ui-ticket-mcp is CC BY-NC (non-commercial).
- Source quality varies (some detail from builder blogs); the Bolt claim leans on a secondary source; one chrome-devtools-mcp negative was a 2-1 split.
- Point-in-time and not exhaustive — stars/versions are mid-2026 and drift fast; a new entrant could appear. Two claims were refuted and excluded (Stagewise being DOM-only; visual-feedback tools having no AI integration).

## Key sources

- Stagewise — https://github.com/stagewise-io/stagewise
- dev-inspector-mcp — https://github.com/mcpc-tech/dev-inspector-mcp
- Frontman — https://github.com/frontman-ai/frontman
- React Grab — https://github.com/aidenybai/react-grab
- ui-ticket-mcp — https://github.com/0ics-srls/ui-ticket-mcp_public
- chrome-devtools-mcp — https://github.com/ChromeDevTools/chrome-devtools-mcp
- BrowserTools MCP — https://github.com/AgentDeskAI/browser-tools-mcp
