/**
 * ui/input.js
 * Unified pointer / touch input handler for SOLI canvas.
 *
 * Uses the Pointer Events API (supported on all modern browsers, iOS 13+,
 * and Capacitor) — one handler covers mouse, stylus, and multi-touch.
 *
 * Recognises two gestures:
 *   Tap  — pointer-down → up with < MOVE_THRESHOLD movement and < TIME_LIMIT_MS
 *   Drag — pointer-down → significant move → up
 *          Fires onDragStart once, onDragMove continuously, onDragEnd on release.
 */

"use strict";

class InputHandler {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {function(x, y)} onTap
   * @param {object} [dragHandlers]
   *   @param {function(x, y)} [dragHandlers.onDragStart]  — first frame drag exceeds threshold
   *   @param {function(x, y)} [dragHandlers.onDragMove]   — every subsequent move event
   *   @param {function(x, y)} [dragHandlers.onDragEnd]    — pointer released after drag
   */
  constructor(canvas, onTap, { onDragStart, onDragMove, onDragEnd } = {}) {
    this.canvas      = canvas;
    this.onTap       = onTap;
    this.onDragStart = onDragStart || null;
    this.onDragMove  = onDragMove  || null;
    this.onDragEnd   = onDragEnd   || null;

    // Per-pointer tracking
    this._active = new Map();   // pointerId → { x0, y0, t0, dragging }

    // Thresholds
    this.MOVE_THRESHOLD = 10;   // px — below this is still a tap
    this.TIME_LIMIT_MS  = 600;  // ms — tap must complete within this

    canvas.addEventListener("pointerdown",  e => this._down(e),   { passive: false });
    canvas.addEventListener("pointermove",  e => this._move(e),   { passive: false });
    canvas.addEventListener("pointerup",    e => this._up(e),     { passive: false });
    canvas.addEventListener("pointercancel", e => this._cancel(e), { passive: false });
  }

  // ── Coordinate helper ─────────────────────────────────────────────────────

  _toCanvas(e) {
    const rect   = this.canvas.getBoundingClientRect();
    const scaleX = this.canvas.width  / (window.devicePixelRatio || 1) / rect.width;
    const scaleY = this.canvas.height / (window.devicePixelRatio || 1) / rect.height;
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top)  * scaleY,
    };
  }

  // ── Pointer events ────────────────────────────────────────────────────────

  _down(e) {
    e.preventDefault();
    const pos = this._toCanvas(e);
    this._active.set(e.pointerId, {
      x0:      pos.x,
      y0:      pos.y,
      t0:      performance.now(),
      dragging: false,
    });
  }

  _move(e) {
    const info = this._active.get(e.pointerId);
    if (!info) return;
    e.preventDefault();

    const pos = this._toCanvas(e);
    const dx  = pos.x - info.x0;
    const dy  = pos.y - info.y0;

    if (!info.dragging && Math.hypot(dx, dy) > this.MOVE_THRESHOLD) {
      // Transition from potential-tap to drag
      info.dragging = true;
      if (this.onDragStart) this.onDragStart(info.x0, info.y0);
    }

    if (info.dragging && this.onDragMove) {
      this.onDragMove(pos.x, pos.y);
    }
  }

  _up(e) {
    e.preventDefault();
    const info = this._active.get(e.pointerId);
    if (!info) return;
    this._active.delete(e.pointerId);

    const pos = this._toCanvas(e);

    if (info.dragging) {
      if (this.onDragEnd) this.onDragEnd(pos.x, pos.y);
    } else {
      const elapsed = performance.now() - info.t0;
      if (elapsed < this.TIME_LIMIT_MS) {
        this.onTap(pos.x, pos.y);
      }
    }
  }

  _cancel(e) {
    const info = this._active.get(e.pointerId);
    if (info && info.dragging && this.onDragEnd) {
      // Snap back — pass the start position so game can deselect cleanly
      this.onDragEnd(info.x0, info.y0);
    }
    this._active.delete(e.pointerId);
  }
}
