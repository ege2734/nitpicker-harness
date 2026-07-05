// `nitpicker verify [--dir <path>]` — prod-leak guard for CI/pre-release. nitpicker is a DEV-ONLY tool;
// its two primary gates (the layout `NODE_ENV !== "production"` guard + the next.config loader gating)
// are supposed to keep it out of the shipped build. This subcommand is the third belt: it scans a build
// output directory (default `.next`) for nitpicker's fingerprint and FAILS (nonzero exit) if any of it
// leaked into a shipped path — so a broken install can't sneak the overlay + html2canvas into prod
// unnoticed. It mirrors the manual checks in SKILL.md's "Prod-safety" section (grep .next/static for
// `html2canvas`, grep .next for `data-nitpicker-source`, excluding the cache and dev trees).
//
// Zero-dependency by design: node built-ins only (node:fs, node:path), run under tsx like the rest of
// the sidecar/CLI. No transitive deps means nothing extra to audit before shipping this into a repo.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, sep } from "node:path";

export interface VerifyArgs {
  dir: string;
}

// The strings that betray nitpicker in a build: the screenshot lib it pulls in, and the source-stamp
// attribute the babel loader writes onto elements. Either one in a shipped file means a prod leak.
const MARKERS = ["html2canvas", "data-nitpicker-source"] as const;

// Skip binaries and huge assets — the markers are ASCII source/HTML/JS text, never inside these.
const SKIP_EXT = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".avif",
  ".ico",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".mp4",
  ".webm",
  ".pdf",
  ".zip",
  ".gz",
  ".wasm",
]);

const MAX_BYTES = 5 * 1024 * 1024; // skip files over ~5MB — nothing text-like to scan there.

/** `cache` and `dev` subtrees legitimately retain dev-only artifacts and are NOT shipped, so they're
 *  excluded from the scan (matches SKILL.md's prod-safety grep, which greps `.next/static` and excludes
 *  `cache`/`dev`). `.next/dev/` is Turbopack's dev-server output — if a stale one is left on disk from a
 *  prior `next dev`, it legitimately contains the stamp + html2canvas and would false-FAIL the scan of an
 *  otherwise-clean prod build. Any path segment named `cache` or `dev` is treated as excluded. */
function isExcluded(relPath: string): boolean {
  const segments = relPath.split(sep);
  return segments.includes("cache") || segments.includes("dev");
}

function extname(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot).toLowerCase() : "";
}

export interface Leak {
  file: string;
  line: number;
  marker: string;
}

/** Recursively collect every leak (file:line:marker) under `root`, skipping excluded/binary/huge files. */
function scanDir(root: string, current: string, leaks: Leak[]): void {
  let entries;
  try {
    entries = readdirSync(current, { withFileTypes: true });
  } catch {
    return; // unreadable dir — nothing to scan
  }
  for (const entry of entries) {
    const full = join(current, entry.name);
    const rel = full.slice(root.length + 1); // path relative to the scanned root
    if (isExcluded(rel)) continue;
    if (entry.isDirectory()) {
      scanDir(root, full, leaks);
      continue;
    }
    if (!entry.isFile()) continue;
    if (SKIP_EXT.has(extname(entry.name))) continue;
    // Skip sourcemaps. A `.map` embeds the ORIGINAL source text (`sourcesContent`), which legitimately
    // contains the marker strings as identifiers/comments (e.g. core/region.ts imports "html2canvas",
    // react-source.ts defines "data-nitpicker-source"). Sourcemaps are debug artifacts, not shipped
    // executable code — the actual leak surface is the emitted JS/HTML/CSS. Scanning `.map` files would
    // false-positive on every correct install (the emitted `.js` is tree-shaken clean while its map still
    // carries the original source). Matches SKILL.md's own `grep .next/static` intent.
    if (entry.name.endsWith(".map")) continue;
    let size = 0;
    try {
      size = statSync(full).size;
    } catch {
      continue;
    }
    if (size > MAX_BYTES) continue;
    scanFile(full, leaks);
  }
}

function scanFile(file: string, leaks: Leak[]): void {
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return; // unreadable/binary decode failure — skip
  }
  // Cheap pre-filter: only split into lines if a marker is present at all.
  if (!MARKERS.some((m) => text.includes(m))) return;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const marker of MARKERS) {
      if (lines[i].includes(marker)) leaks.push({ file, line: i + 1, marker });
    }
  }
}

/** Scan `args.dir` for nitpicker leakage markers. Prints offenders and returns an exit code
 *  (0 = clean, 1 = leak found or dir missing). Kept as a return value (not process.exit) so it's unit-
 *  testable; the bin wrapper turns a nonzero return into a process exit. */
export function runVerify(args: VerifyArgs): number {
  const root = args.dir;
  let rootIsDir = false;
  try {
    rootIsDir = statSync(root).isDirectory();
  } catch {
    rootIsDir = false;
  }
  if (!rootIsDir) {
    process.stderr.write(
      `nitpicker verify: build directory not found: ${root}\n` +
        `  (run your production build first, or pass --dir <path>)\n`,
    );
    return 1;
  }

  const leaks: Leak[] = [];
  scanDir(root, root, leaks);

  if (leaks.length > 0) {
    process.stderr.write(
      `nitpicker verify: FAIL — dev-only nitpicker artifacts leaked into ${root} ` +
        `(${leaks.length} occurrence(s)). This must never ship to production:\n`,
    );
    for (const leak of leaks) {
      process.stderr.write(`  ${leak.file}:${leak.line}  ${leak.marker}\n`);
    }
    process.stderr.write(
      `\nCheck that <NitpickerOverlay/> is gated behind NODE_ENV !== "production" and the next.config ` +
        `loader wiring is dev-only (see SKILL.md "Prod-safety").\n`,
    );
    return 1;
  }

  process.stdout.write(`nitpicker verify: OK — no nitpicker leakage found in ${root}.\n`);
  return 0;
}
