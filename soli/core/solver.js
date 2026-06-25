/**
 * core/solver.js
 * Look-ahead hint engine for SOLI.
 *
 * For each currently-legal move, it explores the chain of successive legal moves
 * that move unlocks — branching through all options but NEVER revisiting a board
 * position (so it can't loop by shuffling a card back and forth) — and recommends
 * the move that leads to the LONGEST chain of moves before the board dead-ends.
 *
 * Tie-break: among equally-long chains, the one that gains the most points.
 * A line that completes the board (win) always takes priority.
 *
 * The search is bounded (node budget + depth cap) so the hint is effectively
 * instant, even on a phone. bestMove() keeps the same return shape the UI expects:
 *   [[fromRow, fromCol], [toRow, toCol]]   (or null if no move exists)
 */

"use strict";

const _SOLVER_MOVE_BASE    = 10;
const _SOLVER_ROW_BONUS    = 150;
const _SOLVER_NODE_BUDGET  = 20000;  // max board expansions per hint (keeps it instant)
const _SOLVER_DEPTH_CAP    = 48;     // longest chain we'd ever care about

class Solver {
    constructor(engine) {
        this.engine = engine;
    }

    // ── Pure rule helpers (operate on a passed 4×13 board of Card|null) ──────

    static _validMove(board, card, r, c) {
        if (board[r][c] !== null) return false;
        if (c === 0) return card.rank === 2;
        const left = board[r][c - 1];
        if (!left || left.rank === "K") return false;
        return card.suit === left.suit && card.value() === left.value() + 1;
    }

    // Gap-driven: for each empty cell, find the card(s) that legally fill it.
    // A non-row-start gap has at most ONE filling card (the unique suit+rank successor
    // of its left neighbour); a row-start gap accepts any 2. Same move set as the brute
    // scan, but ~10× cheaper and with a much smaller branching factor.
    static _legalMoves(board) {
        const moves = [];
        for (let r = 0; r < 4; r++) {
            for (let c = 0; c < 13; c++) {
                if (board[r][c] !== null) continue;        // only gaps
                if (c === 0) {
                    for (let rr = 0; rr < 4; rr++)
                        for (let cc = 0; cc < 13; cc++) {
                            const x = board[rr][cc];
                            if (x && x.rank === 2) moves.push([[rr, cc], [r, 0]]);
                        }
                } else {
                    const left = board[r][c - 1];
                    if (!left || left.rank === "K") continue;   // dead gap
                    const needSuit = left.suit, needVal = left.value() + 1;
                    let found = false;
                    for (let rr = 0; rr < 4 && !found; rr++)
                        for (let cc = 0; cc < 13; cc++) {
                            const x = board[rr][cc];
                            if (x && x.suit === needSuit && x.value() === needVal) {
                                moves.push([[rr, cc], [r, c]]);
                                found = true;
                                break;
                            }
                        }
                }
            }
        }
        return moves;
    }

    static _seqLen(board, r) {
        const row = board[r];
        if (!row[0] || row[0].rank !== 2) return 0;
        let n = 1;
        for (let c = 1; c < 13; c++) {
            const prev = row[c - 1], curr = row[c];
            if (curr && prev && curr.suit === prev.suit && curr.value() === prev.value() + 1) n++;
            else break;
        }
        return n;
    }

    static _isWon(board) {
        for (let r = 0; r < 4; r++) {
            let suit = null;
            for (let c = 0; c < 12; c++) {
                const card = board[r][c];
                if (!card) return false;
                if (c === 0) {
                    if (card.rank !== 2) return false;
                    suit = card.suit;
                } else if (card.suit !== suit || card.value() !== board[r][c - 1].value() + 1) {
                    return false;
                }
            }
            if (board[r][12] !== null) return false;
        }
        return true;
    }

