// nitpicker-harness — the browser entry for the EMBEDDED BUILDER pane (hz-agent §2, loom-decision D7). A
// sibling of the builder-shell (src/shell/entry.ts): same parent-window `InteractionLayer` over the same-
// origin proxied iframe, but the right rail is a LIVE agent transcript instead of a queue→sidecar sink.
// Marks accumulate as chips and ride the next message to the Agent Gateway; the agent edits the app's real
// source and the preview HMRs on its own — the chat and the live preview stay in lockstep with zero
// preview-refresh code.
//
// Config (session + sidecar endpoint) rides this script's own <script src> query string — read
// SYNCHRONOUSLY at module load (currentScript is only non-null then; see AGENTS.md).
import type { QueueItem } from "../../vendor/nitpicker/core/types";
import { InteractionLayer, type InteractionSink } from "../shell/interaction";
import type { ParentBox } from "../shell/geometry";
import type { AgentEvent } from "../agent/backend";
import { AgentGatewayClient } from "./client";
import { AnnotationPopup, annotateLabel } from "./annotate";

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

class BuilderChrome implements InteractionSink {
  private readonly client: AgentGatewayClient;
  private readonly annotate = new AnnotationPopup();
  private pendingMarks: QueueItem[] = [];
  private sending = false;
  private busy = false;
  private currentAssistant: HTMLElement | null = null;
  private currentAssistantText: Text | null = null;

  private readonly transcriptEl = document.getElementById("nh-transcript") as HTMLElement;
  private readonly marksEl = document.getElementById("nh-marks") as HTMLElement;
  private readonly inputEl = document.getElementById("nh-input") as HTMLTextAreaElement;
  private readonly sendBtn = document.getElementById("nh-send-btn") as HTMLButtonElement;
  private readonly stopBtn = document.getElementById("nh-stop-btn") as HTMLButtonElement;
  private readonly statusEl = document.getElementById("nh-status") as HTMLElement;
  private readonly dotEl = document.getElementById("nh-dot") as HTMLElement;

  constructor(session: string, endpoint: string) {
    this.client = new AgentGatewayClient(session, endpoint);
    // Interaction layer produces marks; its sink is `this`.
    new InteractionLayer(this);
    this.wire();
    this.renderMarks();
    void this.hydrate();
  }

  // ---- InteractionSink ----
  takeNote(): string {
    // In embedded mode the composer text IS the turn message; marks carry only their descriptor.
    return "";
  }
  onMark(item: QueueItem, anchor?: ParentBox): void {
    // Restore the classic per-mark confirm/annotate step: instead of silently auto-attaching, open a popup
    // near the selection so the user can add a note and confirm — or discard the mark entirely (Esc/Cancel).
    this.annotate.open(
      anchor,
      {
        onConfirm: (note) => {
          item.text = note;
          this.pendingMarks.push(item);
          this.renderMarks();
          this.setStatus(note ? "Mark attached." : "Mark attached (no note).", "ok");
        },
        onCancel: () => {
          // Never pushed to pendingMarks, so nothing to remove; any in-flight region raster just resolves
          // into an orphaned item that's GC'd. removeMark(id) on a late capture failure is a harmless no-op.
          this.setStatus("Mark discarded.");
        },
      },
      { label: annotateLabel(item.kind) },
    );
  }
  removeMark(id: string): void {
    this.pendingMarks = this.pendingMarks.filter((i) => i.id !== id);
    this.renderMarks();
  }
  onCaptureSettled(): void {
    this.renderMarks();
  }
  setStatus(msg: string, kind?: "ok" | "err"): void {
    this.statusEl.textContent = msg;
    this.statusEl.className = `nh-status${kind ? ` nh-${kind}` : ""}`;
  }

  // ---- lifecycle ----
  private async hydrate(): Promise<void> {
    try {
      const h = await this.client.history();
      this.transcriptEl.textContent = "";
      for (const m of h.messages) this.appendMessage(m.role, m.text);
      if (h.running) this.setBusy(true);
      // Resume the (maybe in-flight) turn from the server-provided cursor; idle → replays nothing.
      this.client.connect((e) => this.onAgentEvent(e), h.resumeFrom);
      if (!h.messages.length) this.renderEmpty();
    } catch (err) {
      this.setStatus(`Could not reach the agent: ${(err as Error).message}`, "err");
      // Still open the stream so a late-starting gateway recovers on reconnect.
      this.client.connect((e) => this.onAgentEvent(e));
    }
  }

