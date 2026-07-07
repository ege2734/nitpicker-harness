// nitpicker-harness — the browser entry for the "builder shell" (viability report §6 / Phase 1+2). Runs in
// the PARENT shell window (SHELL_PATH), a sibling of the same-origin `<iframe src="/">` holding the proxied
// app. It owns the chat + queue + transport, so that state lives in the parent heap and survives ANY
// navigation the iframe does. The markup is server-rendered by inject.ts:shellPage(); this file wires
// behavior onto it.
//
// Phase 2's interactive layer (mode toolbar, element picker, region drag → capture, inline text edit) has
// been extracted into the reusable `InteractionLayer` (src/shell/interaction.ts) so the embedded builder
// pane (src/builder/entry.ts) shares it. `ShellChrome` is now the SIDECAR host: it owns the queue + the
// reused `Transport` (POST /feedback) and hands the layer a sink that pushes marks into that queue. The
// interaction behavior is byte-identical to the pre-extraction shell.
//
// Config (session + sidecar endpoint) rides on this script's own <script src> query string, exactly like
// the overlay, so no inline <script> is needed.
import { Transport } from "../../vendor/nitpicker/core/transport";
import type { QueueItem } from "../../vendor/nitpicker/core/types";
import { InteractionLayer, frameViewport, iframeLocation, type InteractionSink } from "./interaction";

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

class ShellChrome implements InteractionSink {
  private readonly transport: Transport;
  private queue: QueueItem[] = [];
  private sending = false;
  private readonly interaction: InteractionLayer;

  private readonly queueEl = document.getElementById("nh-queue") as HTMLElement;
  private readonly countEl = document.getElementById("nh-count") as HTMLElement;
  private readonly inputEl = document.getElementById("nh-input") as HTMLTextAreaElement;
  private readonly queueBtn = document.getElementById("nh-queue-btn") as HTMLButtonElement;
  private readonly sendBtn = document.getElementById("nh-send-btn") as HTMLButtonElement;
  private readonly statusEl = document.getElementById("nh-status") as HTMLElement;

  constructor(session: string, endpoint: string) {
    this.transport = new Transport(session, endpoint);
    this.interaction = new InteractionLayer(this);
    this.wire();
    this.render();
  }

  // ---- InteractionSink ----
  takeNote(): string {
    const note = this.inputEl.value.trim();
    this.inputEl.value = "";
    return note;
  }
  onMark(item: QueueItem): void {
    this.queue.push(item);
    this.render();
  }
  removeMark(id: string): void {
    this.queue = this.queue.filter((i) => i.id !== id);
    this.render();
  }
  onCaptureSettled(): void {
    this.render();
  }
  setStatus(msg: string, kind?: "ok" | "err"): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = `nh-status${kind ? ` nh-${kind}` : ""}`;
  }

  private wire(): void {
    this.queueBtn.addEventListener("click", () => this.queueMessage());
    this.sendBtn.addEventListener("click", () => void this.send());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        this.queueMessage();
      }
    });
  }

  private queueMessage(): void {
    const text = this.inputEl.value.trim();
    if (!text) return;
    const frame = document.getElementById("nh-frame") as HTMLIFrameElement | null;
    const { href, route } = iframeLocation(frame);
    this.queue.push({
      id: cryptoId(),
      kind: "message",
      text,
      pageUrl: href,
      route,
      viewport: frameViewport(frame),
      timestamp: new Date().toISOString(),
    });
    this.inputEl.value = "";
    this.setStatus("");
    this.render();
    this.inputEl.focus();
  }

  private async send(): Promise<void> {
    if (this.sending || this.queue.length === 0) return;
    this.sending = true;
    const batch = this.queue.slice();
    const n = batch.length;
    this.render();
    this.setStatus(`Sending ${n} item${n === 1 ? "" : "s"}…`);
    try {
      const pending = batch.map((i) => i._pending).filter(Boolean) as Promise<void>[];
      if (pending.length) {
        this.setStatus(`Finishing ${pending.length} screenshot${pending.length === 1 ? "" : "s"}…`);
        await Promise.all(pending);
      }
      const uploadable = batch.filter((i) => !(i.kind === "region" && !i._blob));
      if (uploadable.length === 0) return;
      await this.transport.sendBatch(uploadable);
      this.queue = this.queue.filter((i) => !uploadable.includes(i));
      this.setStatus(`Sent ${uploadable.length} item${uploadable.length === 1 ? "" : "s"} to the agent.`, "ok");
    } catch (err) {
      this.setStatus(`Send failed: ${(err as Error).message}`, "err");
    } finally {
      this.sending = false;
      this.render();
    }
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

      if (item.kind === "region") {
        const chip = document.createElement("span");
        chip.className = "nh-item-route";
        chip.textContent = item._thumb ? "region ✓" : item._error ? "region ✕" : "region · capturing…";
        row.appendChild(chip);
      } else if (item.kind === "element" && item.element) {
        const el = item.element;
        const chip = document.createElement("span");
        chip.className = "nh-item-route";
        chip.textContent = el.component ? `⬡ ${el.component}` : el.selector ?? "element";
        row.appendChild(chip);
        if (el.source) {
          const src = document.createElement("span");
          src.className = "nh-item-route nh-item-source";
          src.textContent = el.source;
          row.appendChild(src);
        }
      } else if (item.kind === "text-edit") {
        const chip = document.createElement("span");
        chip.className = "nh-item-route";
        chip.textContent = "✎ edit";
        row.appendChild(chip);
        const src = item.element?.source;
        if (src) {
          const srcChip = document.createElement("span");
          srcChip.className = "nh-item-route nh-item-source";
          srcChip.textContent = src;
          row.appendChild(srcChip);
        }
        const diff = document.createElement("span");
        diff.className = "nh-item-edit";
        diff.textContent = `“${item.oldText ?? ""}” → “${item.newText ?? ""}”`;
        row.appendChild(diff);
      }

      row.appendChild(document.createTextNode(item.text || "(no note)"));
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
      del.addEventListener("click", () => this.removeMark(item.id));
      row.appendChild(del);
      this.queueEl.appendChild(row);
    }
  }
}

function cryptoId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
}

// Read the config NOW, at synchronous module-execution time (see AGENTS.md: currentScript is only non-null
// while the script runs synchronously; deferring the read into DOMContentLoaded loses it).
const CONFIG = readConfig();

function mount(): void {
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
