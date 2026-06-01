/**
 * core/sound.js
 * Procedural sound effects for SOLI — no audio files required.
 * Uses the Web Audio API (AudioContext) with lazy initialisation:
 * the context is created on the first user gesture (required by browsers).
 *
 * Three sounds:
 *   cardSnap      — short filtered-noise click when a card lands
 *   rowComplete   — ascending 3-note chime when a row is completed
 *   win           — triumphant C-major fanfare on game win
 */

"use strict";

class SoundManager {
  constructor() {
    this._ctx     = null;
    this._enabled = true;
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /** Enable or disable all sound. Called from SFX toggle. */
  setEnabled(v) { this._enabled = !!v; }

  /** Short click — play on every successful card move. */
  playCardSnap() {
    if (!this._enabled) return;
    const ctx = this._ctx_();
    if (!ctx) return;

    const DURATION = 0.045;   // 45 ms
    const buf      = ctx.createBuffer(1, Math.ceil(ctx.sampleRate * DURATION), ctx.sampleRate);
    const data     = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      // White noise with exponential envelope
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2);
    }

    const src    = ctx.createBufferSource();
    src.buffer   = buf;

    // High-pass filter — keeps it crisp, not thumpy
    const hp     = ctx.createBiquadFilter();
    hp.type      = "highpass";
    hp.frequency.value = 1800;

    const gain   = ctx.createGain();
    const now    = ctx.currentTime;
    gain.gain.setValueAtTime(0.35, now);
    gain.gain.exponentialRampToValueAtTime(0.001, now + DURATION);

    src.connect(hp);
    hp.connect(gain);
    gain.connect(ctx.destination);
    src.start(now);
  }

  /** Ascending 3-note chime — play when a row sequence is completed. */
  playRowComplete() {
    if (!this._enabled) return;
    const ctx = this._ctx_();
    if (!ctx) return;

    // E5, G5, B5 — a pleasant major triad arpeggio
    const notes = [659.25, 783.99, 987.77];
    notes.forEach((freq, i) => {
      const t    = ctx.currentTime + i * 0.11;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type           = "sine";
      osc.frequency.value = freq;

      gain.gain.setValueAtTime(0,    t);
      gain.gain.linearRampToValueAtTime(0.22, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.32);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.35);
    });
  }

  /** Triumphant fanfare — play when the player wins the game. */
  playWin() {
    if (!this._enabled) return;
    const ctx = this._ctx_();
    if (!ctx) return;

    // C major ascending arpeggio: C5 E5 G5 C6 E6
    const notes = [523.25, 659.25, 783.99, 1046.50, 1318.51];
    notes.forEach((freq, i) => {
      const t    = ctx.currentTime + i * 0.13;
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.type            = "triangle";
      osc.frequency.value = freq;

      gain.gain.setValueAtTime(0,    t);
      gain.gain.linearRampToValueAtTime(0.28, t + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.55);

      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.60);
    });
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  /** Lazy-create AudioContext; returns null if Web Audio unavailable. */
  _ctx_() {
    if (!this._ctx) {
      try {
        this._ctx = new (window.AudioContext || window.webkitAudioContext)();
      } catch (_) {
        return null;
      }
    }
    // Resume if browser suspended it (e.g. page was backgrounded)
    if (this._ctx.state === "suspended") {
      this._ctx.resume();
    }
    return this._ctx;
  }
}
