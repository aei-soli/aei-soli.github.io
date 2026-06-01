/**
 * ui/renderer.js
 * Canvas drawing layer for SOLI web/iPad.
 * All coordinates are in CSS logical pixels; the caller is responsible for
 * applying the devicePixelRatio transform to the context before drawing.
 */

"use strict";

// ── Palette ──────────────────────────────────────────────────────────────────
const PALETTE = {
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
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function _fmtTime(secs) {
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}

// ── Renderer ─────────────────────────────────────────────────────────────────
class Renderer {
  /**
   * @param {HTMLCanvasElement} canvas
   */
  constructor(canvas) {
    this.canvas = canvas;
    this.ctx    = canvas.getContext("2d");
    this.layout = null;   // populated by computeLayout()
    this._cardImgs = {};  // keyed by card.toString() e.g. "2H"
    this._imgsReady = false;
    this._loadCardImages();
  }

  // ── Card image loading ───────────────────────────────────────────────────

  _cardFilename(suit, rank) {
    const SUIT_NAMES = { H: "hearts", D: "diamonds", C: "clubs", S: "spades" };
    const RANK_NAMES = {
      2:"2", 3:"3", 4:"4", 5:"5", 6:"6", 7:"7", 8:"8", 9:"9", 10:"10",
      J:"jack", Q:"queen", K:"king", A:"ace"
    };
    // window._SOLI_ASSET_BASE lets host pages (e.g. play-soli.html at root)
    // override the asset path prefix. Defaults to "" (relative, works for /soli/).
    const base = window._SOLI_ASSET_BASE || "";
    return `${base}assets/cards/${RANK_NAMES[rank]}_of_${SUIT_NAMES[suit]}.png`;
  }

  _loadCardImages() {
    const suits = ["H","D","C","S"];
    const ranks = [2,3,4,5,6,7,8,9,10,"J","Q","K","A"];
    let loaded = 0;
    const total = suits.length * ranks.length;
    for (const suit of suits) {
      for (const rank of ranks) {
        const key = `${rank}${suit}`;
        const img = new Image();
        img.onload = () => {
          loaded++;
          if (loaded === total) {
            this._imgsReady = true;
            // Trigger a full redraw now that all card images are ready
            if (this._onImgsReady) this._onImgsReady();
          }
        };
        img.onerror = () => { loaded++; }; // fall back to text if missing
        img.src = this._cardFilename(suit, rank);
        this._cardImgs[key] = img;
      }
    }
  }

  // ── Layout ──────────────────────────────────────────────────────────────

  /**
   * Recompute all layout metrics from current logical viewport size.
   * @param {number} W  logical width  (CSS px)
   * @param {number} H  logical height (CSS px)
   */
  computeLayout(W, H) {
    const COLS       = 13;
    const ROWS       = 4;
    const HEADER_H   = 62;
    const FOOTER_H   = 68;
    const BOARD_PAD  = 6;   // horizontal & vertical board padding
    const CELL_GAP   = 4;   // gap between cards

    // Available space for the board grid
    const availW = W - BOARD_PAD * 2;
    const availH = H - HEADER_H - FOOTER_H - BOARD_PAD * 2;

    // Cell and card dimensions
    const cellW  = availW / COLS;
    const cardW  = cellW - CELL_GAP;
    // Card height: standard ratio ≈ 1.43; but also constrained by row count
    const maxCardH = (availH / ROWS) - CELL_GAP;
    const cardH  = Math.min(Math.floor(cardW * 1.43), Math.floor(maxCardH));
    const rowH   = cardH + CELL_GAP;

    // Top-left of the board grid (centred within available space)
    const boardX = BOARD_PAD + (availW - cellW * COLS) / 2;
    const boardY = HEADER_H + BOARD_PAD + (availH - rowH * ROWS) / 2;

    this.layout = {
      W, H,
      COLS, ROWS,
      HEADER_H, FOOTER_H,
      BOARD_PAD, CELL_GAP,
      cellW, cardW, cardH, rowH,
      boardX, boardY,
    };
    return this.layout;
  }

  // ── Coordinate helpers ───────────────────────────────────────────────────

  /** Top-left corner of cell [row, col] */
  cellXY(row, col) {
    const { boardX, boardY, cellW, rowH } = this.layout;
    return [boardX + col * cellW, boardY + row * rowH];
  }

  /**
   * Return [row, col] for a tap at (px, py), or null if not on a cell.
   */
  hitTestBoard(px, py) {
    const { boardX, boardY, cellW, cardW, cardH, rowH, ROWS, COLS } = this.layout;
    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const x = boardX + c * cellW;
        const y = boardY + r * rowH;
        if (px >= x && px <= x + cardW && py >= y && py <= y + cardH) {
          return [r, c];
        }
      }
    }
    return null;
  }

  /**
   * Return the button id hit, or null.
   * @param {number} px
   * @param {number} py
   * @param {Array}  buttons  — from this.layout.buttons
   */
  hitTestButtons(px, py, buttons) {
    if (!buttons) return null;
    for (const btn of buttons) {
      if (!btn.disabled &&
          px >= btn.x && px <= btn.x + btn.w &&
          py >= btn.y && py <= btn.y + btn.h) {
        return btn.id;
      }
    }
    return null;
  }

  // ── Main draw ────────────────────────────────────────────────────────────

  /**
   * Full redraw.
   * @param {GameEngine} engine
   * @param {object}     uiState  { selected, validSlots, message }
   * @param {object|null} anim    Flying-card descriptor (see game.js _startAnim).
   *   { card, x, y, dstRow, dstCol }  — x/y are already-interpolated logical coords.
   */
  draw(engine, uiState, anim = null) {
    const { ctx } = this;
    const { W, H } = this.layout;

    // Felt background
    ctx.fillStyle = PALETTE.felt;
    ctx.fillRect(0, 0, W, H);

    this._drawHeader(engine, uiState);
    this._drawBoard(engine, uiState, anim);
    const buttons = this._drawFooter(engine);
    this.layout.buttons = buttons;   // store for hit-testing

    // Flying card drawn on top of the board
    if (anim) {
      this._drawCard(anim.card, anim.x, anim.y, "normal");
    }

    // GDPR must block everything else on first run
    if (uiState.showGDPR) {
      this._drawGDPR();
      return;
    }

    // Interstitial ad (blocks everything)
    if (uiState.adOverlay) {
      this._drawInterstitial(uiState.adOverlay);
      return;
    }

    // Bonus Round lifeline
    if (uiState.showBonusRound) {
      this._drawBonusRound(uiState.isPremium);
      return;
    }

    // Win overlay with name input (daily challenge)
    if (uiState.winInput) {
      this._drawWinOverlay(uiState.message || { title: "You Win!" }, uiState.winInput);
      return;
    }

    if (uiState.menuOpen) {
      this._drawMenu(engine, uiState);
    } else if (uiState.screen === "stats") {
      this._drawStats(uiState.stats);
    } else if (uiState.screen === "settings") {
      this._drawSettings(uiState.settings);
    } else if (uiState.screen === "highscores") {
      this._drawHighScores(uiState.highScores, uiState.hsTab || "regular");
    } else if (uiState.screen === "themes") {
      this._drawThemes(uiState.settings.theme || "green");
    } else if (uiState.screen === "privacy") {
      this._drawPrivacy();
    } else if (uiState.screen === "premium") {
      this._drawPremium(uiState.premiumState || {});
    } else if (uiState.screen === "howtoplay") {
      this._drawHowToPlay();
    } else if (uiState.message) {
      this._drawOverlay(uiState.message);
    }
  }

  // ── Header ───────────────────────────────────────────────────────────────

  /**
   * @param {GameEngine} engine
   * @param {object}     uiState  — needs uiState.timerSeconds
   */
  _drawHeader(engine, uiState) {
    const { ctx } = this;
    const { W, HEADER_H } = this.layout;

    ctx.fillStyle = PALETTE.headerBg;
    ctx.fillRect(0, 0, W, HEADER_H);

    // Four stat blocks: Score | Moves | Time | Round
    // Menu button takes ~52px on the right
    const MENU_BTN_W = 52;
    const statsW     = W - MENU_BTN_W;
    const secs       = uiState.timerSeconds || 0;
    const mm         = String(Math.floor(secs / 60)).padStart(2, "0");
    const ss         = String(secs % 60).padStart(2, "0");

    const stats = [
      { label: "SCORE",  value: String(engine.score) },
      { label: "MOVES",  value: String(engine.moves || 0) },
      { label: "TIME",   value: `${mm}:${ss}` },
      { label: uiState.gameType === "daily" ? "DAILY" : "ROUND",
        value: engine.round > 4 ? "Bonus" : `${engine.round} / 4` },
    ];

    const slotW  = statsW / stats.length;
    const labelY = HEADER_H * 0.30;
    const valueY = HEADER_H * 0.72;

    ctx.textBaseline = "middle";
    stats.forEach((s, i) => {
      const cx = slotW * i + slotW / 2;

      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = `10px system-ui, -apple-system, sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(s.label, cx, labelY);

      ctx.fillStyle = PALETTE.textPrimary;
      ctx.font      = `bold 16px system-ui, -apple-system, sans-serif`;
      ctx.fillText(s.value, cx, valueY);
    });

    // Thin separator line
    ctx.strokeStyle = "rgba(255,255,255,0.10)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(0, HEADER_H - 0.5);
    ctx.lineTo(W, HEADER_H - 0.5);
    ctx.stroke();

    this._drawMenuButton();
  }

  _drawMenuButton() {
    const { ctx } = this;
    const { W, HEADER_H } = this.layout;
    const BTN_W = 44;
    const BTN_H = 36;
    const x = W - BTN_W - 6;
    const y = (HEADER_H - BTN_H) / 2;

    // Store for hit-testing
    this.layout.menuBtn = { x, y, w: BTN_W, h: BTN_H };

    ctx.fillStyle = "rgba(255,255,255,0.15)";
    this._rrect(x, y, BTN_W, BTN_H, 8);
    ctx.fill();

    // Hamburger lines
    ctx.strokeStyle = PALETTE.textPrimary;
    ctx.lineWidth   = 2;
    ctx.lineCap     = "round";
    const cx = x + BTN_W / 2;
    const lineY = [y + BTN_H * 0.3, y + BTN_H * 0.5, y + BTN_H * 0.7];
    const hw = 10;
    for (const ly of lineY) {
      ctx.beginPath();
      ctx.moveTo(cx - hw, ly);
      ctx.lineTo(cx + hw, ly);
      ctx.stroke();
    }
  }

  /** Check if (px, py) is inside the menu button. */
  hitTestMenuButton(px, py) {
    const btn = this.layout.menuBtn;
    if (!btn) return false;
    return px >= btn.x && px <= btn.x + btn.w &&
           py >= btn.y && py <= btn.y + btn.h;
  }

  // ── Board ────────────────────────────────────────────────────────────────

  _drawBoard(engine, uiState, anim = null) {
    const { ROWS, COLS } = this.layout;
    const { selected, validSlots } = uiState;

    for (let r = 0; r < ROWS; r++) {
      for (let c = 0; c < COLS; c++) {
        const card = engine.board[r][c];
        const [x, y] = this.cellXY(r, c);

        let cellState = "normal";
        if (selected && selected[0] === r && selected[1] === c) {
          cellState = "selected";
        } else if (validSlots && validSlots.some(([vr, vc]) => vr === r && vc === c)) {
          cellState = "valid";
        }

        // While a card is flying into this cell, draw it as empty so the
        // sprite appears to land rather than pop from two places at once.
        const isAnimDst = anim && anim.dstRow === r && anim.dstCol === c;

        if (card && !isAnimDst) {
          this._drawCard(card, x, y, cellState);
        } else {
          this._drawEmptySlot(x, y, isAnimDst ? "normal" : cellState);
        }
      }
    }
  }

  // ── Card ─────────────────────────────────────────────────────────────────

  _drawCard(card, x, y, state) {
    const { ctx } = this;
    const { cardW, cardH } = this.layout;
    const R = 7;

    // Drop shadow
    ctx.save();
    ctx.shadowColor   = PALETTE.cardShadow;
    ctx.shadowBlur    = 8;
    ctx.shadowOffsetX = 0;
    ctx.shadowOffsetY = 3;
    ctx.fillStyle = PALETTE.cardFace;
    this._rrect(x, y, cardW, cardH, R);
    ctx.fill();
    ctx.restore();

    // Draw card image if loaded, otherwise fall back to text
    const imgKey = `${card.rank}${card.suit}`;
    const img = this._cardImgs[imgKey];
    if (img && img.complete && img.naturalWidth > 0) {
      // Clip to rounded rect so image doesn't overflow card corners
      ctx.save();
      this._rrect(x, y, cardW, cardH, R);
      ctx.clip();
      ctx.drawImage(img, x, y, cardW, cardH);
      ctx.restore();
    } else {
      // Fallback: text rendering
      const suitColor = (card.suit === "H" || card.suit === "D")
                        ? PALETTE.redSuit : PALETTE.blackSuit;
      const symbol    = SUIT_SYMBOLS[card.suit];
      const rankStr   = String(RANK_DISP[card.rank]);
      const cornerSize = Math.max(9, Math.floor(cardW * 0.27));
      ctx.fillStyle    = suitColor;
      ctx.textBaseline = "top";
      ctx.textAlign    = "left";
      ctx.font         = `bold ${cornerSize}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(rankStr, x + 4, y + 3);
      ctx.font         = `${Math.floor(cornerSize * 0.88)}px system-ui, -apple-system, sans-serif`;
      ctx.fillText(symbol, x + 4, y + 4 + cornerSize);
      const centreSize = Math.floor(cardW * 0.42);
      ctx.font         = `bold ${centreSize}px system-ui, -apple-system, sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(symbol, x + cardW / 2, y + cardH / 2);
    }

    // Selection/valid highlight border drawn on top of image
    if (state === "selected") {
      ctx.strokeStyle = PALETTE.borderSelected;
      ctx.lineWidth   = 3;
      this._rrect(x, y, cardW, cardH, R);
      ctx.stroke();
    } else if (state === "valid") {
      ctx.strokeStyle = PALETTE.borderValid;
      ctx.lineWidth   = 2.5;
      this._rrect(x, y, cardW, cardH, R);
      ctx.stroke();
    }
  }

  // ── Empty slot ───────────────────────────────────────────────────────────

  _drawEmptySlot(x, y, state) {
    const { ctx } = this;
    const { cardW, cardH } = this.layout;
    const R = 7;

    ctx.setLineDash([]);

    if (state === "valid") {
      // Solid green tinted fill + solid border
      ctx.fillStyle = PALETTE.slotValid;
      this._rrect(x, y, cardW, cardH, R);
      ctx.fill();

      ctx.strokeStyle = PALETTE.borderValid;
      ctx.lineWidth   = 2.5;
      this._rrect(x, y, cardW, cardH, R);
      ctx.stroke();
    } else {
      // Subtle dashed outline only
      ctx.strokeStyle = PALETTE.slotEmpty;
      ctx.lineWidth   = 1.5;
      ctx.setLineDash([4, 5]);
      this._rrect(x, y, cardW, cardH, R);
      ctx.stroke();
      ctx.setLineDash([]);
    }
  }

  // ── Footer / buttons ─────────────────────────────────────────────────────

  /**
   * Draw footer and return button descriptors.
   */
  _drawFooter(engine) {
    const { ctx } = this;
    const { W, H, FOOTER_H } = this.layout;
    const footerY = H - FOOTER_H;

    ctx.fillStyle = PALETTE.footerBg;
    ctx.fillRect(0, footerY, W, FOOTER_H);

    const buttons = this._buildButtons(engine, footerY, FOOTER_H, W);
    for (const btn of buttons) this._drawButton(btn);
    return buttons;
  }

  _buildButtons(engine, footerY, footerH, W) {
    const BTN_H  = 44;
    const BTN_Y  = footerY + (footerH - BTN_H) / 2;
    const PAD    = 8;

    const defs = [
      { id: "undo",      label: "Undo",       disabled: engine.history.length === 0 },
      { id: "redo",      label: "Redo",       disabled: engine.future.length === 0 },
      { id: "new",       label: "New Game",   disabled: false },
      {
        id: "nextround",
        label: "End Round",
        disabled: engine.gameWon,
      },
    ];

    const count  = defs.length;
    const btnW   = (W - PAD * (count + 1)) / count;

    return defs.map((d, i) => ({
      ...d,
      x: PAD + i * (btnW + PAD),
      y: BTN_Y,
      w: btnW,
      h: BTN_H,
    }));
  }

  _drawButton(btn) {
    const { ctx } = this;
    const { x, y, w, h, label, disabled } = btn;
    const R = 11;

    // Background
    ctx.fillStyle = disabled ? PALETTE.btnDisabled : PALETTE.btnNormal;
    this._rrect(x, y, w, h, R);
    ctx.fill();

    if (!disabled) {
      ctx.strokeStyle = PALETTE.btnBorder;
      ctx.lineWidth   = 1;
      this._rrect(x, y, w, h, R);
      ctx.stroke();
    }

    // Label
    ctx.fillStyle    = disabled ? PALETTE.textDisabled : PALETTE.textPrimary;
    ctx.font         = `${w < 90 ? 13 : 14}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2);
  }

  // ── Menu overlay ─────────────────────────────────────────────────────────

  _drawMenu(engine, uiState) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(340, W - 40);
    const itemH  = 42;
    const gap    = 6;
    const sepH   = 16;
    const pad    = 16;
    const soundH = 48;   // inline sound toggle row

    const groups = [
      [
        { id: "resume",         label: "Resume",         accent: true },
      ],
      [
        { id: "undo",           label: "Undo",           disabled: !engine.history.length },
        { id: "redo",           label: "Redo",           disabled: !engine.future.length },
        { id: "hint",
          label: uiState.isPremium ? "Show Hint" : `Show Hint (${Math.max(0, 3 - (uiState.hintsUsed || 0))} left)`,
          disabled: engine.isLocked || engine.gameWon },
      ],
      [
        { id: "newgame",        label: "New Game" },
        { id: "dailychallenge", label: "Daily Challenge" },
      ],
      [
        { id: "highscores",     label: "High Scores" },
        { id: "statistics",     label: "Statistics" },
      ],
      [
        { id: "themes",         label: "Themes" },
        { id: "gopremium",      label: "⭐  Go Premium" },
        { id: "howtoplay",      label: "How to Play" },
        { id: "privacy",        label: "Privacy" },
      ],
    ];

    const totalItems = groups.reduce((s, g) => s + g.length, 0);
    const totalSeps  = groups.length - 1;
    // +1 group separator worth of space for the sound toggle
    const panelH = pad * 2 + totalItems * (itemH + gap) - gap
                 + totalSeps * sepH + soundH + sepH;

    const panelX = (W - panelW) / 2;
    const panelY = Math.max(6, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    const menuBtns = [];
    let curY = panelY + pad;

    // ── Sound SFX toggle row ─────────────────────────────────────
    const bx = panelX + pad;
    const bw = panelW - pad * 2;
    ctx.fillStyle = "rgba(0,0,0,0.18)";
    this._rrect(bx, curY, bw, soundH, 10);
    ctx.fill();

    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("SFX", bx + 14, curY + soundH / 2);

    const sfxOn = uiState.settings && uiState.settings.sound;
    const tW = 48, tH = 26;
    const tx = bx + bw - 14 - tW;
    const ty = curY + (soundH - tH) / 2;
    ctx.fillStyle = sfxOn ? "#34d399" : "rgba(255,255,255,0.2)";
    this._rrect(tx, ty, tW, tH, tH / 2);
    ctx.fill();
    const kx = sfxOn ? tx + tW - tH / 2 - 2 : tx + tH / 2 + 2;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(kx, ty + tH / 2, tH / 2 - 2.5, 0, Math.PI * 2);
    ctx.fill();
    this.layout.menuSoundToggle = { x: bx, y: curY, w: bw, h: soundH };
    menuBtns.push({ id: "_sound", x: bx, y: curY, w: bw, h: soundH });

    curY += soundH;

    // Separator after sound row
    this._menuSep(panelX, curY, panelW, pad, sepH);
    curY += sepH;

    // ── Item groups ──────────────────────────────────────────────
    groups.forEach((group, gi) => {
      group.forEach((item) => {
        const by = curY;
        if (item.accent) {
          ctx.fillStyle = "rgba(255,255,255,0.24)";
        } else if (item.disabled) {
          ctx.fillStyle = "rgba(255,255,255,0.06)";
        } else {
          ctx.fillStyle = "rgba(0,0,0,0.22)";
        }
        this._rrect(bx, by, bw, itemH, 10);
        ctx.fill();

        ctx.fillStyle    = item.disabled ? PALETTE.textDisabled : PALETTE.textPrimary;
        ctx.font         = `${item.accent ? "bold " : ""}16px system-ui, -apple-system, sans-serif`;
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(item.label, bx + bw / 2, by + itemH / 2);

        if (!item.disabled) {
          menuBtns.push({ id: item.id, x: bx, y: by, w: bw, h: itemH });
        }
        curY += itemH + gap;
      });

      if (gi < groups.length - 1) {
        curY -= gap;
        this._menuSep(panelX, curY, panelW, pad, sepH);
        curY += sepH;
      }
    });

    this.layout.menuBtns = menuBtns;
  }

  _menuSep(panelX, curY, panelW, pad, sepH) {
    const { ctx } = this;
    ctx.strokeStyle = "rgba(255,255,255,0.12)";
    ctx.lineWidth   = 1;
    ctx.beginPath();
    ctx.moveTo(panelX + pad * 2, curY + sepH / 2);
    ctx.lineTo(panelX + panelW - pad * 2, curY + sepH / 2);
    ctx.stroke();
  }

  hitTestMenu(px, py) {
    const btns = this.layout.menuBtns;
    if (!btns) return null;
    for (const btn of btns) {
      if (px >= btn.x && px <= btn.x + btn.w &&
          py >= btn.y && py <= btn.y + btn.h) {
        return btn.id;
      }
    }
    return null;
  }

  // ── Stats overlay ────────────────────────────────────────────────────────

  _drawStats(stats) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(340, W - 40);
    const rows   = [
      ["Games Played",  stats.played],
      ["Games Won",     stats.won],
      ["Win Rate",      stats.played ? `${Math.round(stats.won / stats.played * 100)}%` : "—"],
      ["Best Score",    stats.bestScore || "—"],
      ["Best Time",     stats.bestTime  ? _fmtTime(stats.bestTime)  : "—"],
      ["Time Played",   stats.totalSeconds ? _fmtTime(stats.totalSeconds) : "—"],
    ];
    const rowH   = 44;
    const pad    = 20;
    const panelH = pad * 2 + 52 + rows.length * rowH + 52; // title + rows + close btn
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    // Title
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Statistics", panelX + panelW / 2, panelY + pad + 14);

    // Rows
    rows.forEach(([label, value], i) => {
      const ry = panelY + pad + 42 + i * rowH;
      ctx.fillStyle    = PALETTE.textMuted;
      ctx.font         = "14px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(label, panelX + pad, ry + rowH / 2);

      ctx.fillStyle    = PALETTE.textPrimary;
      ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "right";
      ctx.fillText(String(value), panelX + panelW - pad, ry + rowH / 2);

      // Light divider
      if (i < rows.length - 1) {
        ctx.strokeStyle = "rgba(255,255,255,0.10)";
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(panelX + pad, ry + rowH);
        ctx.lineTo(panelX + panelW - pad, ry + rowH);
        ctx.stroke();
      }
    });

    // Close button
    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);

    this.layout.statsCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestStatsClose(px, py) {
    const b = this.layout.statsCloseBtn;
    if (!b) return false;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  // ── Settings overlay ─────────────────────────────────────────────────────

  _drawSettings(settings) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(340, W - 40);
    const pad    = 20;
    const rowH   = 54;
    const panelH = pad * 2 + 52 + rowH + 52;
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    // Title
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Settings", panelX + panelW / 2, panelY + pad + 14);

    // Sound toggle row
    const ry  = panelY + pad + 42;
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "17px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("Sound Effects", panelX + pad, ry + rowH / 2);

    // Toggle pill
    const tW = 52, tH = 30;
    const tx = panelX + panelW - pad - tW;
    const ty = ry + (rowH - tH) / 2;
    const on = settings.sound;
    ctx.fillStyle = on ? "#34d399" : "rgba(255,255,255,0.2)";
    this._rrect(tx, ty, tW, tH, tH / 2);
    ctx.fill();
    // Knob
    const kx = on ? tx + tW - tH / 2 - 3 : tx + tH / 2 + 3;
    ctx.fillStyle = "#fff";
    ctx.beginPath();
    ctx.arc(kx, ty + tH / 2, tH / 2 - 3, 0, Math.PI * 2);
    ctx.fill();

    this.layout.soundToggle = { x: tx, y: ty, w: tW, h: tH };

    // Close button
    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);

    this.layout.settingsCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestSoundToggle(px, py) {
    const b = this.layout.soundToggle;
    if (!b) return false;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  hitTestSettingsClose(px, py) {
    const b = this.layout.settingsCloseBtn;
    if (!b) return false;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  // ── Premium overlay ──────────────────────────────────────────────────────

  /**
   * Two-step premium flow:
   *   ps.isPremium              → "already active" screen
   *   ps.step === "activate"    → email input / verify screen
   *   default (step "features") → features list + Buy + Already Purchased
   *
   * @param {{ step, email, emailActive, checking, result, isPremium }} ps
   */
  _drawPremium(ps) {
    const { ctx } = this;
    const { W, H } = this.layout;

    // Clear all layout refs on each draw to avoid stale hit areas
    this.layout.premiumCloseBtn    = null;
    this.layout.premiumBuyBtn      = null;
    this.layout.premiumActivateBtn = null;
    this.layout.premiumBackBtn     = null;
    this.layout.premiumEmailInput  = null;
    this.layout.premiumCheckBtn    = null;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(380, W - 40);
    const pad    = 22;
    const panelX = (W - panelW) / 2;

    // ── Already premium ──────────────────────────────────────────────
    if (ps.isPremium) {
      const panelH = 220;
      const panelY = Math.max(8, (H - panelH) / 2);
      this._premiumPanel(panelX, panelY, panelW, panelH);
      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#fbbf24";
      ctx.font      = "bold 24px system-ui, -apple-system, sans-serif";
      ctx.fillText("⭐  Go Premium", panelX + panelW / 2, panelY + pad + 12);
      ctx.fillStyle = "#34d399";
      ctx.font      = "bold 17px system-ui, -apple-system, sans-serif";
      ctx.fillText("✓ Premium Active", panelX + panelW / 2, panelY + 82);
      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = "14px system-ui, -apple-system, sans-serif";
      ctx.fillText("Unlimited hints · All themes · No ads", panelX + panelW / 2, panelY + 110);
      const cbx = panelX + pad, cbw = panelW - pad * 2, cby = panelY + panelH - pad - 36;
      this._premiumBtn(cbx, cby, cbw, 36, "rgba(255,255,255,0.15)", PALETTE.textPrimary, "Close", false);
      this.layout.premiumCloseBtn = { x: cbx, y: cby, w: cbw, h: 36 };
      return;
    }

    // ── Activate purchase screen ─────────────────────────────────────
    if (ps.step === "activate") {
      const panelH = 380;
      const panelY = Math.max(8, (H - panelH) / 2);
      this._premiumPanel(panelX, panelY, panelW, panelH);

      ctx.textAlign = "center"; ctx.textBaseline = "middle";
      ctx.fillStyle = "#fbbf24";
      ctx.font      = "bold 21px system-ui, -apple-system, sans-serif";
      ctx.fillText("Activate Purchase", panelX + panelW / 2, panelY + pad + 10);

      // Instructions
      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = "14px system-ui, -apple-system, sans-serif";
      ctx.fillText("Enter the email address used for", panelX + panelW / 2, panelY + 68);
      ctx.fillText("your Stripe payment, then press Verify.", panelX + panelW / 2, panelY + 88);

      // Email input
      const inputX = panelX + pad, inputW = panelW - pad * 2;
      const inputY = panelY + 112, inputH = 46;
      ctx.fillStyle  = "rgba(255,255,255,0.08)";
      this._rrect(inputX, inputY, inputW, inputH, 9); ctx.fill();
      ctx.strokeStyle = ps.emailActive ? "#fbbf24" : "rgba(255,255,255,0.25)";
      ctx.lineWidth   = ps.emailActive ? 2 : 1;
      this._rrect(inputX, inputY, inputW, inputH, 9); ctx.stroke();
      const cursor = ps.emailActive && Math.floor(Date.now() / 500) % 2 === 0 ? "|" : "";
      ctx.fillStyle    = (ps.email || "").length ? PALETTE.textPrimary : PALETTE.textDisabled;
      ctx.font         = "15px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "left"; ctx.textBaseline = "middle";
      ctx.fillText((ps.email || "your@email.com") + cursor, inputX + 10, inputY + inputH / 2);
      this.layout.premiumEmailInput = { x: inputX, y: inputY, w: inputW, h: inputH };

      // Privacy note
      ctx.fillStyle = "rgba(255,255,255,0.38)";
      ctx.font      = "12px system-ui, -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Your email is only used to verify this purchase.",
                   panelX + panelW / 2, inputY + inputH + 16);

      // Result message
      const resultY = inputY + inputH + 36;
      if (ps.result === false) {
        ctx.fillStyle = "#f87171";
        ctx.font      = "13px system-ui, -apple-system, sans-serif";
        ctx.fillText("No license found for this email.", panelX + panelW / 2, resultY);
      } else if (ps.result === null && !ps.checking && ps.email) {
        ctx.fillStyle = PALETTE.textDisabled;
        ctx.font      = "13px system-ui, -apple-system, sans-serif";
        ctx.fillText("Network error — try again.", panelX + panelW / 2, resultY);
      }

      // Verify button
      const hasEmail = (ps.email || "").includes("@");
      const verifyY  = panelY + panelH - pad - 36 - 10 - 46;
      const vBg  = ps.checking ? "rgba(255,255,255,0.15)" : hasEmail ? "#fbbf24" : "rgba(255,255,255,0.12)";
      const vFg  = ps.checking ? PALETTE.textMuted        : hasEmail ? "#0d2b1a" : PALETTE.textDisabled;
      this._premiumBtn(inputX, verifyY, inputW, 46, vBg, vFg, ps.checking ? "Checking…" : "Verify License", true);
      this.layout.premiumCheckBtn = (!ps.checking && hasEmail)
        ? { x: inputX, y: verifyY, w: inputW, h: 46 } : null;

      // Back button
      const backY = panelY + panelH - pad - 36;
      this._premiumBtn(inputX, backY, inputW, 36, "rgba(255,255,255,0.12)", PALETTE.textPrimary, "Back", false);
      this.layout.premiumBackBtn = { x: inputX, y: backY, w: inputW, h: 36 };
      return;
    }

    // ── Features / buy screen ────────────────────────────────────────
    const features = [
      "Full Cross-Platform Pass",
      "Full access: macOS · Web · Mobile",
      "No ads ever",
      "One-time purchase — no subscription",
      "Global Daily Challenge leaderboard",
      "Many themes and card faces",
    ];
    const featLineH = 24;
    const featH     = features.length * featLineH;
    // panelH = top pad + title + features + price line + buy btn + activate btn + close + bottom pad
    const panelH = pad + 42 + featH + 28 + 46 + 10 + 40 + 10 + 36 + pad;
    const panelY = Math.max(8, (H - panelH) / 2);
    this._premiumPanel(panelX, panelY, panelW, panelH);

    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillStyle = "#fbbf24";
    ctx.font      = "bold 24px system-ui, -apple-system, sans-serif";
    ctx.fillText("⭐  Go Premium", panelX + panelW / 2, panelY + pad + 10);

    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = "14px system-ui, -apple-system, sans-serif";
    features.forEach((f, i) =>
      ctx.fillText(`✓  ${f}`, panelX + panelW / 2, panelY + pad + 40 + i * featLineH));

    ctx.fillStyle = "#fbbf24";
    ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
    ctx.fillText("€4.99 launch price  ·  €9.99 regular",
                 panelX + panelW / 2, panelY + pad + 40 + featH + 14);

    const bx  = panelX + pad, bw = panelW - pad * 2;
    let   curY = panelY + pad + 40 + featH + 34;

    // Buy button
    this._premiumBtn(bx, curY, bw, 46, "#fbbf24", "#1a1a0a", "Buy Premium — €4.99", true);
    this.layout.premiumBuyBtn = { x: bx, y: curY, w: bw, h: 46 };
    curY += 46 + 10;

    // Already Purchased button
    ctx.fillStyle  = "rgba(255,255,255,0.13)";
    this._rrect(bx, curY, bw, 40, 10); ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.22)"; ctx.lineWidth = 1;
    this._rrect(bx, curY, bw, 40, 10); ctx.stroke();
    ctx.fillStyle = PALETTE.textPrimary;
    ctx.font      = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "center"; ctx.textBaseline = "middle";
    ctx.fillText("Already Purchased?  Activate License", bx + bw / 2, curY + 20);
    this.layout.premiumActivateBtn = { x: bx, y: curY, w: bw, h: 40 };
    curY += 40 + 10;

    // Close button
    this._premiumBtn(bx, curY, bw, 36, "rgba(255,255,255,0.10)", PALETTE.textMuted, "Close", false);
    this.layout.premiumCloseBtn = { x: bx, y: curY, w: bw, h: 36 };
  }

  /** Shared panel frame helper. */
  _premiumPanel(panelX, panelY, panelW, panelH) {
    const { ctx } = this;
    ctx.fillStyle   = "#1e3315";
    this._rrect(panelX, panelY, panelW, panelH, 18); ctx.fill();
    ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.5;
    this._rrect(panelX, panelY, panelW, panelH, 18); ctx.stroke();
  }

  /** Shared button helper. */
  _premiumBtn(x, y, w, h, bg, fg, label, bold) {
    const { ctx } = this;
    ctx.fillStyle = bg;
    this._rrect(x, y, w, h, 10); ctx.fill();
    ctx.fillStyle    = fg;
    ctx.font         = `${bold ? "bold " : ""}15px system-ui, -apple-system, sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, x + w / 2, y + h / 2);
  }

  hitTestPremium(px, py) {
    // Returns: 'close'|'buy'|'activate'|'back'|'emailinput'|'verify'|null
    const hit = (b, id) => b && px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h ? id : null;
    return hit(this.layout.premiumCloseBtn,    "close")
        || hit(this.layout.premiumBuyBtn,      "buy")
        || hit(this.layout.premiumActivateBtn, "activate")
        || hit(this.layout.premiumBackBtn,     "back")
        || hit(this.layout.premiumEmailInput,  "emailinput")
        || hit(this.layout.premiumCheckBtn,    "verify")
        || null;
  }

  // Keep old method name for backward compat
  hitTestPremiumClose(px, py) { return this.hitTestPremium(px, py) === "close"; }

  // ── How to Play overlay ──────────────────────────────────────────────────

  _drawHowToPlay() {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(360, W - 40);
    const pad    = 20;
    const lines  = [
      "Build 4 suit sequences: 2 → 3 → … → K",
      "Each row starts with a 2 in the first slot.",
      "Tap a card to select it, then tap a valid",
      "empty slot to move it.",
      "A slot is valid if the card to its left is",
      "the same suit and one rank lower.",
      "Kings cannot be followed — avoid blocking",
      "empty slots with Kings.",
      "If no moves remain, press Next Round to",
      "reshuffle the unplaced cards (up to 4×).",
    ];
    const lineH  = 26;
    const panelH = pad * 2 + 48 + lines.length * lineH + 52;
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("How to Play", panelX + panelW / 2, panelY + pad + 14);

    ctx.font         = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "left";
    ctx.fillStyle    = "rgba(255,255,255,0.85)";
    lines.forEach((line, i) => {
      ctx.fillText(line, panelX + pad, panelY + pad + 42 + i * lineH + lineH / 2);
    });

    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);

    this.layout.htpCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestHtpClose(px, py) {
    const b = this.layout.htpCloseBtn;
    if (!b) return false;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  // ── High Scores overlay ──────────────────────────────────────────────────

  /**
   * @param {{ regular: Array, daily: Array }} scores
   * @param {'regular'|'daily'} activeTab
   */
  _drawHighScores(scores, activeTab) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(360, W - 40);
    const pad    = 16;
    const rowH   = 36;
    const tabH   = 38;
    const rows   = scores[activeTab] || [];
    const visRows = Math.min(rows.length || 5, 15);
    const emptyH  = rows.length === 0 ? 52 : 0;
    const panelH  = pad * 2 + 44 + tabH + 8 + Math.max(visRows, 1) * rowH + emptyH + 52;
    const panelX  = (W - panelW) / 2;
    const panelY  = Math.max(6, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    // Title
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("High Scores", panelX + panelW / 2, panelY + pad + 14);

    // Tabs
    const tabY  = panelY + pad + 36;
    const tabW  = (panelW - pad * 2) / 2 - 3;
    const tabs  = [
      { id: "regular", label: "Regular",         x: panelX + pad },
      { id: "daily",   label: "Daily Challenge",  x: panelX + pad + tabW + 6 },
    ];
    const tabBtns = [];
    tabs.forEach(tab => {
      const active = tab.id === activeTab;
      ctx.fillStyle = active ? "rgba(255,255,255,0.28)" : "rgba(0,0,0,0.22)";
      this._rrect(tab.x, tabY, tabW, tabH, 10);
      ctx.fill();
      if (active) {
        ctx.strokeStyle = "rgba(255,255,255,0.35)";
        ctx.lineWidth   = 1;
        this._rrect(tab.x, tabY, tabW, tabH, 10);
        ctx.stroke();
      }
      ctx.fillStyle    = PALETTE.textPrimary;
      ctx.font         = `${active ? "bold " : ""}13px system-ui, -apple-system, sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(tab.label, tab.x + tabW / 2, tabY + tabH / 2);
      tabBtns.push({ id: tab.id, x: tab.x, y: tabY, w: tabW, h: tabH });
    });
    this.layout.hsTabs = tabBtns;

    // Column headers
    const listY = tabY + tabH + 8;
    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = "11px system-ui, -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    ctx.fillText("#", panelX + pad + 2, listY + 10);
    ctx.fillText("Score", panelX + pad + 28, listY + 10);
    ctx.textAlign = "center";
    ctx.fillText("Time", panelX + panelW / 2 + 10, listY + 10);
    ctx.textAlign = "right";
    ctx.fillText("Player", panelX + panelW - pad, listY + 10);

    if (rows.length === 0) {
      ctx.fillStyle    = PALETTE.textDisabled;
      ctx.font         = "15px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("No scores yet", panelX + panelW / 2, listY + 24 + emptyH / 2);
    } else {
      rows.forEach((entry, i) => {
        const ry = listY + 22 + i * rowH;
        // Alternate row tint
        if (i % 2 === 0) {
          ctx.fillStyle = "rgba(0,0,0,0.12)";
          this._rrect(panelX + pad, ry - 4, panelW - pad * 2, rowH, 6);
          ctx.fill();
        }
        ctx.textBaseline = "middle";
        const midRy = ry + rowH / 2 - 4;

        ctx.fillStyle = i === 0 ? "#fbbf24" : PALETTE.textPrimary;
        ctx.font      = `${i < 3 ? "bold " : ""}14px system-ui, -apple-system, sans-serif`;
        ctx.textAlign = "left";
        ctx.fillText(`${i + 1}`, panelX + pad + 2, midRy);
        ctx.fillText(String(entry.score), panelX + pad + 28, midRy);
        ctx.textAlign = "center";
        ctx.fillText(_fmtTime(entry.seconds), panelX + panelW / 2 + 10, midRy);
        ctx.textAlign = "right";
        ctx.fillStyle = PALETTE.textMuted;
        ctx.font      = "13px system-ui, -apple-system, sans-serif";
        ctx.fillText(entry.name || "—", panelX + panelW - pad, midRy);
      });
    }

    // Close button
    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);
    this.layout.hsCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestHighScores(px, py) {
    // Returns 'regular', 'daily', 'close', or null
    const close = this.layout.hsCloseBtn;
    if (close && px >= close.x && px <= close.x + close.w &&
        py >= close.y && py <= close.y + close.h) return "close";
    const tabs = this.layout.hsTabs || [];
    for (const t of tabs) {
      if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return t.id;
    }
    return null;
  }

  // ── Themes overlay ───────────────────────────────────────────────────────

  _drawThemes(currentTheme) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const themes = [
      { id: "green",    label: "Classic Green", felt: "#1b5e3b" },
      { id: "blue",     label: "Ocean",         felt: "#1a3f6e" },
      { id: "midnight", label: "Midnight Blue", felt: "#0d1b3e" },
      { id: "darkfelt", label: "Dark Felt",     felt: "#2a2a2a" },
      { id: "purple",   label: "Royal Purple",  felt: "#3b1a5e" },
    ];

    const panelW    = Math.min(360, W - 40);
    const pad       = 20;
    const swatchH   = 72;
    const swatchGap = 10;
    const cols      = 2;
    const rows      = Math.ceil(themes.length / cols);
    const swatchW = (panelW - pad * 2 - swatchGap) / cols;
    const panelH  = pad * 2 + 48 + rows * (swatchH + swatchGap) - swatchGap + 52;
    const panelX  = (W - panelW) / 2;
    const panelY  = Math.max(6, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Themes", panelX + panelW / 2, panelY + pad + 14);

    const themeBtns = [];
    themes.forEach((theme, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const sx  = panelX + pad + col * (swatchW + swatchGap);
      const sy  = panelY + pad + 42 + row * (swatchH + swatchGap);
      const sel = theme.id === currentTheme;

      ctx.fillStyle = theme.felt;
      this._rrect(sx, sy, swatchW, swatchH - 20, 10);
      ctx.fill();

      if (sel) {
        ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth   = 2.5;
        this._rrect(sx, sy, swatchW, swatchH - 20, 10);
        ctx.stroke();
        // Checkmark
        ctx.fillStyle = "#fbbf24";
        ctx.font      = "16px system-ui";
        ctx.textAlign = "right";
        ctx.textBaseline = "top";
        ctx.fillText("✓", sx + swatchW - 6, sy + 4);
      }

      ctx.fillStyle    = PALETTE.textPrimary;
      ctx.font         = `${sel ? "bold " : ""}14px system-ui, -apple-system, sans-serif`;
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(theme.label, sx + swatchW / 2, sy + swatchH - 10);

      themeBtns.push({ id: theme.id, x: sx, y: sy, w: swatchW, h: swatchH });
    });
    this.layout.themeBtns = themeBtns;

    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);
    this.layout.themeCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestThemes(px, py) {
    const close = this.layout.themeCloseBtn;
    if (close && px >= close.x && px <= close.x + close.w &&
        py >= close.y && py <= close.y + close.h) return "close";
    for (const t of (this.layout.themeBtns || [])) {
      if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return t.id;
    }
    return null;
  }

  // ── Privacy overlay ──────────────────────────────────────────────────────

  _drawPrivacy() {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(360, W - 40);
    const pad    = 20;
    const lineH  = 24;
    const lines  = [
      "SOLI does not collect or share",
      "any personal data.",
      "",
      "All game data — scores, statistics,",
      "and settings — is stored only on",
      "your device using localStorage.",
      "",
      "Free users see ads to support",
      "development. No personal tracking.",
    ];
    const panelH = pad * 2 + 48 + lines.length * lineH + 52;
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(6, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Privacy", panelX + panelW / 2, panelY + pad + 14);

    lines.forEach((line, i) => {
      if (!line) return;
      ctx.fillStyle    = "rgba(255,255,255,0.85)";
      ctx.font         = "15px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(line, panelX + panelW / 2, panelY + pad + 42 + i * lineH + lineH / 2);
    });

    const cbx = panelX + pad;
    const cby = panelY + panelH - pad - 40;
    const cbw = panelW - pad * 2;
    ctx.fillStyle = "rgba(255,255,255,0.20)";
    this._rrect(cbx, cby, cbw, 40, 10);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Close", cbx + cbw / 2, cby + 20);
    this.layout.privacyCloseBtn = { x: cbx, y: cby, w: cbw, h: 40 };
  }

  hitTestPrivacyClose(px, py) {
    const b = this.layout.privacyCloseBtn;
    if (!b) return false;
    return px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h;
  }

  // ── GDPR Consent screen ──────────────────────────────────────────────────

  _drawGDPR() {
    const { ctx } = this;
    const { W, H } = this.layout;

    // Full blocking overlay — no game visible beneath
    ctx.fillStyle = "#0d2b1a";
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(380, W - 32);
    const pad    = 22;
    const lineH  = 22;
    const lines  = [
      "SOLI uses Firebase to power the",
      "Daily Challenge global leaderboard.",
      "",
      "Your display name and game score",
      "may be stored on our servers when",
      "you submit a Daily Challenge result.",
      "",
      "No account required. No tracking.",
      "You can play without the leaderboard.",
    ];
    const btnH   = 48;
    const panelH = pad * 2 + 54 + lines.length * lineH + 16 + btnH + 10 + btnH + pad;
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.20)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    // Icon + title
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Before we start 🃏", panelX + panelW / 2, panelY + pad + 14);

    // Body text
    ctx.font         = "14px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    lines.forEach((line, i) => {
      if (!line) return;
      ctx.fillStyle = i < 2 ? PALETTE.textPrimary : "rgba(255,255,255,0.78)";
      ctx.fillText(line, panelX + panelW / 2, panelY + pad + 46 + i * lineH);
    });

    // Buttons
    const bx  = panelX + pad;
    const bw  = panelW - pad * 2;
    const by1 = panelY + panelH - pad - btnH * 2 - 10;
    const by2 = by1 + btnH + 10;

    // Accept button (primary)
    ctx.fillStyle = "#34d399";
    this._rrect(bx, by1, bw, btnH, 12);
    ctx.fill();
    ctx.fillStyle    = "#0d2b1a";
    ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Accept & Play", bx + bw / 2, by1 + btnH / 2);

    // Decline button (secondary)
    ctx.fillStyle = "rgba(255,255,255,0.15)";
    this._rrect(bx, by2, bw, btnH, 12);
    ctx.fill();
    ctx.fillStyle    = PALETTE.textMuted;
    ctx.font         = "15px system-ui, -apple-system, sans-serif";
    ctx.fillText("Play without leaderboard", bx + bw / 2, by2 + btnH / 2);

    this.layout.gdprAcceptBtn  = { x: bx, y: by1, w: bw, h: btnH };
    this.layout.gdprDeclineBtn = { x: bx, y: by2, w: bw, h: btnH };
  }

  hitTestGDPR(px, py) {
    const a = this.layout.gdprAcceptBtn;
    const d = this.layout.gdprDeclineBtn;
    if (a && px >= a.x && px <= a.x + a.w && py >= a.y && py <= a.y + a.h) return "accept";
    if (d && px >= d.x && px <= d.x + d.w && py >= d.y && py <= d.y + d.h) return "decline";
    return null;
  }

  // ── Win overlay with name input ───────────────────────────────────────────

  /**
   * @param {object} message   { title, subtitle, color }
   * @param {object} nameInput { value, active, submitted, firebaseOk }
   */
  _drawWinOverlay(message, nameInput) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(360, W - 40);
    const pad    = 20;
    const panelH = nameInput ? (nameInput.useFirebase ? 320 : 280) : 200;
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e3a25";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = message.color || "rgba(255,255,255,0.2)";
    ctx.lineWidth   = 1.5;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    // Title
    ctx.fillStyle    = message.color || PALETTE.textPrimary;
    ctx.font         = `bold ${Math.floor(panelW * 0.12)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(message.title, panelX + panelW / 2, panelY + pad + 18);

    // Subtitle (score · time)
    ctx.fillStyle    = PALETTE.textMuted;
    ctx.font         = "16px system-ui, -apple-system, sans-serif";
    ctx.fillText(message.subtitle || "", panelX + panelW / 2, panelY + pad + 52);

    if (!nameInput) {
      // Tap to dismiss hint
      ctx.fillStyle = PALETTE.textDisabled;
      ctx.font      = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("Tap to continue", panelX + panelW / 2, panelY + panelH / 2 + 30);
      return;
    }

    // ── Daily Challenge name input + submit ──────────────────
    const inputY = panelY + 90;
    const inputW = panelW - pad * 2;
    const inputH = 46;
    const inputX = panelX + pad;

    if (!nameInput.submitted) {
      // Label
      ctx.fillStyle    = "rgba(255,255,255,0.6)";
      ctx.font         = "13px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        nameInput.useFirebase ? "Submit to global leaderboard:" : "Your name (optional):",
        inputX, inputY - 12
      );

      // Input field
      ctx.fillStyle = nameInput.active ? "rgba(255,255,255,0.15)" : "rgba(255,255,255,0.08)";
      this._rrect(inputX, inputY, inputW, inputH, 10);
      ctx.fill();
      ctx.strokeStyle = nameInput.active ? "#34d399" : "rgba(255,255,255,0.25)";
      ctx.lineWidth   = nameInput.active ? 2 : 1;
      this._rrect(inputX, inputY, inputW, inputH, 10);
      ctx.stroke();

      const displayText = nameInput.value || "";
      const cursor      = nameInput.active && Math.floor(Date.now() / 500) % 2 === 0 ? "|" : "";
      ctx.fillStyle    = displayText ? PALETTE.textPrimary : PALETTE.textDisabled;
      ctx.font         = "17px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "left";
      ctx.textBaseline = "middle";
      ctx.fillText(
        (displayText || "Your name") + cursor,
        inputX + 12, inputY + inputH / 2
      );

      this.layout.winNameInput = { x: inputX, y: inputY, w: inputW, h: inputH };

      if (nameInput.useFirebase) {
        // Submit button (daily challenge Firebase flow)
        const sbY = inputY + inputH + 10;
        const hasName = displayText.trim().length > 0;
        ctx.fillStyle = hasName ? "#34d399" : "rgba(255,255,255,0.15)";
        this._rrect(inputX, sbY, inputW, 44, 10);
        ctx.fill();
        ctx.fillStyle    = hasName ? "#0d2b1a" : PALETTE.textDisabled;
        ctx.font         = "bold 15px system-ui, -apple-system, sans-serif";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Submit Score", inputX + inputW / 2, sbY + 22);
        this.layout.winSubmitBtn = hasName
          ? { x: inputX, y: sbY, w: inputW, h: 44 }
          : null;

        // Skip link
        const skipY = sbY + 54;
        ctx.fillStyle = PALETTE.textDisabled;
        ctx.font      = "13px system-ui, -apple-system, sans-serif";
        ctx.fillText("Skip — play again", inputX + inputW / 2, skipY);
        this.layout.winSkipBtn      = { x: inputX, y: skipY - 12, w: inputW, h: 24 };
        this.layout.winPlayAgainBtn = null;
      } else {
        // Play Again button (regular wins — saves name locally)
        const paY = inputY + inputH + 10;
        ctx.fillStyle = "#34d399";
        this._rrect(inputX, paY, inputW, 46, 12);
        ctx.fill();
        ctx.fillStyle    = "#0d2b1a";
        ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
        ctx.textAlign    = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Play Again", inputX + inputW / 2, paY + 23);
        this.layout.winPlayAgainBtn = { x: inputX, y: paY, w: inputW, h: 46 };
        this.layout.winSubmitBtn    = null;
        this.layout.winSkipBtn      = null;
      }

    } else {
      // Submitted state
      const ok = nameInput.firebaseOk;
      const mid = panelY + panelH / 2;

      ctx.fillStyle    = ok ? "#34d399" : PALETTE.textMuted;
      ctx.font         = "bold 17px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(
        ok ? "Score submitted! 🎉" : "Saved locally (offline)",
        panelX + panelW / 2, mid - 36
      );

      // View Leaderboard button
      const lbX = panelX + pad;
      const lbW = panelW - pad * 2;
      const lbY = mid - 6;
      ctx.fillStyle = ok ? "#34d399" : "rgba(255,255,255,0.18)";
      this._rrect(lbX, lbY, lbW, 44, 10);
      ctx.fill();
      ctx.fillStyle    = ok ? "#0d2b1a" : PALETTE.textPrimary;
      ctx.font         = "bold 15px system-ui, -apple-system, sans-serif";
      ctx.fillText("View Today's Leaderboard", lbX + lbW / 2, lbY + 22);
      this.layout.winLeaderboardBtn = { x: lbX, y: lbY, w: lbW, h: 44 };

      // Continue / tap anywhere hint
      ctx.fillStyle = PALETTE.textDisabled;
      ctx.font      = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText("Tap anywhere to continue", panelX + panelW / 2, lbY + 62);
    }
  }

  hitTestWinOverlay(px, py) {
    // Returns 'nameinput' | 'submit' | 'skip' | 'leaderboard' | 'playagain' | null
    const ni = this.layout.winNameInput;
    const sb = this.layout.winSubmitBtn;
    const sk = this.layout.winSkipBtn;
    const lb = this.layout.winLeaderboardBtn;
    const pa = this.layout.winPlayAgainBtn;
    if (lb && px >= lb.x && px <= lb.x + lb.w && py >= lb.y && py <= lb.y + lb.h) return "leaderboard";
    if (pa && px >= pa.x && px <= pa.x + pa.w && py >= pa.y && py <= pa.y + pa.h) return "playagain";
    if (ni && px >= ni.x && px <= ni.x + ni.w && py >= ni.y && py <= ni.y + ni.h) return "nameinput";
    if (sb && px >= sb.x && px <= sb.x + sb.w && py >= sb.y && py <= sb.y + sb.h) return "submit";
    if (sk && px >= sk.x && px <= sk.x + sk.w && py >= sk.y && py <= sk.y + sk.h) return "skip";
    return null;
  }

  // ── Bonus Round (lifeline) overlay ──────────────────────────────────────

  /**
   * @param {boolean} isPremium  — if true, omit the "ad will play" note
   * @param {boolean} canPlayR5  — always true (engine supports force=true)
   */
  _drawBonusRound(isPremium) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = "rgba(0,0,0,0.72)";
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(360, W - 40);
    const pad    = 22;
    const panelH = 310;
    const panelX = (W - panelW) / 2;
    const panelY = (H - panelH) / 2;

    ctx.fillStyle = "#1a2e1a";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "#fbbf24";
    ctx.lineWidth   = 1.5;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    // Title
    ctx.fillStyle = "#fbbf24";
    ctx.font      = "bold 22px system-ui, -apple-system, sans-serif";
    ctx.fillText("🃏  Lifeline", panelX + panelW / 2, panelY + pad + 12);

    // Body
    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = "15px system-ui, -apple-system, sans-serif";
    ctx.fillText("Round 4 is over. What would you like to do?",
                 panelX + panelW / 2, panelY + 72);

    const bx  = panelX + pad;
    const bw  = panelW - pad * 2;

    // Replay R4 button
    const r4Y = panelY + 102;
    ctx.fillStyle = "rgba(255,255,255,0.18)";
    this._rrect(bx, r4Y, bw, 54, 12);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.3)";
    ctx.lineWidth   = 1;
    this._rrect(bx, r4Y, bw, 54, 12);
    ctx.stroke();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
    ctx.fillText("Replay Round 4", bx + bw / 2, r4Y + 22);
    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = "13px system-ui, -apple-system, sans-serif";
    ctx.fillText("Same cards, fresh start", bx + bw / 2, r4Y + 40);
    this.layout.bonusReplayBtn = { x: bx, y: r4Y, w: bw, h: 54 };

    // Play R5 button
    const r5Y = r4Y + 64;
    ctx.fillStyle = "#34d399";
    this._rrect(bx, r5Y, bw, 54, 12);
    ctx.fill();
    ctx.fillStyle    = "#0d2b1a";
    ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
    ctx.fillText("Play Round 5", bx + bw / 2, r5Y + 22);
    ctx.fillStyle = "rgba(0,0,0,0.5)";
    ctx.font      = "13px system-ui, -apple-system, sans-serif";
    ctx.fillText(
      isPremium ? "Bonus round — beyond the limit!" : "A short ad plays first",
      bx + bw / 2, r5Y + 40
    );
    this.layout.bonusR5Btn = { x: bx, y: r5Y, w: bw, h: 54 };

    // New Game — proper button (not faded text)
    const ngY = r5Y + 64;
    ctx.fillStyle = "rgba(255,255,255,0.14)";
    this._rrect(bx, ngY, bw, 40, 10);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth   = 1;
    this._rrect(bx, ngY, bw, 40, 10);
    ctx.stroke();
    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "15px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("New Game", bx + bw / 2, ngY + 20);
    this.layout.bonusNewBtn = { x: bx, y: ngY, w: bw, h: 40 };
  }

  hitTestBonusRound(px, py) {
    const r4 = this.layout.bonusReplayBtn;
    const r5 = this.layout.bonusR5Btn;
    const ng = this.layout.bonusNewBtn;
    if (r4 && px >= r4.x && px <= r4.x + r4.w && py >= r4.y && py <= r4.y + r4.h) return "replay";
    if (r5 && px >= r5.x && px <= r5.x + r5.w && py >= r5.y && py <= r5.y + r5.h) return "r5";
    if (ng && px >= ng.x && px <= ng.x + ng.w && py >= ng.y && py <= ng.y + ng.h) return "new";
    return null;
  }

  // ── Interstitial ad overlay (browser) ────────────────────────────────────

  /**
   * @param {{ remaining, total, canClose }} state  — from AdManager.overlayState
   */
  _drawInterstitial(state) {
    const { ctx } = this;
    const { W, H } = this.layout;

    // Full black cover
    ctx.fillStyle = "#050f08";
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;

    // Logo / title
    ctx.fillStyle    = "#34d399";
    ctx.font         = `bold ${Math.floor(W * 0.11)}px system-ui, -apple-system, sans-serif`;
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("SOLI", cx, H * 0.28);

    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = "16px system-ui, -apple-system, sans-serif";
    ctx.fillText("A premium solitaire experience", cx, H * 0.38);

    // Progress bar
    const barW  = Math.min(280, W - 80);
    const barX  = cx - barW / 2;
    const barY  = H * 0.52;
    const barH  = 6;
    const prog  = 1 - (state.remaining / state.total);

    ctx.fillStyle = "rgba(255,255,255,0.12)";
    this._rrect(barX, barY, barW, barH, barH / 2);
    ctx.fill();
    if (prog > 0) {
      ctx.fillStyle = "#34d399";
      this._rrect(barX, barY, barW * prog, barH, barH / 2);
      ctx.fill();
    }

    // Countdown
    ctx.fillStyle    = PALETTE.textMuted;
    ctx.font         = "14px system-ui, -apple-system, sans-serif";
    ctx.textBaseline = "middle";
    ctx.fillText(
      state.canClose ? "Tap Continue to play" : `Resuming in ${state.remaining}s…`,
      cx, barY + 28
    );

    // Go Premium button
    const gpW = Math.min(280, W - 60);   // wider to fit the label
    const gpX = cx - gpW / 2;
    const gpY = H * 0.66;
    ctx.fillStyle = "#fbbf24";
    this._rrect(gpX, gpY, gpW, 48, 12);
    ctx.fill();
    ctx.fillStyle    = "#1a1a0a";
    ctx.font         = "bold 14px system-ui, -apple-system, sans-serif";  // slightly smaller
    ctx.textBaseline = "middle";
    ctx.fillText("⭐  Go Premium — Remove Ads", cx, gpY + 24);
    this.layout.adPremiumBtn = { x: gpX, y: gpY, w: gpW, h: 48 };

    // Continue button (only when countdown done)
    const contW = gpW;
    const contX = cx - contW / 2;
    const contY = gpY + 62;
    ctx.fillStyle = state.canClose ? "rgba(255,255,255,0.22)" : "rgba(255,255,255,0.07)";
    this._rrect(contX, contY, contW, 44, 12);
    ctx.fill();
    ctx.fillStyle    = state.canClose ? PALETTE.textPrimary : PALETTE.textDisabled;
    ctx.font         = "15px system-ui, -apple-system, sans-serif";
    ctx.fillText("Continue", cx, contY + 22);
    this.layout.adContinueBtn = state.canClose
      ? { x: contX, y: contY, w: contW, h: 44 } : null;
  }

  hitTestInterstitial(px, py) {
    const prem = this.layout.adPremiumBtn;
    const cont = this.layout.adContinueBtn;
    if (prem && px >= prem.x && px <= prem.x + prem.w && py >= prem.y && py <= prem.y + prem.h) return "premium";
    if (cont && px >= cont.x && px <= cont.x + cont.w && py >= cont.y && py <= cont.y + cont.h) return "continue";
    return null;
  }

  // ── Daily Challenge date picker ──────────────────────────────────────────

  /**
   * @param {Array<{label, dateStr}>} options   list of available dates
   * @param {boolean}                 isPremium  show all dates vs. today only
   */
  _drawDailyPicker(options, isPremium) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const panelW = Math.min(340, W - 40);
    const pad    = 20;
    const itemH  = 50;
    const gap    = 8;
    const panelH = pad * 2 + 44 + options.length * (itemH + gap) - gap + (isPremium ? 0 : 56);
    const panelX = (W - panelW) / 2;
    const panelY = Math.max(8, (H - panelH) / 2);

    ctx.fillStyle = "#1e6b40";
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.18)";
    ctx.lineWidth   = 1;
    this._rrect(panelX, panelY, panelW, panelH, 18);
    ctx.stroke();

    ctx.fillStyle    = PALETTE.textPrimary;
    ctx.font         = "bold 20px system-ui, -apple-system, sans-serif";
    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("Daily Challenge", panelX + panelW / 2, panelY + pad + 12);

    const bx = panelX + pad;
    const bw = panelW - pad * 2;
    const btns = [];

    options.forEach((opt, i) => {
      const by = panelY + pad + 40 + i * (itemH + gap);
      ctx.fillStyle = "rgba(0,0,0,0.22)";
      this._rrect(bx, by, bw, itemH, 10);
      ctx.fill();

      ctx.fillStyle    = PALETTE.textPrimary;
      ctx.font         = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(opt.label, bx + bw / 2, by + itemH / 2 - 7);

      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = "13px system-ui, -apple-system, sans-serif";
      ctx.fillText(opt.dateStr, bx + bw / 2, by + itemH / 2 + 11);

      btns.push({ id: opt.dateStr, x: bx, y: by, w: bw, h: itemH });
    });

    // Upsell for non-premium
    if (!isPremium) {
      const uy = panelY + panelH - pad - 40;
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      this._rrect(bx, uy, bw, 40, 10);
      ctx.fill();
      ctx.fillStyle    = PALETTE.textMuted;
      ctx.font         = "13px system-ui, -apple-system, sans-serif";
      ctx.textAlign    = "center";
      ctx.textBaseline = "middle";
      ctx.fillText("⭐  Premium unlocks past challenges", bx + bw / 2, uy + 20);
      btns.push({ id: "_premium", x: bx, y: uy, w: bw, h: 40 });
    }

    this.layout.dailyPickerBtns = btns;
  }

  hitTestDailyPicker(px, py) {
    const btns = this.layout.dailyPickerBtns;
    if (!btns) return null;
    for (const b of btns) {
      if (px >= b.x && px <= b.x + b.w && py >= b.y && py <= b.y + b.h) return b.id;
    }
    return null;
  }

  // ── Overlay (win / locked / game-over) ──────────────────────────────────

  /**
   * @param {object} message  { title, subtitle, color, type }
   *   type: 'win' | 'locked' | undefined
   */
  _drawOverlay(message) {
    const { ctx } = this;
    const { W, H } = this.layout;

    ctx.fillStyle = PALETTE.overlayBg;
    ctx.fillRect(0, 0, W, H);

    const cx = W / 2;
    const cy = H / 2;

    ctx.textAlign    = "center";
    ctx.textBaseline = "middle";

    ctx.fillStyle = message.color || PALETTE.textPrimary;
    ctx.font      = `bold ${Math.floor(W * 0.065)}px system-ui, -apple-system, sans-serif`;
    ctx.fillText(message.title, cx, cy - 40);

    ctx.fillStyle = PALETTE.textMuted;
    ctx.font      = `${Math.floor(W * 0.038)}px system-ui, -apple-system, sans-serif`;
    const subtitleLines = (message.subtitle || "").split("\n");
    subtitleLines.forEach((line, i) => ctx.fillText(line, cx, cy + i * 22));

    const bw  = Math.min(220, W - 60);
    const bx  = cx - bw / 2;
    const bhH = 46;
    // Reset all 3 button slots on every draw
    this.layout.overlayBtn1 = null;
    this.layout.overlayBtn2 = null;
    this.layout.overlayBtn3 = null;

    if (message.type === "win") {
      // Play Again (primary) + New Game (secondary)
      const b1y = cy + 32;
      ctx.fillStyle = "#34d399";
      this._rrect(bx, b1y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = "#0d2b1a";
      ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText("Play Again", cx, b1y + bhH / 2);
      this.layout.overlayBtn1 = { id: "playagain", x: bx, y: b1y, w: bw, h: bhH };

      const b2y = b1y + bhH + 10;
      ctx.fillStyle = "rgba(255,255,255,0.18)";
      this._rrect(bx, b2y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = PALETTE.textPrimary;
      ctx.font      = "15px system-ui, -apple-system, sans-serif";
      ctx.fillText("New Game", cx, b2y + bhH / 2);
      this.layout.overlayBtn2 = { id: "newgame", x: bx, y: b2y, w: bw, h: bhH };

    } else if (message.type === "locked") {
      // Rounds 1-3 locked: dynamic label + Undo
      const b1Label = message.btn1Label || "End Round";
      const b1bw = Math.min(Math.max(bw, b1Label.length * 10 + 40), W - 60);
      const b1bx = cx - b1bw / 2;
      const b1y  = cy + 32;
      ctx.fillStyle = "#34d399";
      this._rrect(b1bx, b1y, b1bw, bhH, 12); ctx.fill();
      ctx.fillStyle = "#0d2b1a";
      ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText(b1Label, cx, b1y + bhH / 2);
      this.layout.overlayBtn1 = { id: "endround", x: b1bx, y: b1y, w: b1bw, h: bhH };

      const b2y = b1y + bhH + 10;
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      this._rrect(bx, b2y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = "15px system-ui, -apple-system, sans-serif";
      ctx.fillText("Undo Last Move", cx, b2y + bhH / 2);
      this.layout.overlayBtn2 = { id: "undo", x: bx, y: b2y, w: bw, h: bhH };

    } else if (message.type === "r4locked") {
      // Round 4 locked: 3 options — New Game (with score check), Lifeline, Undo
      const b1y = cy + 20;
      ctx.fillStyle = "#34d399";
      this._rrect(bx, b1y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = "#0d2b1a";
      ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText("New Game", cx, b1y + bhH / 2);
      this.layout.overlayBtn1 = { id: "endgame", x: bx, y: b1y, w: bw, h: bhH };

      const b2y = b1y + bhH + 8;
      ctx.fillStyle  = "rgba(255,211,0,0.18)";
      this._rrect(bx, b2y, bw, bhH, 12); ctx.fill();
      ctx.strokeStyle = "#fbbf24"; ctx.lineWidth = 1.2;
      this._rrect(bx, b2y, bw, bhH, 12); ctx.stroke();
      ctx.fillStyle = "#fbbf24";
      ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText("🃏  Lifeline", cx, b2y + bhH / 2);
      this.layout.overlayBtn2 = { id: "lifeline", x: bx, y: b2y, w: bw, h: bhH };

      const b3y = b2y + bhH + 8;
      ctx.fillStyle = "rgba(255,255,255,0.10)";
      this._rrect(bx, b3y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = PALETTE.textMuted;
      ctx.font      = "15px system-ui, -apple-system, sans-serif";
      ctx.fillText("Undo Last Move", cx, b3y + bhH / 2);
      this.layout.overlayBtn3 = { id: "undo", x: bx, y: b3y, w: bw, h: bhH };

    } else if (message.type === "gameover") {
      const b1y = cy + 32;
      ctx.fillStyle = "#34d399";
      this._rrect(bx, b1y, bw, bhH, 12); ctx.fill();
      ctx.fillStyle = "#0d2b1a";
      ctx.font      = "bold 16px system-ui, -apple-system, sans-serif";
      ctx.fillText("New Game", cx, b1y + bhH / 2);
      this.layout.overlayBtn1 = { id: "newgame", x: bx, y: b1y, w: bw, h: bhH };
    }
  }

  hitTestOverlay(px, py) {
    for (const btn of [this.layout.overlayBtn1, this.layout.overlayBtn2, this.layout.overlayBtn3]) {
      if (btn && px >= btn.x && px <= btn.x + btn.w &&
          py >= btn.y && py <= btn.y + btn.h) return btn.id;
    }
    return null;
  }

  // ── Utility: rounded rectangle path ─────────────────────────────────────

  _rrect(x, y, w, h, r) {
    const { ctx } = this;
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y,     x + w, y + r,     r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x,     y + h, x,     y + h - r, r);
    ctx.lineTo(x,     y + r);
    ctx.arcTo(x,     y,     x + r, y,         r);
    ctx.closePath();
  }
}
