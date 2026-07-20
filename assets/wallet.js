/* Cubist Souls — unified wallet provider (injected + WalletConnect v2).
 *
 * ONE small always-loaded helper shared by index.html and my-souls.html so both
 * pages get identical wallet plumbing. It resolves the *active* EIP-1193 provider:
 * the injected wallet (MetaMask/Rabby — the original flow, untouched and always the
 * first option) OR a WalletConnect v2 provider for wallet-less browsers (mobile
 * Safari/Chrome without an extension, desktop without a wallet → QR).
 *
 * The heavy WalletConnect UMD (~1.8 MB) is loaded LAZILY — only when someone starts
 * a WalletConnect connection, or when a prior WC session must be restored on landing.
 * A fresh visitor who never touches "connect" downloads nothing extra.
 *
 * Everything that must go through the *user's wallet* (connect, approve, convert,
 * personal_sign) uses CSWallet.getEip1193(). Chain/ownership READS keep using the
 * pages' own Tenderly/public JSON-RPC providers — those are not touched here.
 *
 * Kill-switch: respects window.CS_FLAGS.wc (from /flags.json via tele.js). When
 * wc === false, WalletConnect is never offered — only the injected flow.
 *
 * MOBILE (no injected wallet): the WalletConnect deep-link handoff to a wallet app
 * is flaky in iOS Safari ("Continue in MetaMask" hangs). So on mobile without an
 * injected provider we offer FIRST the reliable path — open cubistsouls.com inside
 * the wallet's own dapp browser (universal links), where the provider is injected
 * and connect is instant, no QR, no handoff. WalletConnect stays as a discreet
 * secondary option. openWalletSheet() renders that self-contained museum-cartela
 * sheet; dappLinks() builds the universal links for the CURRENT page. These links
 * do NOT depend on WalletConnect, so they show even when flags.wc === false, and
 * they never load the heavy WC UMD.
 */
