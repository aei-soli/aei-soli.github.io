/**
 * ui/ads.js
 * Ad management for SOLI web/iPad.
 *
 * Two runtime environments:
 *   Browser   — canvas interstitial overlay (countdown + Go Premium CTA)
 *   Capacitor — @capacitor-community/admob plugin (native banner + interstitial)
 *
 * Frequency is controlled by Firebase remote config (same keys as macOS):
 *   enabled, every_n_rounds, between_games, before_bonus,
 *   duration_secs, heavy_after_games, heavy_after_minutes,
 *   heavy_every_n_rounds, heavy_duration_secs
 *
 * Premium users skip all ads entirely.
 */

"use strict";

// ── AdMob test/production switch ───────────────────────────────────────────────
// SINGLE SOURCE OF TRUTH. Flip this ONE constant before archiving for the App Store.
//   true  → Google serves TEST creatives against your real Ad Unit IDs (dev/TestFlight)
//   false → real ads, real revenue (App Store release ONLY)
// Apple/Google can ban your account if you click your own LIVE ads, so keep this
// true on every device you personally test on. See ADMOB_SETUP_GUIDE.md.
const AD_TESTING = true;

// DEV TOGGLE: set to false to suppress all interstitial ads (handy while testing on
// the simulator, where every ad request fails and the upsell overlay keeps appearing).
// Set back to true before release. Does not affect the banner or premium logic.
const INTERSTITIALS_ENABLED = true;

// MASTER ADS KILL-SWITCH: set to false to fully disable AdMob (no banner, no interstitial,
// no init). The iOS Simulator can't reach Google's ad servers, so leaving ads on there
// produces an endless failed-request loop that can crash the WebView. Keep this FALSE
// while testing on the simulator; set it back to TRUE before building for a real device
// / release so banners + interstitials work again.
const ADS_ENABLED = true;

// ── AdMob unit IDs ────────────────────────────────────────────────────────────
const ADMOB_BANNER_ID       = "ca-app-pub-4986726877058608/6166149794"; // your banner
const ADMOB_INTERSTITIAL_ID = "ca-app-pub-4986726877058608/5900910546"; // your interstitial
// Fallback test IDs for reference:
// banner:       ca-app-pub-3940256099942544/2934735716
// interstitial: ca-app-pub-3940256099942544/4411468910

class AdManager {
  /**
   * @param {FirebaseClient} firebase
   * @param {function(): boolean} isPremium  — called each time to check current status
   */
  constructor(firebase, isPremium) {
    this._fb        = firebase;
    this._isPremium = isPremium;

    // Session counters
    this._roundsPlayed = 0;
    this._gamesPlayed  = 0;
    this._sessionStart = Date.now();

    // A/B variant — assigned once on first run, persisted
    this._variant = this._loadVariant();

    // Detect Capacitor
    this._isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                            window.Capacitor.isNativePlatform());

    // AdMob state (Capacitor only)
    this._admobReady        = false;
    this._interstitialReady = false;   // true after prepareInterstitial succeeds
    this._bannerShown       = false;
    this._bannerH           = 50;      // updated via bannerAdSizeChanged event
    this._admobModule       = null;    // cached import

