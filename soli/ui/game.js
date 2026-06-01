/**
 * ui/game.js
 * Top-level controller for SOLI web/iPad.
 * Wires together: GameEngine (core logic) + Renderer (canvas) + InputHandler.
 *
 * UI state machine:
 *   idle  → tap card       → selected  (card highlighted, valid slots shown)
 *   selected → tap valid   → move applied → idle
 *   selected → tap invalid → idle (deselect)
 *   selected → tap same    → idle (deselect)
 *   any state → button tap → action, back to idle
 *   any state → overlay shown → tap anywhere → overlay dismissed
 */

"use strict";

class GameUI {
  constructor() {
    this.canvas   = document.getElementById("game");
    this.renderer = new Renderer(this.canvas);
    // Re-render once all 52 card images finish loading so we never show text fallback
    this.renderer._onImgsReady = () => this._render();
    this.engine   = null;
    // Optional header offset — set window._SOLI_HEADER_OFFSET before loading game.js
    // to reserve space for a host page's navigation bar (e.g. 64 for the AEI site header).
    this._headerOffset = window._SOLI_HEADER_OFFSET || 0;

    this.uiState  = {
      selected:     null,
      validSlots:   [],
      message:      null,
      menuOpen:     false,
      timerSeconds: 0,
      screen:       null,
      hintCells:    null,
      stats:        null,
      settings:     this._loadSettings(),
      showGDPR:      !localStorage.getItem("soli_gdpr"),
      winInput:      null,
      highScores:    { regular: [], daily: [] },
      hsTab:         "regular",
      showBonusRound: false,
      adOverlay:     null,
      isPremium:     false,
      gameType:      "regular",   // 'regular' | 'daily' — for header label
      hintsUsed:     0,
    };

    // Managers
    this._stats     = new StatsManager();
    this._firebase  = new FirebaseClient();
    this._gameType  = "regular";   // 'regular' | 'daily'
    this._isPremium = this._loadPremium();
    this._ads       = new AdManager(this._firebase, () => this._isPremium);
    this._sound     = new SoundManager();

    // Hint tracking (3 free per game, unlimited premium)
    this._hintsUsed = 0;

    // Animation
    this._anim   = null;
    this._rafId  = null;

    // Timer
    this._timerInterval = null;

    // Size canvas and compute layout
    this._resize();

    // Instantiate engine
    this.engine = new GameEngine();
    this._startTimer();
    this._applyTheme(this.uiState.settings.theme || "green");

    // Daily challenge state
    this._dailyDateStr   = null;    // date string of current daily ("2026-05-31")
    this._dailyCanSubmit = false;   // only true for premium playing today's challenge

    // Drag state — card being dragged (null when not dragging)
    this._dragging = null;   // { srcCell, card }

    // Wire input — tap + drag
    this.input = new InputHandler(this.canvas, (x, y) => this._onTap(x, y), {
      onDragStart: (x, y) => this._onDragStart(x, y),
      onDragMove:  (x, y) => this._onDragMove(x, y),
      onDragEnd:   (x, y) => this._onDragEnd(x, y),
    });

    window.addEventListener("resize", () => {
      this._resize();
      this._render();
    });

    // Sync isPremium + show/hide ad banner
    this.uiState.isPremium = this._isPremium;
    this._syncAdBanner();

    // Sync initial sound setting
    this._sound.setEnabled(this.uiState.settings.sound !== false);

    // Fetch remote config in background (non-blocking)
    this._firebase.fetchConfig();

    // Initialise AdMob on Capacitor (non-blocking; shows banner for free users)
    if (window.Capacitor) {
      this._ads.initAdMob(!this._isPremium, () => {
        // Banner size is now known — resize canvas to prevent overlap
        this._resize();
        this._render();
      });
    }

    // Keyboard capture — uses hidden HTML inputs to trigger iOS native keyboard
    this._kbActive  = null;   // 'name' | 'email' | null
    this._kbCleanup = null;
    window.addEventListener("keydown", e => this._onKey(e));  // desktop fallback

    // Initial paint
    this._render();
  }

  // ── Canvas sizing ────────────────────────────────────────────────────────

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    const W   = window.innerWidth;
    const H   = window.innerHeight - this._headerOffset;

    // Banner height reservation:
    //   Web:       HTML #ad-strip div height (50px when visible)
    //   Capacitor: native AdMob banner overlays the WebView from the bottom
    //              — leave 60px so footer buttons aren't hidden under it
    let bannerH = 0;
    if (window.Capacitor && !this._isPremium) {
      // Use the height reported by bannerAdSizeChanged; fall back to 72px safe default
      bannerH = (this._ads && this._ads.bannerH) ? this._ads.bannerH : 72;
    } else {
      const adEl = document.getElementById("ad-strip");
      bannerH = (adEl && adEl.style.display !== "none")
                ? adEl.getBoundingClientRect().height || 50
                : 0;
    }

