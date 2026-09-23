/* Shared on every public page: app install + cookieless visit count + language.
   Loaded with `defer`, so it never blocks the page. */
(function () {
  /* ---- visit counter (no cookies; see /api/pv on the server) ---- */
  try {
    navigator.sendBeacon && navigator.sendBeacon("/api/pv",
      new Blob([JSON.stringify({ path: location.pathname, ref: document.referrer })], { type: "application/json" }));
  } catch (e) {}

  /* ---- installable app ---- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
  var deferred = null;
  var DISMISS = "ph_install_dismissed";
  function banner() {
    if (document.getElementById("phInstall")) return;
    try { if (+localStorage.getItem(DISMISS) > Date.now() - 14 * 864e5) return; } catch (e) {}
    var b = document.createElement("div");
    b.id = "phInstall";
    b.setAttribute("role", "dialog");
    b.innerHTML = '<img src="/favicon-192.png" alt="" width="36" height="36">' +
      '<div><b data-i18n="install.title">Get the PataHome app</b><span data-i18n="install.sub">Faster on your phone — free, no Play Store needed.</span></div>' +
      '<button type="button" class="phi-go" data-i18n="install.go">Install</button>' +
      '<button type="button" class="phi-x" aria-label="Not now">✕</button>';
    var css = document.createElement("style");
    css.textContent = "#phInstall{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9000;max-width:460px;margin:0 auto;display:flex;align-items:center;gap:10px;padding:10px 10px 10px 12px;border-radius:14px;background:#fff;border:1px solid #d3e8de;box-shadow:0 14px 34px rgba(7,33,25,.18);font:14px/1.3 Inter,system-ui,sans-serif;color:#17201c}" +
      "#phInstall img{border-radius:9px}#phInstall div{flex:1;min-width:0}#phInstall b{display:block;font-size:.9rem}#phInstall span{display:block;color:#5f6b66;font-size:.76rem}" +
      "#phInstall .phi-go{border:0;border-radius:9px;background:#073d2e;color:#fff;font:inherit;font-weight:700;padding:9px 14px;cursor:pointer}" +
      "#phInstall .phi-x{border:0;background:none;color:#5f6b66;font-size:1rem;cursor:pointer;padding:6px}" +
      "@media(min-width:900px){#phInstall{left:auto;right:20px;bottom:20px}}";
    document.head.appendChild(css);
    document.body.appendChild(b);
    if (window.PH_I18N) window.PH_I18N.apply(b);
    b.querySelector(".phi-x").onclick = function () { try { localStorage.setItem(DISMISS, Date.now()); } catch (e) {} b.remove(); };
    b.querySelector(".phi-go").onclick = function () {
      if (!deferred) return;
      deferred.prompt();
      deferred.userChoice.finally(function () { deferred = null; b.remove(); });
    };
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    // wait until the visitor has looked around a little
    setTimeout(banner, 20000);
  });
  window.PH_INSTALL = function () { if (deferred) { deferred.prompt(); } else alert("To install: open your browser menu and tap “Add to Home screen”."); };
})();
