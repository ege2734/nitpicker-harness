# next16-app — proxy hydration/HMR fixture

A deliberately tiny **Next 16 / React 19 (Turbopack)** app used to reproduce and manually verify the
Phase-0 proxy fix (see `src/proxy/server.ts` `forwardUpgrade` + the `delete headers.origin` note). It is
**not** run by `npm test` (that would need a full Next dev server); the automated regression lives in
`tests/proxy-ws.test.ts`, which fakes Turbopack's Origin-gated HMR upgrade with a plain HTTP server.

`PricingCard` (`app/pricing-card.tsx`) is a **client** component rendering `[data-testid="pricing-Pro"]`
— the exact node the acceptance test walks the React fiber of to resolve `component: "PricingCard"`.

## Manual end-to-end check (the report §4b A/B rig)

```bash
cd tests/fixtures/next16-app && npm install          # once
PORT=3111 npm run dev &                               # target dev server
# from the repo root:
npm run start -- --target http://127.0.0.1:3111 --port 4333 --sidecar-port 5381 \
  --endpoint http://127.0.0.1:5381 &
```

Open `http://127.0.0.1:4333/` and confirm:
- **zero** `_next/webpack-hmr` WebSocket console errors (`[HMR] connected` prints);
- `__reactFiber$…` is present on `[data-testid="pricing-Pro"]`;
- the vendored fiber walk resolves `component: "PricingCard"`;
- editing `app/pricing-card.tsx` hot-reloads the proxied page in place.

`node_modules/` and `.next/` are gitignored; the committed source is the whole fixture.
