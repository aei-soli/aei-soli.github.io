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
      highScores:    { regular: [], daily: [], lifetime: [] },
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
    // Draw/update the canvas interstitial whenever the ad manager pushes overlay state.
    // Works for both the immediate browser path and the async AdMob-failure fallback.
    this._ads.setOverlayCallback((ov) => { this.uiState.adOverlay = ov; this._render(); });
    this._carbon    = (typeof CarbonAds !== "undefined") ? new CarbonAds() : null;  // web-only ad strip
    this._purchases = (typeof PurchasesManager !== "undefined") ? new PurchasesManager() : null;  // native IAP
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
    const _pack = this.uiState.settings.cardPack || "classic";
    if (_pack !== "classic") this._applyCardPack(_pack);

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

    // Viewport / orientation handling. WKWebView often reports the final size a beat
    // after launch and on rotation, so we re-sync on several signals + short delays.
    const onViewportChange = () => {
      this._syncCardStyle();   // phone → simple cards, tablet → art
      this._resize();
      this._render();
    };
    this._onViewportChange = onViewportChange;
    window.addEventListener("resize", onViewportChange);
    window.addEventListener("orientationchange", () => setTimeout(onViewportChange, 150));
    if (window.visualViewport) window.visualViewport.addEventListener("resize", onViewportChange);
    // Catch the settled viewport shortly after launch (fixes wrong-orientation first paint).
    setTimeout(onViewportChange, 250);
    setTimeout(onViewportChange, 800);

    // Sync isPremium + show/hide ad banner
    this.uiState.isPremium = this._isPremium;
    this._syncAdBanner();

    // Sync initial sound setting
    this._sound.setEnabled(this.uiState.settings.sound !== false);

    // Fetch remote config in background (non-blocking)
    this._firebase.fetchConfig();

    // Initialise RevenueCat on native, then reconcile premium status from the store.
    // Store entitlement is the source of truth on mobile (survives reinstalls).
    if (this._purchases && this._purchases.available) {
      this._purchases.init().then(async (ready) => {
        if (!ready) return;
        const owned = await this._purchases.isPremiumActive();
        if (owned && !this._isPremium) {
          this._grantPremium();
          this._render();
        }
        // Show the real localized store price on the Go Premium screen.
        const price = await this._purchases.getPremiumPriceString();
        if (price) { this.renderer.setPriceString(price); this._render(); }
      });
    }

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
    this._syncCardStyle();
    this._render();
  }

  /**
   * Decide card face style by DEVICE, not card width: phones use the crisp drawn
   * faces (art is muddy on small screens), tablets/desktop keep the art.
   * Phone = the shorter screen side ≤ 500px (true for all iPhones in any orientation;
   * iPad mini and up stay on art).
   */
  _syncCardStyle() {
    const minDim  = Math.min(window.innerWidth, window.innerHeight);
    const isPhone = minDim <= 500;
    this.renderer.setCardStyle(isPhone ? "simple" : "auto");
  }

  // ── Canvas sizing ────────────────────────────────────────────────────────

  _resize() {
    const dpr = window.devicePixelRatio || 1;
    // The canvas is positioned inside the iOS safe area by CSS (top/left/right/bottom
    // = env(safe-area-inset-*)), so its on-screen rect IS the true drawable area —
    // no notch/Dynamic-Island/home-indicator clipping. Read it directly.
    // The canvas fills the safe-area-padded body at 100%×100%, so clientWidth/Height
    // give the true drawable area (insets excluded). Fall back to the window size if
    // layout hasn't settled yet on the very first call.
    let W = this.canvas.clientWidth;
    let H = this.canvas.clientHeight;
    if (W < 50)  W = window.innerWidth  || 320;
    if (H < 50)  H = window.innerHeight || 480;

    this.canvas.width  = Math.round(W * dpr);
    this.canvas.height = Math.round(H * dpr);

    const ctx = this.canvas.getContext("2d");
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // The native AdMob banner (free users on Capacitor) is centered at the SCREEN
    // bottom. Rather than reserving a separate felt strip below the footer (which left
    // a dead band), we fold it INTO the footer band: the board extends straight down to
    // the top of the footer, and the footer row holds the undo/redo icons on the left,
    // the banner in the centre, and New Game / End Round on the right. Tell the renderer
    // whether a banner is present + its size so it can size the band and keep the centre
    // clear.
    const bannerPresent = !!(window.Capacitor && !this._isPremium);
    const platform = (window.Capacitor && window.Capacitor.getPlatform &&
                      window.Capacitor.getPlatform()) || "web";
    this.renderer._bannerInfo = {
      present: bannerPresent,
      platform,
      w: (this._ads && this._ads.bannerW) ? this._ads.bannerW : 320,
      h: (this._ads && this._ads.bannerH) ? this._ads.bannerH : 50,
    };
    this.renderer.computeLayout(W, H);
  }

  /** Show/hide the ad banner and re-layout. Call whenever _isPremium changes. */
  _syncAdBanner() {
    const adEl = document.getElementById("ad-strip");
    if (!adEl) return;
    // Web ad strip shows only for: free user + browser (not Capacitor) + CarbonAds
    // is actually configured. Otherwise we'd reserve an empty bottom bar.
    const carbonReady = !!(this._carbon && this._carbon.configured);
    const show = !this._isPremium && !window.Capacitor && carbonReady;
    adEl.style.display = show ? "block" : "none";

    if (show) {
      this._carbon.mount(document.getElementById("carbon-host"));
    } else if (this._carbon) {
      this._carbon.remove();   // e.g. user just went premium
    }
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

    this._animBufBuilt = false;   // build the static buffer on the first tick
    if (this._rafId) cancelAnimationFrame(this._rafId);
    this._rafId = requestAnimationFrame(ts => this._animTick(ts));
  }

  _animTick(timestamp) {
    const a = this._anim;
    if (!a) return;

    // Build the static board buffer once, so each frame is just a blit + 1 card.
    if (!this._animBufBuilt) {
      this.renderer.buildAnimBuffer(this.engine, this.uiState, a.dstRow, a.dstCol);
      this._animBufBuilt = true;
    }

    // Ease-out cubic: t → 1-(1-t)^3
    const raw = Math.min(1, (timestamp - a.t0) / a.duration);
    const t   = 1 - Math.pow(1 - raw, 3);

    let fy = a.y0 + (a.y1 - a.y0) * t;
    // Move-style hook: skins can declare anim.move === "arc" to lift the card mid-flight.
    const sa = this.renderer._skinAnim;
    if (sa && sa.move === "arc") fy -= Math.sin(Math.PI * t) * 42;

    const flyingCard = {
      card: a.card,
      x:    a.x0 + (a.x1 - a.x0) * t,
      y:    fy,
      dstRow: a.dstRow,
      dstCol: a.dstCol,
    };

    // Fast path: blit cached board + flying card. Fall back to full redraw if needed.
    if (!this.renderer.blitAnimFrame(flyingCard)) this._render(flyingCard);

    if (raw < 1) {
      this._rafId = requestAnimationFrame(ts => this._animTick(ts));
    } else {
      // Animation complete
      this.renderer.clearAnimBuffer();
      this._anim   = null;
      this._rafId  = null;
      this._animBufBuilt = false;
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

    // If an overlay was scaled to fit (landscape), map the tap into its coordinate
    // space so buttons line up. Identity when no overlay is scaled (e.g. board taps).
    [x, y] = this.renderer.mapOverlayTap(x, y);

    // Interstitial ad (blocks everything except premium CTA)
    if (this.uiState.adOverlay) {
      const hit = this.renderer.hitTestInterstitial(x, y);
      if (hit === "continue") { this._ads.dismissInterstitial(true); }  // always escapable
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
      else if (hit === "regular" || hit === "daily" || hit === "lifetime") { this.uiState.hsTab = hit; this._openHighScores(); }
      return;
    }
    if (sc === "themes") {
      const hit = this.renderer.hitTestThemes(x, y);
      if (!hit) return;
      if (hit.type === "close") { this.uiState.screen = null; this._render(); return; }
      if (hit.locked) {
        // Premium-gated skin/pack → route to Go Premium (#27 gating).
        this.uiState.premiumState = {
          step: "features",
          email: localStorage.getItem("soli_premium_email") || "",
          isPremium: this._isPremium,
        };
        this.uiState.screen = "premium";
        this._render();
        return;
      }
      if (hit.type === "skin") {
        this.uiState.settings.theme = hit.id;
        this._applyTheme(hit.id);
        this._saveSettings(); this._render();
      } else if (hit.type === "pack" && hit.available) {
        this.uiState.settings.cardPack = hit.id;
        this._applyCardPack(hit.id);
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
        // Native (iOS/Android): Apple/Google REQUIRE in-app purchase — use RevenueCat,
        // never the Stripe link. Web/desktop: keep the Stripe checkout.
        if (this._purchases && this._purchases.available) {
          this._buyPremiumNative();
        } else {
          const STRIPE_URL = "https://buy.stripe.com/eVq14obMleKjepj57fcjS00";
          if (window.Capacitor) {
            import("@capacitor/browser").then(({ Browser }) => Browser.open({ url: STRIPE_URL })).catch(() => window.open(STRIPE_URL, "_blank"));
          } else {
            window.open(STRIPE_URL, "_blank");
          }
        }
      } else if (hit === "activate") {
        // Email-license activation on ALL platforms: a web/macOS/Windows buyer
        // (Stripe → Firebase /licenses) enters their email here to unlock Premium and
        // remove ads — including on iOS. This is a network check, not a store check.
        ps.step = "activate"; ps.emailActive = false; ps.result = undefined;
        this.uiState.premiumState = ps;
        this._render();
      } else if (hit === "restore") {
        // Apple/Google "Restore Purchases" (store IAP) — native only.
        this._restorePremiumNative();
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
    const defaults = { sound: true, theme: "green", cardPack: "classic" };
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
    // Entitlement guard: only the free skin is allowed for non-premium users.
    // (Protects against a stale localStorage value pointing at a premium skin.)
    if (getSkin(id).premium && !this._isPremium) {
      id = "green";
      if (this.uiState.settings.theme !== "green") {
        this.uiState.settings.theme = "green";
        this._saveSettings();
      }
    }
    // applySkin (ui/skins.js) rewrites the live PALETTE + body background.
    const skin = applySkin(id);
    this.renderer.setSkinAnim(skin.anim);   // enable/disable card sheen, move style
    this._syncAmbient();                     // start/stop the ambient animation loop
  }

  /** Switch the card-face pack (no-op for unavailable slots or unentitled users). */
  _applyCardPack(id) {
    const pack = getCardPack(id);
    if (!pack || !pack.available) return;
    if (pack.premium && !this._isPremium) return;
    this.renderer.loadCardPack(id, () => this._render());
  }

  /**
   * Ambient animation loop — only runs while the active skin declares an animated
   * effect (e.g. premium card sheen). Throttled to ~16fps and only repaints while
   * the player is on the board (not in menus/overlays) to save battery.
   */
  _syncAmbient() {
    const anim = this.renderer._skinAnim;
    const want = !!(anim && anim.sheen);
    if (want && !this._ambientId) {
      let last = 0;
      const loop = (ts) => {
        this.renderer.setClock(ts);
        const idleView = !this.uiState.menuOpen && !this.uiState.screen &&
                         !this.uiState.message && !this.uiState.showGDPR &&
                         !this.uiState.adOverlay && !this.uiState.winInput && !this._anim;
        if (idleView && ts - last > 60) { last = ts; this._render(); }
        this._ambientId = requestAnimationFrame(loop);
      };
      this._ambientId = requestAnimationFrame(loop);
    } else if (!want && this._ambientId) {
      cancelAnimationFrame(this._ambientId);
      this._ambientId = null;
    }
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

  /** Apply premium unlock from any source (RevenueCat, license, etc.). */
  _grantPremium() {
    this._isPremium        = true;
    this.uiState.isPremium = true;
    try { localStorage.setItem("soli_premium", JSON.stringify({ active: true })); } catch (_) {}
    this._syncAdBanner();       // hide web ad strip
    this._ads.removeBanner();   // remove native AdMob banner
  }

  /** Native in-app purchase via RevenueCat (iOS/Android only). */
  async _buyPremiumNative() {
    const ps = this.uiState.premiumState || {};
    ps.checking = true; ps.result = undefined;
    this.uiState.premiumState = ps;
    this._render();

    const res = await this._purchases.purchasePremium();
    ps.checking = false;

    if (res.premium) {
      ps.isPremium = true; ps.result = true;
      this._grantPremium();
    } else if (res.cancelled) {
      ps.result = undefined;   // user backed out — no error toast
    } else {
      ps.result = false;       // failed
      // Feedback so the button doesn't feel dead (esp. on the simulator, which has
      // no StoreKit). On a real device with the IAP live this path won't normally hit.
      try { alert("Purchase couldn't be completed. On the iOS Simulator in‑app purchases aren't available — test on a real device or add a StoreKit Configuration file."); } catch (_) {}
    }
    this.uiState.premiumState = ps;
    this._render();
  }

  /** Native "Restore Purchases" via RevenueCat (iOS/Android only). */
  async _restorePremiumNative() {
    const ps = this.uiState.premiumState || {};
    ps.checking = true; ps.result = undefined;
    this.uiState.premiumState = ps;
    this._render();

    const ok = await this._purchases.restore();
    ps.checking = false;
    ps.result   = ok ? true : false;
    if (ok) {
      ps.isPremium = true; this._grantPremium();
      try { alert("Premium restored. Thank you!"); } catch (_) {}
    } else {
      try { alert("No previous purchase found to restore. Make sure you're signed into the same Apple ID. (In‑app purchases don't work on the iOS Simulator — test on a real device.)"); } catch (_) {}
    }
    this.uiState.premiumState = ps;
    this._render();
  }

  // ── High Scores — also fetch Firebase daily scores ────────────────────────

  async _openHighScores() {
    const st = this._stats.getStats();
    const local = {
      regular:  this._stats.getHighScores("regular"),
      daily:    this._stats.getHighScores("daily"),
      lifetime: this._stats.getHighScores("lifetime"),
      meta:     { total: st.totalScore || 0, games: st.played || 0, best: st.bestScore || 0 },
    };
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
    // Overlay drawing is handled by the setOverlayCallback registered in the
    // constructor — it fires for both the immediate browser path and the async
    // AdMob-failure fallback, so the countdown always renders and never stalls.
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