    // Browser canvas interstitial state
    this._overlayState = null;
    this._overlayTimer = null;
  }

  // ── Counters ─────────────────────────────────────────────────────────────

  recordRound() { this._roundsPlayed++; }
  recordGame()  { this._gamesPlayed++;  }

  /** The assigned A/B variant ('a' or 'b'). Stable for the lifetime of the install. */
  get variant() { return this._variant; }

  /** Actual banner height in CSS px (updated after bannerAdSizeChanged fires). */
  get bannerH() { return this._bannerH; }

  // ── AdMob initialisation (Capacitor only) ────────────────────────────────

  /**
   * Call once at app startup (after Capacitor is ready).
   * For browser: no-op.
   * For Capacitor: initialises AdMob, requests ATT authorisation on iOS,
   * shows the banner for free users, and pre-loads the first interstitial.
   * @param {boolean} showBannerForFreeUser
   */
  /**
   * @param {boolean}       showBannerForFreeUser
   * @param {function|null} onBannerResize  called with actual banner height (px)
   *                                        whenever the banner size is determined
   */
  async initAdMob(showBannerForFreeUser = true, onBannerResize = null) {
    if (!this._isCapacitor || !ADS_ENABLED) return;   // master kill-switch (see top)

    try {
      const mod = await this._getAdMob();
      if (!mod) return;

      await mod.AdMob.initialize({
        requestTrackingAuthorization: true,   // iOS ATT prompt
        initializeForTesting: AD_TESTING,     // single switch — see top of file
      });

      this._admobReady = true;

      if (showBannerForFreeUser && !this._isPremium()) {
        await this.showBanner(onBannerResize);
      }

      // Pre-load the first interstitial so it's ready when needed
      this._preloadInterstitial();

    } catch (err) {
      console.warn("AdMob init failed:", err);
    }
  }

  // ── Banner (Capacitor only) ───────────────────────────────────────────────

  /**
   * Show a native full-width bottom banner.
   * @param {function|null} onResize  called with height (px) when banner size is known
   */
  async showBanner(onResize = null) {
    if (!this._isCapacitor || this._isPremium()) return;
    try {
      const mod = await this._getAdMob();
      if (!mod) return;

      const { BannerAdSize, BannerAdPosition, BannerAdPluginEvents } = mod;

      // Lift the banner out of the home-indicator safe area so it sits flush with the
      // footer button row (drawn inside the webview, above the safe area). The body is
      // padded by env(safe-area-inset-bottom), so read that value and use it as margin.
      let bottomMargin = 0;
      try {
        const sb = parseFloat(getComputedStyle(document.body).paddingBottom);
        if (!isNaN(sb) && sb > 0) bottomMargin = Math.round(sb);
      } catch (e) { /* ignore */ }

      // Listen for the actual rendered height so the game canvas can resize precisely
      if (BannerAdPluginEvents) {
        mod.AdMob.addListener(BannerAdPluginEvents.SizeChanged, (info) => {
          // Reserve exactly the banner's reported height (no extra padding) so the
          // board sits right above it with no dead gap.
          const h = info && info.height ? Math.ceil(info.height) : 50;
          this._bannerH = h;
          if (onResize) onResize(h);
        });
      }

      await mod.AdMob.showBanner({
        adId:      ADMOB_BANNER_ID,
        adSize:    BannerAdSize.BANNER,            // fixed 320×50 — sits in the centre footer slot
        position:  BannerAdPosition.BOTTOM_CENTER, // between the left/right button groups
        margin:    bottomMargin,                   // lift above the home-indicator safe area
        isTesting: AD_TESTING,   // single switch — see top of file
      });
      this._bannerShown = true;
    } catch (err) {
      console.warn("AdMob banner failed:", err);
    }
  }

  /**
   * Hide the native banner (e.g. while showing a full-screen overlay).
   * Use removeBanner() to permanently remove (e.g. on premium unlock).
   */
  async hideBanner() {
    if (!this._isCapacitor || !this._bannerShown) return;
    try {
      const mod = await this._getAdMob();
      if (mod) await mod.AdMob.hideBanner();
    } catch (_) {}
  }

  /**
   * Permanently remove the banner — call when user goes premium.
   */
  async removeBanner() {
    if (!this._isCapacitor) return;
    try {
      const mod = await this._getAdMob();
      if (mod) { await mod.AdMob.removeBanner(); this._bannerShown = false; }
    } catch (_) {}
  }

  // ── Should-show logic (mirrors macOS) ────────────────────────────────────

  shouldShowAfterRound() {
    if (!INTERSTITIALS_ENABLED) return false;
    if (this._isPremium()) return false;
    const cfg = this._fb.config;
    if (!cfg.enabled) return false;
    const n = this._everyNRounds();
    return n > 0 && this._roundsPlayed > 0 && this._roundsPlayed % n === 0;
  }

  shouldShowBeforeGame() {
    if (!INTERSTITIALS_ENABLED) return false;
    if (this._isPremium()) return false;
    const cfg = this._fb.config;
    return cfg.enabled && cfg.between_games && this._gamesPlayed > 0;
  }

  shouldShowBeforeBonus() {
    if (!INTERSTITIALS_ENABLED) return false;
    if (this._isPremium()) return false;
    const cfg = this._fb.config;
    return cfg.enabled && cfg.before_bonus;
  }

  // ── Show interstitial ─────────────────────────────────────────────────────

  /**
   * Display an interstitial ad, then call onDone.
   * @param {function} onDone     called when the ad is dismissed or fails
   * @param {function} onPremium  called if user taps "Go Premium" (browser only)
   */
  /**
   * Show the interstitial overlay, then call onDone when dismissed.
   *
   * Always uses the canvas overlay (SOLI-branded countdown, Firebase-timed,
   * landscape-safe, auto-dismissing).  This matches the original macOS app's
   * interstitial style and respects the Admin Dashboard timer/frequency settings.
   * The native AdMob full-screen interstitial requires additional iOS orientation
   * configuration and is available via _showAdMobInterstitial() when needed.
   */
  async showInterstitial(onDone, onPremium) {
    // Respect BOTH switches here so every caller (incl. the game-over / end-of-round
    // path) is suppressed when interstitials are disabled — not just the shouldShow* gates.
    if (!ADS_ENABLED || !INTERSTITIALS_ENABLED) { if (onDone) onDone(); return; }
    if (this._isCapacitor) {
      await this._showAdMobInterstitial(onDone, onPremium);   // real Google ad
    } else {
      this._showBrowserInterstitial(onDone, onPremium);  // SOLI canvas overlay
    }
  }

  // ── Capacitor / AdMob interstitial ────────────────────────────────────────

  async _showAdMobInterstitial(onDone, onPremium) {
    const mod = await this._getAdMob();
    if (!mod) { onDone(); return; }

    const { AdMob, InterstitialAdPluginEvents } = mod;

    // One-shot listener — remove after first event to avoid memory leaks
    const cleanup = () => {
      AdMob.removeAllListeners();
    };

    try {
      // If pre-loaded, show immediately; otherwise load now (slower)
      if (!this._interstitialReady) {
        await AdMob.prepareInterstitial({
          adId:      ADMOB_INTERSTITIAL_ID,
          isTesting: AD_TESTING,   // single switch — see top of file
        });
      }
      this._interstitialReady = false;

      // Listen for dismiss or failure
      AdMob.addListener(InterstitialAdPluginEvents.Dismissed, () => {
        cleanup();
        this._preloadInterstitial();  // pre-load next one immediately
        onDone();
      });
      AdMob.addListener(InterstitialAdPluginEvents.FailedToShow, () => {
        cleanup();
        onDone();  // skip gracefully
      });

      await AdMob.showInterstitial();

    } catch (err) {
      console.warn("AdMob interstitial failed — falling back to canvas overlay:", err);
      cleanup();
      // Fall back to browser canvas overlay so user still sees the upsell.
      // Pass onPremium through so the "Go Premium" button works in the fallback too.
      this._showBrowserInterstitial(onDone, onPremium);
    }
  }

  /** Pre-load the next interstitial in the background. */
  async _preloadInterstitial() {
    if (!this._admobReady) return;
    try {
      const mod = await this._getAdMob();
      if (!mod) return;
      await mod.AdMob.prepareInterstitial({
        adId:      ADMOB_INTERSTITIAL_ID,
        isTesting: AD_TESTING,   // single switch — see top of file
      });
      this._interstitialReady = true;
    } catch (_) {
      this._interstitialReady = false;
    }
  }

  // ── Browser canvas interstitial ───────────────────────────────────────────

  /** game.js registers a callback here that draws/updates the canvas overlay. */
  setOverlayCallback(cb) { this._onOverlay = cb; }

  /** Push the current overlay state to the UI (works for sync AND async-fallback paths). */
  _pushOverlay() { if (this._onOverlay) this._onOverlay(this._overlayState); }

  _showBrowserInterstitial(onDone, onPremium) {
    const total = this._duration();
    this._overlayState = {
      remaining: total,
      total,
      onDone,
      onPremium,
      canClose:  false,
    };
    this._pushOverlay();   // draw it immediately

    const tick = () => {
      if (!this._overlayState) return;
      this._overlayState.remaining = Math.max(0, this._overlayState.remaining - 1);
      if (this._overlayState.remaining <= 0) this._overlayState.canClose = true;
      this._pushOverlay();   // redraw with updated countdown
      if (this._overlayState.remaining > 0) {
        this._overlayTimer = setTimeout(tick, 1000);
      }
    };
    this._overlayTimer = setTimeout(tick, 1000);

    // Hard failsafe — never trap the user. Force-dismiss shortly after the countdown
    // should have finished, even if the tick stalls (e.g. WKWebView timer throttling).
    this._overlayHardTimer = setTimeout(() => this.dismissInterstitial(true), (total + 3) * 1000);
  }

  get overlayState() { return this._overlayState; }

  _clearOverlayTimers() {
    if (this._overlayTimer)     { clearTimeout(this._overlayTimer);     this._overlayTimer = null; }
    if (this._overlayHardTimer) { clearTimeout(this._overlayHardTimer); this._overlayHardTimer = null; }
  }

  /** Continue. force=true bypasses the countdown gate (used for tap + failsafe). */
  dismissInterstitial(force = false) {
    if (!this._overlayState) return;
    if (!force && !this._overlayState.canClose) return;
    this._clearOverlayTimers();
    const cb = this._overlayState.onDone;
    this._overlayState = null;
    this._pushOverlay();   // clear it in the UI
    if (cb) cb();
  }

  /** User tapped Go Premium during browser ad. */
  premiumFromInterstitial() {
    if (!this._overlayState) return;
    this._clearOverlayTimers();
    const cb = this._overlayState.onPremium;
    this._overlayState = null;
    this._pushOverlay();
    if (cb) cb();
  }

  // ── Helpers ───────────────────────────────────────────────────────────────

  /**
   * Return the AdMob module, or null if unavailable.
   *
   * Two resolution paths:
   *  1. ES-module import — works when the project is bundled with Vite/Webpack.
   *  2. Script-tag fallback — capacitor.core.js + admob.plugin.js are loaded in
   *     index.html, giving us window.capacitorStripe which holds AdMob + all enums.
   */
  async _getAdMob() {
    if (this._admobModule) return this._admobModule;

    // Path 1: bundler resolves the npm package (future-proof)
    try {
      this._admobModule = await import("@capacitor-community/admob");
      return this._admobModule;
    } catch (_) {}

    // Path 2: vanilla JS — admob.plugin.js IIFE exports as window.capacitorStripe
    if (window.capacitorStripe && window.capacitorStripe.AdMob) {
      this._admobModule = window.capacitorStripe;
      return this._admobModule;
    }

    return null;
  }

  _isHeavy() {
    const cfg     = this._fb.config;
    const minutes = (Date.now() - this._sessionStart) / 60000;
    return this._gamesPlayed >= cfg.heavy_after_games ||
           minutes           >= cfg.heavy_after_minutes;
  }

  _everyNRounds() {
    const cfg = this._fb.config;
    if (this._isHeavy()) return cfg.heavy_every_n_rounds;
    if (cfg.ab_mode) {
      return this._variant === "a"
        ? cfg.variant_a_every_n_rounds
        : cfg.variant_b_every_n_rounds;
    }
    return cfg.every_n_rounds;
  }

  _duration() {
    const cfg = this._fb.config;
    if (this._isHeavy()) return cfg.heavy_duration_secs || 8;
    if (cfg.ab_mode) {
      return this._variant === "a"
        ? (cfg.variant_a_duration_secs || 5)
        : (cfg.variant_b_duration_secs || 8);
    }
    return cfg.duration_secs || 5;
  }

  _loadVariant() {
    try {
      const stored = localStorage.getItem("soli_ab_variant");
      if (stored === "a" || stored === "b") return stored;
    } catch (_) {}
    const v = Math.random() < 0.5 ? "a" : "b";
    try { localStorage.setItem("soli_ab_variant", v); } catch (_) {}
    return v;
  }
}
