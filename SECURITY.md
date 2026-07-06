# Security Policy

## Reporting a vulnerability

**Please do not open a public issue for security problems.**

Report vulnerabilities privately through GitHub's private vulnerability reporting:

➡️ **https://github.com/ege2734/nitpicker-harness/security/advisories/new**

We aim to acknowledge a report within a few days and will keep you updated as we work on a fix.

## Scope & threat model

nitpicker-harness is a **local development tool**. It runs a reverse proxy that:

- fronts a target dev server on `127.0.0.1`,
- injects a feedback overlay into streamed HTML,
- **relaxes framing and CSP** (`X-Frame-Options` stripped, `frame-ancestors`/`script-src`/`connect-src`/
  `style-src` loosened) on the proxied responses so the overlay can run same-origin, and
- runs a local sidecar that accepts feedback POSTs.

These relaxations are intentional and are only appropriate for **local development against your own app**.
Do not expose the harness or its sidecar to untrusted networks, and do not run it in front of production
traffic. The overlay engine is guarded to refuse to mount when `NODE_ENV === 'production'`.

Reports that amount to "the dev proxy relaxes CSP" or "the sidecar has no auth" are known, by-design
properties of a localhost dev tool rather than vulnerabilities — but if you find a way these lead to
harm beyond the local dev box (e.g. an injection that escapes the intended dev-only scope), we want to
hear about it.
