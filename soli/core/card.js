/**
 * core/card.js
 * Pure domain model for playing cards in SOLI.
 * No UI, no platform dependencies.
 */

"use strict";

const SUITS = ["H", "D", "C", "S"];
const RANKS = [2, 3, 4, 5, 6, 7, 8, 9, 10, "J", "Q", "K", "A"];

const RANK_DISP = {
    2: "2", 3: "3", 4: "4", 5: "5", 6: "6", 7: "7",
    8: "8", 9: "9", 10: "10", J: "J", Q: "Q", K: "K", A: "A"
};

// Numerical value for ordering (2=2 … A=14)
const RANK_VAL = {};
RANKS.forEach((r, i) => { RANK_VAL[r] = i + 2; });

const SUIT_NAMES = { H: "Hearts", D: "Diamonds", C: "Clubs", S: "Spades" };
const SUIT_SYMBOLS = { H: "♥", D: "♦", C: "♣", S: "♠" };
const SUIT_COLORS  = { H: "#cc2222", D: "#cc2222", C: "#1a1a2e", S: "#1a1a2e" };

class Card {
    constructor(suit, rank) {
        this.suit = suit;
        this.rank = rank;
    }

    value() {
        return RANK_VAL[this.rank];
    }

    toString() {
        return `${RANK_DISP[this.rank]}${this.suit}`;
    }

    equals(other) {
        return other instanceof Card &&
               this.suit === other.suit &&
               this.rank === other.rank;
    }

    clone() {
        return new Card(this.suit, this.rank);
    }
}

function createDeck() {
    const deck = [];
    for (const suit of SUITS) {
        for (const rank of RANKS) {
            deck.push(new Card(suit, rank));
        }
    }
    return deck;
}
