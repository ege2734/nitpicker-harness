// nitpicker-harness — builder composer semantics (pure, unit-tested in tests/compose.test.ts). The builder
// chat composer stages into the SAME queue the marks feed: Enter queues the typed text, Cmd/Ctrl+Enter
// flushes the whole queue to the agent, Shift+Enter is a newline. Kept pure so the keyboard routing and the
// turn-assembly grouping are testable without constructing the network-bound BuilderChrome.
import type { QueueItem } from "../../vendor/nitpicker/core/types";

export type ComposerAction = "queue" | "flush" | "newline";

/** Classify a composer keydown. Null = not a submit chord (let the textarea handle it). */
export function classifyComposerKey(e: {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
}): ComposerAction | null {
  if (e.key !== "Enter") return null;
  if (e.shiftKey) return "newline";
  if (e.metaKey || e.ctrlKey) return "flush";
  return "queue";
}

/**
 * Assemble a flush into one turn (the open grouping decision): queued "message" items become the turn's
 * typed text — joined in queue order — and every non-message mark (region/element/text-edit) rides as a
 * `mark`, carrying its file:line / region context. This is exactly the shape the gateway's `formatTurn`
 * composes (typed text leads; marks follow as context blocks), so messages read as the user's instruction
 * and marks as the evidence.
 */
export function partitionQueue(items: QueueItem[]): { text: string; marks: QueueItem[] } {
  const text = items
    .filter((i) => i.kind === "message")
    .map((m) => m.text.trim())
    .filter(Boolean)
    .join("\n\n");
  const marks = items.filter((i) => i.kind !== "message");
  return { text, marks };
}
