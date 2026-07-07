// nitpicker-harness — the builder pane's queued-mark UI, PORTED from the classic prior art so the builder is
// at parity with the injected overlay / shell instead of the minimal chip bar it shipped with:
//   • the per-kind mark row (region / element / text-edit, source chip, note preview, remove) mirrors
//     ShellChrome.render() (src/shell/entry.ts);
//   • the EXPANDABLE detail — the red-boxed region SCREENSHOT (full-res _blob object URL → _thumb data URL →
//     "capturing…/failed" placeholder) and the element/text-edit descriptor lines — is ported from the
//     overlay's item modal (vendor/nitpicker/core/overlay.ts openItemModal + fillRegionBody).
// It stays SINK-AGNOSTIC: it only builds DOM + calls back on remove / note-edit. The builder attaches these
// marks (+ notes) to the live agent turn over the Agent Gateway — the queue/annotation UI is what's ported,
// NOT the sidecar/poll destination. Self-contained inline styles (dark builder chrome); unit-tested in
// tests/queue.test.ts.
import type { QueueItem } from "../../vendor/nitpicker/core/types";

export interface QueueItemHandlers {
  /** Remove the mark from the queue (the classic modal's Remove). */
  onRemove: (id: string) => void;
  /** Toggle the expanded detail for this item (single-open, tracked by the host). */
  onToggle: (id: string) => void;
  /** Live note edit from the expanded detail's textarea (supersedes the classic Save button). */
  onNoteChange: (id: string, note: string) => void;
}

/** Short kind chip label — region reflects capture state (…/✓/✕). Mirrors ShellChrome + the overlay dock. */
export function kindLabel(item: QueueItem): string {
  switch (item.kind) {
    case "region":
      return item._error ? "region ✕" : item._blob || item._thumb ? "region ✓" : "region · capturing…";
    case "element":
      return item.element?.component ? `⬡ ${item.element.component}` : item.element?.selector ?? "element";
    case "text-edit":
      return "✎ edit";
    default:
      return "message";
  }
}

/** The element-descriptor lines shown in an expanded element/text-edit item (ported verbatim from the
 *  overlay item modal's element branch). */
export function descriptorLines(item: QueueItem): string[] {
  const d = item.element;
  if (!d) return [];
  return [
    d.component && `component: ${d.component}`,
    d.source && `source: ${d.source}`,
    d.selector && `selector: ${d.selector}`,
    d.testid && `testid: ${d.testid}`,
    d.tag && `tag: ${d.tag}`,
  ].filter(Boolean) as string[];
}

const MONO = "ui-monospace,SFMono-Regular,Menlo,monospace";

