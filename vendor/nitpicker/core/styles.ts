// @nitpicker/core — all overlay CSS, injected into the shadow root so host page styles can never
// collide with ours and vice-versa (shadow-root isolation).
export const CSS = `
:host { all: initial; }
.np-root { position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;
  --np-panel-w: 320px;
  font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }

/* ---- dock ---- */
/* Bottom-CENTER by default. When the chat panel is open it shifts left so the right-side panel
   never covers it (see .np-shift + the narrow-viewport media query below). */
.np-dock { position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  transition: transform .18s ease, bottom .18s ease;
  display: flex; gap: 4px; align-items: center;
  background: #1e1e24; border: 1px solid #34343c; border-radius: 12px; padding: 6px;
  box-shadow: 0 6px 24px rgba(0,0,0,.4); pointer-events: auto; }
/* panel open: re-center the dock within the space to the LEFT of the panel */
.np-dock.np-shift { transform: translateX(calc(-50% - var(--np-panel-w) / 2)); }
.np-btn { display: grid; place-items: center; width: 34px; height: 34px; border-radius: 8px;
  border: none; background: transparent; color: #b8b8c4; cursor: pointer; position: relative; }
.np-btn:hover:not(:disabled) { background: #2c2c35; color: #fff; }
.np-btn.np-active { background: #3b5bdb; color: #fff; }
.np-btn:disabled { color: #56565f; cursor: not-allowed; }
.np-btn svg { width: 18px; height: 18px; }
.np-sep { width: 1px; height: 22px; background: #34343c; margin: 0 2px; }
.np-badge { position: absolute; top: -4px; right: -4px; min-width: 16px; height: 16px; padding: 0 4px;
  border-radius: 8px; background: #ff3b30; color: #fff; font-size: 10px; font-weight: 700;
  display: none; place-items: center; line-height: 16px; }
.np-badge.np-show { display: grid; }
.np-btn .np-soon { position: absolute; bottom: -3px; right: -3px; font-size: 7px; background: #56565f;
  color: #fff; border-radius: 4px; padding: 0 2px; }

/* ---- region drag ---- */
.np-interaction { position: fixed; inset: 0; pointer-events: none; cursor: crosshair; }
.np-interaction.np-armed { pointer-events: auto; }
.np-band { position: fixed; background: rgba(0,0,0,.45); pointer-events: none; display: none; }
.np-outline { position: fixed; border: 1px dashed #ff3b30; pointer-events: none; display: none; }

/* ---- element picker ---- */
.np-el-hl { position: fixed; box-sizing: border-box; border: 2px solid #3b5bdb;
  background: rgba(59,91,219,.12); pointer-events: none; display: none; z-index: 1; }
.np-el-hl-label { position: absolute; left: 0; top: -18px; max-width: 100%; overflow: hidden;
  white-space: nowrap; text-overflow: ellipsis; background: #3b5bdb; color: #fff; font-size: 10px;
  font-family: ui-monospace, monospace; line-height: 16px; padding: 0 5px; border-radius: 3px; }

/* ---- hotkey freeze snapshot (below the interaction layer so bands/outline draw on top) ---- */
.np-snapshot { position: fixed; inset: 0; pointer-events: none; display: none; }
.np-snapshot.np-show { display: block; }
.np-snapshot canvas { position: fixed; top: 0; left: 0; }

/* ---- freeze layer + queue card ---- */
.np-freeze { position: fixed; inset: 0; pointer-events: none; display: none; }
.np-freeze.np-show { display: block; }
.np-freeze canvas { position: fixed; top: 0; left: 0; }
/* transparent click-catcher behind the element-mode card (region uses its opaque canvas instead). */
.np-backdrop { position: fixed; inset: 0; pointer-events: auto; background: rgba(0,0,0,.02); }
.np-card { position: fixed; width: 280px; background: #1e1e24; border: 1px solid #34343c;
  border-radius: 12px; padding: 12px; box-shadow: 0 6px 24px rgba(0,0,0,.5); pointer-events: auto; }
.np-card textarea { width: 100%; box-sizing: border-box; min-height: 60px; resize: vertical;
  background: #14141a; color: #eee; border: 1px solid #34343c; border-radius: 8px; padding: 8px;
  font: inherit; font-size: 13px; }
.np-card .np-actions { display: flex; gap: 8px; margin-top: 8px; justify-content: flex-end; }

/* ---- chat panel ---- */
.np-panel { position: fixed; top: 0; right: 0; height: 100%; width: var(--np-panel-w); background: #17171c;
  border-left: 1px solid #34343c; box-shadow: -8px 0 24px rgba(0,0,0,.35); pointer-events: auto;
  display: none; flex-direction: column; color: #e6e6ee; }
.np-panel.np-open { display: flex; }

/* ---- narrow viewports: reflow the right panel into a bottom sheet so it and the dock
   never overlap (the shifted-left dock would otherwise run off the left edge) ---- */
@media (max-width: 720px) {
  .np-panel { top: auto; bottom: 0; width: 100%; height: 70vh;
    border-left: none; border-top: 1px solid #34343c; box-shadow: 0 -8px 24px rgba(0,0,0,.35); }
  /* dock stays bottom-CENTER but rides just above the bottom sheet */
  .np-dock.np-shift { transform: translateX(-50%); bottom: calc(70vh + 12px); }
}
.np-panel-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 14px;
  border-bottom: 1px solid #2a2a31; font-weight: 600; font-size: 13px; }
.np-list { flex: 1; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.np-empty { color: #71717a; font-size: 12px; text-align: center; margin-top: 24px; white-space: pre-line; }
.np-item { display: flex; gap: 8px; background: #1e1e24; border: 1px solid #2a2a31; border-radius: 8px;
  padding: 8px; }
.np-item img { width: 56px; height: 40px; object-fit: cover; border-radius: 4px; flex: none;
  background: #000; }
.np-item-body { flex: 1; min-width: 0; }
.np-item-kind { font-size: 10px; text-transform: uppercase; letter-spacing: .04em; color: #8a8a99; }
.np-item-text { font-size: 12px; color: #e6e6ee; word-break: break-word;
  display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
.np-item-chip { font-size: 10px; color: #9aa5ff; font-family: ui-monospace, monospace; }
.np-x { border: none; background: transparent; color: #71717a; cursor: pointer; font-size: 14px;
  align-self: flex-start; }
.np-x:hover { color: #ff6b6b; }
.np-panel-foot { border-top: 1px solid #2a2a31; padding: 10px; display: flex; flex-direction: column; gap: 8px; }
.np-panel-foot textarea { width: 100%; box-sizing: border-box; min-height: 44px; resize: vertical;
  background: #14141a; color: #eee; border: 1px solid #34343c; border-radius: 8px; padding: 8px;
  font: inherit; font-size: 13px; }
.np-primary { background: #3b5bdb; color: #fff; border: none; border-radius: 8px; padding: 8px 12px;
  font: inherit; font-size: 13px; font-weight: 600; cursor: pointer; }
.np-primary:hover { background: #4c6ef5; }
.np-primary:disabled { background: #2c2c35; color: #71717a; cursor: not-allowed; }
.np-ghost { background: #2c2c35; color: #cfcfda; border: none; border-radius: 8px; padding: 6px 12px;
  font: inherit; font-size: 13px; cursor: pointer; }
.np-ghost:hover { background: #3a3a44; }
.np-status { font-size: 11px; color: #9a9aa5; min-height: 14px; }
`;
