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
  // localhost-only harness: ?wcforce=1 pretends there is NO injected wallet, so
  // "Connect Wallet" goes straight to the WalletConnect modal (QR).
  var FORCE_WC = isLocal && new URLSearchParams(location.search).get("wcforce") === "1";

  var active = null;   // the EIP-1193 provider currently in use (injected or WC)
  var wc = null;       // the WalletConnect EthereumProvider instance (once inited)
  var scriptP = null;  // memoized lazy-load promise for the UMD
  var changeCb = null; // page callback for account/chain/disconnect on the WC provider

  function injected() { return FORCE_WC ? null : (window.ethereum || null); }
  function hasInjected() { return !!injected(); }

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

  return {
    getEip1193: getEip1193,
    hasInjected: hasInjected,
    wcEnabled: wcEnabled,
    forceWc: function () { return FORCE_WC; },
    isLocal: function () { return isLocal; },
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
