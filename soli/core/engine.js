/**
 * core/engine.js
 * Pure game logic for SOLI — no UI, no platform code.
 * Direct port of soli-refactor/core/engine.py
 */

"use strict";

// ── Constants ────────────────────────────────────────────────────
const MAX_ROUNDS          = 4;
const MOVE_BASE           = 10;
const ROW_BONUS           = 150;
const WIN_BONUS_BASE      = 500;
const WIN_BONUS_PER_ROUND = 200;

// ── Seeded RNG (Mulberry32) — for Daily Challenge determinism ────
function mulberry32(seed) {
    return function() {
        seed |= 0; seed = seed + 0x6D2B79F5 | 0;
        let t = Math.imul(seed ^ seed >>> 15, 1 | seed);
        t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
        return ((t ^ t >>> 14) >>> 0) / 4294967296;
    };
}

function shuffleArray(arr, rng) {
    // Fisher-Yates
    const rand = rng || (() => Math.random());
    for (let i = arr.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [arr[i], arr[j]] = [arr[j], arr[i]];
    }
}

// ── Deep clone board ─────────────────────────────────────────────
function cloneBoard(board) {
    return board.map(row => row.map(cell => cell ? cell.clone() : null));
}

// ── GameEngine ───────────────────────────────────────────────────
class GameEngine {
    /**
     * @param {number|null} seed  - null = random game, integer = Daily Challenge
     */
    constructor(seed = null) {
        this.round    = 1;
        this.score    = 0;
        this.moves    = 0;
        this.winBonus = 0;
        this.board    = Array.from({ length: 4 }, () => Array(13).fill(null));
        this.history  = [];   // [{board, score}]
        this.future   = [];
        this.isLocked  = false;
        this.gameWon   = false;
        this.gameOver  = false;
        this._round4Snapshot = null;
        this._deal(seed);
    }

