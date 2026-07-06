// nitpicker — sidecar drain semantics. The invariant that matters: a long-poll DRAINS the queue
// (delivered exactly once), but the queue is only cleared by an ACTUAL delivery — so a killed/re-issued
// poll never loses feedback.
import { describe, it, expect } from "vitest";
import { SessionStore, type FeedbackItem } from "../server/store";

const item = (id: string): FeedbackItem => ({ id, kind: "message", text: id });

describe("SessionStore", () => {
  it("drains all queued items exactly once, then reports empty", () => {
    const s = new SessionStore();
    s.enqueue("a", [item("1"), item("2")]);
    expect(s.size("a")).toBe(2);

    const first = s.drain("a");
    expect(first.map((i) => i.id)).toEqual(["1", "2"]);
    expect(s.size("a")).toBe(0);
    expect(s.drain("a")).toEqual([]); // second drain gets nothing
  });

  it("keeps sessions isolated", () => {
    const s = new SessionStore();
    s.enqueue("a", [item("a1")]);
    s.enqueue("b", [item("b1")]);
    expect(s.drain("a").map((i) => i.id)).toEqual(["a1"]);
    expect(s.drain("b").map((i) => i.id)).toEqual(["b1"]);
  });

  it("wakes a subscriber on enqueue", () => {
    const s = new SessionStore();
    let woke = 0;
    const off = s.onFeedback("a", () => woke++);
    s.enqueue("a", [item("1")]);
    expect(woke).toBe(1);
    off();
    s.enqueue("a", [item("2")]);
    expect(woke).toBe(1); // unsubscribed → no further wakeups
  });

  it("feedback survives a poll that never delivers (client hung up before draining)", () => {
    const s = new SessionStore();
    // A parked poll subscribes but decides NOT to drain (socket already dead).
    const off = s.onFeedback("a", () => {
      /* would drain here, but the connection is gone → skip */
    });
    s.enqueue("a", [item("1")]);
    off();
    // The item is still queued for the next poll — nothing was lost.
    expect(s.size("a")).toBe(1);
    expect(s.drain("a").map((i) => i.id)).toEqual(["1"]);
  });

  it("round-trips a text-edit mark's oldText/newText + element source (Phase 4, schema-light passthrough)", () => {
    const s = new SessionStore();
    const edit: FeedbackItem = {
      id: "e1",
      kind: "text-edit",
      text: "",
      route: "/",
      element: { source: "app/pricing-card.tsx:9:7", selector: "h2", component: "PricingCard" },
      oldText: "Pro plan",
      newText: "Pro plan — EDITED FROM PARENT",
    };
    s.enqueue("a", [edit]);
    const [drained] = s.drain("a");
    expect(drained.kind).toBe("text-edit");
    expect(drained.oldText).toBe("Pro plan");
    expect(drained.newText).toBe("Pro plan — EDITED FROM PARENT");
    expect(drained.element).toEqual({
      source: "app/pricing-card.tsx:9:7",
      selector: "h2",
      component: "PricingCard",
    });
  });
});
