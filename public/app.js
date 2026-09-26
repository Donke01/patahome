/* Shared on every public page: app install + cookieless visit count + language.
   Loaded with `defer`, so it never blocks the page. */
(function () {
  /* ---- always start at the top: on refresh, and when the logo is tapped ---- */
  try { if ("scrollRestoration" in history) history.scrollRestoration = "manual"; } catch (e) {}
  function toTop() { if (!location.hash) window.scrollTo(0, 0); }
  toTop();
  window.addEventListener("load", toTop);
  window.addEventListener("pageshow", function (e) { if (e.persisted) toTop(); });
  document.addEventListener("click", function (e) {
    var a = e.target.closest && e.target.closest("a.ph-logo, a.logo, a[data-home]");
    if (!a || e.metaKey || e.ctrlKey || e.shiftKey || e.button) return;
    var u = new URL(a.href, location.href);
    if (u.origin === location.origin && u.pathname === "/" && location.pathname === "/") {
      e.preventDefault();
      if (location.search || location.hash) history.replaceState(null, "", "/");
      window.scrollTo({ top: 0, behavior: "smooth" });
    }
  });

  /* ---- visit counter (no cookies; see /api/pv on the server) ---- */
  try {
    navigator.sendBeacon && navigator.sendBeacon("/api/pv",
      new Blob([JSON.stringify({ path: location.pathname, ref: document.referrer })], { type: "application/json" }));
  } catch (e) {}

  /* ---- installable app ---- */
  if ("serviceWorker" in navigator) {
    window.addEventListener("load", function () { navigator.serviceWorker.register("/sw.js").catch(function () {}); });
  }
  /* ---- "Get the app" popup ----
     Android / desktop Chrome & Edge: one tap opens the browser's own install prompt.
     iPhone / iPad (Safari has no prompt): shows the two steps (Share, then Add to Home Screen).
     Shown once after ~15s of browsing, not again for 14 days after "Not now", never once installed.
     The footer's "Install app" link opens it any time. */
  var deferred = null;
  var DISMISS = "ph_install_dismissed";
  var ua = navigator.userAgent || "";
  var isIOS = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
  var installed = function () { return (window.matchMedia && matchMedia("(display-mode: standalone)").matches) || navigator.standalone === true; };
  var SHARE = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-3px"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/></svg>';
  var PLUS = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" style="vertical-align:-3px"><rect x="4" y="4" width="16" height="16" rx="4"/><path d="M12 8v8M8 12h8"/></svg>';
  function css() {
    if (document.getElementById("phInstallCss")) return;
    var c = document.createElement("style"); c.id = "phInstallCss";
    c.textContent =
      "#phInstall{position:fixed;left:12px;right:12px;bottom:calc(84px + env(safe-area-inset-bottom));z-index:9000;max-width:400px;margin:0 auto;padding:18px 18px 16px;border-radius:20px;background:#fff;color:#0E2A3B;box-shadow:0 24px 60px -12px rgba(8,22,32,.4),0 0 0 1px rgba(14,42,59,.06);font:14px/1.4 Inter,system-ui,sans-serif;animation:phiIn .35s cubic-bezier(.2,.8,.2,1) both}" +
      "@keyframes phiIn{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}" +
      "#phInstall .phi-top{display:flex;align-items:center;gap:12px}" +
      "#phInstall .phi-ic{width:54px;height:54px;border-radius:14px;flex:0 0 auto;box-shadow:0 4px 14px -4px rgba(14,42,59,.3),0 0 0 1px rgba(14,42,59,.08);background:#fff}" +
      "#phInstall b{display:block;font:500 1.12rem/1.2 'Fraunces',Georgia,serif}" +
      "#phInstall .phi-sub{display:block;margin-top:2px;color:#5b6b75;font-size:.8rem}" +
      "#phInstall .phi-x{position:absolute;top:10px;right:10px;width:30px;height:30px;border:0;border-radius:50%;background:#f1efe9;color:#5b6b75;font-size:.8rem;cursor:pointer}" +
      "#phInstall ul{list-style:none;display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 0;padding:0}" +
      "#phInstall li{padding:5px 10px;border-radius:99px;background:#f5f2ea;color:#43525c;font-size:.74rem;font-weight:500}" +
      "#phInstall li:before{content:'\\2713  ';color:#0f7a5a;font-weight:700}" +
      "#phInstall .phi-steps{margin:14px 0 0;padding:12px 14px;border-radius:14px;background:#f5f2ea;font-size:.84rem;color:#23343e}" +
      "#phInstall .phi-steps div+div{margin-top:8px}#phInstall .phi-steps i{font-style:normal;display:inline-grid;place-items:center;width:20px;height:20px;margin-right:8px;border-radius:50%;background:#0E2A3B;color:#fff;font-size:.7rem;font-weight:700}" +
      "#phInstall .phi-act{display:flex;gap:8px;margin-top:14px}" +
      "#phInstall .phi-go{flex:1;height:44px;border:0;border-radius:99px;background:#0E2A3B;color:#fff;font:600 .92rem Inter,system-ui,sans-serif;cursor:pointer}" +
      "#phInstall .phi-go:hover{background:#163A50}" +
      "#phInstall .phi-no{height:44px;padding:0 16px;border:1px solid #e3ddd1;border-radius:99px;background:#fff;color:#43525c;font:500 .88rem Inter,system-ui,sans-serif;cursor:pointer}" +
      "html.dark #phInstall{background:#15222b;color:#eef2f4;box-shadow:0 24px 60px -12px rgba(0,0,0,.6),0 0 0 1px rgba(255,255,255,.08)}html.dark #phInstall li,html.dark #phInstall .phi-steps{background:#1f2e38;color:#cfd8dd}html.dark #phInstall .phi-sub{color:#9fb0ba}html.dark #phInstall .phi-x{background:#1f2e38;color:#9fb0ba}html.dark #phInstall .phi-no{background:none;border-color:#33444f;color:#cfd8dd}html.dark #phInstall .phi-go{background:#c9a45c;color:#0E2A3B}" +
      "@media(min-width:900px){#phInstall{left:auto;right:24px;bottom:24px;margin:0}}";
    document.head.appendChild(c);
  }
  function close(remember) {
    var b = document.getElementById("phInstall"); if (b) b.remove();
    if (remember) { try { localStorage.setItem(DISMISS, Date.now()); } catch (e) {} }
  }
  function steps() {
    if (isIOS) return '<div class="phi-steps"><div><i>1</i>Tap ' + SHARE + ' <b style="display:inline;font:600 .84rem Inter,sans-serif">Share</b> at the bottom of Safari</div><div><i>2</i>Choose ' + PLUS + ' <b style="display:inline;font:600 .84rem Inter,sans-serif">Add to Home Screen</b></div></div>';
    if (/android/i.test(ua)) return '<div class="phi-steps"><div><i>1</i>Open your browser menu <b style="display:inline;font:600 .84rem Inter,sans-serif">⋮</b></div><div><i>2</i>Tap <b style="display:inline;font:600 .84rem Inter,sans-serif">Install app</b> or <b style="display:inline;font:600 .84rem Inter,sans-serif">Add to Home screen</b></div></div>';
    return '<div class="phi-steps"><div><i>1</i>Click the install icon ' + PLUS + ' at the right of the address bar</div><div><i>2</i>Or open the browser menu and choose <b style="display:inline;font:600 .84rem Inter,sans-serif">Install PataHome</b></div></div>';
  }
  function show(manual) {
    if (installed()) { if (manual) alert("PataHome is already installed on this device."); return; }
    if (document.getElementById("phInstall")) return;
    if (!manual) { try { if (+localStorage.getItem(DISMISS) > Date.now() - 14 * 864e5) return; } catch (e) {} }
    css();
    var canPrompt = !!deferred, b = document.createElement("div");
    b.id = "phInstall"; b.setAttribute("role", "dialog"); b.setAttribute("aria-label", "Get the PataHome app");
    b.innerHTML = '<button type="button" class="phi-x" aria-label="Close">✕</button>' +
      '<div class="phi-top"><img class="phi-ic" src="/app-icon-192.png" alt="" width="54" height="54"><div><b>Get the PataHome app</b><span class="phi-sub">Free · no Play Store or App Store needed</span></div></div>' +
      '<ul><li>Opens instantly</li><li>Works on slow networks</li><li>Your saved homes</li></ul>' +
      (canPrompt ? "" : steps()) +
      '<div class="phi-act">' + (canPrompt ? '<button type="button" class="phi-go">Install app</button>' : '<button type="button" class="phi-go">Got it</button>') +
      '<button type="button" class="phi-no">Not now</button></div>';
    document.body.appendChild(b);
    b.querySelector(".phi-x").onclick = function () { close(true); };
    b.querySelector(".phi-no").onclick = function () { close(true); };
    b.querySelector(".phi-go").onclick = function () {
      if (!deferred) { close(true); return; }
      deferred.prompt();
      deferred.userChoice.then(function (c) { if (c && c.outcome === "dismissed") close(true); else close(false); }).catch(function () { close(false); });
      deferred = null;
    };
  }
  window.addEventListener("beforeinstallprompt", function (e) {
    e.preventDefault(); deferred = e;
    setTimeout(function () { show(false); }, 15000);
  });
  window.addEventListener("appinstalled", function () { close(false); });
  // iPhone/iPad never fire beforeinstallprompt: offer the steps once, after a short look around
  if (isIOS && !installed()) setTimeout(function () { show(false); }, 15000);
  window.PH_INSTALL = function () { show(true); };
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
