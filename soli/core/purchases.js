/**
 * core/purchases.js
 * RevenueCat in-app-purchase wrapper for SOLI (Capacitor iOS / Android).
 *
 * Why RevenueCat: Apple and Google REQUIRE digital unlocks bought inside a native
 * app to use their own in-app purchase (StoreKit / Play Billing) — you may NOT use
 * the Stripe link inside the iOS/Android app. RevenueCat wraps both stores and tells
 * you, with one call, whether the user owns the "premium" entitlement.
 *
 * SOLI's premium is a ONE-TIME non-consumable ("lifetime" package, entitlement id
 * "premium"). The Stripe link stays as the WEB / macOS / Windows purchase path; this
 * module is the MOBILE purchase path.
 *
 * Platforms:
 *   • Browser / web   → no-op (PurchasesManager.available === false). Web keeps the
 *                       Stripe + Firebase-license flow.
 *   • Capacitor iOS   → RevenueCat with the Apple API key below.
 *   • Capacitor Android→ RevenueCat with the Google API key below.
 *
 * Setup: see REVENUECAT_SETUP_GUIDE.md. Paste the public SDK keys below.
 */

"use strict";

// ── RevenueCat public SDK keys (NOT secret — safe to ship in the app) ──────────
// Dashboard → Project settings → API keys → "Public app-specific" key per platform.
const RC_APPLE_API_KEY  = "appl_GlIDuaasPTKnyvvItzMkvUXSSXQ";    // iOS App Store (public SDK key)
const RC_GOOGLE_API_KEY = "goog_YOUR_GOOGLE_KEY";   // Google Play

// Entitlement identifier configured in the RevenueCat dashboard.
const RC_ENTITLEMENT_ID = "premium";

class PurchasesManager {
  constructor() {
    this._isCapacitor = !!(window.Capacitor && window.Capacitor.isNativePlatform &&
                           window.Capacitor.isNativePlatform());
    this._mod   = null;    // resolved Purchases plugin
    this._ready = false;
  }

  /** True only on a native platform with a real (non-placeholder) key. */
  get available() {
    if (!this._isCapacitor) return false;
    const key = this._apiKey();
    return !!key && key.indexOf("YOUR_") === -1;
  }

  _platform() {
    const p = window.Capacitor && window.Capacitor.getPlatform && window.Capacitor.getPlatform();
    return p || "ios";
  }

  _apiKey() {
    return this._platform() === "android" ? RC_GOOGLE_API_KEY : RC_APPLE_API_KEY;
  }

  /**
   * Resolve the Purchases plugin. Mirrors ads.js: prefer the npm module (when the
   * project is bundled), fall back to the native bridge that Capacitor auto-registers
   * after `npx cap sync` (works in the plain script-tag build).
   */
  async _getMod() {
    if (this._mod) return this._mod;
    try {
      const m = await import("@revenuecat/purchases-capacitor");
      if (m && m.Purchases) { this._mod = m.Purchases; return this._mod; }
    } catch (_) {}
    if (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.Purchases) {
      this._mod = window.Capacitor.Plugins.Purchases;
      return this._mod;
    }
    return null;
  }

  /**
   * Configure the SDK once at startup. Safe to call on web (no-op).
   * @returns {Promise<boolean>} true if RevenueCat is configured and ready.
   */
  async init() {
    if (!this.available) return false;
    try {
      const P = await this._getMod();
      if (!P) return false;
      await P.configure({ apiKey: this._apiKey() });
      this._ready = true;
      return true;
    } catch (err) {
      console.warn("RevenueCat configure failed:", err);
      return false;
    }
  }

  /**
   * Fetch the localized store price string for the premium package (e.g. "$4.99",
   * "4,99 €"). Returns null if unavailable. Used to show the real price in the UI.
   * @returns {Promise<string|null>}
   */
  async getPremiumPriceString() {
    if (!this._ready) return null;
    try {
      const P = await this._getMod();
      const offerings = await P.getOfferings();
      const cur = offerings && offerings.current;
      if (!cur) return null;
      const pkg = cur.lifetime || (cur.availablePackages && cur.availablePackages[0]);
      return (pkg && pkg.product && pkg.product.priceString) ? pkg.product.priceString : null;
    } catch (err) {
      console.warn("RevenueCat getOfferings (price) failed:", err);
      return null;
    }
  }

  /** Read the cached/refreshed entitlement state. @returns {Promise<boolean>} */
  async isPremiumActive() {
    if (!this._ready) return false;
    try {
      const P = await this._getMod();
      const { customerInfo } = await P.getCustomerInfo();
      return this._hasEntitlement(customerInfo);
    } catch (err) {
      console.warn("RevenueCat getCustomerInfo failed:", err);
      return false;
    }
  }

  /**
   * Run the store purchase flow for the premium unlock.
   * @returns {Promise<{ok:boolean, premium:boolean, cancelled?:boolean, error?:string}>}
   */
  async purchasePremium() {
    if (!this._ready) return { ok: false, premium: false, error: "not_ready" };
    try {
      const P = await this._getMod();
      const offerings = await P.getOfferings();
      const current   = offerings && offerings.current;
      if (!current) return { ok: false, premium: false, error: "no_offering" };

      // Prefer an explicit lifetime package; else the first available package.
      const pkg = current.lifetime ||
                  (current.availablePackages && current.availablePackages[0]);
      if (!pkg) return { ok: false, premium: false, error: "no_package" };

      const result = await P.purchasePackage({ aPackage: pkg });
      const premium = this._hasEntitlement(result && result.customerInfo);
      return { ok: true, premium };
    } catch (err) {
      // RevenueCat sets userCancelled on a user-dismissed purchase.
      if (err && (err.userCancelled || err.code === "1" || /cancel/i.test(err.message || ""))) {
        return { ok: false, premium: false, cancelled: true };
      }
      console.warn("RevenueCat purchase failed:", err);
      return { ok: false, premium: false, error: (err && err.message) || "purchase_failed" };
    }
  }

  /**
   * Restore purchases (App Store / Play require a visible "Restore" path).
   * @returns {Promise<boolean>} true if premium is active after restore.
   */
  async restore() {
    if (!this._ready) return false;
    try {
      const P = await this._getMod();
      const { customerInfo } = await P.restorePurchases();
      return this._hasEntitlement(customerInfo);
    } catch (err) {
      console.warn("RevenueCat restore failed:", err);
      return false;
    }
  }

  _hasEntitlement(customerInfo) {
    const active = customerInfo && customerInfo.entitlements && customerInfo.entitlements.active;
    if (!active) return false;
    if (active[RC_ENTITLEMENT_ID]) return true;
    // Case-insensitive fallback: the RevenueCat dashboard identifier may be "Premium"
    // while our constant is "premium". Match regardless of casing.
    const want = RC_ENTITLEMENT_ID.toLowerCase();
    return Object.keys(active).some(k => k.toLowerCase() === want);
  }
}

// Expose globally (no module bundler in this build).
window.PurchasesManager = PurchasesManager;