window.CSWallet = (function () {
  "use strict";

  // Public WalletConnect Cloud projectId (same one already live on zerothetoken).
  var WC_PROJECT_ID = "21fef48091f12692cad574a6f7753643";
  // Pinned exact version — the 2.23.4 UMD exposes the class as
  // window["@walletconnect/ethereum-provider"].EthereumProvider (NOT window.EthereumProvider).
  var WC_SRC = "https://cdn.jsdelivr.net/npm/@walletconnect/ethereum-provider@2.23.4/dist/index.umd.js";
  var WC_INTEGRITY = "sha384-nhmVr4U4jwVfKgLwOrnEBNp3cSJgufORrOwEkYmRQms0jOJlvSknC3UyKhJg8s96";
  var WC_META = {
    name: "Cubist Souls",
    description: "Burn a Pikkazo, free its Cubist Soul",
    url: "https://cubistsouls.com",
    icons: ["https://cubistsouls.com/assets/logo.svg"]
  };
  // WalletConnect v2 stores its live session under this localStorage key.
  var WC_SESSION_KEY = "wc@2:client:0.3//session";

  var isLocal = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
  var QS = new URLSearchParams(location.search);
  // localhost-only harness: ?wcforce=1 pretends there is NO injected wallet, so
  // "Connect Wallet" goes straight to the WalletConnect modal (QR).
  var FORCE_WC = isLocal && QS.get("wcforce") === "1";
  // localhost-only harness: ?mobileforce=1 pretends this is a mobile device with
  // NO injected wallet, so "Connect Wallet" opens the museum wallet sheet on desktop.
  var FORCE_MOBILE = isLocal && QS.get("mobileforce") === "1";

  var active = null;   // the EIP-1193 provider currently in use (injected or WC)
  var wc = null;       // the WalletConnect EthereumProvider instance (once inited)
  var scriptP = null;  // memoized lazy-load promise for the UMD
  var changeCb = null; // page callback for account/chain/disconnect on the WC provider

  // Both localhost harnesses pretend there is no injected wallet so the wallet-less
  // paths (WC modal / mobile sheet) can be exercised on a dev machine with an extension.
  function injected() { return (FORCE_WC || FORCE_MOBILE) ? null : (window.ethereum || null); }
  function hasInjected() { return !!injected(); }

  // Robust mobile detection. Classic mobile UAs, plus iPadOS 13+ which lies and
  // reports as desktop "Macintosh" — caught via touch points on a Mac UA. The
  // localhost ?mobileforce=1 harness forces it on for desktop verification.
  function isMobile() {
    if (FORCE_MOBILE) return true;
    var ua = navigator.userAgent || "";
    if (/Android|iPhone|iPod|Windows Phone|BlackBerry|BB10|Mobi/i.test(ua)) return true;
    if (/iPad/i.test(ua)) return true;
    // iPadOS masquerading as macOS: Mac UA + a touch screen (real Macs report 0).
    if (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) return true;
    return false;
  }

  // Build the CURRENT page's URL for the wallet dapp-browser universal links,
  // stripping the localhost-only debug params so they never leak into the link.
  function currentUrlForDapp() {
    var params = new URLSearchParams(location.search);
    params.delete("wcforce");
    params.delete("mobileforce");
    var qs = params.toString();
    var tail = location.pathname + (qs ? "?" + qs : "");
    return {
      hostPath: location.host + tail,                 // no scheme (MetaMask format)
      full: location.protocol + "//" + location.host + tail // full URL (Coinbase format)
    };
  }

  // Universal links that open cubistsouls.com INSIDE a wallet's own dapp browser,
  // where the wallet provider is injected and connect is one tap (no QR, no iOS
  // deep-link handoff that hangs in Safari). Only wallets with a confirmed, stable
  // universal-link format are included:
  //   - MetaMask:  https://metamask.app.link/dapp/<host+path>  (host/path, no scheme)
  //     src: https://docs.metamask.io/wallet/how-to/use-mobile/
  //   - Coinbase:  https://go.cb-w.com/dapp?cb_url=<url-encoded full url>
  //     src: https://docs.cdp.coinbase.com/coinbase-wallet/developer-guidance/mobile-dapp-integration
  // Omitted (unconfirmed / broken for our case): Rabby (no stable HTTPS dapp-browser
  // link), Phantom (browse deeplink has documented "page not found" issues), Trust
  // (its iOS dapp browser was removed; link format migrated to Branch.io).
  function dappLinks() {
    var u = currentUrlForDapp();
    return [
      { id: "metamask", name: "MetaMask", mono: "M", tint: "#f6851b",
        url: "https://metamask.app.link/dapp/" + u.hostPath },
      { id: "coinbase", name: "Coinbase Wallet", mono: "C", tint: "#0052ff",
        url: "https://go.cb-w.com/dapp?cb_url=" + encodeURIComponent(u.full) }
    ];
  }

  // The active provider for anything that must hit the user's wallet.
  function getEip1193() { return active || injected(); }

  // Kill-switch. Fail-open (matches tele.js) and open before flags load.
  function wcEnabled() {
    var f = window.CS_FLAGS;
    if (f && typeof f.wc !== "undefined") return f.wc !== false;
    return true;
  }

  // Resolve the EthereumProvider class from whatever global the UMD exposed.
  function resolveCtor() {
    if (window.EthereumProvider && window.EthereumProvider.init) return window.EthereumProvider;
    var ns = window["@walletconnect/ethereum-provider"];
    if (ns) {
      if (ns.EthereumProvider && ns.EthereumProvider.init) return ns.EthereumProvider;
      if (ns.default && ns.default.init) return ns.default;
    }
    return null;
  }

  // Lazily inject the WalletConnect UMD, once.
  function loadScript() {
    if (scriptP) return scriptP;
    scriptP = new Promise(function (resolve, reject) {
      if (resolveCtor()) return resolve();
      var s = document.createElement("script");
      s.src = WC_SRC;
      s.integrity = WC_INTEGRITY;
      s.crossOrigin = "anonymous";
      s.async = true;
      s.onload = function () {
        resolveCtor() ? resolve() : reject(new Error("WalletConnect loaded but exposed no EthereumProvider"));
      };
      s.onerror = function () { scriptP = null; reject(new Error("WalletConnect script failed to load")); };
      (document.head || document.documentElement).appendChild(s);
    });
    return scriptP;
  }

  function fireChange(type) {
    if (typeof changeCb === "function") { try { changeCb(type); } catch (e) { /* noop */ } }
  }

  function wireWc() {
    if (!wc || wc.__csWired) return;
    wc.__csWired = true;
    // Mirror the injected flow: any account/chain/disconnect change → the page reloads.
    wc.on("accountsChanged", function () { fireChange("accountsChanged"); });
    wc.on("chainChanged", function () { fireChange("chainChanged"); });
    wc.on("disconnect", function () { fireChange("disconnect"); });
    wc.on("session_delete", function () { fireChange("disconnect"); });
  }

  // Init (or reuse) the WalletConnect provider. Mainnet only (chains:[1]).
  async function initWc() {
    if (wc) return wc;
    await loadScript();
    var Ctor = resolveCtor();
    if (!Ctor) throw new Error("WalletConnect EthereumProvider unavailable");
    wc = await Ctor.init({
      projectId: WC_PROJECT_ID,
      chains: [1],
      showQrModal: true,
      metadata: WC_META
    });
    wireWc();
    return wc;
  }

  // Start (or resume) a WalletConnect session. Opens the QR / deep-link modal when
  // there is no live session. Resolves once the wallet approves.
  async function connectWalletConnect() {
    var p = await initWc();
    if (!p.session || !(p.accounts && p.accounts.length)) {
      await p.enable(); // opens the modal; rejects if the user closes it
    }
    active = p;
    return p;
  }

  function connectInjected() {
    var inj = injected();
    if (!inj) throw new Error("No injected wallet");
    active = inj;
    return inj;
  }

  function hasPersistedWcSession() {
    try {
      var raw = localStorage.getItem(WC_SESSION_KEY);
      if (!raw) return false;
      var arr = JSON.parse(raw);
      return Array.isArray(arr) && arr.length > 0;
    } catch (e) { return false; }
  }

  // On landing: restore a prior WalletConnect session, but ONLY load the heavy UMD
  // when a persisted session actually exists (keeps the network tab clean otherwise).
  async function restoreSession() {
    if (!wcEnabled()) return null;
    if (!hasPersistedWcSession()) return null;
    try {
      var p = await initWc();
      if (p.session && p.accounts && p.accounts.length) { active = p; return p; }
    } catch (e) { /* silent — user can still connect manually */ }
    return null;
  }

  // Best-effort switch of the active provider to Ethereum mainnet. Works for both
  // injected and WalletConnect (WC is inited on chain 1, so this is usually a no-op).
  async function ensureMainnet() {
    var p = getEip1193(); if (!p) return false;
    try {
      var cid = await p.request({ method: "eth_chainId" });
      if (parseInt(cid, 16) === 1) return true;
    } catch (e) { /* fall through to switch */ }
    try {
      await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0x1" }] });
      return true;
    } catch (e) { return false; }
  }

  async function disconnect() {
    try { if (wc && wc.disconnect) await wc.disconnect(); } catch (e) { /* noop */ }
    active = null;
  }

  // ── Mobile wallet sheet ─────────────────────────────────────────────────────
  // Self-contained (own inline <style>, no page CSS dependency) so both pages get
  // an identical museum-cartela sheet. Never loads the WalletConnect UMD.
  function ensureSheetStyles() {
    if (document.getElementById("cs-wsheet-css")) return;
    var css = document.createElement("style");
    css.id = "cs-wsheet-css";
    css.textContent = [
      ".cs-wsheet-ov{position:fixed;inset:0;z-index:9999;display:flex;align-items:flex-end;justify-content:center;",
        "background:rgba(6,5,4,.72);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px);",
        "opacity:0;transition:opacity .2s ease;padding:0}",
      ".cs-wsheet-ov.in{opacity:1}",
      "@media(min-width:560px){.cs-wsheet-ov{align-items:center;padding:20px}}",
      ".cs-wsheet{position:relative;width:100%;max-width:440px;background:#171311;color:#f3ece3;",
        "border:1px solid #2a2320;border-top:2px solid #e0a520;",
        "border-radius:18px 18px 0 0;padding:26px 22px calc(24px + env(safe-area-inset-bottom));",
        "box-shadow:0 -20px 60px rgba(0,0,0,.6);transform:translateY(14px);transition:transform .24s cubic-bezier(.2,.9,.3,1.2);",
        "font-family:'Helvetica Neue',Helvetica,Arial,sans-serif}",
      ".cs-wsheet-ov.in .cs-wsheet{transform:translateY(0)}",
      "@media(min-width:560px){.cs-wsheet{border-radius:18px;border-top:1px solid #2a2320;box-shadow:0 30px 80px rgba(0,0,0,.6)}}",
      ".cs-wsheet-x{position:absolute;top:12px;right:12px;width:34px;height:34px;padding:0;border:none;",
        "background:transparent;color:#9c8f84;font-size:24px;line-height:1;cursor:pointer;border-radius:8px}",
      ".cs-wsheet-x:hover{color:#f3ece3;background:#2a2320}",
      ".cs-wsheet-kicker{font-family:ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:.3em;",
        "text-transform:uppercase;color:#e0a520}",
      ".cs-wsheet-title{margin:8px 0 6px;font-size:21px;font-weight:800;color:#f3ece3;letter-spacing:-.01em}",
      ".cs-wsheet-copy{margin:0 0 18px;font-size:13.5px;line-height:1.5;color:#9c8f84}",
      ".cs-wsheet-list{display:flex;flex-direction:column;gap:10px}",
      ".cs-wsheet-btn{display:flex;align-items:center;gap:13px;text-decoration:none;",
        "background:#2a2320;border:1px solid #3a312c;border-radius:12px;padding:13px 15px;",
        "color:#f3ece3;transition:.15s ease}",
      ".cs-wsheet-btn:hover,.cs-wsheet-btn:active{border-color:#e0a520;transform:translateY(-1px)}",
      ".cs-wsheet-ico{flex:0 0 auto;width:34px;height:34px;border-radius:9px;display:flex;align-items:center;",
        "justify-content:center;font-weight:800;font-size:17px;color:#fff}",
      ".cs-wsheet-name{flex:1 1 auto;font-weight:700;font-size:15px}",
      ".cs-wsheet-arrow{flex:0 0 auto;color:#9c8f84;font-size:17px}",
      ".cs-wsheet-wc{display:block;width:100%;margin:16px 0 0;padding:10px;background:none;border:none;",
        "color:#9c8f84;font-size:12.5px;cursor:pointer;font-family:inherit;text-align:center;",
        "border-top:1px solid #2a2320}",
      ".cs-wsheet-wc:hover{color:#e0a520}"
    ].join("");
    (document.head || document.documentElement).appendChild(css);
  }

  var sheetEl = null, sheetKeyHandler = null;
  function closeWalletSheet() {
    if (!sheetEl) return;
    var el = sheetEl; sheetEl = null;
    el.classList.remove("in");
    if (sheetKeyHandler) { document.removeEventListener("keydown", sheetKeyHandler); sheetKeyHandler = null; }
    setTimeout(function () { if (el && el.parentNode) el.parentNode.removeChild(el); }, 220);
  }

  // Render the sheet. opts.onWalletConnect (fn|null): when provided, a discreet
  // "Other wallet (WalletConnect)" link is shown that runs it (the page's WC flow).
  // When null (wc disabled or no page handler), only the dapp-browser links show.
  function openWalletSheet(opts) {
    opts = opts || {};
    ensureSheetStyles();
    closeWalletSheet();
    var links = dappLinks();

    var ov = document.createElement("div");
    ov.className = "cs-wsheet-ov";
    ov.setAttribute("role", "dialog");
    ov.setAttribute("aria-modal", "true");
    ov.setAttribute("aria-label", "Open in your wallet");

    var html =
      '<div class="cs-wsheet">' +
        '<button class="cs-wsheet-x" type="button" aria-label="Close">×</button>' +
        '<div class="cs-wsheet-kicker">Cubist Souls</div>' +
        '<h3 class="cs-wsheet-title">Open in your wallet</h3>' +
        '<p class="cs-wsheet-copy">Opens cubistsouls.com inside your wallet’s browser, where connecting is one tap.</p>' +
        '<div class="cs-wsheet-list">';
    links.forEach(function (l) {
      html +=
        '<a class="cs-wsheet-btn" data-wid="' + l.id + '" href="' + l.url + '" rel="noopener">' +
          '<span class="cs-wsheet-ico" style="background:' + l.tint + '">' + l.mono + '</span>' +
          '<span class="cs-wsheet-name">' + l.name + '</span>' +
          '<span class="cs-wsheet-arrow">→</span>' +
        '</a>';
    });
    html += '</div>';
    if (typeof opts.onWalletConnect === "function") {
      html += '<button class="cs-wsheet-wc" type="button">Other wallet (WalletConnect) →</button>';
    }
    html += '</div>';
    ov.innerHTML = html;
    document.body.appendChild(ov);
    sheetEl = ov;

    // animate in
    requestAnimationFrame(function () { ov.classList.add("in"); });

    ov.querySelector(".cs-wsheet-x").onclick = closeWalletSheet;
    ov.onclick = function (e) { if (e.target === ov) closeWalletSheet(); };
    // dapp links navigate the app open on tap; close the sheet behind them.
    ov.querySelectorAll(".cs-wsheet-btn").forEach(function (a) {
      a.addEventListener("click", function () { setTimeout(closeWalletSheet, 400); });
    });
    var wcBtn = ov.querySelector(".cs-wsheet-wc");
    if (wcBtn) wcBtn.onclick = function () { closeWalletSheet(); opts.onWalletConnect(); };
    sheetKeyHandler = function (e) { if (e.key === "Escape") closeWalletSheet(); };
    document.addEventListener("keydown", sheetKeyHandler);
    return ov;
  }

  return {
    getEip1193: getEip1193,
    hasInjected: hasInjected,
    wcEnabled: wcEnabled,
    forceWc: function () { return FORCE_WC; },
    forceMobile: function () { return FORCE_MOBILE; },
    isMobile: isMobile,
    isLocal: function () { return isLocal; },
    dappLinks: dappLinks,
    openWalletSheet: openWalletSheet,
    closeWalletSheet: closeWalletSheet,
    connectInjected: connectInjected,
    connectWalletConnect: connectWalletConnect,
    restoreSession: restoreSession,
    hasPersistedWcSession: hasPersistedWcSession,
    onChange: function (cb) { changeCb = cb; },
    isWcActive: function () { return !!wc && active === wc; },
    ensureMainnet: ensureMainnet,
    disconnect: disconnect
  };
})();
