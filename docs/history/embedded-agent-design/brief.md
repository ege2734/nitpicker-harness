You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
**FIRST** read the shared vision & source map at `~/egeprojects/firstmate/data/loom-vision.md`. You are the **hz-agent** workstream. You are in a worktree of **nitpicker-harness** itself — read it in place.

Design the extension that turns nitpicker-harness into Loom's builder engine: a mode where **the side pane IS the agent you build/iterate with**, embedded, rather than an external `poll`-driven agent.

Read deeply and cite specifics: `README.md`, `AGENTS.md`, `SKILL.md`, `src/proxy/*`, `src/overlay/*`, `src/shell/*` (`inject.ts:shellPage`, `entry.ts`, `geometry.ts`), `src/cli.ts`, `vendor/nitpicker/` (`core/{overlay,region,elements,redbox,transport}`, `server/` sidecar, `cli/`, `next/`), `tests/`. Fully understand the two current modes (feedback-proxy vs builder-shell), the sidecar, `poll`, and the turn-end stop-hook driver.

Deliver a design for:
1. **The new embedded-agent mode** — e.g. `nitpicker-harness <path-to-app>`: the harness can (a) **start/own the target app's dev server** from a path (detect framework/dev command, or take an explicit command), and (b) host an **embedded agent session in the side pane** — the user types build instructions, the agent edits the app's source, the preview hot-reloads (HMR already survives the proxy). The pane becomes the primary build interface.
2. **The embedding contract** — how the side-pane agent process runs and connects to the pane (websocket/SSE to a server-side agent), how it **reuses the existing sidecar/transport** vs needs a new channel, how the overlay affordances (element-pick → `file:line`, region screenshot, inline edit) are fed to the embedded agent as structured context, streaming the agent's turn output token-by-token to the pane, and session persistence across reloads/navigations (the builder-shell parent chrome already survives iframe nav).
3. **Agent-backend abstraction** — keep it **vendor-agnostic** (a well-scoped "agent backend" interface), since the harness is agnostic today via `poll`. Propose the interface (start session, send message, stream response, apply edits, report done) so Claude/Codex/etc. slot in. Coordinate the concrete choice with **stack-verify**.
4. **How Loom stands this up per app** — in Loom, the container runs the app dev server + this embedded agent, and Loom's builder UI *is* this harness shell served to the user. Design the harness as a **library/service Loom drives per app** (config, ports, session id, auth), not just a CLI. Coordinate the builder UI boundary with **ds-frontend**.
5. **Backwards compatibility** — do NOT break existing feedback-proxy / builder-shell / `poll` / stop-hook usage (pocketwatcher + membership-management depend on it). The embedded mode is additive.

Report the architecture, the `src/`/CLI changes required, interface sketches, and a **DECISIONS FOR THE CAPTAIN** list.

# Setup
You are in a disposable git worktree of nitpicker-harness, at a detached HEAD on a clean default branch.
This is a SCOUT task: the deliverable is a written report, not a PR.
The worktree is your laboratory - install, run, edit, and make scratch commits freely; all of it is discarded at teardown.
The report is the only thing that survives, so anything worth keeping must be in it.

# Rules
1. Never push to any remote and never open a PR.
2. Stay inside this worktree; the only files you may write outside it are the report and the status file below.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/hz-agent-h2.status'`
   States: working, needs-decision, blocked, done, failed.
   Each append wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on and the needs-decision/blocked/done/failed states. No step-by-step
   FYI progress lines; firstmate reads your pane for that.
5. If you hit the same obstacle twice, append `blocked: {why}` and stop; firstmate will help.
6. If a decision belongs to a human (product choices, destructive actions),
   append `needs-decision: {summary of options}` and stop. Firstmate will reply with the decision.

# Definition of done
Write your findings to `../embedded-agent-design/report.md`.
The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.
When the report is complete, append `done: {one-line conclusion}` to the status file and stop.
If your findings reveal work that should ship (e.g. you reproduced a bug and the fix is clear), say so in the report; firstmate may promote this task in place, and you would then receive mode-specific ship instructions as a follow-up message.