/** Build one expandable queued-mark row for the builder pane. `expanded` opens its detail panel. */
export function buildQueueItem(
  item: QueueItem,
  handlers: QueueItemHandlers,
  expanded: boolean,
): HTMLElement {
  const row = document.createElement("div");
  row.className = "nh-item";
  row.dataset.id = item.id;
  row.style.cssText =
    "border:1px solid #262b33;border-radius:8px;background:#1a1e24;overflow:hidden;";

  // ---- header (click toggles the detail) ----
  const head = document.createElement("div");
  head.className = "nh-item-head";
  head.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:7px 8px 7px 10px;cursor:pointer;";
  head.addEventListener("click", () => handlers.onToggle(item.id));

  const caret = document.createElement("span");
  caret.textContent = expanded ? "▾" : "▸";
  caret.style.cssText = "color:#6b727c;font-size:10px;flex:0 0 auto;";
  head.appendChild(caret);

  const kind = document.createElement("span");
  kind.className = "nh-item-kind";
  kind.textContent = kindLabel(item);
  kind.style.cssText = "flex:0 0 auto;color:#c7cdd6;font-size:12px;";
  head.appendChild(kind);

  const src = item.element?.source;
  if (src) {
    const s = document.createElement("span");
    s.className = "nh-item-source";
    s.textContent = src;
    s.style.cssText = `flex:0 1 auto;font-family:${MONO};color:#8a93a0;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;`;
    head.appendChild(s);
  }

  const note = document.createElement("span");
  note.className = "nh-item-note";
  note.textContent = item.text || "(no note)";
  note.style.cssText =
    "flex:1 1 auto;min-width:0;color:" +
    (item.text ? "#e6e8eb" : "#6b727c") +
    ";font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" +
    (item.text ? "" : "font-style:italic;");
  head.appendChild(note);

  const del = document.createElement("button");
  del.className = "nh-del";
  del.type = "button";
  del.setAttribute("aria-label", "Remove mark");
  del.textContent = "×";
  del.style.cssText =
    "flex:0 0 auto;border:0;background:transparent;color:#6b727c;cursor:pointer;font-size:15px;line-height:1;padding:0 2px;";
  del.addEventListener("click", (e) => {
    e.stopPropagation();
    handlers.onRemove(item.id);
  });
  head.appendChild(del);
  row.appendChild(head);

  if (!expanded) return row;

  // ---- expanded detail (screenshot / descriptor + editable note + route) ----
  const detail = document.createElement("div");
  detail.className = "nh-item-detail";
  detail.style.cssText =
    "display:flex;flex-direction:column;gap:8px;padding:2px 10px 10px 10px;border-top:1px solid #262b33;";

  if (item.kind === "region") {
    detail.appendChild(regionPreview(item));
  } else if (item.kind === "element") {
    detail.appendChild(descBlock(descriptorLines(item).join("\n") || "(element)"));
  } else if (item.kind === "text-edit") {
    const diff = document.createElement("div");
    diff.className = "nh-item-edit";
    diff.textContent = `“${item.oldText ?? ""}” → “${item.newText ?? ""}”`;
    diff.style.cssText = "color:#c7cdd6;font-size:12px;word-break:break-word;";
    detail.appendChild(diff);
    const lines = descriptorLines(item);
    if (lines.length) detail.appendChild(descBlock(lines.join("\n")));
  }

  const ta = document.createElement("textarea");
  ta.className = "nh-item-noteedit";
  ta.placeholder = "Note for the agent… (optional)";
  ta.value = item.text ?? "";
  ta.rows = 2;
  ta.style.cssText =
    "resize:none;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #2b313a;background:#0e1114;color:#e6e8eb;font:inherit;font-size:12px;";
  ta.addEventListener("input", () => handlers.onNoteChange(item.id, ta.value));
  // Don't let a click inside the textarea bubble to the header toggle.
  ta.addEventListener("click", (e) => e.stopPropagation());
  detail.appendChild(ta);

  if (item.route) {
    const route = document.createElement("span");
    route.className = "nh-item-route";
    route.textContent = item.route;
    route.style.cssText = "font-size:10px;color:#6b727c;";
    detail.appendChild(route);
  }

  row.appendChild(detail);
  return row;
}

/** The red-boxed region screenshot (full-res blob → thumbnail → placeholder). Ported from fillRegionBody. */
function regionPreview(item: QueueItem): HTMLElement {
  const src = (item._blob && tryObjectURL(item._blob)) || item._thumb || null;
  if (src) {
    const img = document.createElement("img");
    img.className = "nh-item-img";
    img.src = src;
    img.alt = "region screenshot";
    img.style.cssText =
      "display:block;max-width:100%;border-radius:6px;border:1px solid #2b313a;background:#0e1114;";
    return img;
  }
  const ph = document.createElement("div");
  ph.className = "nh-item-note";
  ph.textContent = item._error ? "Screenshot capture failed." : "Capturing screenshot…";
  ph.style.cssText = "color:#8b929c;font-size:11px;font-style:italic;";
  return ph;
}

function descBlock(text: string): HTMLElement {
  const pre = document.createElement("div");
  pre.className = "nh-item-desc";
  pre.textContent = text;
  pre.style.cssText = `font-family:${MONO};font-size:11px;color:#c7cdd6;white-space:pre-wrap;word-break:break-word;`;
  return pre;
}

/** Best-effort object URL for the full-res blob; null in jsdom / when unavailable (falls back to _thumb). */
function tryObjectURL(blob: Blob): string | null {
  try {
    return URL.createObjectURL(blob);
  } catch {
    return null;
  }
}
