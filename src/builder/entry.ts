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
import {
  InteractionLayer,
  frameViewport,
  iframeLocation,
  type InteractionSink,
} from "../shell/interaction";
import type { ParentBox } from "../shell/geometry";
import type { AgentEvent } from "../agent/backend";
import { AgentGatewayClient } from "./client";
import { AnnotationPopup, annotateLabel } from "./annotate";
import { buildQueueItem } from "./queue";
import { classifyComposerKey, partitionQueue } from "./compose";

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
  private readonly interaction: InteractionLayer;
  private pendingMarks: QueueItem[] = [];
  private expandedId: string | null = null;
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
    // Interaction layer produces marks; its sink is `this`. Kept so we can drive the persistent selection
    // visual (red box + dim backdrop) while an annotate popup is open.
    this.interaction = new InteractionLayer(this);
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
    // The persistent selection visual (red box + dimmed backdrop, classic "persist until commit") stays up the
    // whole time the popup is open. `open()` first resolves any prior popup (→ its onCancel → clearSelection),
    // so show the NEW selection AFTER opening.
    this.annotate.open(
      anchor,
      {
        onConfirm: (note) => {
          item.text = note;
          this.pendingMarks.push(item);
          this.interaction.clearSelection();
          this.renderMarks();
          this.setStatus(note ? "Mark attached." : "Mark attached (no note).", "ok");
        },
        onCancel: () => {
          // Never pushed to pendingMarks, so nothing to remove; any in-flight region raster just resolves
          // into an orphaned item that's GC'd. removeMark(id) on a late capture failure is a harmless no-op.
          this.interaction.clearSelection();
          this.setStatus("Mark discarded.");
        },
      },
      { label: annotateLabel(item.kind) },
    );
    this.interaction.showSelection(anchor);
  }
  removeMark(id: string): void {
    this.pendingMarks = this.pendingMarks.filter((i) => i.id !== id);
    if (this.expandedId === id) this.expandedId = null;
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
    // The Send button flushes the whole queue (typed messages + marks) as one turn.
    this.sendBtn.addEventListener("click", () => void this.flush());
    this.stopBtn.addEventListener("click", () => void this.client.interrupt());
    // Composer submit semantics: Enter → queue the typed text (stage, don't send); Cmd/Ctrl+Enter → flush
    // the whole queue to the agent; Shift+Enter → newline.
    this.inputEl.addEventListener("keydown", (e) => {
      const action = classifyComposerKey(e);
      if (!action || action === "newline") return; // Shift+Enter / non-Enter → default (newline)
      e.preventDefault();
      if (action === "flush") void this.flush();
      else this.queueFromComposer();
    });
  }

  /** Stage the composer text as a standalone "message" mark in the same queue the picks/regions feed. */
  private queueFromComposer(): boolean {
    const text = this.inputEl.value.trim();
    if (!text) return false;
    const frame = document.getElementById("nh-frame") as HTMLIFrameElement | null;
    const { href, route } = iframeLocation(frame);
    this.pendingMarks.push({
      id: newId(),
      kind: "message",
      text,
      pageUrl: href,
      route,
      viewport: frameViewport(frame),
      timestamp: new Date().toISOString(),
    });
    this.inputEl.value = "";
    this.renderMarks();
    this.setStatus("Queued — ⌘↵ to send.");
    return true;
  }

  /**
   * Flush the whole queue to the agent as ONE turn. Any un-queued composer text is queued first (so a single
   * quick message still sends in one gesture). Grouping (the open judgment call): queued "message" items
   * become the turn's typed text, joined in order; region/element/text-edit marks ride as `marks` carrying
   * their file:line / region context — exactly the shape the gateway's formatTurn already composes (typed
   * text leads, marks follow as context blocks).
   */
  private async flush(): Promise<void> {
    if (this.sending || this.busy) return;
    this.queueFromComposer(); // fold any un-staged composer text into the queue first
    const { text, marks } = partitionQueue(this.pendingMarks);
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
      this.pendingMarks = [];
      this.expandedId = null;
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
    empty.textContent =
      "Mark the preview or type a message. Enter queues · ⌘/Ctrl+Enter sends the queue to the agent.";
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
    // Revoke any full-res object URLs from the previous render (region previews) before rebuilding.
    this.marksEl.querySelectorAll("img.nh-item-img").forEach((img) => {
      const s = (img as HTMLImageElement).src;
      if (s.startsWith("blob:")) URL.revokeObjectURL(s);
    });
    this.marksEl.textContent = "";

    if (this.pendingMarks.length === 0) {
      this.marksEl.style.display = "none";
      return;
    }
    // Column list of expandable items (ported parity with the classic shell/overlay queue), with a count.
    this.marksEl.style.cssText =
      "display:flex;flex-direction:column;gap:6px;padding:8px 12px;border-top:1px solid #23272e;max-height:42vh;overflow-y:auto;";

    const header = document.createElement("div");
    header.className = "nh-marks-head";
    header.textContent = `Queued marks · ${this.pendingMarks.length}`;
    header.style.cssText = "font-size:10px;letter-spacing:.4px;text-transform:uppercase;color:#6b727c;";
    this.marksEl.appendChild(header);

    for (const item of this.pendingMarks) {
      this.marksEl.appendChild(
        buildQueueItem(
          item,
          {
            onRemove: (id) => this.removeMark(id),
            onToggle: (id) => {
              this.expandedId = this.expandedId === id ? null : id;
              this.renderMarks();
            },
            onNoteChange: (id, note) => {
              const it = this.pendingMarks.find((m) => m.id === id);
              if (it) it.text = note;
            },
          },
          this.expandedId === item.id,
        ),
      );
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

function newId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : `np-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
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