    const canvasH = H - bannerH;
    this.canvas.width  = Math.round(W * dpr);
    this.canvas.height = Math.round(canvasH * dpr);
    this.canvas.style.width  = W + "px";
    this.canvas.style.height = canvasH + "px";

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    this.renderer.computeLayout(W, canvasH);
  }

  /** Show/hide the ad banner and re-layout. Call whenever _isPremium changes. */
  _syncAdBanner() {
    const adEl = document.getElementById("ad-strip");
    if (!adEl) return;
    const show = !this._isPremium && !window.Capacitor;  // Capacitor uses AdMob native
    adEl.style.display = show ? "block" : "none";
    this._resize();
  }

  // ── Render ───────────────────────────────────────────────────────────────

  _render(anim = null) {
    this.renderer.draw(this.engine, this.uiState, anim);
  }

  // ── Animation ─────────────────────────────────────────────────────────────

  /**
   * Slide a card from src cell to dst cell, then call onDone.
   * @param {Card}     card
   * @param {number[]} srcCell  [row, col]
   * @param {number[]} dstCell  [row, col]
   * @param {function} onDone   called after animation completes
   */
  _startAnim(card, srcCell, dstCell, onDone) {
    const [x0, y0] = this.renderer.cellXY(srcCell[0], srcCell[1]);
    const [x1, y1] = this.renderer.cellXY(dstCell[0], dstCell[1]);

    this._anim = {
      card,
      x0, y0, x1, y1,
      dstRow: dstCell[0],
      dstCol: dstCell[1],
      t0:       performance.now(),
      duration: 180,   // ms — fast enough to feel snappy, slow enough to read
      onDone,
    };

    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(ts => this._animTick(ts));
  }

  _animTick(timestamp) {
    const a = this._anim;
    if (!a) return;

    // Ease-out cubic: t → 1-(1-t)^3
    const raw = Math.min(1, (timestamp - a.t0) / a.duration);
    const t   = 1 - Math.pow(1 - raw, 3);

    const flyingCard = {
      card: a.card,
      x:    a.x0 + (a.x1 - a.x0) * t,
      y:    a.y0 + (a.y1 - a.y0) * t,
      dstRow: a.dstRow,
      dstCol: a.dstCol,
    };

    this._render(flyingCard);

    if (raw < 1) {
      this._rafId = requestAnimationFrame(ts => this._animTick(ts));
    } else {
      // Animation complete
      this._anim   = null;
      this._rafId  = null;
      a.onDone();
    }
  }

  // ── Timer ────────────────────────────────────────────────────────────────

  _startTimer() {
    this._stopTimer();
    this.uiState.timerSeconds = 0;
    this._timerInterval = setInterval(() => {
      if (!this.uiState.menuOpen) {
        this.uiState.timerSeconds++;
        this._render();
      }
    }, 1000);
  }

  _stopTimer() {
    if (this._timerInterval) {
      clearInterval(this._timerInterval);
      this._timerInterval = null;
    }
  }

  // ── Input dispatch ───────────────────────────────────────────────────────

  _onTap(x, y) {
    if (this._anim) return;

    // Interstitial ad (blocks everything except premium CTA)
    if (this.uiState.adOverlay) {
      const hit = this.renderer.hitTestInterstitial(x, y);
      if (hit === "continue") { this._ads.dismissInterstitial(); }
      if (hit === "premium")  { this._ads.premiumFromInterstitial(); }
      return;
    }

    // Bonus Round lifeline
    if (this.uiState.showBonusRound) {
      const hit = this.renderer.hitTestBonusRound(x, y);
      if (hit === "replay") {
        this.uiState.showBonusRound = false;
        this.engine.replayRound4();
        this._hintsUsed = 0;
        this._clearSelection();
      } else if (hit === "r5") {
        this._activateRound5();
      } else if (hit === "new") {
        this.uiState.showBonusRound = false;
        this._startNewGame();
      }
      return;
    }

    // GDPR consent (blocks everything)
    if (this.uiState.showGDPR) {
      const hit = this.renderer.hitTestGDPR(x, y);
      if (hit === "accept")  { this._gdprRespond("accepted"); }
      if (hit === "decline") { this._gdprRespond("declined"); }
      return;
    }

    // Win overlay with name input (daily challenge)
    if (this.uiState.winInput) {
      this._handleWinInputTap(x, y);
      return;
    }

    // 0a. Sub-screen routing
    const sc = this.uiState.screen;
    if (sc === "stats") {
      if (this.renderer.hitTestStatsClose(x, y)) { this.uiState.screen = null; this._render(); }
      return;
    }
    if (sc === "settings") {
      if (this.renderer.hitTestSoundToggle(x, y)) {
        this.uiState.settings.sound = !this.uiState.settings.sound;
        this._sound.setEnabled(this.uiState.settings.sound);
        this._saveSettings(); this._render();
      } else if (this.renderer.hitTestSettingsClose(x, y)) {
        this.uiState.screen = null; this._render();
      }
      return;
    }
    if (sc === "highscores") {
      const hit = this.renderer.hitTestHighScores(x, y);
      if (hit === "close")                           { this.uiState.screen = null; this._render(); }
      else if (hit === "regular" || hit === "daily") { this.uiState.hsTab = hit; this._openHighScores(); }
      return;
    }
    if (sc === "themes") {
      const hit = this.renderer.hitTestThemes(x, y);
      if (hit === "close") { this.uiState.screen = null; this._render(); }
      else if (hit) {
        this.uiState.settings.theme = hit;
        this._applyTheme(hit);
        this._saveSettings(); this._render();
      }
      return;
    }
    if (sc === "premium") {
      const hit = this.renderer.hitTestPremium(x, y);
      const ps  = this.uiState.premiumState || {};
      if (hit === "close") {
        this.uiState.screen = null; this.uiState.premiumState = null;
        this._deactivateKeyboard();
        if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
        this._render();
      } else if (hit === "buy") {
        const STRIPE_URL = "https://buy.stripe.com/eVq14obMleKjepj57fcjS00";
        if (window.Capacitor) {
          import("@capacitor/browser").then(({ Browser }) => Browser.open({ url: STRIPE_URL })).catch(() => window.open(STRIPE_URL, "_blank"));
        } else {
          window.open(STRIPE_URL, "_blank");
        }
      } else if (hit === "activate") {
        // Move to the license-activation step
        ps.step = "activate"; ps.emailActive = false; ps.result = undefined;
        this.uiState.premiumState = ps;
        this._render();
      } else if (hit === "back") {
        ps.step = "features"; ps.emailActive = false;
        this.uiState.premiumState = ps;
        this._deactivateKeyboard();
        if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
        this._render();
      } else if (hit === "emailinput") {
        ps.emailActive = true;
        this.uiState.premiumState = ps;
        this._activateKeyboard(
          "email", ps.email || "",
          (val) => { this.uiState.premiumState.email = val; },
          () => { if ((this.uiState.premiumState.email || "").includes("@")) this._checkPremiumLicense(); }
        );
        if (this._cursorTick) clearInterval(this._cursorTick);
        this._cursorTick = setInterval(() => this._render(), 500);
      } else if (hit === "verify") {
        this._checkPremiumLicense();
      } else {
        // Tap elsewhere in premium screen — deactivate keyboard if active
        if (ps.emailActive) {
          ps.emailActive = false;
          this.uiState.premiumState = ps;
          this._deactivateKeyboard();
          if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
          this._render();
        }
      }
      return;
    }
    if (sc === "howtoplay") {
      if (this.renderer.hitTestHtpClose(x, y)) { this.uiState.screen = null; this._render(); }
      return;
    }
    if (sc === "privacy") {
      if (this.renderer.hitTestPrivacyClose(x, y)) { this.uiState.screen = null; this._render(); }
      return;
    }

    // 0b. Menu open → handle menu taps
    if (this.uiState.menuOpen) {
      const action = this.renderer.hitTestMenu(x, y);
      if (action === "_sound") {
        // Inline toggle — stay in menu
        this.uiState.settings.sound = !this.uiState.settings.sound;
        this._sound.setEnabled(this.uiState.settings.sound);
        this._saveSettings(); this._render();
      } else if (action) {
        this._handleMenuAction(action);
      }
      return;
    }

    // 0c. Menu button in header?
    if (this.renderer.hitTestMenuButton(x, y)) {
      this.uiState.menuOpen = true;
      this._clearSelection();   // also redraws
      return;
    }

    // 1. Overlay active — check buttons first, then dismiss
    if (this.uiState.message) {
      const hit = this.renderer.hitTestOverlay(x, y);
      if (hit === "playagain") {
        this.uiState.message = null;
        this._startNewGame(this._gameType);
        return;
      }
      if (hit === "newgame") {
        this.uiState.message = null;
        this._startNewGame("regular");
        return;
      }
      if (hit === "endround") {
        this.uiState.message = null;
        this._endRound();
        return;
      }
      if (hit === "endgame") {
        this.uiState.message = null;
        this._endGameFromR4();
        return;
      }
      if (hit === "lifeline") {
        this.uiState.message = null;
        this._endRound();   // _endRound() in round 4 → shows bonus round panel
        return;
      }
      if (hit === "undo") {
        this.uiState.message = null;
        if (this.engine.undo()) this._clearSelection();
        else this._render();
        return;
      }
      // Tap anywhere else dismisses
      this.uiState.message = null;
      this._render();
      return;
    }

    // 2. Button row?
    const btnId = this.renderer.hitTestButtons(x, y, this.renderer.layout.buttons);
    if (btnId) {
      this._handleButton(btnId);
      return;
    }

    // 3. Board hit?
    const cell = this.renderer.hitTestBoard(x, y);
    if (!cell) {
      // Tapped outside board — deselect
      this._clearSelection();
      return;
    }

    const [r, c] = cell;

    // 4. Card selected and we tapped somewhere?
    if (this.uiState.selected) {
      const [sr, sCol] = this.uiState.selected;

      // Same cell → deselect
      if (sr === r && sCol === c) {
        this._clearSelection();
        return;
      }

      // Valid destination → animate then apply move
      const srcCard = this.engine.board[sr][sCol];
      if (srcCard && this.engine.validMove(srcCard, r, c)) {
        // Clear selection visuals immediately so the board looks clean during flight
        const movingCard = srcCard;
        const srcCell    = [sr, sCol];
        const dstCell    = [r, c];
        this.uiState.selected   = null;
        this.uiState.validSlots = [];

        // Apply move now so engine state is correct during animation
        const completedRows = this.engine.applyMove(srcCell, dstCell);

        this._startAnim(movingCard, srcCell, dstCell, () => {
          this._sound.playCardSnap();
          this._render();
          this._checkPostMove(completedRows);
        });
        return;
      }

      // Tapped a different card → re-select it (fall through)
    }

    // 5. Select / re-select a card
    const card = this.engine.board[r][c];
    if (card) {
      this.uiState.selected   = [r, c];
      this.uiState.validSlots = this.engine.validSlots(card);
    } else {
      this._clearSelection();
      return;
    }
    this._render();
  }

  // ── Post-move checks ─────────────────────────────────────────────────────

  _checkPostMove(completedRows = []) {
    // Row completion chime (before win check — win fanfare overrides if game done)
    if (completedRows.length > 0 && !this.engine.gameWon) {
      this._sound.playRowComplete();
    }

    if (this.engine.gameWon) {
      this._sound.playWin();
      this._stopTimer();
      const t    = this.uiState.timerSeconds;
      const type = this._gameType || "regular";
      this._stats.recordGame({ won: true, score: this.engine.score, seconds: t });
      // Record with last known name; _finishRegularWin will update it if user changes it
      const savedName = localStorage.getItem("soli_player_name") || "";
      this._stats.recordScore(type, { score: this.engine.score, seconds: t, name: savedName });

      const mm = String(Math.floor(t / 60)).padStart(2, "0");
      const ss = String(t % 60).padStart(2, "0");
      // Win message — free daily users get upsell subtitle
      const freeDaily = (type === "daily" && !this._dailyCanSubmit);
      this.uiState.message = {
        title:    "You Win!",
        subtitle: freeDaily
          ? `Score: ${this.engine.score}  ·  Time: ${mm}:${ss}\nGo Premium to compete today!`
          : `Score: ${this.engine.score}  ·  Time: ${mm}:${ss}`,
        color:    "#fbbf24",
        type:     "win",
      };

      // Always show name input; Firebase submission only for premium daily + GDPR consent
      const consented  = localStorage.getItem("soli_gdpr") === "accepted";
      const useFirebase = type === "daily" && this._dailyCanSubmit && consented;
      this.uiState.winInput = {
        value:       localStorage.getItem("soli_player_name") || "",
        active:      false,
        submitted:   false,
        firebaseOk:  null,
        score:       this.engine.score,
        moves:       this.engine.moves,
        time:        t,
        won:         true,
        round:       this.engine.round,
        useFirebase,  // true → Firebase submit flow; false → local save + Play Again
      };

      this._render();
      return;
    }

    if (this.engine.isLocked) {
      if (this.engine.round >= 5) {
        this.uiState.message = {
          title:    "Game Over",
          subtitle: "Round 5 was your last chance",
          type:     "gameover",
        };
      } else if (this.engine.round === 4) {
        this.uiState.message = {
          title:    "Round 4 Complete!",
          subtitle: "No more moves — choose your next step",
          type:     "r4locked",
        };
      } else {
        const next = this.engine.round + 1;
        this.uiState.message = {
          title:     `Round ${this.engine.round} Complete!`,
          subtitle:  "Board locked — preserved sequences carry over",
          type:      "locked",
          btn1Label: `Begin Round ${next}`,
        };
      }
      this._render();
    }
  }

  // ── Button actions ───────────────────────────────────────────────────────

  _handleButton(id) {
    switch (id) {
      case "undo":
        this.engine.undo();
        break;

      case "redo":
        this.engine.redo();
        break;

      case "new":
        this._startNewGame("regular");
        return;

      case "nextround":
        this._endRound();
        return;   // _endRound manages its own redraw
    }

    this._clearSelection();
  }

  _handleMenuAction(action) {
    this.uiState.menuOpen = false;
    switch (action) {
      case "resume":
        break;  // just close menu

      case "undo":
        this.engine.undo();
        break;

      case "redo":
        this.engine.redo();
        break;

      case "hint":
        if (!this._isPremium && this._hintsUsed >= 3) {
          this.uiState.menuOpen = false;
          this.uiState.premiumState = {
            step: "features",
            email: localStorage.getItem("soli_premium_email") || "",
            emailActive: false, checking: false, result: undefined,
            isPremium: false,
          };
          this.uiState.screen = "premium";
          this._clearSelection();
          return;
        }
        this._showHint();
        break;

      case "newgame":
        this._startNewGame("regular");
        return;

      case "dailychallenge":
        this._launchDailyChallenge();
        return;

      case "highscores":
        this._openHighScores();
        return;

      case "statistics":
        this.uiState.stats  = this._stats.getStats();
        this.uiState.screen = "stats";
        break;

      case "themes":
        this.uiState.screen = "themes";
        break;

      case "gopremium":
        this.uiState.premiumState = {
          step:        "features",
          email:       localStorage.getItem("soli_premium_email") || "",
          emailActive: false,
          checking:    false,
          result:      undefined,
          isPremium:   this._isPremium,
        };
        this.uiState.screen = "premium";
        break;

      case "howtoplay":
        this.uiState.screen = "howtoplay";
        break;

      case "privacy":
        this.uiState.screen = "privacy";
        break;
    }
    this._clearSelection();
  }

  // ── Hint ─────────────────────────────────────────────────────────────────

  _showHint() {
    const solver = new Solver(this.engine);
    const move   = solver.bestMove();
    if (!move) return;
    this._hintsUsed++;
    this.uiState.hintsUsed = this._hintsUsed;

    const [src, dst] = move;

    let flashes = 0;
    const MAX_FLASHES = 4;

    const tick = () => {
      const on = flashes % 2 === 0;
      this.uiState.selected   = on ? src : null;
      this.uiState.validSlots = on ? [dst] : [];
      this._render();
      flashes++;
      if (flashes < MAX_FLASHES * 2) {
        setTimeout(tick, 260);
      } else {
        this.uiState.selected   = null;
        this.uiState.validSlots = [];
        this._render();
      }
    };
    tick();
  }

  // ── Settings persistence ──────────────────────────────────────────────────

  _loadSettings() {
    const defaults = { sound: true, theme: "green" };
    try {
      const raw = localStorage.getItem("soli_settings_v1");
      if (raw) return { ...defaults, ...JSON.parse(raw) };
    } catch (_) {}
    return defaults;
  }

  _saveSettings() {
    try { localStorage.setItem("soli_settings_v1", JSON.stringify(this.uiState.settings)); }
    catch (_) {}
  }

  _applyTheme(id) {
    const FELT_COLOURS = {
      green:    "#1b5e3b",   // Classic Green
      blue:     "#1a3f6e",   // Ocean
      midnight: "#0d1b3e",   // Midnight Blue
      darkfelt: "#2a2a2a",   // Dark Felt
      purple:   "#3b1a5e",   // Royal Purple
    };
    const colour = FELT_COLOURS[id] || FELT_COLOURS.green;
    PALETTE.felt = colour;
    document.body.style.background = colour;
  }

  // ── GDPR ─────────────────────────────────────────────────────────────────

  _gdprRespond(choice) {
    localStorage.setItem("soli_gdpr", choice);
    this.uiState.showGDPR = false;
    this._render();
  }

  // ── Win name input (daily challenge) ─────────────────────────────────────

  _handleWinInputTap(x, y) {
    const wi  = this.uiState.winInput;
    if (!wi) return;

    if (wi.submitted) {
      const hit = this.renderer.hitTestWinOverlay(x, y);
      if (hit === "leaderboard") {
        // Open High Scores on the Daily tab
        this.uiState.winInput = null;
        this.uiState.message  = null;
        this.uiState.hsTab    = "daily";
        this._openHighScores();   // async — fetches Firebase daily scores
        return;
      }
      // Tap anywhere else dismisses
      this.uiState.winInput = null;
      this.uiState.message  = null;
      this._render();
      return;
    }

    const hit = this.renderer.hitTestWinOverlay(x, y);

    if (hit === "nameinput") {
      wi.active = true;
      this._activateKeyboard(
        "name", wi.value,
        (val) => { wi.value = val; },
        () => {
          if (wi.useFirebase) { if (wi.value.trim()) this._submitDailyScore(wi); }
          else this._finishRegularWin(wi);
        }
      );
      if (this._cursorTick) clearInterval(this._cursorTick);
      this._cursorTick = setInterval(() => this._render(), 500);
      return;
    }

    if (hit === "playagain") {
      // Regular win: save name locally and start new game
      this._finishRegularWin(wi);
      return;
    }

    if (hit === "submit" && wi.value.trim()) {
      this._deactivateKeyboard();
      if (wi.useFirebase) {
        this._submitDailyScore(wi);
      } else {
        this._finishRegularWin(wi);
      }
      return;
    }

    if (hit === "skip") {
      this._deactivateKeyboard();
      if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
      this.uiState.winInput = null;
      this.uiState.message  = null;
      this._render();
      return;
    }

    // Tap outside input — deactivate
    wi.active = false;
    this._deactivateKeyboard();
    if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
    this._render();
  }

  async _submitDailyScore(wi) {
    const name = wi.value.trim();
    localStorage.setItem("soli_player_name", name);
    wi.submitted  = true;
    wi.firebaseOk = null;
    this._render();

    const ok = await this._firebase.postDailyScore(this._firebase.todayStr(), {
      name,
      score: wi.score,
      moves: wi.moves,
      time:  wi.time,
      won:   wi.won,
      round: wi.round,
    });
    wi.firebaseOk = ok;
    this._render();
  }

  /** Save name locally, patch the leaderboard entry, and start a new game. */
  _finishRegularWin(wi) {
    const name = (wi.value || "").trim();
    if (name) {
      localStorage.setItem("soli_player_name", name);
      // Patch the score entry that was recorded at win-time with the player's chosen alias
      const type = wi.isEndGame ? "regular" : (this._gameType || "regular");
      this._stats.updateLastScoreName(type, name);
    }
    this._deactivateKeyboard();
    if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
    this.uiState.winInput = null;
    this.uiState.message  = null;
    this._startNewGame(this._gameType);
  }

  /**
   * Called when the player chooses "New Game" from the Round 4 locked overlay.
   * Records a non-win game result, then checks if the score qualifies for the
   * local leaderboard. If so, shows the name-entry overlay before starting over.
   */
  _endGameFromR4() {
    const score = this.engine.score;
    const t     = this.uiState.timerSeconds;

    this._stopTimer();

    // Record game stats (not a win — guarded in case already recorded)
    if (!this.engine.gameWon) {
      this._stats.recordGame({ won: false, score, seconds: t });
    }
    this._ads.recordGame();

    // Check if score makes the top 15 local leaderboard
    const existing  = this._stats.getHighScores("regular");
    const qualifies = score > 0 &&
                      (existing.length < 15 || score > existing[existing.length - 1].score);

    if (qualifies) {
      // Record score with last-known name (player can update it in the overlay)
      const savedName = localStorage.getItem("soli_player_name") || "";
      this._stats.recordScore("regular", { score, seconds: t, name: savedName });

      const mm = String(Math.floor(t / 60)).padStart(2, "0");
      const ss = String(t % 60).padStart(2, "0");
      this.uiState.message = {
        title:    "Top Score!",
        subtitle: `Score: ${score}  ·  Time: ${mm}:${ss}`,
        color:    "#fbbf24",
      };
      this.uiState.winInput = {
        value:       savedName,
        active:      false,
        submitted:   false,
        firebaseOk:  null,
        score,
        moves:       this.engine.moves,
        time:        t,
        won:         false,
        round:       this.engine.round,
        useFirebase: false,
        isEndGame:   true,   // signals _finishRegularWin to use "regular" type
      };
    } else {
      this._startNewGame("regular");
    }
    this._render();
  }

  // ── Keyboard (desktop / iPad external keyboard) ───────────────────────────

  _onKey(e) {
    // Win name input
    const wi = this.uiState.winInput;
    if (wi && wi.active && !wi.submitted) {
      if (e.key === "Backspace") { wi.value = wi.value.slice(0, -1); }
      else if (e.key === "Enter") {
        if (wi.useFirebase) { if (wi.value.trim()) this._submitDailyScore(wi); }
        else this._finishRegularWin(wi);
      }
      else if (e.key.length === 1 && wi.value.length < 24) { wi.value += e.key; }
      e.preventDefault();
      this._render();
      return;
    }
    // Premium email input
    const ps = this.uiState.premiumState;
    if (ps && ps.emailActive && !ps.checking && !ps.isPremium) {
      if (e.key === "Backspace")       { ps.email = (ps.email || "").slice(0, -1); }
      else if (e.key === "Enter")      { if (ps.email.includes("@")) this._checkPremiumLicense(); }
      else if (e.key.length === 1 && (ps.email || "").length < 64) { ps.email = (ps.email || "") + e.key; }
      e.preventDefault();
      this._render();
    }
  }

  // ── Premium ───────────────────────────────────────────────────────────────

  _loadPremium() {
    try {
      const raw = localStorage.getItem("soli_premium");
      if (raw) return JSON.parse(raw).active === true;
    } catch (_) {}
    return false;
  }

  _savePremium(email) {
    try {
      localStorage.setItem("soli_premium", JSON.stringify({ active: true, email }));
      localStorage.setItem("soli_premium_email", email);
    } catch (_) {}
  }

  async _checkPremiumLicense() {
    const ps = this.uiState.premiumState;
    if (!ps || !ps.email || ps.checking) return;

    ps.checking    = true;
    ps.result      = undefined;
    ps.emailActive = false;
    this._deactivateKeyboard();   // retract iOS keyboard immediately
    if (this._cursorTick) { clearInterval(this._cursorTick); this._cursorTick = null; }
    this._render();

    const result = await this._firebase.checkLicense(ps.email);
    ps.checking = false;
    ps.result   = result;

    if (result === true) {
      ps.isPremium             = true;
      this._isPremium          = true;
      this.uiState.isPremium   = true;
      this._savePremium(ps.email);
      this._syncAdBanner();         // hide HTML banner (web)
      this._ads.removeBanner();     // remove native banner (Capacitor)
    }
    this._render();
  }

  // ── High Scores — also fetch Firebase daily scores ────────────────────────

  async _openHighScores() {
    const local   = { regular: this._stats.getHighScores("regular"), daily: this._stats.getHighScores("daily") };
    this.uiState.highScores = local;
    this.uiState.hsTab      = this.uiState.hsTab || "regular";
    this.uiState.screen     = "highscores";
    this._render();

    // Fetch Firebase daily scores and merge (firebase entries show name + source)
    const firebaseEntries = await this._firebase.fetchDailyScores(this._firebase.todayStr());
    if (firebaseEntries.length) {
      this.uiState.highScores = {
        ...local,
        daily: firebaseEntries.map(e => ({
          score:   e.score,
          seconds: e.time,
          date:    "global",
          name:    e.name || "—",
        })),
      };
      if (this.uiState.screen === "highscores") this._render();
    }
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  // ── Round / game flow ────────────────────────────────────────────────────

  /**
   * "End Round" button handler.
   * Rounds 1-3: show interstitial if due, then advance.
   * Round 4: show interstitial if due, then show Bonus Round lifeline.
   */
  _endRound() {
    this.uiState.selected   = null;
    this.uiState.validSlots = [];
    this.uiState.message    = null;

    if (this.engine.round >= 5) {
      // Round 5 already used — game over, no more lifelines
      this.uiState.message = {
        title:    "Game Over",
        subtitle: "Round 5 was your last chance",
        type:     "gameover",
      };
      this._render();
      return;
    }

    if (this.engine.round < 4) {
      this._ads.recordRound();
      if (this._ads.shouldShowAfterRound()) {
        this._showInterstitialThen(() => {
          this.engine.nextRound();
          this._hintsUsed = 0;
          this.uiState.hintsUsed = 0;
          this._render();
        });
      } else {
        this.engine.nextRound();
        this._hintsUsed = 0;
        this.uiState.hintsUsed = 0;
        this._render();
      }
    } else {
      // Round 4 → one-time bonus round lifeline
      this._ads.recordRound();
      if (this._ads.shouldShowBeforeBonus()) {
        this._showInterstitialThen(() => {
          this.uiState.showBonusRound = true;
          this._render();
        });
      } else {
        this.uiState.showBonusRound = true;
        this._render();
      }
    }
  }

  /** Start Round 5 (forced). Free users already saw the interstitial via _endRound. */
  _activateRound5() {
    if (this._isPremium) {
      this.uiState.showBonusRound = false;
      this.engine.nextRound(true);   // force beyond MAX_ROUNDS
      this._hintsUsed = 0;
      this.uiState.hintsUsed = 0;
      this._clearSelection();
    } else {
      // Show interstitial before Round 5 for free users
      this._showInterstitialThen(() => {
        this.uiState.showBonusRound = false;
        this.engine.nextRound(true);
        this._hintsUsed = 0;
        this.uiState.hintsUsed = 0;
        this._clearSelection();
      });
    }
  }

  /**
   * Start a new game, showing an interstitial first if due.
   * @param {'regular'|'daily'} type
   */
  _startNewGame(type = "regular") {
    // Only record the current game as a loss if it wasn't already won (wins are
    // recorded in _checkPostMove — recording again here would inflate stats).
    if (!this.engine.gameWon) {
      this._stats.recordGame({ won: false, score: this.engine.score, seconds: this.uiState.timerSeconds });
    }
    this._ads.recordGame();
    this.uiState.menuOpen = false;

    const launch = () => {
      this._hintsUsed = 0;
      this.uiState.hintsUsed      = 0;
      this.uiState.showBonusRound = false;
      this.uiState.message        = null;
      this.uiState.winInput       = null;
      this.uiState.adOverlay      = null;
      this.uiState.screen         = null;
      if (type === "daily") {
        // Replay the same date that was already set (yesterday for free, today for premium)
        const dateStr = this._dailyDateStr || this._firebase.todayStr();
        const [y, m, d] = dateStr.split("-").map(Number);
        this.engine    = new GameEngine(y * 10000 + m * 100 + d);
        this._gameType = "daily";
      } else {
        this.engine    = new GameEngine();
        this._gameType = "regular";
      }
      this.uiState.gameType = this._gameType;
      this._startTimer();
      this._clearSelection();
    };

    if (this._ads.shouldShowBeforeGame()) {
      this._showInterstitialThen(launch);
    } else {
      launch();
    }
  }

  /**
   * Show the browser interstitial overlay, call onDone when dismissed.
   * Automatically wires the render callback so the countdown redraws.
   */
  _showInterstitialThen(onDone) {
    this._ads.showInterstitial(
      () => {
        // Ad dismissed
        this.uiState.adOverlay = null;
        this._render();
        onDone();
      },
      () => {
        // User tapped "Go Premium" from the ad
        this.uiState.adOverlay = null;
        this.uiState.premiumState = {
          step:        "features",
          email:       localStorage.getItem("soli_premium_email") || "",
          emailActive: false, checking: false, result: undefined,
          isPremium:   this._isPremium,
        };
        this.uiState.screen = "premium";
        this._render();
      }
    );
    // For browser: sync overlayState into uiState so renderer sees it
    if (this._ads.overlayState) {
      this.uiState.adOverlay = this._ads.overlayState;
      // Register render callback on the overlay so countdown triggers redraws
      this._ads.overlayState._renderFn = () => {
        this.uiState.adOverlay = this._ads.overlayState;
        this._render();
      };
      this._render();
    }
  }

  // ── Daily Challenge ───────────────────────────────────────────────────────

  /**
   * Launch the daily challenge per freemium rules:
   *   Premium → today's puzzle, score submission enabled
   *   Free    → yesterday's puzzle, no submission, upsell in win overlay
   */
  _launchDailyChallenge() {
    this.uiState.menuOpen = false;
    if (!this.engine.gameWon) {
      this._stats.recordGame({ won: false, score: this.engine.score, seconds: this.uiState.timerSeconds });
    }
    this._ads.recordGame();

    // Determine date and submission rights
    const today     = this._firebase.todayStr();
    const yesterday = this._dateOffset(-1);

    const dateStr  = this._isPremium ? today : yesterday;
    const canSubmit = this._isPremium;

    this._dailyDateStr   = dateStr;
    this._dailyCanSubmit = canSubmit;

    const [y, m, d] = dateStr.split("-").map(Number);
    const seed = y * 10000 + m * 100 + d;

    const launch = () => {
      this._hintsUsed             = 0;
      this.uiState.hintsUsed      = 0;
      this.uiState.showBonusRound = false;
      this.uiState.message        = null;
      this.uiState.winInput       = null;
      this.uiState.adOverlay      = null;
      this.engine                 = new GameEngine(seed);
      this._gameType              = "daily";
      this.uiState.gameType       = "daily";
      this._startTimer();
      this._clearSelection();
    };

    if (this._ads.shouldShowBeforeGame()) {
      this._showInterstitialThen(launch);
    } else {
      launch();
    }
  }

  /** Return a date string offset by N days from today. */
  _dateOffset(days) {
    const d = new Date();
    d.setDate(d.getDate() + days);
    const y  = d.getFullYear();
    const m  = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${dd}`;
  }

  // ── Drag-to-move ─────────────────────────────────────────────────────────

  _onDragStart(x, y) {
    // Ignore drags while overlays/animations are active
    if (this._anim || this.uiState.showGDPR || this.uiState.adOverlay ||
        this.uiState.showBonusRound || this.uiState.menuOpen ||
        this.uiState.screen || this.uiState.message || this.uiState.winInput) return;

    const cell = this.renderer.hitTestBoard(x, y);
    if (!cell) return;

    const [r, c] = cell;
    const card   = this.engine.board[r][c];
    if (!card) return;

    // Start drag — select the card and show valid targets
    this._dragging               = { srcCell: cell, card };
    this.uiState.selected        = cell;
    this.uiState.validSlots      = this.engine.validSlots(card);
    this._render();
  }

  _onDragMove(x, y) {
    if (!this._dragging) return;

    // Draw floating card centred on finger
    const { cardW, cardH } = this.renderer.layout;
    const flyCard = {
      card:   this._dragging.card,
      x:      x - cardW / 2,
      y:      y - cardH / 2,
      dstRow: this._dragging.srcCell[0],
      dstCol: this._dragging.srcCell[1],
    };
    this.renderer.draw(this.engine, this.uiState, flyCard);
  }

  _onDragEnd(x, y) {
    if (!this._dragging) return;

    const { srcCell, card } = this._dragging;
    this._dragging = null;
    this.uiState.selected   = null;
    this.uiState.validSlots = [];

    const dstCell = this.renderer.hitTestBoard(x, y);

    if (dstCell && this.engine.validMove(card, dstCell[0], dstCell[1])) {
      const completedRows = this.engine.applyMove(srcCell, dstCell);

      // Short snap animation from drop position to cell
      const { cardW, cardH } = this.renderer.layout;
      const [x1, y1]         = this.renderer.cellXY(dstCell[0], dstCell[1]);

      // Reuse animation system — override start position to current finger position
      this._anim = {
        card,
        x0:     x - cardW / 2,
        y0:     y - cardH / 2,
        x1, y1,
        dstRow: dstCell[0],
        dstCol: dstCell[1],
        t0:     performance.now(),
        duration: 90,
        onDone: () => {
          this._sound.playCardSnap();
          this._render();
          this._checkPostMove(completedRows);
        },
      };
      if (this._rafId) cancelAnimationFrame(this._rafId);
      this._rafId = requestAnimationFrame(ts => this._animTick(ts));
    } else {
      // Dropped on invalid spot — just deselect
      this._render();
    }
  }

  // ── Keyboard capture (iOS native keyboard via hidden HTML input) ─────────

  /**
   * Focus a hidden HTML input to trigger the iOS keyboard.
   * @param {'name'|'email'} type
   * @param {string}   initialValue
   * @param {function} onChange(value)  — called on every keystroke
   * @param {function} onSubmit()       — called when user presses Return
   */
  _activateKeyboard(type, initialValue, onChange, onSubmit) {
    this._deactivateKeyboard();   // clean up any previous

    const el = document.getElementById(type === "email" ? "kb-email" : "kb-name");
    if (!el) return;

    el.value           = initialValue || "";
    el.style.pointerEvents = "auto";

    const onInput   = () => { onChange(el.value); this._render(); };
    const onKeydown = (e) => { if (e.key === "Enter") { e.preventDefault(); onSubmit(); } };

    el.addEventListener("input",   onInput);
    el.addEventListener("keydown", onKeydown);
    el.focus();

    this._kbActive  = type;
    this._kbCleanup = () => {
      el.removeEventListener("input",   onInput);
      el.removeEventListener("keydown", onKeydown);
      el.style.pointerEvents = "none";
      el.blur();
      this._kbActive  = null;
      this._kbCleanup = null;
    };
  }

  _deactivateKeyboard() {
    if (this._kbCleanup) this._kbCleanup();
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _clearSelection() {
    this.uiState.selected   = null;
    this.uiState.validSlots = [];
    this._render();
  }
}

// ── Boot ─────────────────────────────────────────────────────────────────────
window.addEventListener("DOMContentLoaded", () => {
  window._soliGame = new GameUI();
});
