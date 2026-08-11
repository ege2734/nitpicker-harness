# nitpicker-harness — public-readiness report

**Repo:** `ege2734/nitpicker-harness` (currently **PRIVATE**)
**Playbook:** `/repo-public` (run from `firstmate/projects/repo-public/SKILL.md`)
**Date:** 2026-07-06
**Branch:** `fm/nh-go-public`
**Scope note:** The repo was **NOT flipped public.** The final flip is held for the captain.

---

## Verdict: **NO-GO until one history/PII decision is made** (everything else is GO)

The working tree and the `main` branch are clean and public-ready. The **only** blocker is a personal-email
exposure that lives in the history of the *merged feature branches* and the *GitHub PR refs*, not on `main`.
It cannot be fixed by a forward commit — it needs a history decision the captain owns (see **Decision
required** below). Once that decision is executed, the repo is safe to publish.

---

## 1. What I audited

Full-history leak/PII/secrets scan (all 47 commits across all 10 refs, not just the tip), plus the working
tree, filenames, and the tree I'm about to commit:

- **Secrets/keys** — regex sweep for private keys, AWS `AKIA…`, GitHub `ghp_/gho_`, Slack `xox…`,
  `sk-…`, GitLab PATs across `git rev-list --all`. (No gitleaks binary available; regex-only.)
- **PII** — real name (`<redacted>`), personal email (`<redacted>`), absolute home paths
  (`~/…`).
- **Internal codenames / tooling** — `firstmate`, `treehouse`, `crewmate`, `no-mistakes`, `*-axi`,
  `lavish`, `fleetview`, internal hostnames/Slack links.
- **AI/session breadcrumbs** — `Co-Authored-By: Claude`, `noreply@anthropic`, session markers in commit
  messages and authorship.
- **Git surface** — authors/committers on every commit, remote branches, tags, PR refs.
- **Governance/docs/CI** — LICENSE, README, `.gitignore`, CI workflow, `package.json`.

## 2. What the scan found

| # | Finding | Where | Risk | Fix |
|---|---------|-------|------|-----|
| 1 | **Personal email `<redacted>`** as author+committer on **36 commits** | History of the 10 merged `fm/*` branches (still on the remote) + the PR refs `refs/pull/1–10/head`. **NOT on `main`.** | **Medium** — deanonymizes the pseudonymous `ege2734` handle. Recoverable via `git log -p`/PR pages even though `main` is clean. | **History decision required** (rewrite / fresh repo / branch+PR cleanup). See below. |
| 2 | Internal codename **`firstmate`** | `src/hook.ts` comment + `AGENTS.md` (design analogy) | Low | **Fixed forward** in this PR (genericized; no meaning lost). Still present in history — benign (a tool name, not a secret). |
| 3 | Internal wrapper name **`chrome-devtools-axi`** | `AGENTS.md` dev-notes | Low | **Fixed forward** in this PR → `chrome-devtools-mcp` (the real public bridge). |
| 4 | **`Co-Authored-By: Claude …`** trailers | 20 commits on `main` | None (cosmetic) | Left as-is. Common in public repos; scrub only if the captain prefers. Removing needs a history rewrite. |

**Clean — no findings:**
- ✅ No API tokens, keys, `.env` contents, or credentials anywhere in history.
- ✅ No absolute `/Users/...` paths in any committed file.
- ✅ No private URLs, internal hostnames, or Slack links.
- ✅ `main` (the 11 squash-merge commits = what a fresh viewer sees) uses **only** the GitHub noreply
  identity `110061031+ege2734@users.noreply.github.com`. The Gmail is confined to the merged branch/PR
  history.
- ✅ Working tree clean; `.env`, `.playwright-mcp/`, `.claude/`, scratch dirs all gitignored and untracked.
- ✅ LICENSE present — MIT, holder `ege2734` (a handle; pseudonymous copyright is valid and matches the
  identity-hiding default).
- ✅ `package.json` carries no personal email.

## 3. Decision required (history strategy — the flip blocker)

The Gmail in finding #1 is the "history intact ≠ old content gone" case. Options, for the captain:

- **A — Fresh repo (skill's recommended, bulletproof).** New repo, one squashed clean commit from the
  cleaned tree, authored with the noreply identity. No shared objects, no PR refs, no `fm/*` branches, no
  old Actions runs. 100% guarantee the Gmail is gone.
- **B — In-place rewrite.** `git filter-repo` to rewrite `<redacted>` → noreply across all
  commits, force-push. Lighter, but **not bulletproof**: PR refs (`refs/pull/N/head`) and dangling objects
  linger until GitHub GC, and old SHAs can leak via Actions logs.
- **C — Delete branches + accept `main`-only.** Delete the 10 remote `fm/*` branches before flipping. `main`
  is already clean, but the **PR refs still expose the Gmail** on the PR "Commits" tabs — so this is only
  partial and is **not** a full fix.

**Recommendation:** A (fresh repo) if the goal is a zero-trace publish; B if preserving history/PR numbers
matters more than the residual PR-ref exposure. Either way, set commit author/committer to
`110061031+ege2734@users.noreply.github.com`. *This is escalated to firstmate as a `needs-decision`; I did
not decide or execute it.*

## 4. Governance / docs / CI added (this PR — safe, additive, independent of the decision above)

- **`CONTRIBUTING.md`** — setup, test commands, the "keep `inject.ts` pure" + "preserve `vendor/` deltas" rules.
- **`CODE_OF_CONDUCT.md`** — Contributor Covenant 2.1; enforcement routed to **GitHub private vulnerability
  reporting**, not a personal email.
- **`SECURITY.md`** — private-reporting link + an explicit dev-tool threat model (the CSP/framing relaxation
  is by-design and local-only).
- **`.github/ISSUE_TEMPLATE/`** — `bug_report.yml`, `feature_request.yml`, `config.yml` (steers security to
  private reporting, questions to Discussions).
- **`.github/pull_request_template.md`** — checklist incl. typecheck/tests + the vendored-delta guard.
- **`.github/dependabot.yml`** — weekly npm + github-actions updates.
- **`CHANGELOG.md`** — Keep-a-Changelog, seeds `0.1.0` (Phase 1) + Unreleased.
- **README** — CI + MIT license badges added. (README was already clean, public-facing, and complete.)
- **Codename cleanup** — genericized `firstmate` / `chrome-devtools-axi` (findings #2, #3) forward.

**LICENSE:** already present and appropriate — no change.

## 5. CI

`.github/workflows/ci.yml` is already sane for a public repo: on push/PR to `main`, `npm ci` against the
committed `package-lock.json`, `npm run typecheck`, `npm test`, Node 20. No change needed.

## 6. Verify (skill verify step)

- ✅ `npm run typecheck` — clean.
- ✅ `npm test` — **143/143 passing** (19 files) after all edits.
- ✅ Post-change full re-scan of the staged tree — **zero** hits for PII / secrets / internal codenames.

## 7. Recommended settings for the captain at flip time (out of my scope)

- Delete the 10 stale `fm/*` remote branches (regardless of history strategy).
- After flip: enable Discussions, enable private vulnerability reporting
  (`gh api -X PUT repos/ege2734/nitpicker-harness/private-vulnerability-reporting`), set description + topics.
- Social-preview image + branch protection are optional web-UI items.

---

### Bottom line
Governance, docs, CI, and the working tree are **public-ready and green**. **Do not flip** until the
captain picks and executes a history strategy for the personal Gmail in the merged-branch/PR history
(finding #1). Everything in §4 ships as one no-mistakes PR on `fm/nh-go-public`.
