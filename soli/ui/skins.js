/**
 * ui/skins.js
 * Visual theming registry for SOLI: board SKINS + CARD_PACKS, plus the live PALETTE.
 *
 * Loaded BEFORE renderer.js. The renderer reads the shared global `PALETTE`; calling
 * applySkin(id) rewrites PALETTE in place so every drawing routine picks up new colours
 * on the next frame. (Cross-script top-level `const` sharing is the existing pattern in
 * this project — renderer.js already reads SUIT_SYMBOLS/RANK_DISP defined in card.js.)
 *
 * THREE things live here:
 *   1. SKINS      — board look (felt, accents, optional animation flags). Free + premium.
 *   2. CARD_PACKS — swappable card-face image sets + a card-back. Free + premium + slots.
 *   3. applySkin / helpers.
 *
 * Adding content later (see THEMING_GUIDE.md):
 *   • New skin  → add an entry to SKINS with a `palette` override + `premium` flag.
 *   • New cards → drop 52 PNGs (+ back.png) in web/assets/cards/<packId>/, then add a
 *                 CARD_PACKS entry with `dir:"<packId>/"`, `available:true`, `premium:true`.
 */

"use strict";

// ── Base palette (the original Classic Green look) ─────────────────────────────
const BASE_PALETTE = {
  felt:          "#1b5e3b",
  feltDark:      "#164d30",
  cardFace:      "#fffef8",
  cardShadow:    "rgba(0,0,0,0.35)",
  slotEmpty:     "rgba(255,255,255,0.18)",
  slotValid:     "rgba(52,211,153,0.28)",
  borderValid:   "#34d399",
  borderSelected:"#fbbf24",
  headerBg:      "rgba(0,0,0,0.28)",
  footerBg:      "rgba(0,0,0,0.28)",
  btnNormal:     "rgba(255,255,255,0.22)",
  btnBorder:     "rgba(255,255,255,0.38)",
  btnDisabled:   "rgba(255,255,255,0.10)",
  textPrimary:   "#ffffff",
  textMuted:     "rgba(255,255,255,0.55)",
  textDisabled:  "rgba(255,255,255,0.28)",
  overlayBg:     "rgba(0,0,0,0.60)",
  winGold:       "#fbbf24",
  redSuit:       "#c0392b",
  blackSuit:     "#1a1a2e",
  panelBg:       "#1e6b40",   // themes/menu panel fill (was hard-coded)
};

// The LIVE palette the renderer draws from. Starts as a copy of base.
const PALETTE = Object.assign({}, BASE_PALETTE);

// ── Skins ──────────────────────────────────────────────────────────────────────
// `palette` is a partial override merged over BASE_PALETTE.
// `anim`     optional: { sheen:true } draws a slow moving gloss across cards (premium feel),
//            `move:"arc"` makes card moves arc instead of sliding flat.
// ONLY the Classic Green deck is free. Every other skin requires Premium.
const SKINS = {
  green:    { label: "Classic Green", premium: false, palette: {} },

  // ── Premium skins (everything below requires the Premium unlock) ──
  blue:     { label: "Ocean",         premium: true,  palette: { felt: "#1a3f6e", feltDark: "#143257", panelBg: "#1f4a7d" } },
  midnight: { label: "Midnight Blue", premium: true,  palette: { felt: "#0d1b3e", feltDark: "#0a1531", panelBg: "#16264f" } },
  darkfelt: { label: "Dark Felt",     premium: true,  palette: { felt: "#2a2a2a", feltDark: "#1f1f1f", panelBg: "#333333" } },
  purple:   { label: "Royal Purple",  premium: true,  palette: { felt: "#3b1a5e", feltDark: "#2e1449", panelBg: "#4a2275" } },
  emerald:  { label: "Emerald Velvet", premium: true,
              palette: { felt: "#0f5132", feltDark: "#0a3a24", panelBg: "#13633e",
                         borderSelected: "#ffd700", winGold: "#ffd700" },
              anim: { sheen: true } },
  crimson:  { label: "Crimson Royale", premium: true,
              palette: { felt: "#5e1620", feltDark: "#471019", panelBg: "#73202c",
                         borderSelected: "#ffcf66", winGold: "#ffcf66", borderValid: "#ef9a9a", slotValid: "rgba(239,154,154,0.26)" },
              anim: { sheen: true } },
  carbon:   { label: "Carbon & Gold",  premium: true,
              palette: { felt: "#151515", feltDark: "#0c0c0c", panelBg: "#202020",
                         borderSelected: "#e0b84a", winGold: "#e0b84a", cardShadow: "rgba(0,0,0,0.6)" },
              anim: { sheen: true, move: "arc" } },
};

// ── Card packs ───────────────────────────────────────────────────────────────
// `dir`       image folder under assets/cards/ ("" = the existing flat default set).
// `back`      card-back filename within dir (used by face-down / future deal animation).
// `available` false = a planned slot; UI shows it greyed "Soon" and won't switch to it.
const CARD_PACKS = {
  classic:    { label: "Classic",      premium: false, available: true,  dir: "",            back: "back.png" },

  // ── Slots for future packs (drop art in assets/cards/<dir> then flip available:true) ──
  minimalist: { label: "Minimalist",   premium: true,  available: false, dir: "minimalist/", back: "back.png" },
  largepip:   { label: "Large Pip",    premium: true,  available: false, dir: "largepip/",   back: "back.png" },
  royal:      { label: "Royal",        premium: true,  available: false, dir: "royal/",      back: "back.png" },
};

// ── Apply / helpers ────────────────────────────────────────────────────────────

/** Rewrite the live PALETTE for skin `id` (falls back to green). Returns the skin. */
function applySkin(id) {
  const skin = SKINS[id] || SKINS.green;
  // Reset to base first so a previous skin's overrides don't leak, then apply.
  Object.assign(PALETTE, BASE_PALETTE, skin.palette || {});
  try { document.body.style.background = PALETTE.felt; } catch (_) {}
  return skin;
}

function getSkin(id)      { return SKINS[id] || SKINS.green; }
function getCardPack(id)  { return CARD_PACKS[id] || CARD_PACKS.classic; }

/** [{id,label,premium,anim}] in display order. */
function skinList() {
  return Object.keys(SKINS).map(id => ({ id, ...SKINS[id] }));
}
/** [{id,label,premium,available,dir,back}] in display order. */
function cardPackList() {
  return Object.keys(CARD_PACKS).map(id => ({ id, ...CARD_PACKS[id] }));
}

// Expose for non-bundled scripts.
window.SKINS = SKINS;
window.CARD_PACKS = CARD_PACKS;
window.applySkin = applySkin;
