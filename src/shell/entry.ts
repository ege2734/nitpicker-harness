// nitpicker-harness — the browser entry for the "builder shell" (viability report §6 / Phase 1). Unlike
// the injected overlay (src/overlay/entry.ts), this runs in the PARENT shell window (SHELL_PATH), a
// sibling of the same-origin `<iframe src="/">` that holds the proxied app. It owns the chat + queue +
// transport, so that state lives in the parent heap and survives ANY navigation the iframe does — SPA
// route change, hard reload, even a cross-origin excursion — with zero extra work (the iframe reloading
// never touches the parent). The markup is server-rendered by inject.ts:shellPage(); this file only wires
// behavior onto it, so the bundle stays small (no html2canvas — Phase 1 is chat + send-to-sidecar only).
//
// Config (session + sidecar endpoint) rides on this script's own <script src> query string, exactly like
// the overlay, so no inline <script> is needed.
import { Transport } from "../../vendor/nitpicker/core/transport";
import type { QueueItem, Viewport } from "../../vendor/nitpicker/core/types";

function readConfig(): { session: string; endpoint: string } {
  const fallback = { session: "nitpicker", endpoint: "http://127.0.0.1:5178" };
  try {
    const cur = document.currentScript as HTMLScriptElement | null;
    const src = cur?.src;
    if (!src) return fallback;
    const params = new URL(src).searchParams;
    return {
      session: params.get("session") || fallback.session,
      endpoint: params.get("endpoint") || fallback.endpoint,
    };
  } catch {
    return fallback;
  }
}

function uuid(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

/** The proxied app's current location, read across the same-origin iframe boundary. Falls back to the
 *  shell's own location when the iframe has wandered cross-origin (contentWindow.location then throws /
 *  reads null) — so queued items always carry a sensible route even mid-excursion. */
function iframeLocation(frame: HTMLIFrameElement | null): { href: string; route: string } {
  try {
    const loc = frame?.contentWindow?.location;
    if (loc && loc.href && loc.href !== "about:blank") {
      return { href: loc.href, route: loc.pathname };
    }
  } catch {
    /* cross-origin iframe — DOM read is blocked; fall through to the shell's own location */
  }
  return { href: location.href, route: location.pathname };
}

/** Viewport of the app frame (the surface the feedback is about), best-effort. */
function frameViewport(frame: HTMLIFrameElement | null): Viewport {
  const w = frame?.clientWidth || window.innerWidth;
  const h = frame?.clientHeight || window.innerHeight;
  return { w, h, dpr: window.devicePixelRatio || 1 };
}

class ShellChrome {
  private readonly transport: Transport;
  private queue: QueueItem[] = [];
  private sending = false;

  private readonly frame = document.getElementById("nh-frame") as HTMLIFrameElement | null;
  private readonly queueEl = document.getElementById("nh-queue") as HTMLElement;
  private readonly countEl = document.getElementById("nh-count") as HTMLElement;
  private readonly inputEl = document.getElementById("nh-input") as HTMLTextAreaElement;
  private readonly queueBtn = document.getElementById("nh-queue-btn") as HTMLButtonElement;
  private readonly sendBtn = document.getElementById("nh-send-btn") as HTMLButtonElement;
  private readonly statusEl = document.getElementById("nh-status") as HTMLElement;

  constructor(private readonly session: string, endpoint: string) {
    this.transport = new Transport(session, endpoint);
    this.wire();
    this.render();
  }

  private wire(): void {
    this.queueBtn.addEventListener("click", () => this.queueMessage());
    this.sendBtn.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      // Enter queues; Shift+Enter inserts a newline.
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.queueMessage();
      }
    });
  }

  private queueMessage(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const { href, route } = iframeLocation(this.frame);
    this.queue.push({
      id: uuid(),
      kind: "message",
      text,
      pageUrl: href,
      route,
      viewport: frameViewport(this.frame),
      timestamp: new Date().toISOString(),
    });
    this.inputEl.value = "";
    this.setStatus("");
    this.render();
    this.inputEl.focus();
  }

  private removeItem(id: string): void {
    this.queue = this.queue.filter((i) => i.id !== id);
    this.render();
  }

  private async send(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const n = this.queue.length;
    this.render();
    this.setStatus(`Sending ${n} item${n === 1 ? "" : "s"}…`);
    try {
      await this.transport.sendBatch(this.queue);
      this.queue = [];
      this.setStatus(`Sent ${n} item${n === 1 ? "" : "s"} to the agent.`, "ok");
    } catch (err) {
      this.setStatus(`Send failed: ${(err as Error).message}`, "err");
    } finally {
      this.sending = false;
      this.render();
    }
  }

  private setStatus(msg: string, kind?: "ok" | "err"): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = `nh-status${kind ? ` nh-${kind}` : ""}`;
  }

  private render(): void {
    this.countEl.textContent = String(this.queue.length);
    this.sendBtn.disabled = this.sending || this.queue.length === 0;
    this.sendBtn.textContent = this.sending ? "Sending…" : "Send to agent";

    this.queueEl.textContent = "";
    if (this.queue.length === 0) {
      const empty = document.createElement("div");
      empty.className = "nh-empty";
      empty.textContent = "No feedback queued yet.";
      this.queueEl.appendChild(empty);
      return;
    }
    for (const item of this.queue) {
      const row = document.createElement("div");
      row.className = "nh-item";
      row.appendChild(document.createTextNode(item.text));
      if (item.route) {
        const route = document.createElement("span");
        route.className = "nh-item-route";
        route.textContent = item.route;
        row.appendChild(route);
      }
      const del = document.createElement("button");
      del.className = "nh-del";
      del.type = "button";
      del.setAttribute("aria-label", "Remove");
      del.textContent = "×";
      del.addEventListener("click", () => this.removeItem(item.id));
      row.appendChild(del);
      this.queueEl.appendChild(row);
    }
  }
}

// Read the config NOW, at synchronous module-execution time. `document.currentScript` is only non-null
// while the script is executing synchronously; if we deferred this read into a DOMContentLoaded callback
// (which fires when the end-of-body script ran during readyState === "loading"), currentScript would be
// null and we'd silently fall back to the default endpoint. So capture it here, once, and reuse it.
const CONFIG = readConfig();

function mount(): void {
  // The shell markup (from inject.ts:shellPage) must already be present. It always is: the injector places
  // this <script> at the end of <body>, after the chrome.
  if (!document.getElementById("nh-chat")) {
    console.error("[nitpicker-harness] shell chrome not found — is this the shell page?");
    return;
  }
  new ShellChrome(CONFIG.session, CONFIG.endpoint);
  console.info(
    "[nitpicker-harness] builder shell mounted. session:",
    CONFIG.session,
    "endpoint:",
    CONFIG.endpoint,
  );
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", mount, { once: true });
} else {
  mount();
}
