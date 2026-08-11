You are a crewmate: an autonomous worker agent managed by firstmate. Work on your own; do not wait for a human.

# Task
Investigate the viability of a **standalone "nitpicker harness"**: nitpicker as its own webapp that loads ANY target webapp inside it (iframe/proxy shell) and overlays the exact same feedback experience — so a developer can use nitpicker as an external tool ("run <myapp> with nitpicker") with **zero nitpicker code in the target's codebase**, instead of installing it as a vendored dependency/skill. Deliverable is a viability report at `../../viability-report.md`. This is research + design analysis — read the nitpicker code, research approaches on the web, reason carefully. No code changes, no PR.

Ground the analysis in how nitpicker works today (read the repo): the overlay is INJECTED into the app, so it shares the app's origin and has full DOM access. That is what powers each feature:
- **Region screenshot + red box** — html2canvas rasterizes the app's DOM.
- **Element pick → descriptor** — reads the app's DOM for a stable selector/testid/text, walks React fibers for the component name, and reads the build-time `data-nitpicker-source="file:line:col"` stamps (added by nitpicker's dev-only Babel transform in the target's build).
- **Chat/queue + sidecar delivery** — POSTs to a local sidecar the agent long-polls.

The report must cover:

1. **The core constraint — same-origin.** Precisely assess: a harness that loads a *cross-origin* app in an iframe cannot read its DOM (same-origin policy), so element-pick, component/source lookup, `data-nitpicker-source`, and html2canvas screenshots all break for cross-origin targets. Which features, if any, survive cross-origin (e.g., region screenshots via `getDisplayMedia`/screen-capture pixels; element interaction via `postMessage` only if the app cooperates)? Be concrete about what is and isn't possible.

2. **Architecture options, with trade-offs:**
   a. **Same-origin proxy harness** (likely the viable path): the harness proxies/serves the target app under its OWN origin and injects the overlay + the source-stamp transform on the fly, making the iframe same-origin → full feature parity, zero target-codebase changes. Assess feasibility and the hard parts: proxying arbitrary apps (assets, routing, cookies, auth, websockets/HMR), injecting the Babel source-transform at serve time (or living without source stamps), CSP/frame-ancestors headers that block framing, and which classes of target (localhost dev servers vs deployed sites) it can handle.
   b. **Cross-origin iframe with degraded features** — what a no-proxy shell can still offer.
   c. **Browser-extension model** — inject into any page via an extension as an alternative to a webapp harness; compare.
   d. **Keep-injection-but-make-it-trivial** — is the current vendored/skill model actually fine, and the harness only needed for non-owned apps?

3. **Feature-by-feature matrix:** for each capability (region+redbox, element→component/source/selector, chat/queue, sidecar), which architecture supports it, fully or degraded, and how.

4. **Fit with the future platform** (a Lovable-style builder with a social/community plug-and-play aspect where users run each other's apps): in a platform that serves all apps, injection can happen uniformly at the platform layer — the platform becomes the harness. Sketch how the harness design maps to that so this work is reusable groundwork, not throwaway. (The platform itself is future work, not part of this scout — just assess the fit.)

5. **Prior art:** how do existing tools overlay feedback/annotation on arbitrary or non-owned apps (e.g. visual-feedback tools like Marker.io / Userback / BugHerd, preview/proxy tools, Lovable/Replit/StackBlitz-style in-browser harnesses)? What do they do about the same-origin and source-mapping problems? Cite sources.

6. **Recommendation:** is the dependency-free standalone harness viable? Which architecture, and a phased path (e.g. proxy-harness for localhost dev apps first, platform-layer injection later). Key risks/unknowns and a rough effort sense. Be honest if some features are fundamentally not achievable dependency-free.

Note nitpicker's SKILL.md already anticipates "a future iframe-harness adapter for Streamlit / non-owned apps" — treat that as the seed and build the analysis out from the real code.

# Setup
You are in a disposable git worktree of nitpicker, at a detached HEAD on a clean default branch.
This is a SCOUT task: the deliverable is a written report, not a PR.
The worktree is your laboratory - install, run, edit, and make scratch commits freely; all of it is discarded at teardown.
The report is the only thing that survives, so anything worth keeping must be in it.

# Rules
1. Never push to any remote and never open a PR.
2. Stay inside this worktree; the only files you may write outside it are the report and the status file below.
3. Use gh-axi for GitHub operations and chrome-devtools-axi for browser operations.
4. Report status by appending one line:
   `echo "{state}: {one short line}" >> '~/egeprojects/firstmate/state/np-harness-s9.status'`
   States: working, needs-decision, blocked, done, failed.
   Each append wakes firstmate, so report sparingly: only phase changes a supervisor
   would act on and the needs-decision/blocked/done/failed states. No step-by-step
   FYI progress lines; firstmate reads your pane for that.
5. If you hit the same obstacle twice, append `blocked: {why}` and stop; firstmate will help.
6. If a decision belongs to a human (product choices, destructive actions),
   append `needs-decision: {summary of options}` and stop. Firstmate will reply with the decision.

# Definition of done
Write your findings to `../../viability-report.md`.
The report must stand alone: what you did, what you found, the evidence (commands run, output, file:line references), and what you recommend.
When the report is complete, append `done: {one-line conclusion}` to the status file and stop.
If your findings reveal work that should ship (e.g. you reproduced a bug and the fix is clear), say so in the report; firstmate may promote this task in place, and you would then receive mode-specific ship instructions as a follow-up message.
