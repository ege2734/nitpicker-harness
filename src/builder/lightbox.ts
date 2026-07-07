// nitpicker-harness — full-screen lightbox for a queued region mark's red-boxed screenshot (builder pane).
// An expanded queued mark shows a small preview; clicking it opens the FULL-resolution capture (`_blob`,
// falling back to the `_thumb` data URL) centered over a dim backdrop. Esc or a backdrop click closes; the
// full-size object URL is revoked on close so it never leaks. Single-instance (opening one closes any prior).
// Self-contained inline styles; unit-tested in tests/lightbox.test.ts.
import type { QueueItem } from "../../vendor/nitpicker/core/types";

let currentClose: (() => void) | null = null;

/** Open the region screenshot full-screen. No-op when the mark carries no image yet (still capturing). */
export function openRegionLightbox(item: QueueItem): void {
  const blobUrl = item._blob ? tryObjectURL(item._blob) : null;
  const src = blobUrl ?? item._thumb ?? null;
  if (!src) return;
  closeLightbox(); // never stack two

  const back = document.createElement("div");
  back.className = "nh-lightbox";
  back.style.cssText =
    "position:fixed;inset:0;z-index:2147483002;display:flex;align-items:center;justify-content:center;" +
    "padding:24px;box-sizing:border-box;background:rgba(0,0,0,.8);cursor:zoom-out;";

  const img = document.createElement("img");
  img.className = "nh-lightbox-img";
  img.src = src;
  img.alt = "region screenshot";
  img.style.cssText =
    "max-width:100%;max-height:100%;border-radius:6px;box-shadow:0 8px 40px rgba(0,0,0,.6);cursor:default;";
  // Clicking the image itself must NOT close — only the backdrop (or Esc) does.
  img.addEventListener("click", (e) => e.stopPropagation());
  back.appendChild(img);

  const done = (): void => {
    back.remove();
    document.removeEventListener("keydown", onKey, true);
    if (blobUrl) URL.revokeObjectURL(blobUrl);
    if (currentClose === done) currentClose = null;
  };
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      done();
    }
  };
  back.addEventListener("click", done);
  document.addEventListener("keydown", onKey, true);
  document.body.appendChild(back);
  currentClose = done;
}

/** Close any open lightbox (used before opening another; exported for teardown/tests). */
export function closeLightbox(): void {
  if (currentClose) currentClose();
}

function tryObjectURL(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