    // ── Setup ──────────────────────────────────────────────────
    _deal(seed) {
        const deck = createDeck();
        const rng  = seed !== null ? mulberry32(seed) : null;
        shuffleArray(deck, rng);

        let idx = 0;
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 13; c++) {
                const card = deck[idx++];
                this.board[r][c] = (card.rank === "A") ? null : card;
            }
        }
        this._refreshLocked();
    }

    // ── Move validation ────────────────────────────────────────
    validMove(card, r, c) {
        if (this.board[r][c] !== null) return false;
        if (c === 0) return card.rank === 2;
        const left = this.board[r][c - 1];
        if (!left || left.rank === "K") return false;
        return card.suit === left.suit && card.value() === left.value() + 1;
    }

    validSlots(card) {
        const slots = [];
        for (let r = 0; r < 4; r++)
            for (let c = 0; c < 13; c++)
                if (this.validMove(card, r, c)) slots.push([r, c]);
        return slots;
    }

    allMoves() {
        const moves = [];
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 13; c++) {
                const card = this.board[r][c];
                if (!card) continue;
                for (let rr = 0; rr < 4; rr++)
                    for (let cc = 0; cc < 13; cc++)
                        if (this.validMove(card, rr, cc))
                            moves.push([[r, c], [rr, cc]]);
            }
        }
        return moves;
    }

    // ── Apply / Undo / Redo ────────────────────────────────────
    /**
     * Execute a move. Returns array of newly-completed row indices.
     */
    applyMove(src, dst) {
        this.moves++;
        const lensBefore = this.sequenceLengths();
        this.history.push({ board: cloneBoard(this.board), score: this.score });
        this.future = [];

        const [sr, sc] = src;
        const [dr, dc] = dst;
        this.board[dr][dc] = this.board[sr][sc];
        this.board[sr][sc] = null;

        const lensAfter = this.sequenceLengths();

        // Points only if move extends destination without shortening source
        if (lensAfter[dr] > lensBefore[dr] && lensAfter[sr] >= lensBefore[sr]) {
            this.score += MOVE_BASE + dc;
        }

        // Row-completion bonus
        const newCompletions = [];
        for (let r = 0; r < 4; r++) {
            if (lensAfter[r] === 12 && lensBefore[r] < 12) newCompletions.push(r);
        }
        if (newCompletions.length) {
            this.score += newCompletions.length * ROW_BONUS;
        }

        this._refreshLocked();
        this._checkWin();
        return newCompletions;
    }

    undo() {
        if (!this.history.length) return false;
        this.future.push({ board: cloneBoard(this.board), score: this.score });
        const prev = this.history.pop();
        this.board    = prev.board;
        this.score    = prev.score;
        this.gameWon  = false;
        this.gameOver = false;
        this._refreshLocked();
        return true;
    }

    redo() {
        if (!this.future.length) return false;
        this.history.push({ board: cloneBoard(this.board), score: this.score });
        const next = this.future.pop();
        this.board = next.board;
        this.score = next.score;
        this._refreshLocked();
        this._checkWin();
        return true;
    }

    // ── Round transition ───────────────────────────────────────
    /**
     * Advance to the next round.
     * @param {boolean} force  - allow beyond MAX_ROUNDS (lifeline round 5)
     * @returns {boolean} true if advanced, false if game over
     */
    nextRound(force = false) {
        if (this.round >= MAX_ROUNDS && !force) {
            this.gameOver = true;
            return false;
        }
        this.round++;
        const { newBoard, remaining } = this._extractSequences();
        shuffleArray(remaining);

        let idx = 0;
        for (let r = 0; r < 4; r++) {
            let gapSkipped = false;
            for (let c = 0; c < 13; c++) {
                if (newBoard[r][c] === null) {
                    if (!gapSkipped) { gapSkipped = true; continue; }
                    if (idx < remaining.length) newBoard[r][c] = remaining[idx++];
                }
            }
        }
        this.board = newBoard;

        if (this.round === 4) {
            this._round4Snapshot = cloneBoard(newBoard);
        }

        this.history = [];
        this.future  = [];
        this._refreshLocked();
        return true;
    }

    replayRound4() {
        if (!this._round4Snapshot) return false;
        this.board    = cloneBoard(this._round4Snapshot);
        this.gameOver = false;
        this.history  = [];
        this.future   = [];
        this._refreshLocked();
        return true;
    }

    _extractSequences() {
        const newBoard  = Array.from({ length: 4 }, () => Array(13).fill(null));
        const remaining = [];
        for (let r = 0; r < 4; r++) {
            const row = this.board[r];
            const seq = [];
            if (row[0] && row[0].rank === 2) {
                seq.push(row[0]);
                let c = 1;
                while (c < 13) {
                    const prev = seq[seq.length - 1];
                    const curr = row[c];
                    if (curr && curr.suit === prev.suit && curr.value() === prev.value() + 1) {
                        seq.push(curr);
                        c++;
                    } else break;
                }
            }
            seq.forEach((card, i) => { newBoard[r][i] = card; });
            for (let c = seq.length; c < 13; c++) {
                if (row[c]) remaining.push(row[c]);
            }
        }
        return { newBoard, remaining };
    }

    // ── Win / Lock checks ──────────────────────────────────────
    _checkWin() {
        for (let r = 0; r < 4; r++) {
            let suit = null;
            for (let c = 0; c < 12; c++) {
                const card = this.board[r][c];
                if (!card) return;
                if (c === 0) {
                    if (card.rank !== 2) return;
                    suit = card.suit;
                } else {
                    if (card.suit !== suit || card.value() !== this.board[r][c - 1].value() + 1) return;
                }
            }
            if (this.board[r][12] !== null) return;
        }
        this.winBonus = WIN_BONUS_BASE + (MAX_ROUNDS - this.round) * WIN_BONUS_PER_ROUND;
        this.score   += this.winBonus;
        this.gameWon  = true;
    }

    _refreshLocked() {
        this.isLocked = this.allMoves().length === 0;
    }

    // ── Sequence progress ──────────────────────────────────────
    sequenceLengths() {
        return this.board.map(row => {
            if (!row[0] || row[0].rank !== 2) return 0;
            let n = 1;
            for (let c = 1; c < 13; c++) {
                const prev = row[c - 1], curr = row[c];
                if (curr && prev && curr.suit === prev.suit && curr.value() === prev.value() + 1) n++;
                else break;
            }
            return n;
        });
    }
}
