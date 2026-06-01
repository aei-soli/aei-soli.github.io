/**
 * core/firebase.js
 * Thin Firebase Realtime Database REST client for SOLI web/iPad.
 *
 * Uses plain fetch() — no SDK required.
 * Mirrors the macOS Python implementation (main.py) exactly:
 *   - Same database URL
 *   - Same /config key names and defaults
 *   - Same /licenses email encoding
 *   - Same /daily entry shape
 *
 * All network calls are fire-and-forget with timeouts; failures always
 * fall back gracefully so the game remains fully playable offline.
 */

"use strict";

const FIREBASE_URL = "https://soli-game-default-rtdb.firebaseio.com";

// Default remote config — matches macOS _RC_DEFAULTS exactly.
// Used immediately; overwritten after fetchConfig() resolves.
const RC_DEFAULTS = {
  enabled:                  true,
  every_n_rounds:           2,
  between_games:            true,
  before_bonus:             true,
  duration_secs:            5,
  heavy_after_games:        5,
  heavy_after_minutes:      30,
  heavy_every_n_rounds:     1,
  heavy_duration_secs:      8,
  ab_mode:                  false,
  variant_a_every_n_rounds: 2,
  variant_a_duration_secs:  5,
  variant_b_every_n_rounds: 1,
  variant_b_duration_secs:  8,
};

class FirebaseClient {
  constructor(url = FIREBASE_URL) {
    this._url  = url.replace(/\/$/, "");
    /** Live remote config — starts with defaults, updated by fetchConfig(). */
    this.config = { ...RC_DEFAULTS };
  }

  // ── Remote Config ─────────────────────────────────────────────────────────

  /**
   * Fetch /config.json from Firebase.
   * Non-blocking: call without await at startup; config updates in background.
   * Handles nested objects and legacy "interstitial_*" key prefix.
   * @returns {Promise<object>} resolved config (same as this.config after call)
   */
  async fetchConfig() {
    try {
      const res  = await fetch(`${this._url}/config.json`,
                               { signal: AbortSignal.timeout(4000) });
      const data = await res.json();
      if (data && typeof data === "object") {
        // Flatten one level of nesting: {heavy: {after_games: 3}} → heavy_after_games: 3
        const flat = {};
        for (const [k, v] of Object.entries(data)) {
          if (v && typeof v === "object" && !Array.isArray(v)) {
            for (const [sk, sv] of Object.entries(v)) flat[`${k}_${sk}`] = sv;
          } else {
            flat[k] = v;
          }
        }
        // Accept legacy "interstitial_*" prefixed keys from old config schema
        const LEGACY = {
          interstitial_enabled:        "enabled",
          interstitial_every_n_rounds: "every_n_rounds",
          interstitial_between_games:  "between_games",
          interstitial_before_bonus:   "before_bonus",
          interstitial_duration_secs:  "duration_secs",
        };
        for (const [old, neo] of Object.entries(LEGACY)) {
          if (old in flat && !(neo in flat)) { flat[neo] = flat[old]; delete flat[old]; }
        }
        this.config = { ...RC_DEFAULTS, ...flat };
      }
    } catch (_) {
      // Network unavailable — keep defaults; game works offline
    }
    return this.config;
  }

  // ── Premium License ───────────────────────────────────────────────────────

  /**
   * Check whether an email has a valid premium license.
   * @param {string} email
   * @returns {Promise<true|false|null>}
   *   true  = license active
   *   false = email not found
   *   null  = network/timeout error
   */
  async checkLicense(email) {
    try {
      const key = this._encodeEmail(email);
      const res = await fetch(`${this._url}/licenses/${key}.json`,
                              { signal: AbortSignal.timeout(8000) });
      const txt = (await res.text()).trim();
      return txt === "true";
    } catch (_) {
      return null;
    }
  }

  // ── Daily Challenge Leaderboard ───────────────────────────────────────────

  /**
   * POST a completed game result to the global daily leaderboard.
   * Only call if user has given GDPR consent.
   * @param {string} dateStr  "YYYY-MM-DD"
   * @param {{ name, score, moves, time, won, round }} entry
   * @returns {Promise<boolean>} true on success
   */
  async postDailyScore(dateStr, { name, score, moves, time, won, round }) {
    try {
      const body = JSON.stringify({ name, score, moves, time, won, round });
      const res  = await fetch(`${this._url}/daily/${dateStr}.json`, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body,
        signal:  AbortSignal.timeout(5000),
      });
      return res.ok;
    } catch (_) {
      return false;
    }
  }

  /**
   * Fetch and sort the global daily leaderboard for a given date.
   * @param {string} dateStr  "YYYY-MM-DD"
   * @returns {Promise<Array>} sorted entries (score desc → time asc → moves asc)
   */
  async fetchDailyScores(dateStr) {
    try {
      const res  = await fetch(`${this._url}/daily/${dateStr}.json`,
                               { signal: AbortSignal.timeout(5000) });
      const data = await res.json();
      if (data && typeof data === "object" && !Array.isArray(data)) {
        const entries = Object.values(data);
        entries.sort((a, b) =>
          (b.score  - a.score)  ||
          (a.time   - b.time)   ||
          (a.moves  - b.moves)
        );
        return entries;
      }
    } catch (_) {}
    return [];
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Encode an email for use as a Firebase key.
   * Must match the Cloudflare Stripe webhook worker and the macOS app exactly:
   *   @ → _at_   . → _dot_
   * e.g. "user@example.com" → "user_at_example_dot_com"
   */
  _encodeEmail(email) {
    return email.toLowerCase().trim()
      .replace(/@/g, "_at_")
      .replace(/\./g, "_dot_");
  }

  /** "YYYY-MM-DD" for today in local time — used as the daily challenge key. */
  todayStr() {
    const d = new Date();
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const s = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${s}`;
  }
}
