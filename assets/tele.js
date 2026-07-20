/* Cubist Souls — front-end telemetry + feature-flag loader.
 *
 * This file does TWO jobs and is wired into every page with a single
 *   <script src="/assets/tele.js" defer></script>
 * so we never add a second tag (keeps the shared HTML pages one-line-clean).
 *
 * 1) ERROR TELEMETRY
 *    window.onerror + unhandledrejection → POST /api/telemetry with ONLY the
 *    error message, the current page path, and the User-Agent. No PII, ever.
 *    Wrapped in total try/catch: telemetry can NEVER throw, break a page, or
 *    recurse into itself. Same-message reports are de-duped within a session.
 *
 * 2) FEATURE FLAGS (flags.json)
 *    Fetches /flags.json → window.CS_FLAGS and fires a `cs:flags` event.
 *    Flags (all default true if the fetch fails — fail-open):
 *      collab  — collab plaque + "fire" button on the Souls (kill-switch below)
 *      ticker  — scrolling ticker strip
 *      eraBar  — era / progress bar
 *      govern  — governance entry points
 *      wc      — offer WalletConnect (consumed by assets/wallet.js). false =
 *                injected-wallet flow only, no WalletConnect anywhere.
 *    CONVENTION for other scripts: read `window.CS_FLAGS` if it already exists,
 *    otherwise listen once for `document.addEventListener('cs:flags', ...)`.
 *    e.g.  function withFlags(cb){ if(window.CS_FLAGS) cb(window.CS_FLAGS);
 *            else document.addEventListener('cs:flags', e => cb(e.detail), {once:true}); }
 *    This file only CONSUMES `collab` (kill-switch); ticker/eraBar are left for
 *    the page scripts to consume via the convention above.
 */
(function () {
  "use strict";

  var ENDPOINT = "/api/telemetry";
  var FLAGS_URL = "/flags.json";
  var DEFAULT_FLAGS = { collab: true, ticker: true, eraBar: true, govern: true, wc: true };

  // ── error telemetry ───────────────────────────────────────────────────────
  var sent = {};       // session-scoped dedupe: msg → true
  var count = 0;       // client-side cap so a tight loop can't spam even us
  var MAX_PER_SESSION = 20;

  function report(msg, stack) {
    try {
      if (!msg) return;
      msg = String(msg).slice(0, 500);
      if (sent[msg]) return;              // already reported this message
      if (count >= MAX_PER_SESSION) return;
      sent[msg] = true;
      count++;

      var payload = {
        page: (location.pathname || "/").slice(0, 300),
        msg: msg,
        ua: (navigator.userAgent || "").slice(0, 512),
        ts: Date.now(),
      };
      if (stack) payload.stack = String(stack).slice(0, 2000);

      var json = JSON.stringify(payload);

      // Prefer sendBeacon (survives page unload); fall back to keepalive fetch.
      var beacon = navigator.sendBeacon;
      if (beacon) {
        try {
          var blob = new Blob([json], { type: "application/json" });
          if (navigator.sendBeacon(ENDPOINT, blob)) return;
        } catch (e) { /* fall through to fetch */ }
      }
      if (window.fetch) {
        fetch(ENDPOINT, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: json,
          keepalive: true,
        }).catch(function () { /* swallow — telemetry never surfaces errors */ });
      }
    } catch (e) { /* telemetry must never throw */ }
  }

  try {
    window.addEventListener("error", function (ev) {
      try {
        var msg = ev && ev.message ? ev.message : (ev && ev.error && ev.error.message) || "error";
        var stack = ev && ev.error && ev.error.stack ? ev.error.stack : null;
        report(msg, stack);
      } catch (e) { /* noop */ }
    });

    window.addEventListener("unhandledrejection", function (ev) {
      try {
        var reason = ev && ev.reason;
        var msg = reason && reason.message ? reason.message : String(reason || "unhandledrejection");
        var stack = reason && reason.stack ? reason.stack : null;
        report("unhandledrejection: " + msg, stack);
      } catch (e) { /* noop */ }
    });
  } catch (e) { /* if listeners can't attach, we still load flags below */ }

  // ── feature-flag loader ───────────────────────────────────────────────────
  function applyFlags(flags) {
    try {
      window.CS_FLAGS = flags;
      // collab kill-switch: hide the plaque + fire button with no redeploy.
      if (flags && flags.collab === false) {
        try {
          var style = document.createElement("style");
          style.setAttribute("data-cs-flag", "collab-off");
          style.textContent = ".collab-plaque,.fire-btn{display:none!important}";
          (document.head || document.documentElement).appendChild(style);
        } catch (e) { /* noop */ }
      }
      // Announce to page scripts (ticker/eraBar/govern consumers).
      try {
        document.dispatchEvent(new CustomEvent("cs:flags", { detail: flags }));
      } catch (e) { /* CustomEvent unsupported → CS_FLAGS is still readable */ }
    } catch (e) { /* noop */ }
  }

  try {
    if (window.fetch) {
      fetch(FLAGS_URL, { cache: "no-cache" })
        .then(function (r) { return r.ok ? r.json() : DEFAULT_FLAGS; })
        .then(function (f) { applyFlags(f && typeof f === "object" ? f : DEFAULT_FLAGS); })
        .catch(function () { applyFlags(DEFAULT_FLAGS); });   // fail-open
    } else {
      applyFlags(DEFAULT_FLAGS);
    }
  } catch (e) {
    applyFlags(DEFAULT_FLAGS);
  }
})();
