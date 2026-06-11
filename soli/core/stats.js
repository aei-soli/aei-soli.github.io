/**
 * core/stats.js
 * Persistent game statistics and high scores via localStorage.
 * No UI dependencies — pure data management.
 */

"use strict";

const STATS_KEY  = "soli_stats_v1";
const SCORES_KEY = "soli_scores_v1";
const MAX_SCORES = 15;

class StatsManager {
  constructor() {
    this._data   = this._loadStats();
    this._scores = this._loadScores();
  }

  // ── Statistics ────────────────────────────────────────────────────────────

  getStats() {
    return { ...this._data };
  }

  /**
   * Record the result of a completed (or abandoned) game.
   * @param {{ won: boolean, score: number, seconds: number }} result
   */
  recordGame({ won, score, seconds }) {
    const d = this._data;
    d.played++;
    d.totalScore += (score || 0);            // lifetime cumulative points (all games)
    if (won) {
      d.won++;
      if (score > d.bestScore) d.bestScore = score;
      if (seconds > 0 && (d.bestTime === 0 || seconds < d.bestTime)) d.bestTime = seconds;
    }
    d.totalSeconds += seconds;
    this._saveStats();
  }

  resetStats() {
    this._data = this._defaultStats();
    this._saveStats();
  }

  // ── High Scores ───────────────────────────────────────────────────────────

  /**
   * @param {'regular'|'daily'} type
   * @returns {Array<{score, seconds, date}>} sorted best-first, max MAX_SCORES entries
   */
  getHighScores(type) {
    return (this._scores[type] || []).slice();
  }

  /**
   * Add a score entry and keep only the top MAX_SCORES.
   * @param {'regular'|'daily'} type
   * @param {{ score: number, seconds: number, name?: string }} entry
   */
  recordScore(type, { score, seconds, name = "" }) {
    if (!this._scores[type])     this._scores[type]     = [];
    if (!this._scores.lifetime)  this._scores.lifetime  = [];
    const date  = new Date().toLocaleDateString(undefined, { year: "2-digit", month: "short", day: "numeric" });
    const entry = { score, seconds, date, name };
    const sortTrim = (list) => {
      list.sort((a, b) => b.score - a.score || a.seconds - b.seconds);
      return list.slice(0, MAX_SCORES);
    };
    this._scores[type].push(entry);
    this._scores[type] = sortTrim(this._scores[type]);
    // Lifetime = all-time best across every mode. Push the SAME entry object so a
    // later name patch (updateLastScoreName) propagates to both lists.
    if (type !== "lifetime") {
      this._scores.lifetime.push(entry);
      this._scores.lifetime = sortTrim(this._scores.lifetime);
    }
    // Keep a reference so updateLastScoreName can patch the name after the user types it
    this._lastRecordedType  = type;
    this._lastRecordedEntry = entry;
    this._saveScores();
  }

  /**
   * Update the name on the most recently recorded score entry (call after player types alias).
   * @param {'regular'|'daily'} type
   * @param {string} name
   */
  updateLastScoreName(type, name) {
    if (this._lastRecordedType !== type || !this._lastRecordedEntry) return;
    this._lastRecordedEntry.name = name;   // mutates in-place (same object reference in _scores)
    this._lastRecordedEntry = null;
    this._saveScores();
  }

  resetScores() {
    this._scores = this._defaultScores();
    this._saveScores();
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  _defaultStats() {
    return { played: 0, won: 0, bestScore: 0, bestTime: 0, totalSeconds: 0, totalScore: 0 };
  }

  _defaultScores() {
    return { regular: [], daily: [], lifetime: [] };
  }

  _loadStats() {
    try {
      const raw = localStorage.getItem(STATS_KEY);
      if (raw) return { ...this._defaultStats(), ...JSON.parse(raw) };
    } catch (_) {}
    return this._defaultStats();
  }

  _loadScores() {
    try {
      const raw = localStorage.getItem(SCORES_KEY);
      if (raw) {
        const s = { ...this._defaultScores(), ...JSON.parse(raw) };
        // One-time backfill: build Lifetime from existing regular+daily for users
        // who played before the Lifetime board existed.
        if (!Array.isArray(s.lifetime) || s.lifetime.length === 0) {
          s.lifetime = [...(s.regular || []), ...(s.daily || [])]
            .sort((a, b) => b.score - a.score || a.seconds - b.seconds)
            .slice(0, MAX_SCORES);
        }
        return s;
      }
    } catch (_) {}
    return this._defaultScores();
  }

  _saveStats() {
    try { localStorage.setItem(STATS_KEY, JSON.stringify(this._data)); } catch (_) {}
  }

  _saveScores() {
    try { localStorage.setItem(SCORES_KEY, JSON.stringify(this._scores)); } catch (_) {}
  }
}
