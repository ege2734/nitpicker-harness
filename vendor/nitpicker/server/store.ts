// nitpicker sidecar — in-memory session queue with long-poll drain semantics.
//
// This is the transport core: each session owns a FIFO queue of feedback items. A long-poll DRAINS the
// queue (reads everything, then clears) so every item is delivered exactly once — and, crucially, the
// queue is only cleared by an *actual delivery*, so a killed/re-issued poll never loses feedback.
//
// Pure logic, no HTTP — the http layer (index.ts) and the tests both drive this directly.
import { EventEmitter } from "node:events";

/** A queued feedback item. Shape mirrors the wire schema; the server keeps it opaque except for
 *  `image.path`, which it resolves to a local file before enqueuing. */
export interface FeedbackItem {
  id: string;
  kind: "region" | "element" | "message";
  text: string;
  pageUrl?: string;
  route?: string;
  viewport?: { w: number; h: number; dpr: number };
  timestamp?: string;
  image?: {
    ref?: string;
    path?: string; // local file path the agent opens directly
    url?: string; // GET /blob/:id fallback
    mime?: string;
    hasRedBox?: boolean;
    selectionRect?: { x: number; y: number; w: number; h: number };
  };
  element?: Record<string, unknown>;
}

interface Session {
  queue: FeedbackItem[];
  /** Monotonic count of *actual* deliveries — bumped only when drain() returns >0 items. Used by the
   *  harness feedback driver to tell "agent drained since we drove" from "agent ignored the drive." */
  drains: number;
}

/**
 * Holds every session's queue and emits a `feedback` event on enqueue so a parked long-poll can wake
 * immediately. Drain is the only operation that removes items, and it snapshots-then-clears, so the
 * caller can decide (based on connection liveness) whether the delivery actually happened.
 */
export class SessionStore {
  private readonly sessions = new Map<string, Session>();
  private readonly emitter = new EventEmitter();

  constructor() {
    // Many concurrent pollers across dev apps is normal; lift the default 10-listener warning cap.
    this.emitter.setMaxListeners(0);
  }

  private session(id: string): Session {
    let s = this.sessions.get(id);
    if (!s) {
      s = { queue: [], drains: 0 };
      this.sessions.set(id, s);
    }
    return s;
  }

  /** Append items to a session's queue and wake any parked poller for that session. */
  enqueue(id: string, items: FeedbackItem[]): void {
    if (items.length === 0) return;
    this.session(id).queue.push(...items);
    this.emitter.emit(`feedback:${id}`);
  }

  /** Number of items currently queued for a session. */
  size(id: string): number {
    return this.sessions.get(id)?.queue.length ?? 0;
  }

  /** Monotonic count of actual deliveries for a session (0 if unknown). Bumped only by a real drain. */
  drainCount(id: string): number {
    return this.sessions.get(id)?.drains ?? 0;
  }

  /**
   * Read and remove every queued item for a session. Returns `[]` when empty. This is the single point
   * that clears the queue — call it only when you are about to deliver the result, so that a poll which
   * never delivers (client disconnected) leaves the queue intact for the next poll.
   */
  drain(id: string): FeedbackItem[] {
    const s = this.sessions.get(id);
    if (!s || s.queue.length === 0) return [];
    const items = s.queue;
    s.queue = [];
    s.drains++; // a real delivery just happened — advance the generation
    return items;
  }

  /** Subscribe to enqueues for a session. Returns an unsubscribe fn. */
  onFeedback(id: string, cb: () => void): () => void {
    const event = `feedback:${id}`;
    this.emitter.on(event, cb);
    return () => this.emitter.off(event, cb);
  }
}
