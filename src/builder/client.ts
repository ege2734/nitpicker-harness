// nitpicker-harness — the browser client for the Agent Gateway (hz-agent §3.2). Used by the embedded
// builder pane (src/builder/entry.ts) to drive one live agent session: POST a turn, stream its
// `AgentEvent`s over SSE, interrupt it, and rehydrate the transcript on (re)load.
//
// SSE is a plain `EventSource` (one-way server push, built-in reconnection with `Last-Event-ID`). Region
// screenshots ride the reused sidecar `/blob` store — uploaded here first, then referenced by local `path`
// on the wire so the same-machine agent opens them directly (zero new image plumbing).
import { serializeItem, type QueueItem } from "../../vendor/nitpicker/core/types";
import type { AgentEvent, AgentMessage, WireItem } from "../agent/backend";

const AGENT_PREFIX = "/__nitpicker-harness/agent";
/** The SSE event names the gateway emits (mirrors AgentEvent["type"]). */
const EVENT_TYPES: AgentEvent["type"][] = [
  "turn_start",
  "token",
  "tool_use",
  "tool_result",
  "file_changed",
  "turn_end",
  "error",
];

export interface HistoryResponse {
  sessionId: string;
  messages: AgentMessage[];
  running: boolean;
  lastEventId: number;
  resumeFrom: number;
}

export class AgentGatewayClient {
  private es: EventSource | null = null;
  constructor(
    private readonly sessionId: string,
    /** Sidecar base URL for `/blob` region uploads (same one the shell/overlay use). */
    private readonly blobEndpoint: string,
  ) {}

  /** Rehydrate: completed transcript + the cursor to resume the (maybe in-flight) turn from. */
  async history(): Promise<HistoryResponse> {
    const res = await fetch(
      `${AGENT_PREFIX}/history?sessionId=${encodeURIComponent(this.sessionId)}`,
      { credentials: "same-origin" },
    );
    if (!res.ok) throw new Error(`history failed (${res.status})`);
    return res.json();
  }

  /** Open the SSE stream. `resumeFrom` replays the live turn on first connect; the browser sets
   *  `Last-Event-ID` itself on auto-reconnect (which the gateway honors over the query cursor). */
  connect(onEvent: (e: AgentEvent) => void, resumeFrom = 0): void {
    this.close();
    const q = new URLSearchParams({ sessionId: this.sessionId });
    if (resumeFrom > 0) q.set("lastEventId", String(resumeFrom));
    const es = new EventSource(`${AGENT_PREFIX}/stream?${q.toString()}`, { withCredentials: true });
    for (const type of EVENT_TYPES) {
      es.addEventListener(type, (ev: MessageEvent) => {
        try {
          onEvent(JSON.parse(ev.data) as AgentEvent);
        } catch {
          /* ignore malformed frame */
        }
      });
    }
    this.es = es;
  }

  /** Send one turn. Region blobs upload first; every mark is serialized to a `WireItem`. */
  async send(text: string, marks: QueueItem[]): Promise<void> {
    const wire = await this.serializeMarks(marks);
    const res = await fetch(`${AGENT_PREFIX}/message`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId, text, marks: wire }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`agent message failed (${res.status})${body ? `: ${body}` : ""}`);
    }
  }

  async interrupt(): Promise<void> {
    await fetch(`${AGENT_PREFIX}/interrupt`, {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ sessionId: this.sessionId }),
    });
  }

  close(): void {
    this.es?.close();
    this.es = null;
  }

  private async serializeMarks(marks: QueueItem[]): Promise<WireItem[]> {
    return Promise.all(
      marks.map(async (item) => {
        const serialized = serializeItem(item);
        if (item.kind === "region" && item._blob && serialized.image) {
          const up = await this.uploadBlob(item._blob);
          serialized.image = { ...serialized.image, ref: up.id, path: up.path, url: up.url };
        }
        return serialized;
      }),
    );
  }

  private async uploadBlob(blob: Blob): Promise<{ id: string; path: string; url: string }> {
    const res = await fetch(`${this.blobEndpoint}/blob`, {
      method: "POST",
      headers: { "X-Nitpicker-Mime": blob.type || "image/png" },
      body: blob,
    });
    if (!res.ok) throw new Error(`blob upload failed (${res.status})`);
    return res.json();
  }
}
