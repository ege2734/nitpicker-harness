# Contributing to nitpicker-harness

Thanks for your interest! This project is a small, self-contained tool, and contributions are welcome.

## Ground rules

- **Be kind.** All interaction is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md).
- **Open an issue first** for anything non-trivial, so we can agree on the approach before you invest time.
- **Security issues do not go in public issues** — see [SECURITY.md](./SECURITY.md).

## Development setup

```bash
npm install        # install deps (Node >= 18)
npm run typecheck  # tsc --noEmit
npm test           # vitest: proxy injection (tests/) + overlay engine (vendor/nitpicker/tests/)
```

To run the harness against a live app (runs the TS source under tsx for a fast edit loop; `start` is a
kept alias):

```bash
npm run dev -- --target http://localhost:3000
```

Consumers install a **compiled** package: `npm run build` produces `dist/` and `npm run verify-pack`
proves a packed, production-installed tarball is runnable with no dev deps. See the "Packaging" section of
[`AGENTS.md`](./AGENTS.md).

See [`AGENTS.md`](./AGENTS.md) for the load-bearing design notes and the sharp edges learned the hard way.

## Making a change

1. Fork the repo and create a branch off `main`.
2. Keep changes focused; match the style, comment density, and idioms of the surrounding code.
3. **`src/proxy/inject.ts` must stay pure** (side-effect-free HTML/header rewriting) — it is unit-tested.
4. `vendor/nitpicker/` is copied from an upstream project. It carries a few **harness-local deltas**
   (documented in `vendor/nitpicker/README.md` and `AGENTS.md`); preserve them — do not blind-overwrite
   on re-sync.
5. Add or update tests for behavior changes.
6. Run `npm run typecheck && npm test` — both must be green.
7. Open a pull request using the template; describe what changed and how you verified it.

## Commit / PR conventions

- Conventional-commit-style summaries (`feat(shell): …`, `fix(proxy): …`) are appreciated but not required.
- CI (typecheck + tests) must pass before a PR can merge.

By contributing, you agree that your contributions are licensed under the project's [MIT License](./LICENSE).
