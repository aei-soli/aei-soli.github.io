/**
 * core/solver.js
 * Simple heuristic hint engine for SOLI.
 * Direct port of soli-refactor/core/solver.py
 */

"use strict";

class Solver {
    constructor(engine) {
        this.engine = engine;
    }

    bestMove() {
        const moves = this.engine.allMoves();
        if (!moves.length) return null;

        const score = ([[fr, fc], [tr, tc]]) => {
            let s = tc * 2;
            const card = this.engine.board[fr][fc];
            if (card.rank === 2 && tc === 0) s += 12;
            if (tc > 0) {
                const left = this.engine.board[tr][tc - 1];
                if (left) {
                    if (left.rank === 2) s += 10;
                    const lead = this.engine.board[tr][0];
                    if (lead && lead.rank === 2) s += 8;
                }
            }
            return s;
        };

        return moves.reduce((best, m) => score(m) > score(best) ? m : best);
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
