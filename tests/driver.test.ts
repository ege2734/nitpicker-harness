// @vitest-environment node
//
// The "always drive the agent" mechanism, tested at the two layers it lives on:
//
//   1. The sidecar's driver endpoints — a real sidecar process is booted on an ephemeral port and driven
//      over HTTP. The load-bearing guarantee: a mark queued while NO poll is connected is not lost — it
//      is reported by /pending, wakes /wait, and is delivered to the next /poll. /wait must never drain.
//   2. The Stop-hook decision core (decideStopHook) — pure logic with an injectable transport + state,
//      covering fail-open, the drain-generation loop guard, and the mid-turn re-drive path.
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  decideStopHook,
  buildReason,
  httpTransport,
  memoryHookState,
  type HookTransport,
} from "../src/hook";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");

/** Grab a free TCP port by binding to 0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as AddressInfo).port;
      s.close(() => resolve(port));
    });
    s.on("error", reject);
  });
}

/** Boot the real vendored sidecar on `port` and resolve once it announces it is listening. */
function startSidecar(port: number): Promise<ChildProcess> {
  const tsx = join(ROOT, "node_modules", "tsx", "dist", "cli.mjs");
  const server = join(ROOT, "vendor", "nitpicker", "server", "index.ts");
  const proc = spawn(process.execPath, [tsx, server], {
    env: { ...process.env, NITPICKER_PORT: String(port) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    const onData = (chunk: Buffer): void => {
      if (chunk.toString().includes("listening")) {
        proc.stdout?.off("data", onData);
        resolve(proc);
      }
    };
    proc.stdout?.on("data", onData);
    proc.on("error", reject);
    setTimeout(() => reject(new Error("sidecar did not start in time")), 15_000);
  });
}

const SESSION = "drive-test";
let sidecar: ChildProcess;
let base: string;

const feedback = (id: string): unknown => ({ session: SESSION, id, kind: "message", text: id });

async function post(path: string, body: unknown): Promise<Response> {
  return fetch(base + path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  sidecar = await startSidecar(port);
}, 20_000);

afterAll(() => {
  sidecar.kill();
});

describe("sidecar driver endpoints (durable delivery with no poll connected)", () => {
  it("a mark queued while nothing is polling is reported by /pending and delivered to the next /poll", async () => {
    // No poller is connected. Enqueue two marks.
    const enq = await post("/feedback", { session: SESSION, items: [feedback("m1"), feedback("m2")] });
    expect((await enq.json()).queued).toBe(2);

    // /pending sees them without consuming — this is the cheap signal the hook checks.
    const pending = await (await fetch(`${base}/pending?session=${SESSION}`)).json();
    expect(pending.pending).toBe(2);

    // Still there after the peek (nothing drained).
    expect((await (await fetch(`${base}/pending?session=${SESSION}`)).json()).pending).toBe(2);

    // The next poll — the FIRST poll ever connected — drains them. Nothing was lost.
    const drained = await (await fetch(`${base}/poll?session=${SESSION}&timeoutMs=2000`)).json();
    expect(drained.status).toBe("feedback");
    expect(drained.items.map((i: { id: string }) => i.id)).toEqual(["m1", "m2"]);

    // Queue is now empty; /pending confirms delivery happened exactly once.
    expect((await (await fetch(`${base}/pending?session=${SESSION}`)).json()).pending).toBe(0);
  });

  it("/wait resolves immediately when feedback is already queued, without draining it", async () => {
    await post("/feedback", feedback("w1")); // single bare item
    const waited = await (await fetch(`${base}/wait?session=${SESSION}&timeoutMs=2000`)).json();
    expect(waited.status).toBe("pending");
    expect(waited.pending).toBe(1);
    // /wait only peeks — the item is still there for a real poll to drain.
    expect((await (await fetch(`${base}/pending?session=${SESSION}`)).json()).pending).toBe(1);
    await fetch(`${base}/poll?session=${SESSION}&timeoutMs=2000`); // drain to reset
  });

  it("/wait parks with no feedback and wakes the instant a mark lands", async () => {
    const waitP = fetch(`${base}/wait?session=${SESSION}`).then((r) => r.json());
    // Give the wait a beat to park, then enqueue.
    await new Promise((r) => setTimeout(r, 150));
    await post("/feedback", feedback("late"));
    const waited = await waitP;
    expect(waited.status).toBe("pending");
    expect(waited.pending).toBe(1);
    await fetch(`${base}/poll?session=${SESSION}&timeoutMs=2000`); // drain to reset
  });

  it("/wait honours its timeout and reports nothing pending", async () => {
    const waited = await (await fetch(`${base}/wait?session=${SESSION}&timeoutMs=200`)).json();
    expect(waited.status).toBe("timeout");
    expect(waited.pending).toBe(0);
  });
});

describe("Stop-hook decision core", () => {
  // Fake transport keyed on a { pending, drains } shape. `info` returns null to model an unreachable
  // sidecar; `wait` resolves the park's outcome.
  const fake = (
    info: { pending: number; drains: number } | null,
    waitResult: { pending: number; drains: number } = info ?? { pending: 0, drains: 0 },
  ): HookTransport => ({
    info: async () => info,
    wait: async () => waitResult,
  });
  const input = { session: SESSION, endpoint: base, timeoutMs: 0 };

  it("blocks the stop (drives the agent) when feedback is waiting", async () => {
    const d = await decideStopHook(input, fake({ pending: 2, drains: 0 }), memoryHookState());
    expect(d.block).toBe(true);
    expect(d.reason).toContain("poll --session drive-test");
  });

  it("does not block when nothing is pending and the wait times out", async () => {
    const d = await decideStopHook(
      input,
      fake({ pending: 0, drains: 0 }, { pending: 0, drains: 0 }),
      memoryHookState(),
    );
    expect(d.block).toBe(false);
  });

  it("fails open: never blocks the stop when the sidecar is unreachable", async () => {
    const d = await decideStopHook(input, fake(null), memoryHookState());
    expect(d.block).toBe(false);
  });

  it("loop-guard: does not re-drive while the queue sits undrained (drain generation unchanged)", async () => {
    const state = memoryHookState();
    // First stop drives at drains=0.
    expect((await decideStopHook(input, fake({ pending: 3, drains: 0 }), state)).block).toBe(true);
    // Next stop, still undrained (drains unchanged) → the agent ignored us → suppress, no spin.
    expect((await decideStopHook(input, fake({ pending: 3, drains: 0 }), state)).block).toBe(false);
  });

  it("re-drives when a drain advanced the generation (mid-turn batch is genuinely new)", async () => {
    const state = memoryHookState();
    // Drove at drains=0…
    await decideStopHook(input, fake({ pending: 1, drains: 0 }), state);
    // …agent drained (drains→1) and a fresh mark landed → drive again, not stranded.
    const d = await decideStopHook(input, fake({ pending: 1, drains: 1 }), state);
    expect(d.block).toBe(true);
  });

  it("re-drives after a drain even from the idle park path", async () => {
    const state = memoryHookState();
    // Queue empty at entry (agent drained), but a new mark lands during the /wait park.
    const d = await decideStopHook(
      input,
      fake({ pending: 0, drains: 1 }, { pending: 1, drains: 1 }),
      state,
    );
    expect(d.block).toBe(true);
  });

  it("wires end-to-end through the real HTTP transport", async () => {
    const session = "e2e-wire";
    await post("/feedback", { session, id: "e2e", kind: "message", text: "e2e" });
    const d = await decideStopHook(
      { session, endpoint: base, timeoutMs: 0 },
      httpTransport(base),
      memoryHookState(),
    );
    expect(d.block).toBe(true);
    expect(d.reason).toContain("nitpicker feedback");
    await fetch(`${base}/poll?session=${session}&timeoutMs=2000`); // drain to reset
  });

  it("mid-turn regression: a batch that lands after the agent drains is re-driven, not stranded", async () => {
    const session = "midturn";
    const state = memoryHookState();
    // batch1 queued; the hook drives (records drive at drains=0).
    await post("/feedback", { session, id: "b1", kind: "message", text: "b1" });
    expect(
      (await decideStopHook({ session, endpoint: base, timeoutMs: 0 }, httpTransport(base), state))
        .block,
    ).toBe(true);
    // Agent drains batch1 → drains advances to 1.
    await fetch(`${base}/poll?session=${session}&timeoutMs=2000`);
    // batch2 arrives "mid-turn"; the next stop must re-drive (drains advanced), not idle.
    await post("/feedback", { session, id: "b2", kind: "message", text: "b2" });
    expect(
      (await decideStopHook({ session, endpoint: base, timeoutMs: 0 }, httpTransport(base), state))
        .block,
    ).toBe(true);
    await fetch(`${base}/poll?session=${session}&timeoutMs=2000`); // drain to reset
  });

  it("ignored-loop regression: without draining, a second stop does not re-drive (no infinite loop)", async () => {
    const session = "ignored";
    const state = memoryHookState();
    await post("/feedback", { session, id: "b1", kind: "message", text: "b1" });
    expect(
      (await decideStopHook({ session, endpoint: base, timeoutMs: 0 }, httpTransport(base), state))
        .block,
    ).toBe(true);
    // No drain happened → drains unchanged → the second stop must NOT re-drive.
    expect(
      (await decideStopHook({ session, endpoint: base, timeoutMs: 0 }, httpTransport(base), state))
        .block,
    ).toBe(false);
    await fetch(`${base}/poll?session=${session}&timeoutMs=2000`); // drain to reset
  });
});

describe("buildReason", () => {
  it("uses singular/plural and names the poll command", () => {
    expect(buildReason(1, "s")).toContain("1 nitpicker feedback item(s) is waiting");
    expect(buildReason(3, "s")).toContain("3 nitpicker feedback item(s) are waiting");
    expect(buildReason(1, "s")).toContain("poll --session s");
  });
});
