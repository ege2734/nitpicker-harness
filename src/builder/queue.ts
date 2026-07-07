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
import { openRegionLightbox } from "./lightbox";

export interface QueueItemHandlers {
  /** Remove the mark from the queue (the classic modal's Remove). */
  onRemove: (id: string) => void;
  /** Toggle the expanded detail for this item (single-open, tracked by the host). */
  onToggle: (id: string) => void;
  /** Save an edited note back onto the queued item (Enter-to-save in the expanded textarea, mirroring the
   *  classic overlay item modal's Save). Not fired on Esc (cancel) — the prior note is kept. */
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

export interface QueueItemOptions {
  /** Read-only rendering for a SENT-turn history entry: no remove button, no header toggle, and the note is
   *  shown as static text instead of an editable textarea. The region screenshot + click-to-lightbox and the
   *  element/edit descriptor stay. */
  readonly?: boolean;
}

/** Build one expandable queued-mark row for the builder pane. `expanded` opens its detail panel. */
export function buildQueueItem(
  item: QueueItem,
  handlers: QueueItemHandlers,
  expanded: boolean,
  opts?: QueueItemOptions,
): HTMLElement {
  const readonly = opts?.readonly === true;
  const row = document.createElement("div");
  row.className = "nh-item";
  row.dataset.id = item.id;
  row.style.cssText =
    "border:1px solid #262b33;border-radius:8px;background:#1a1e24;overflow:hidden;";

  // ---- header (click toggles the detail; static in read-only history) ----
  const head = document.createElement("div");
  head.className = "nh-item-head";
  head.style.cssText =
    "display:flex;align-items:center;gap:8px;padding:7px 8px 7px 10px;" + (readonly ? "" : "cursor:pointer;");
  if (!readonly) head.addEventListener("click", () => handlers.onToggle(item.id));

  if (!readonly) {
    const caret = document.createElement("span");
    caret.textContent = expanded ? "▾" : "▸";
    caret.style.cssText = "color:#6b727c;font-size:10px;flex:0 0 auto;";
    head.appendChild(caret);
  }

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

  if (!readonly) {
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
  }
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

  if (readonly) {
    // History: the note is already sent — show it statically (only when present).
    if (item.text) {
      const noteBlock = document.createElement("div");
      noteBlock.className = "nh-item-noteview";
      noteBlock.textContent = item.text;
      noteBlock.style.cssText = "color:#e6e8eb;font-size:12px;white-space:pre-wrap;word-break:break-word;";
      detail.appendChild(noteBlock);
    }
  } else {
    const ta = document.createElement("textarea");
    ta.className = "nh-item-noteedit";
    ta.placeholder = "Edit note… (Enter to save · Shift+Enter newline · Esc cancel)";
    ta.value = item.text ?? "";
    ta.rows = 2;
    ta.style.cssText =
      "resize:none;width:100%;box-sizing:border-box;padding:6px 8px;border-radius:6px;border:1px solid #2b313a;background:#0e1114;color:#e6e8eb;font:inherit;font-size:12px;";
    // Enter-to-save (mirrors the classic overlay item modal's Save + collapse); Esc cancels the edit (the
    // prior note is untouched — edits aren't live-applied); Shift+Enter is a newline within the note.
    ta.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handlers.onNoteChange(item.id, ta.value.trim());
        handlers.onToggle(item.id); // collapse/confirm
      } else if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        handlers.onToggle(item.id); // collapse without saving
      }
    });
    // Don't let a click inside the textarea bubble to the header toggle.
    ta.addEventListener("click", (e) => e.stopPropagation());
    detail.appendChild(ta);
  }

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

/** The red-boxed region screenshot (thumbnail in the rail; click → full-res lightbox). Ported from
 *  fillRegionBody; the rail preview prefers the small `_thumb` data URL (no object-URL leak), while the
 *  lightbox opens the full-res `_blob`. */
function regionPreview(item: QueueItem): HTMLElement {
  const src = item._thumb || (item._blob && tryObjectURL(item._blob)) || null;
  if (src) {
    const img = document.createElement("img");
    img.className = "nh-item-img";
    img.src = src;
    img.alt = "region screenshot";
    img.title = "Click to enlarge";
    img.style.cssText =
      "display:block;max-width:100%;border-radius:6px;border:1px solid #2b313a;background:#0e1114;cursor:zoom-in;";
    img.addEventListener("click", (e) => {
      e.stopPropagation();
      openRegionLightbox(item);
    });
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

const READONLY_HANDLERS: QueueItemHandlers = { onRemove: () => {}, onToggle: () => {}, onNoteChange: () => {} };

/** A SENT-turn history entry for the builder transcript: collapsed shows a compact summary (lead text +
 *  kind badges); expanded lists every item of the flushed batch as a read-only queued item (message text /
 *  region screenshot with click-to-lightbox / element+edit descriptor). Self-contained expand toggle. The
 *  items are the SAME objects retained in history, so their `_thumb`/`_blob` render the screenshots later. */
export function buildSentTurn(items: QueueItem[]): HTMLElement {
  const row = document.createElement("div");
  row.className = "nh-msg nh-user nh-sent";
  row.style.cssText =
    "background:#1c2534;border:1px solid #26344a;border-radius:8px;padding:8px 10px;align-self:flex-end;max-width:96%;";

  const messages = items.filter((i) => i.kind === "message");
  const marks = items.filter((i) => i.kind !== "message");
  const lead = (messages[0]?.text || marks.find((m) => m.text)?.text || "(marks only)").trim();
  const badgeParts: string[] = [];
  if (marks.length) badgeParts.push(`${marks.length} mark${marks.length === 1 ? "" : "s"}`);
  if (messages.length) badgeParts.push(`${messages.length} message${messages.length === 1 ? "" : "s"}`);

  let expanded = false;
  const render = (): void => {
    row.textContent = "";
    const head = document.createElement("div");
    head.className = "nh-sent-head";
    head.style.cssText = "display:flex;align-items:center;gap:8px;cursor:pointer;";
    head.addEventListener("click", () => {
      expanded = !expanded;
      render();
    });

    const caret = document.createElement("span");
    caret.textContent = expanded ? "▾" : "▸";
    caret.style.cssText = "color:#7f8aa0;font-size:10px;flex:0 0 auto;";
    const role = document.createElement("span");
    role.className = "nh-role";
    role.textContent = "you";
    role.style.cssText =
      "flex:0 0 auto;font-size:10px;letter-spacing:.4px;text-transform:uppercase;color:#7f8aa0;";
    const summary = document.createElement("span");
    summary.className = "nh-sent-summary";
    summary.textContent = truncate(lead, 60);
    summary.style.cssText =
      "flex:1 1 auto;min-width:0;color:#e6e8eb;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;";
    const badge = document.createElement("span");
    badge.className = "nh-sent-badge";
    badge.textContent = badgeParts.join(" · ");
    badge.style.cssText = "flex:0 0 auto;font-size:10px;color:#7f8aa0;";
    head.append(caret, role, summary, badge);
    row.appendChild(head);

    if (expanded) {
      const body = document.createElement("div");
      body.className = "nh-sent-body";
      body.style.cssText = "display:flex;flex-direction:column;gap:6px;margin-top:8px;";
      for (const it of items) {
        body.appendChild(buildQueueItem(it, READONLY_HANDLERS, true, { readonly: true }));
      }
      row.appendChild(body);
    }
  };
  render();
  return row;
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s;
}
