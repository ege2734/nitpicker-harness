// nitpicker-harness — the app dev-server lifecycle for EMBEDDED mode (hz-agent §2.3). `nitpicker-harness
// <path-to-app>` OWNS the app's dev server: this module spawns it, waits until it answers HTTP, and surfaces
// crashes. The dev server lives behind an interface (`AppRuntime`), not a bare `spawn`, so a later Fleet
// container ("the dev server is already running; just resolve the URL") slots in with no contract change —
// the LocalRuntime/FleetRuntime seam (loom-decision D6).
//
// The interface shapes mirror `@loom/contracts` (`AppRuntime`, `AppRuntimeStatus`, `LocalAppRuntimeOptions`)
// so Loom consumes this without redeclaring the contract. NOTE the deliberate two-level naming: `AppRuntime`
// here is the IN-CONTAINER dev-server lifecycle; the platform ORCHESTRATOR (provision/reclaim the container)
// is a separate Python `Runtime` in Loom's control plane. Keep the names distinct.
import { spawn, type ChildProcess } from "node:child_process";
import { get } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type AppRuntimeStatus = "starting" | "ready" | "crashed" | "stopped";

export interface AppRuntime {
  /** Bring the app's dev server up; resolve once it answers HTTP. Returns the origin to proxy. */
  start(): Promise<{ targetUrl: string }>;
  stop(): Promise<void>;
  /** Live status for the pane's "server" indicator + crash surfacing. Returns an unsubscribe fn. */
  onStatus(cb: (s: AppRuntimeStatus) => void): () => void;
}

export interface LocalAppRuntimeOptions {
  /** App working directory (the repo the agent edits). Accepts the `appPath` alias for hz-agent parity. */
  appDir: string;
  /** Explicit dev command; when omitted it is detected from package.json. A `string[]` gives exact argv
   *  (no shell-splitting); a `string` is whitespace-split (covers `uvicorn --reload`, etc.). */
  devCommand?: string | string[];
  /** Preferred port; injected as `PORT` and used for the readiness probe. Allocated free if omitted. */
  port?: number;
  /** Extra env for the dev server. */
  env?: Record<string, string>;
  /** How long to wait for the server to answer before giving up (ms; default 60s). */
  readyTimeoutMs?: number;
  /** Log sink for the dev server's stdout/stderr (surfaced to the pane, not swallowed). */
  log?: (m: string) => void;
}

export type DevCommandSource = "explicit" | "next" | "vite" | "react-scripts" | "scripts.dev";

export interface DevCommand {
  cmd: string;
  args: string[];
  source: DevCommandSource;
}

/**
 * Detect the dev command for an app directory (hz-agent §2.3):
 *   explicit override wins → `next` dep → `vite` dep → `react-scripts` dep → `scripts.dev` → throw.
 * Returns the base command; the runtime injects the port per framework. Explicit commands are passed
 * through verbatim so non-Node stacks work (e.g. `uvicorn app:app --reload`).
 */
export function detectDevCommand(appDir: string, explicit?: string | string[]): DevCommand {
  if (explicit !== undefined) {
    const [cmd, ...args] = Array.isArray(explicit) ? explicit : explicit.trim().split(/\s+/);
    if (!cmd) throw new Error("nitpicker-harness: --dev-cmd is empty");
    return { cmd, args, source: "explicit" };
  }
  const pkg = readPackageJson(appDir);
  if (!pkg) {
    throw new Error(
      `nitpicker-harness: no package.json in ${appDir} and no --dev-cmd given. ` +
        `Pass --dev-cmd "<command>" for non-Node apps (e.g. "uvicorn app:app --reload").`,
    );
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  if (deps.next) return { cmd: "next", args: ["dev"], source: "next" };
  if (deps.vite) return { cmd: "vite", args: [], source: "vite" };
  if (deps["react-scripts"]) return { cmd: "react-scripts", args: ["start"], source: "react-scripts" };
  if (pkg.scripts?.dev) return { cmd: "npm", args: ["run", "dev"], source: "scripts.dev" };
  throw new Error(
    `nitpicker-harness: could not detect a dev command in ${appDir} ` +
      `(no next/vite/react-scripts dep and no "dev" script). Pass --dev-cmd explicitly.`,
  );
}

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  scripts?: Record<string, string>;
}

function readPackageJson(appDir: string): PackageJson | null {
  const p = join(appDir, "package.json");
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, "utf8")) as PackageJson;
  } catch {
    return null;
  }
}

/** v0 process-group dev-server owner: detect → spawn → poll readiness → surface crashes (loom-decision D6). */
export class LocalAppRuntime implements AppRuntime {
  private child: ChildProcess | null = null;
  private status: AppRuntimeStatus = "stopped";
  private readonly listeners = new Set<(s: AppRuntimeStatus) => void>();
  private port: number | null = null;
  private readonly appDir: string;

  constructor(private readonly opts: LocalAppRuntimeOptions) {
    this.appDir = opts.appDir;
  }

