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

// ── AdMob unit IDs ────────────────────────────────────────────────────────────
// isTesting: true is set throughout — shows Google test creatives against your
// real Ad Unit IDs. Safe for Mac Simulator and physical iPad during development.
// When submitting to App Store: set isTesting → false everywhere below.
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
    this._bannerH           = 72;      // updated via bannerAdSizeChanged event
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
    if (!this._isCapacitor) return;

    try {
      const mod = await this._getAdMob();
      if (!mod) return;

      await mod.AdMob.initialize({
        requestTrackingAuthorization: true,   // iOS ATT prompt
        initializeForTesting: true,           // set false before App Store submission
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

      // Listen for the actual rendered height so the game canvas can resize precisely
      if (BannerAdPluginEvents) {
        mod.AdMob.addListener(BannerAdPluginEvents.SizeChanged, (info) => {
          // info.height is in dp; add 8px breathing room
          const h = info && info.height ? Math.ceil(info.height) + 8 : 72;
          this._bannerH = h;
          if (onResize) onResize(h);
        });
      }

      await mod.AdMob.showBanner({
        adId:      ADMOB_BANNER_ID,
        adSize:    BannerAdSize.ADAPTIVE_BANNER,   // full-width, no partial overlap
        position:  BannerAdPosition.BOTTOM_CENTER,
        margin:    0,
        isTesting: true,   // set false before App Store submission
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
    if (this._isPremium()) return false;
    const cfg = this._fb.config;
    if (!cfg.enabled) return false;
    const n = this._everyNRounds();
    return n > 0 && this._roundsPlayed > 0 && this._roundsPlayed % n === 0;
  }

  shouldShowBeforeGame() {
    if (this._isPremium()) return false;
    const cfg = this._fb.config;
    return cfg.enabled && cfg.between_games && this._gamesPlayed > 0;
  }

  shouldShowBeforeBonus() {
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
    if (this._isCapacitor) {
      await this._showAdMobInterstitial(onDone);   // real Google ad
    } else {
      this._showBrowserInterstitial(onDone, onPremium);  // SOLI canvas overlay
    }
  }

  // ── Capacitor / AdMob interstitial ────────────────────────────────────────

  async _showAdMobInterstitial(onDone) {
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
          isTesting: true,   // match initializeForTesting above
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
      // Fall back to browser canvas overlay so user still sees the upsell
      this._showBrowserInterstitial(onDone, null);
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
        isTesting: true,   // match initializeForTesting above
      });
      this._interstitialReady = true;
    } catch (_) {
      this._interstitialReady = false;
    }
  }

  // ── Browser canvas interstitial ───────────────────────────────────────────

  _showBrowserInterstitial(onDone, onPremium) {
    const total = this._duration();
    this._overlayState = {
      remaining: total,
      total,
      onDone,
      onPremium,
      canClose:  false,
    };

    const tick = () => {
      if (!this._overlayState) return;
      this._overlayState.remaining = Math.max(0, this._overlayState.remaining - 1);
      if (this._overlayState.remaining <= 0) this._overlayState.canClose = true;
      if (this._overlayState._renderFn) this._overlayState._renderFn();
      if (this._overlayState.remaining > 0) {
        this._overlayTimer = setTimeout(tick, 1000);
      }
    };
    this._overlayTimer = setTimeout(tick, 1000);
  }

  get overlayState() { return this._overlayState; }

  /** User tapped Continue (countdown expired). */
  dismissInterstitial() {
    if (!this._overlayState || !this._overlayState.canClose) return;
    if (this._overlayTimer) clearTimeout(this._overlayTimer);
    const cb = this._overlayState.onDone;
    this._overlayState = null;
    cb();
  }

  /** User tapped Go Premium during browser ad. */
  premiumFromInterstitial() {
    if (!this._overlayState) return;
    if (this._overlayTimer) clearTimeout(this._overlayTimer);
    const cb = this._overlayState.onPremium;
    this._overlayState = null;
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
