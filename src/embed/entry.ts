// nitpicker-harness — the browser entry for EMBED-BRIDGE mode (experience #3: the harness embedded inside a
// host's own chrome). Served at BUILD-sibling route `/__nitpicker-harness/embed` and loaded by the embed
// page (inject.ts:embedPage). It reuses the SAME parent-window InteractionLayer as the /build pane and the
// /shell — but renders NO chrome of its own. It is a headless mark producer: it drives element-pick / region
// / inline-edit over the same-origin app frame and relays every produced mark UP to the trusted host over
// the cross-frame bridge (src/embed/bridge.ts). The host renders its own queue/annotate UI.
//
// Config (session + the trusted host origins) rides this script's own <script src> query string — read
// SYNCHRONOUSLY at module load (currentScript is only non-null then; see AGENTS.md).
import { InteractionLayer } from "../shell/interaction";
import { EmbedBridge } from "./bridge";
import { EmbedSink } from "./sink";
import { parseOrigins } from "./protocol";

function readConfig(): { session: string; origins: string[] } {
  const fallback = { session: "nitpicker", origins: [] as string[] };
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    const src = cur?.src;
    if (!src) return fallback;
    const params = new URL(src).searchParams;
    return {
      session: params.get("session") || fallback.session,
      origins: parseOrigins(params.get("origins")),
    };
  } catch {
    return fallback;
  }
}

const CONFIG = readConfig();

function mount(): void {
  if (!document.getElementById("nh-frame")) {
    console.error("[nitpicker-harness] embed frame not found — is this the embed page?");
    return;
  }
  if (!CONFIG.origins.length) {
    console.warn(
      "[nitpicker-harness] embed bridge disabled: no trusted host origins configured (pass ?origins=…).",
    );
    return;
  }
  const layerRef: { current: InteractionLayer | null } = { current: null };
  const bridge = new EmbedBridge({
    allowedOrigins: CONFIG.origins,
    onSetMode: (mode) => layerRef.current?.setMode(mode),
    onClearSelection: () => layerRef.current?.clearSelection(),
  });
  const sink = new EmbedSink(bridge);
  const layer = new InteractionLayer(sink, (mode) => bridge.emitMode(mode));
  sink.layer = layer;
  layerRef.current = layer;
  console.info(
    "[nitpicker-harness] embed bridge mounted. session:",
    CONFIG.session,
    "trusted origins:",
    CONFIG.origins.join(", "),
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
