// nitpicker sidecar — blob storage. Screenshots are written to a temp dir as binary and referenced by
// id, so the poll JSON never carries a base64-inflated image. The agent reads the PNG straight off the
// returned local file path.
import { mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const ROOT = join(tmpdir(), "nitpicker-blobs");

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

export interface StoredBlob {
  id: string;
  path: string;
  mime: string;
  bytes: number;
}

/** Persist a binary blob under a random id; returns its id + absolute local path. */
export function saveBlob(data: Buffer, mime = "image/png"): StoredBlob {
  mkdirSync(ROOT, { recursive: true });
  const id = randomUUID();
  const path = join(ROOT, `${id}.${EXT[mime] ?? "bin"}`);
  writeFileSync(path, data);
  return { id, path, mime, bytes: data.byteLength };
}

/** Resolve a blob id to its stored bytes + mime, or null if unknown. Used by GET /blob/:id. */
export function readBlob(id: string): { data: Buffer; mime: string } | null {
  if (!UUID_RE.test(id)) return null;
  for (const [mime, ext] of Object.entries(EXT)) {
    const path = join(ROOT, `${id}.${ext}`);
    if (existsSync(path)) return { data: readFileSync(path), mime };
  }
  return null;
}

export function blobDir(): string {
  return ROOT;
}
