/**
 * ui/carbonads.js
 * CarbonAds loader for the SOLI web build (desktop browsers only).
 *
 * CarbonAds is a single-ad, developer-audience network. It requires manual
 * approval of your LIVE site before you get IDs (see CARBONADS_SETUP_GUIDE.md).
 *
 * Behaviour:
 *   • Web (non-Capacitor), free user, IDs configured → inject the Carbon script.
 *   • Premium, or Capacitor (iOS/Android), or IDs not yet configured → do nothing.
 *
 * After approval, paste your serve + placement IDs below. Until then `configured`
 * stays false and GameUi keeps the ad strip hidden, so there is never an empty bar.
 */

"use strict";

// ── Fill these in after CarbonAds approves your site ───────────────────────────
// Found in your CarbonAds dashboard zone snippet:
//   //cdn.carbonads.com/carbon.js?serve=CExxxxxxx&placement=yoursite
const CARBON_SERVE_ID  = "YOUR_SERVE_ID";   // e.g. "CE7DKK3W"
const CARBON_PLACEMENT = "YOUR_PLACEMENT";  // e.g. "playsolicom"

class CarbonAds {
  constructor() {
    this._mounted = false;
  }

  /** True once real IDs have been pasted in above. */
  get configured() {
    return (
      typeof CARBON_SERVE_ID === "string" &&
      CARBON_SERVE_ID.length > 0 &&
      CARBON_SERVE_ID.indexOf("YOUR_") !== 0 &&
      CARBON_PLACEMENT.indexOf("YOUR_") !== 0
    );
  }

  /**
   * Inject the Carbon script into the given host element. Idempotent.
   * @param {HTMLElement} hostEl  the #carbon-host div inside #ad-strip
   */
  mount(hostEl) {
    if (this._mounted || !hostEl || !this.configured) return;
    const s = document.createElement("script");
    s.async = true;
    s.type  = "text/javascript";
    s.id    = "_carbonads_js";
    s.src   = `//cdn.carbonads.com/carbon.js?serve=${encodeURIComponent(CARBON_SERVE_ID)}` +
              `&placement=${encodeURIComponent(CARBON_PLACEMENT)}`;
    hostEl.appendChild(s);
    this._mounted = true;
  }

  /** Remove the rendered ad and script — call when the user goes premium. */
  remove() {
    const ad = document.getElementById("carbonads");
    if (ad) ad.remove();
    const js = document.getElementById("_carbonads_js");
    if (js) js.remove();
    this._mounted = false;
  }
}

// Expose globally (no module bundler in this build).
window.CarbonAds = CarbonAds;
