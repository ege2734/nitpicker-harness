You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

Feasibility spike (investigation only — deliverable is a report at `../builder-shell-spike/report.md`, NO PR, no branch): evaluate re-architecting nitpicker-harness into a "builder shell" that gives a persistent editor chat + a browser-in-a-browser preview + element→source `file:line` provenance, for the use case of BUILDING a whole app (not just leaving feedback on an existing one).

## Background — what exists today
The harness (read `README.md`, `SKILL.md`, `src/proxy/`, `src/overlay/`, `vendor/nitpicker/core/`) is a **same-origin reverse proxy**: it fronts a target dev server under its own origin and injects the overlay into every streamed HTML page. Because it's same-origin, DOM tools (html2canvas, the selector builder, the React fiber walk) work directly with no postMessage bridge. Its deliberate "one honest limit": a proxy has no build step, so it CANNOT stamp `file:line:col` source locations. Captures are already tagged with `pageUrl`+`route` (`overlay.ts`, `types.ts`). The chat pane + queue currently live in the injected in-page overlay, so a HARD page reload resets unsent state (sent items are safe in the sidecar). We were about to fix that with a localStorage persistence change (`nh-persist-nav`) — this spike may replace that plan.

## The architectural question
Mature app-builders (Lovable, Vercel v0, Webflow) use an **iframe + `postMessage` + injected-runtime + build-plugin** model: the app runs in an `<iframe>`, the editor chrome (chat, toolbar) lives in the PARENT window (so it's structurally immune to the app's navigation/reloads), an injected script does element selection and relays via `postMessage`, and a Babel/SWC plugin stamps `data-source-file`/`data-source-line` for provenance.

**The specific hybrid to evaluate (the most promising path — prove or disprove it):** keep the harness's same-origin **proxy** to serve the app, but render the proxied app **inside an `<iframe>` on a harness "shell" page served from the harness's own origin**. Because the iframe's `src` is same-origin with the parent shell, the parent should be able to read the iframe's `contentDocument` DOM **directly — no `postMessage` bridge** — while still getting the iframe's structural benefits (persistent parent chat/queue, CSS/JS isolation, real in-app navigation that never touches the parent).

## Investigate and answer, with evidence (prototype in a real browser — chrome-devtools-axi or Playwright)
1. **Does the same-origin-iframe hybrid actually work?** Build a minimal proof: a harness shell page (parent) that embeds a proxied app in a same-origin iframe, and confirm the parent can (a) read `iframe.contentDocument`, run `elementFromPoint`/`getBoundingClientRect`, walk the React fiber, and draw a highlight overlay over an iframe element from the parent; (b) run html2canvas against the iframe content. Verify with a real proxied dev app. Where does same-origin actually hold vs break (e.g. if the proxied app itself navigates to a truly cross-origin URL)?
2. **Persistence — is it structural?** Confirm that with chat/queue in the PARENT shell, navigating pages inside the iframe (both SPA client nav and hard reloads) leaves the chat + queue completely intact with zero extra work. This is the core claim to validate; if true, `nh-persist-nav` is unnecessary.
3. **`file:line` provenance.** Confirm the build-step source stamp we already had (embedded-nitpicker's `next.config` source-stamp loader — check git history / the pre-migration app for exactly what it did) can be re-introduced for apps whose build WE control, and that the injected inspector reads those attributes. Be explicit that this only works when we own the target's build (not for arbitrary external apps).
4. **Coordinate/overlay mechanics:** does drawing the highlight/red-box from the parent over an iframe element require coordinate translation (iframe offset), and is that clean? Or is it simpler to keep the overlay injected INSIDE the iframe (same-origin) and only lift the chat/queue to the parent? Recommend which.
5. **What we'd lose / cost.** Honest effort estimate vs the small `nh-persist-nav` change. What does this cost us re: the harness's current "zero code, works on ANY running app" superpower? Propose whether this becomes a second mode ("builder shell" for apps we own) alongside the existing "feedback proxy" (external apps), or a replacement.
6. **Verdict + recommendation:** is the hybrid shell worth building? Does it replace `nh-persist-nav`? Give the concrete implementation shape (where the shell page lives, how the parent reaches the iframe, how the overlay/chat split, how provenance re-enters) or, if it doesn't pan out, say so plainly and recommend sticking with the localStorage persistence change.

Be rigorous, cite what you actually ran/measured, and keep scratch experiments out of any real file (this is scout-scratch; only the report survives).

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
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/nh-shell-spike.status'`
   States: working, needs-decision, blocked, done, failed.
   Each append wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on and the needs-decision/blocked/done/failed states. No step-by-step
   FYI progress lines; firstmate reads your pane for that.
5. If you hit the same obstacle twice, append `blocked: {why}` and stop; firstmate will help.
6. If a decision belongs to a human (product choices, destructive actions),
   append `needs-decision: {summary of options}` and stop. Firstmate will reply with the decision.

# Definition of done
Write your findings to `../builder-shell-spike/report.md`.
The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.
When the report is complete, append `done: {one-line conclusion}` to the status file and stop.
If your findings reveal work that should ship (e.g. you reproduced a bug and the fix is clear), say so in the report; firstmate may promote this task in place, and you would then receive mode-specific ship instructions as a follow-up message.