    // Apply a move in place; returns { gain, undo() } so the caller can backtrack.
    static _applyInPlace(board, src, dst) {
        const [sr, sc] = src, [dr, dc] = dst;
        const beforeS = Solver._seqLen(board, sr);
        const beforeD = Solver._seqLen(board, dr);
        const beforeLens = [Solver._seqLen(board, 0), Solver._seqLen(board, 1),
                            Solver._seqLen(board, 2), Solver._seqLen(board, 3)];
        const moved = board[sr][sc];
        board[dr][dc] = moved;
        board[sr][sc] = null;

        let gain = 0;
        const afterS = Solver._seqLen(board, sr);
        const afterD = Solver._seqLen(board, dr);
        if (afterD > beforeD && afterS >= beforeS) gain += _SOLVER_MOVE_BASE + dc;
        let comps = 0;
        for (let r = 0; r < 4; r++) {
            if (Solver._seqLen(board, r) === 12 && beforeLens[r] < 12) comps++;
        }
        if (comps) gain += comps * _SOLVER_ROW_BONUS;

        return { gain, undo() { board[sr][sc] = moved; board[dr][dc] = null; } };
    }

    static _key(board) {
        let s = "";
        for (let r = 0; r < 4; r++)
            for (let c = 0; c < 13; c++) {
                const x = board[r][c];
                s += x ? x.rank + x.suit : ".";
                s += ",";
            }
        return s;
    }

    // a is "better" than b: win > longer chain > more points.
    static _better(a, b) {
        if (a.won !== b.won) return a.won;
        if (a.len !== b.len) return a.len > b.len;
        return a.score > b.score;
    }

    // Depth-first longest non-repeating chain from `board` (already `depth` moves deep,
    // `scoreSoFar` points accrued). `pathSeen` holds board keys on the current line.
    static _dfs(board, pathSeen, depth, scoreSoFar, state) {
        if (Solver._isWon(board)) return { won: true, len: depth, score: scoreSoFar };
        // Best baseline = stop here (dead-end / budget / cap).
        let best = { won: false, len: depth, score: scoreSoFar };
        if (state.nodes > _SOLVER_NODE_BUDGET || depth >= _SOLVER_DEPTH_CAP) return best;

        for (const m of Solver._legalMoves(board)) {
            const ap  = Solver._applyInPlace(board, m[0], m[1]);
            const key = Solver._key(board);
            if (pathSeen.has(key)) { ap.undo(); continue; }   // no repeats
            state.nodes++;
            pathSeen.add(key);
            const res = Solver._dfs(board, pathSeen, depth + 1, scoreSoFar + ap.gain, state);
            pathSeen.delete(key);
            ap.undo();
            if (Solver._better(res, best)) best = res;
        }
        return best;
    }

    /**
     * Recommend the move that unlocks the longest chain of subsequent moves.
     * @returns {[[number,number],[number,number]]|null}
     */
    bestMove() {
        // Work on a clone so we never disturb the live game.
        const work  = this.engine.board.map(row => row.map(cell => cell ? cell.clone() : null));
        const roots = Solver._legalMoves(work);
        if (!roots.length) return null;
        if (roots.length === 1) return roots[0];

        const state    = { nodes: 0 };
        const pathSeen = new Set([Solver._key(work)]);

        let best = null;  // { move, won, len, score }
        for (const m of roots) {
            const ap  = Solver._applyInPlace(work, m[0], m[1]);
            const key = Solver._key(work);
            let res;
            if (pathSeen.has(key)) {
                res = { won: Solver._isWon(work), len: 1, score: ap.gain };
            } else {
                pathSeen.add(key);
                res = Solver._dfs(work, pathSeen, 1, ap.gain, state);
                pathSeen.delete(key);
            }
            ap.undo();
            const cand = { move: m, won: res.won, len: res.len, score: res.score };
            if (!best || Solver._better(cand, best)) best = cand;
        }
        return best.move;
    }

    explain(move) {
        const [[fr, fc], [tr, tc]] = move;
        const card  = this.engine.board[fr][fc];
        const cname = `${RANK_DISP[card.rank]} of ${SUIT_NAMES[card.suit]}`;
        if (tc === 0) return `Hint: Start a row with ${cname}`;
        const left  = this.engine.board[tr][tc - 1];
        const lname = `${RANK_DISP[left.rank]} of ${SUIT_NAMES[left.suit]}`;
        return `Hint: Place ${cname} after ${lname}`;
    }
}
