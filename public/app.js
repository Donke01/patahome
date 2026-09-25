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

/* Site-wide announcement bar (set by the admin under Site → Announcement). */
(function () {
  function show(a) {
    if (!a || !a.text || document.getElementById("phAnnounce")) return;
    var key = "ph_ann_" + a.text.length + "_" + a.text.slice(0, 24);
    try { if (sessionStorage.getItem(key)) return; } catch (e) {}
    var colors = { info: ["#014B6A", "#fff"], warn: ["#FCB805", "#1d1a0c"], success: ["#028467", "#fff"] }[a.level] || ["#014B6A", "#fff"];
    var bar = document.createElement("div");
    bar.id = "phAnnounce"; bar.setAttribute("role", "status");
    bar.style.cssText = "position:relative;z-index:1400;background:" + colors[0] + ";color:" + colors[1] + ";font:600 .86rem/1.4 Inter,system-ui,sans-serif;padding:9px 44px 9px 16px;text-align:center";
    var t = document.createElement(a.link ? "a" : "span");
    t.textContent = a.text;
    if (a.link) { t.href = a.link; t.style.cssText = "color:inherit;text-decoration:underline"; }
    var x = document.createElement("button");
    x.type = "button"; x.setAttribute("aria-label", "Dismiss"); x.textContent = "✕";
    x.style.cssText = "position:absolute;right:8px;top:50%;transform:translateY(-50%);border:0;background:none;color:inherit;font-size:1rem;cursor:pointer;padding:6px";
    x.onclick = function () { try { sessionStorage.setItem(key, "1"); } catch (e) {} bar.remove(); };
    bar.appendChild(t); bar.appendChild(x);
    document.body.insertBefore(bar, document.body.firstChild);
  }
  function load() {
    fetch("/api/config").then(function (r) { return r.json(); }).then(function (c) { show(c.announcement); }).catch(function () {});
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", load); else load();
})();

/* Dark mode: remembered on this device (ph_theme). The page applies it before
   painting (tiny inline script after <body>); this keeps toggles in sync. */
(function () {
  var SUN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/></svg>';
  var MOON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
  function isDark() { return document.documentElement.classList.contains("dark"); }
  function sync() {
    var d = isDark(), b = document.getElementById("darkBtn");
    if (b) { b.innerHTML = d ? SUN : MOON; b.title = d ? "Light mode" : "Dark mode"; }
    document.querySelectorAll("[data-theme-label]").forEach(function (el) { el.textContent = d ? "Light mode" : "Dark mode"; });
    var m = document.querySelector('meta[name="theme-color"]');
    if (m) { if (!m.dataset.light) m.dataset.light = m.content; m.content = d ? "#0d1714" : m.dataset.light; }
  }
  window.phToggleTheme = function () {
    var d = !isDark();
    document.documentElement.classList.toggle("dark", d);
    document.body.classList.toggle("dark", d);
    try { localStorage.setItem("ph_theme", d ? "dark" : "light"); } catch (e) {}
    sync();
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", sync); else sync();
})();
