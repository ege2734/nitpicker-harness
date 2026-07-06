// `nitpicker poll --session <id>` — the agent's long-poll client.
//
// Runs the long-poll, waits (indefinitely by default) for the next drained batch, prints it, and
// exits. The AI session runs this as a background task; on return it gets text + a local image path +
// element info and acts. If killed before a batch arrives, the sidecar keeps the queue — just re-run.
// Pass --watch to loop and keep receiving batches.
import { get } from "node:http";

export interface PollArgs {
  session: string;
  endpoint: string;
  timeoutMs: number;
  watch: boolean;
}

interface FeedbackItem {
  id: string;
  kind: string;
  text?: string;
  route?: string;
  pageUrl?: string;
  image?: { path?: string; url?: string; hasRedBox?: boolean };
  element?: Record<string, unknown>;
  /** text-edit only (builder-shell Phase 4): the visible text before/after an inline edit. */
  oldText?: string;
  newText?: string;
}

interface PollResult {
  status: string;
  items: FeedbackItem[];
}

function pollOnce(args: PollArgs): Promise<PollResult> {
  const u = new URL("/poll", args.endpoint);
  u.searchParams.set("session", args.session);
  if (args.timeoutMs > 0) u.searchParams.set("timeoutMs", String(args.timeoutMs));
  return new Promise((resolve, reject) => {
    const req = get(u, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk) => {
        body += chunk; // heartbeats are leading whitespace; JSON.parse ignores them
      });
      res.on("end", () => {
        const trimmed = body.trim();
        if (!trimmed) return resolve({ status: "timeout", items: [] });
        try {
          resolve(JSON.parse(trimmed) as PollResult);
        } catch (err) {
          reject(new Error(`bad poll response: ${(err as Error).message}`));
        }
      });
    });
    req.on("error", reject);
  });
}

function printBatch(result: PollResult): void {
  const { items } = result;
  process.stdout.write(`\n=== nitpicker: ${items.length} feedback item(s) ===\n`);
  items.forEach((item, i) => {
    process.stdout.write(`\n[${i + 1}] ${item.kind}${item.route ? `  route=${item.route}` : ""}\n`);
    if (item.text) process.stdout.write(`    text: ${item.text}\n`);
    if (item.image?.path) {
      process.stdout.write(
        `    image: ${item.image.path}${item.image.hasRedBox ? "  (red box)" : ""}\n`,
      );
    }
    if (item.kind === "text-edit") {
      // The agent's job is to patch the string in source. Surface the build-stamped `file:line:col` first
      // (owned-build opt-in — most directly greppable), then the old→new diff and the selector fallback.
      const el = item.element ?? {};
      const source = el.source as string | undefined;
      const selector = el.selector as string | undefined;
      const component = el.component as string | undefined;
      if (source) process.stdout.write(`    source: ${source}\n`);
      process.stdout.write(
        `    edit: ${JSON.stringify(item.oldText ?? "")} → ${JSON.stringify(item.newText ?? "")}\n`,
      );
      if (component) process.stdout.write(`    component: ${component}\n`);
      if (selector) process.stdout.write(`    selector: ${selector}\n`);
    } else if (item.element) {
      process.stdout.write(`    element: ${JSON.stringify(item.element)}\n`);
    }
  });
  process.stdout.write(`\n--- raw JSON ---\n${JSON.stringify(result, null, 2)}\n`);
}

export async function runPoll(args: PollArgs): Promise<void> {
  do {
    const result = await pollOnce(args);
    if (result.items.length > 0) printBatch(result);
    else if (!args.watch) process.stdout.write("nitpicker: no feedback (timeout)\n");
  } while (args.watch);
}
