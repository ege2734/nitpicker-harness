// @vitest-environment node
//
// AppRuntime (embedded mode's dev-server owner): dev-command detection precedence + a real spawn/ready/stop
// cycle against a trivial server driven as an explicit --dev-cmd.
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectDevCommand, LocalAppRuntime, type AppRuntimeStatus } from "../src/app/runtime";

const dirs: string[] = [];
function appDir(pkg: Record<string, unknown> | null): string {
  const dir = mkdtempSync(join(tmpdir(), "nh-runtime-"));
  dirs.push(dir);
  if (pkg) writeFileSync(join(dir, "package.json"), JSON.stringify(pkg));
  return dir;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("detectDevCommand", () => {
  it("prefers an explicit override (string, whitespace-split — covers non-Node stacks)", () => {
    expect(detectDevCommand(appDir(null), "uvicorn app:app --reload")).toEqual({
      cmd: "uvicorn",
      args: ["app:app", "--reload"],
      source: "explicit",
    });
  });

  it("takes an explicit array verbatim (no shell-splitting)", () => {
    expect(detectDevCommand(appDir(null), ["node", "-e", "listen(1)"])).toEqual({
      cmd: "node",
      args: ["-e", "listen(1)"],
      source: "explicit",
    });
  });

  it("maps next → `next dev`", () => {
    expect(detectDevCommand(appDir({ dependencies: { next: "16.0.0" } }))).toEqual({
      cmd: "next",
      args: ["dev"],
      source: "next",
    });
  });

  it("maps vite → `vite` (devDependency counts)", () => {
    expect(detectDevCommand(appDir({ devDependencies: { vite: "5.0.0" } }))).toEqual({
      cmd: "vite",
      args: [],
      source: "vite",
    });
  });

  it("maps react-scripts → `react-scripts start`", () => {
    expect(detectDevCommand(appDir({ dependencies: { "react-scripts": "5.0.0" } }))).toEqual({
      cmd: "react-scripts",
      args: ["start"],
      source: "react-scripts",
    });
  });

  it("falls back to `npm run dev` when only a dev script exists", () => {
    expect(detectDevCommand(appDir({ scripts: { dev: "node server.js" } }))).toEqual({
      cmd: "npm",
      args: ["run", "dev"],
      source: "scripts.dev",
    });
  });

  it("prefers a framework dep over the dev script", () => {
    const dir = appDir({ dependencies: { next: "16" }, scripts: { dev: "vite" } });
    expect(detectDevCommand(dir).source).toBe("next");
  });

  it("throws with a helpful message when nothing is detectable", () => {
    expect(() => detectDevCommand(appDir({ dependencies: { react: "19" } }))).toThrow(/could not detect/);
    expect(() => detectDevCommand(appDir(null))).toThrow(/no package.json/);
  });
});

describe("LocalAppRuntime lifecycle", () => {
  it("spawns the dev command, resolves once it answers, then stops cleanly", async () => {
    const dir = appDir(null);
    const script =
      "require('http').createServer((_,res)=>res.end('ok')).listen(process.env.PORT,'127.0.0.1')";
    const statuses: AppRuntimeStatus[] = [];
    const rt = new LocalAppRuntime({
      appDir: dir,
      devCommand: ["node", "-e", script],
      readyTimeoutMs: 10_000,
    });
    rt.onStatus((s) => statuses.push(s));

    const { targetUrl } = await rt.start();
    expect(targetUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(statuses).toContain("starting");
    expect(statuses).toContain("ready");

    // It really answers.
    const res = await fetch(targetUrl);
    expect(await res.text()).toBe("ok");

    await rt.stop();
    expect(statuses[statuses.length - 1]).toBe("stopped");
  }, 15_000);

  it("rejects when the dev command exits before becoming ready", async () => {
    const dir = appDir(null);
    const rt = new LocalAppRuntime({
      appDir: dir,
      devCommand: ["node", "-e", "process.exit(1)"],
      readyTimeoutMs: 5_000,
    });
    await expect(rt.start()).rejects.toThrow(/exited before it was ready/);
  }, 10_000);

  it("stop() reaps a grandchild dev server (process-group kill), freeing the port", async () => {
    const dir = appDir(null);
    // Mirror the `npm run dev` shape: a parent that FORKS the real server as a grandchild and does NOT
    // forward SIGTERM (it ignores it). Killing only the immediate child would leak the grandchild and hold
    // the port; the group kill + SIGKILL escalation must reap both.
    const parent =
      "const cp=require('child_process');" +
      "cp.spawn(process.execPath,['-e'," +
      "`require('http').createServer((_,r)=>r.end('ok')).listen(${process.env.PORT},'127.0.0.1')`]," +
      "{stdio:'ignore'});" +
      "process.on('SIGTERM',()=>{});setInterval(()=>{},1000);";
    const rt = new LocalAppRuntime({
      appDir: dir,
      devCommand: ["node", "-e", parent],
      readyTimeoutMs: 10_000,
    });
    const { targetUrl } = await rt.start();
    const port = Number(new URL(targetUrl).port);
    expect((await (await fetch(targetUrl)).text())).toBe("ok");

    await rt.stop();

    // The grandchild must be gone: the port is bindable again.
    const { createServer } = await import("node:net");
    await new Promise<void>((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(port, "127.0.0.1", () => s.close(() => resolve()));
    });
  }, 20_000);
});