  onStatus(cb: (s: AppRuntimeStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  async start(): Promise<{ targetUrl: string }> {
    if (this.child) throw new Error("nitpicker-harness: runtime already started");
    const dev = detectDevCommand(this.appDir, this.opts.devCommand);
    const port = this.opts.port ?? (await freePort());
    this.port = port;
    const args = withPortArgs(dev, port);
    const env = {
      ...process.env,
      PORT: String(port),
      BROWSER: "none", // stop CRA/next from opening a browser tab in the sandbox
      ...this.opts.env,
    };
    const log = this.opts.log ?? (() => {});
    this.setStatus("starting");

    // shell:false; resolve framework bins from the app's own node_modules/.bin first (matches how a dev
    // would run them), falling back to PATH so `npm`/`uvicorn`/etc. still resolve.
    const cmd = resolveBin(this.appDir, dev.cmd);
    const child = spawn(cmd, args, { cwd: this.appDir, env });
    this.child = child;
    child.stdout?.on("data", (d: Buffer) => log(d.toString()));
    child.stderr?.on("data", (d: Buffer) => log(d.toString()));

    let exited = false;
    child.on("exit", (code) => {
      exited = true;
      this.child = null;
      // A dev server exiting is abnormal (HMR is the normal path) — surface it so the pane can offer restart.
      this.setStatus(code && code !== 0 ? "crashed" : "stopped");
    });
    child.on("error", (err) => {
      exited = true;
      this.child = null;
      log(`spawn error: ${err.message}`);
      this.setStatus("crashed");
    });

    const targetUrl = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + (this.opts.readyTimeoutMs ?? 60_000);
    // Poll the port until the dev server answers (any HTTP response counts — a 404 still means "listening").
    while (Date.now() < deadline) {
      if (exited) {
        throw new Error(
          `nitpicker-harness: dev server exited before it was ready (command: ${cmd} ${args.join(" ")})`,
        );
      }
      if (await probe(targetUrl)) {
        this.setStatus("ready");
        return { targetUrl };
      }
      await delay(200);
    }
    await this.stop();
    throw new Error(
      `nitpicker-harness: dev server did not answer on ${targetUrl} within ` +
        `${this.opts.readyTimeoutMs ?? 60_000}ms (command: ${cmd} ${args.join(" ")})`,
    );
  }

  async stop(): Promise<void> {
    const child = this.child;
    this.child = null;
    if (!child) {
      this.setStatus("stopped");
      return;
    }
    await new Promise<void>((resolve) => {
      let exited = false;
      const done = (): void => resolve();
      child.once("exit", () => {
        exited = true;
        done();
      });
      child.kill("SIGTERM");
      // Escalate if it ignores SIGTERM (dev servers with child workers sometimes do). `child.killed` only
      // means "a signal was sent", so gate on the real exit tracked by the 'exit' handler above.
      setTimeout(() => {
        if (!exited) child.kill("SIGKILL");
        done();
      }, 3000);
    });
    this.setStatus("stopped");
  }

  /** The port the dev server was told to use (null before start). */
  get boundPort(): number | null {
    return this.port;
  }

  private setStatus(s: AppRuntimeStatus): void {
    if (s === this.status) return;
    this.status = s;
    for (const cb of this.listeners) cb(s);
  }
}

/** Inject the port per framework. `next dev` / react-scripts honor `PORT`, but vite needs an explicit flag
 *  (and `--strictPort` so it fails loudly instead of drifting to another port the proxy wouldn't find). */
function withPortArgs(dev: DevCommand, port: number): string[] {
  if (dev.source === "vite") return [...dev.args, "--port", String(port), "--strictPort"];
  if (dev.source === "next") return [...dev.args, "-p", String(port)];
  return dev.args;
}

/** Prefer the app's local `node_modules/.bin/<cmd>` (how a dev runs framework binaries), else PATH. */
function resolveBin(appDir: string, cmd: string): string {
  if (cmd.includes("/")) return cmd; // already a path
  const local = join(appDir, "node_modules", ".bin", cmd);
  return existsSync(local) ? local : cmd;
}

/** True once the URL answers with any HTTP status (listening); false while the connection is refused. */
function probe(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const req = get(url, (res) => {
      res.resume();
      resolve(true);
    });
    req.on("error", () => resolve(false));
    req.setTimeout(1500, () => {
      req.destroy();
      resolve(false);
    });
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Grab a free TCP port by binding to 0 and reading it back. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    // Lazy import to keep node:net out of the module's static surface (only needed when auto-allocating).
    import("node:net")
      .then(({ createServer }) => {
        const s = createServer();
        s.on("error", reject);
        s.listen(0, "127.0.0.1", () => {
          const addr = s.address();
          const port = typeof addr === "object" && addr ? addr.port : 0;
          s.close(() => resolve(port));
        });
      })
      .catch(reject);
  });
}
