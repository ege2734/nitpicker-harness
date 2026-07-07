#!/usr/bin/env bash
# Clean-install regression guard. Packs the harness the way consumers get it and installs the tarball into
# a scratch dir with a PRODUCTION (no-dev) install, then proves the package is runnable with NO tsx / dev
# deps present:
#   (a) the `nitpicker-harness` bin runs (`--help`),
#   (b) embedded mode boots against a tiny throwaway app (owns its dev server, spawns the compiled sidecar,
#       serves the proxy + panes) and answers HTTP — i.e. no `Cannot find module .../tsx/...` MODULE_NOT_FOUND.
#
# This is the exact failure the dist build fixes: the in-repo vitest suite passes even while broken because
# dev deps are present there. Run with pnpm by default (Loom's consumer manager, isolated node_modules —
# the layout that exposed the tsx `exports`-map break); set PM=npm to use npm instead.
set -euo pipefail

PM="${PM:-pnpm}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
WORK="$(mktemp -d)"
cleanup() {
  [ -n "${HARNESS_PID:-}" ] && kill "$HARNESS_PID" 2>/dev/null || true
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "==> building + packing $ROOT"
( cd "$ROOT" && npm run build >/dev/null && npm pack --pack-destination "$WORK" >/dev/null )
TARBALL="$(ls "$WORK"/nitpicker-harness-*.tgz)"
echo "    tarball: $(basename "$TARBALL")"

# ---- consumer project: production (no-dev) install of the tarball ----
CONSUMER="$WORK/consumer"
mkdir -p "$CONSUMER"
cat > "$CONSUMER/package.json" <<'JSON'
{ "name": "consumer", "version": "1.0.0", "private": true, "type": "module" }
JSON
echo "==> installing tarball into consumer via $PM (production, no dev deps)"
if [ "$PM" = "pnpm" ]; then
  ( cd "$CONSUMER" && pnpm add --prod "$TARBALL" >/dev/null 2>&1 )
else
  ( cd "$CONSUMER" && npm install --omit=dev "$TARBALL" >/dev/null 2>&1 )
fi

# Guard: tsx must NOT be needed — assert it is genuinely absent from the consumer tree.
if node -e "require('module').createRequire('$CONSUMER/x.js').resolve('tsx/cli')" >/dev/null 2>&1; then
  echo "!! tsx resolvable in consumer tree — clean-install guard is not meaningful" >&2
fi

BIN="$CONSUMER/node_modules/.bin/nitpicker-harness"

echo "==> (a) bin --help"
"$BIN" --help >/dev/null
echo "    ok: --help ran (exit 0)"

echo "==> (a.5) library surface: import { startEmbeddedBuilder, … } from 'nitpicker-harness'"
cat > "$CONSUMER/lib-check.mjs" <<'JS'
import * as h from "nitpicker-harness";
const need = ["startEmbeddedBuilder", "startHarness", "makeBackend", "LocalAppRuntime",
  "AgentGateway", "resolveSystemPrompt", "LOOM_BUILDER_SYSTEM_PROMPT"];
const missing = need.filter((k) => h[k] === undefined);
if (missing.length) { console.error("missing exports: " + missing.join(", ")); process.exit(1); }
if (typeof h.LOOM_BUILDER_SYSTEM_PROMPT !== "string" || !h.LOOM_BUILDER_SYSTEM_PROMPT.length)
  { console.error("LOOM_BUILDER_SYSTEM_PROMPT not a non-empty string"); process.exit(1); }
console.log("    ok: " + need.length + " exports resolved from dist/index.js");
JS
( cd "$CONSUMER" && node lib-check.mjs )

# ---- tiny throwaway app the harness will own (its dev server binds \$PORT) ----
APP="$WORK/app"
mkdir -p "$APP"
cat > "$APP/package.json" <<'JSON'
{ "name": "throwaway-app", "version": "1.0.0", "private": true, "scripts": { "dev": "node server.mjs" } }
JSON
cat > "$APP/server.mjs" <<'JS'
import { createServer } from "node:http";
const port = process.env.PORT || 3000;
createServer((_req, res) => { res.setHeader("content-type", "text/html"); res.end("<!doctype html><h1>hi</h1>"); })
  .listen(port, "127.0.0.1", () => console.log("throwaway app listening on " + port));
JS

PROXY_PORT=4319
SIDE_PORT=5319
echo "==> (b) embedded mode against throwaway app (--no-agent: classic sink, exercises compiled sidecar)"
"$BIN" "$APP" --no-agent --port "$PROXY_PORT" --sidecar-port "$SIDE_PORT" --session verifypack \
  > "$WORK/harness.log" 2>&1 &
HARNESS_PID=$!

# Wait for the proxy to answer (up to ~30s). A MODULE_NOT_FOUND (tsx / dist) would crash before this.
URL="http://127.0.0.1:$PROXY_PORT/"
for i in $(seq 1 60); do
  if ! kill -0 "$HARNESS_PID" 2>/dev/null; then
    echo "!! harness process exited early — log:" >&2; cat "$WORK/harness.log" >&2; exit 1
  fi
  if curl -fsS "$URL" >/dev/null 2>&1; then READY=1; break; fi
  sleep 0.5
done

if [ "${READY:-0}" != "1" ]; then
  echo "!! harness never answered $URL — log:" >&2; cat "$WORK/harness.log" >&2; exit 1
fi

# Prove the injected overlay + shell are served (the browser bundles resolve from dist/browser, no esbuild).
curl -fsS "http://127.0.0.1:$PROXY_PORT/__nitpicker-harness/overlay.js" | grep -q "np-dock" \
  || { echo "!! overlay bundle missing np-dock" >&2; cat "$WORK/harness.log" >&2; exit 1; }
curl -fsS "http://127.0.0.1:$PROXY_PORT/__nitpicker-harness/shell" | grep -q "nh-send-btn" \
  || { echo "!! shell page not served" >&2; cat "$WORK/harness.log" >&2; exit 1; }

# Guard against a silent tsx fallback anywhere in the run.
if grep -qi "Cannot find module.*tsx\|tsx: command not found\|ERR_MODULE_NOT_FOUND" "$WORK/harness.log"; then
  echo "!! tsx / module-not-found leaked into the run:" >&2; cat "$WORK/harness.log" >&2; exit 1
fi

echo "    ok: proxy + overlay + shell served, compiled sidecar spawned, no tsx/module-not-found"
echo "==> PASS: clean production install is runnable"