  private wire(): void {
    this.sendBtn.addEventListener("click", () => void this.send());
    this.stopBtn.addEventListener("click", () => void this.client.interrupt());
    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.send();
      }
    });
  }

  private async send(): Promise<void> {
    if (this.sending || this.busy) return;
    const text = this.inputEl.value.trim();
    const marks = this.pendingMarks.slice();
    if (!text && marks.length === 0) return;
    this.sending = true;
    this.updateControls();
    try {
      // Wait for any in-flight region rasters so their blobs are attached before upload.
      const pending = marks.map((i) => i._pending).filter(Boolean) as Promise<void>[];
      if (pending.length) {
        this.setStatus(`Finishing ${pending.length} screenshot${pending.length === 1 ? "" : "s"}…`);
        await Promise.all(pending);
      }
      const uploadable = marks.filter((i) => !(i.kind === "region" && !i._blob));
      this.appendMessage("user", text, uploadable);
      await this.client.send(text, uploadable);
      this.inputEl.value = "";
      this.pendingMarks = [];
      this.renderMarks();
      this.setStatus("");
    } catch (err) {
      this.setStatus(`Send failed: ${(err as Error).message}`, "err");
    } finally {
      this.sending = false;
      this.updateControls();
    }
  }

  // ---- streamed agent events → transcript ----
  private onAgentEvent(e: AgentEvent): void {
    switch (e.type) {
      case "turn_start":
        this.setBusy(true);
        this.currentAssistant = this.appendMessage("assistant", "");
        this.currentAssistantText = document.createTextNode("");
        this.currentAssistant.appendChild(this.currentAssistantText);
        break;
      case "token":
        if (!this.currentAssistantText) {
          this.currentAssistant = this.appendMessage("assistant", "");
          this.currentAssistantText = document.createTextNode("");
          this.currentAssistant.appendChild(this.currentAssistantText);
        }
        this.currentAssistantText.appendData(e.text);
        this.scrollToEnd();
        break;
      case "tool_use":
        this.appendTool(`▶ ${e.name}`);
        break;
      case "tool_result":
        if (e.summary) this.appendTool(`${e.ok ? "✓" : "✕"} ${e.name}: ${e.summary}`, !e.ok);
        break;
      case "file_changed":
        this.appendTool(`✎ edited ${e.path}`, false, true);
        break;
      case "turn_end":
        this.currentAssistant = null;
        this.currentAssistantText = null;
        this.setBusy(false);
        break;
      case "error":
        this.appendTool(`error: ${e.message}`, true);
        this.setBusy(false);
        break;
    }
  }

  // ---- rendering ----
  private renderEmpty(): void {
    if (this.transcriptEl.childElementCount) return;
    const empty = document.createElement("div");
    empty.className = "nh-empty";
    empty.textContent = "Ask the agent to build or change something. Use the mode toolbar to mark the preview.";
    this.transcriptEl.appendChild(empty);
  }

  private appendMessage(role: "user" | "assistant", text: string, marks?: QueueItem[]): HTMLElement {
    const empty = this.transcriptEl.querySelector(".nh-empty");
    if (empty) empty.remove();
    const row = document.createElement("div");
    row.className = `nh-msg nh-${role}`;
    const label = document.createElement("span");
    label.className = "nh-role";
    label.textContent = role;
    row.appendChild(label);
    if (text) row.appendChild(document.createTextNode(text));
    if (marks && marks.length) {
      const note = document.createElement("span");
      note.className = "nh-tool";
      note.textContent = `+ ${marks.length} mark${marks.length === 1 ? "" : "s"}`;
      row.appendChild(note);
    }
    this.transcriptEl.appendChild(row);
    this.scrollToEnd();
    return row;
  }

  private appendTool(text: string, isError = false, isFile = false): void {
    const target = this.currentAssistant ?? this.appendMessage("assistant", "");
    const row = document.createElement("div");
    row.className = `nh-tool${isError ? " nh-err" : ""}`;
    if (isFile) {
      const span = document.createElement("span");
      span.className = "nh-file";
      span.textContent = text;
      row.appendChild(span);
    } else {
      row.textContent = text;
    }
    target.appendChild(row);
    this.scrollToEnd();
  }

  private renderMarks(): void {
    this.marksEl.textContent = "";
    for (const item of this.pendingMarks) {
      const chip = document.createElement("span");
      chip.className = "nh-chip";
      const label = document.createElement("span");
      label.textContent = chipLabel(item);
      chip.appendChild(label);
      const src = item.element?.source;
      if (src) {
        const s = document.createElement("span");
        s.className = "nh-src";
        s.textContent = src;
        chip.appendChild(s);
      }
      if (item.text) {
        const note = document.createElement("span");
        note.className = "nh-chip-note";
        note.textContent = item.text;
        note.style.cssText = "color:#c7cdd6;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:160px;";
        chip.appendChild(note);
      }
      const del = document.createElement("button");
      del.className = "nh-del";
      del.type = "button";
      del.setAttribute("aria-label", "Remove mark");
      del.textContent = "×";
      del.addEventListener("click", () => this.removeMark(item.id));
      chip.appendChild(del);
      this.marksEl.appendChild(chip);
    }
  }

  private setBusy(busy: boolean): void {
    this.busy = busy;
    this.dotEl.className = `nh-dot ${busy ? "nh-busy" : "nh-ready"}`;
    this.updateControls();
  }

  private updateControls(): void {
    this.sendBtn.disabled = this.sending || this.busy;
    this.sendBtn.textContent = this.busy ? "Working…" : "Send to agent";
    this.stopBtn.disabled = !this.busy;
  }

  private scrollToEnd(): void {
    this.transcriptEl.scrollTop = this.transcriptEl.scrollHeight;
  }
}

function chipLabel(item: QueueItem): string {
  switch (item.kind) {
    case "region":
      return item._error ? "region ✕" : item._blob ? "region ✓" : "region…";
    case "element":
      return item.element?.component ? `⬡ ${item.element.component}` : item.element?.selector ?? "element";
    case "text-edit":
      return `✎ “${item.oldText ?? ""}” → “${item.newText ?? ""}”`;
    default:
      return "message";
  }
}

const CONFIG = readConfig();

function mount(): void {
  if (!document.getElementById("nh-transcript")) {
    console.error("[nitpicker-harness] builder chrome not found — is this the builder pane?");
    return;
  }
  new BuilderChrome(CONFIG.session, CONFIG.endpoint);
  console.info(
    "[nitpicker-harness] builder pane mounted. session:",
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
