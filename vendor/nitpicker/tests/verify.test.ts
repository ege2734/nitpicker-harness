// nitpicker — `nitpicker verify` leak-scanner contract. The guardrail must catch an overlay leak in an
// EXECUTABLE build artifact while ignoring the two false-positive surfaces: sourcemaps (`.map` files
// embed the original source text, which legitimately contains the marker strings) and the excluded
// `cache` tree. Getting this wrong makes the guardrail cry wolf on every correct install, so pin it.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { runVerify } from "../cli/verify";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nitpicker-verify-"));
  // Silence the command's own stdout/stderr reporting during the run.
  vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(root, { recursive: true, force: true });
});

function write(rel: string, contents: string): void {
  const full = join(root, rel);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, contents);
}

describe("nitpicker verify leak-scan", () => {
  it("passes (0) on a clean build dir", () => {
    write("static/chunks/app.js", "export const x = 1;\n");
    expect(runVerify({ dir: root })).toBe(0);
  });

  it("fails (1) when html2canvas leaks into an executable client chunk", () => {
    write("static/chunks/app.js", 'import h from "html2canvas";\n');
    expect(runVerify({ dir: root })).toBe(1);
  });

  it("fails (1) when the data-nitpicker-source stamp leaks into emitted HTML", () => {
    write("server/app/page.html", '<div data-nitpicker-source="app/page.tsx:1:1">x</div>');
    expect(runVerify({ dir: root })).toBe(1);
  });

  it("ignores sourcemaps — they embed original source text (false positive)", () => {
    write("server/chunks/ssr/root.js.map", '{"sourcesContent":["import \\"html2canvas\\";"]}');
    expect(runVerify({ dir: root })).toBe(0);
  });

  it("ignores the cache tree — dev artifacts, never shipped", () => {
    write("cache/webpack/leak.js", 'import "html2canvas"; // data-nitpicker-source');
    expect(runVerify({ dir: root })).toBe(0);
  });

  it("ignores the dev tree — stale next-dev output, never shipped", () => {
    write("dev/chunks/page.js", 'import "html2canvas"; // data-nitpicker-source');
    expect(runVerify({ dir: root })).toBe(0);
  });

  it("fails (1) when the build directory does not exist", () => {
    expect(runVerify({ dir: join(root, "does-not-exist") })).toBe(1);
  });
});
