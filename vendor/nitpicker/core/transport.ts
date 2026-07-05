// @nitpicker/core — transport client to the dev-only sidecar. Uploads region PNGs as binary blobs FIRST
// (so the poll JSON never carries base64), then POSTs the whole queue in one batch.
import { serializeItem, type QueueItem } from "./types";

export class Transport {
  constructor(
    private readonly session: string,
    private readonly endpoint: string,
  ) {}

  /** Upload one binary blob; the sidecar writes it to a temp file and returns a local path. */
  private async uploadBlob(blob: Blob): Promise<{ id: string; path: string; url: string }> {
    const res = await fetch(`${this.endpoint}/blob`, {
      method: "POST",
      headers: { "X-Nitpicker-Mime": blob.type || "image/png" },
      body: blob,
    });
    if (!res.ok) throw new Error(`nitpicker: blob upload failed (${res.status})`);
    return res.json();
  }

  /** Send the entire queue as one batch. Region blobs are uploaded first and their refs inlined. */
  async sendBatch(items: QueueItem[]): Promise<void> {
    const wire = await Promise.all(
      items.map(async (item) => {
        const serialized = serializeItem(item);
        if (item.kind === "region" && item._blob && serialized.image) {
          const up = await this.uploadBlob(item._blob);
          serialized.image = { ...serialized.image, ref: up.id, path: up.path, url: up.url };
        }
        return serialized;
      }),
    );
    const res = await fetch(`${this.endpoint}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: this.session, items: wire }),
    });
    if (!res.ok) throw new Error(`nitpicker: feedback send failed (${res.status})`);
  }

  async health(): Promise<boolean> {
    try {
      const res = await fetch(`${this.endpoint}/health`);
      return res.ok;
    } catch {
      return false;
    }
  }
}
