(() => {
  const KEY = "ph_cookie_notice_seen";
  const seen = (() => { try { return localStorage.getItem(KEY) === "1"; } catch { return false; } })();
  const style = document.createElement("style");
  style.textContent = `.ph-cookie{position:fixed;left:16px;right:16px;bottom:16px;z-index:5000;display:flex;align-items:center;gap:18px;max-width:920px;margin:auto;padding:15px 18px;background:#fff;border:1px solid #cfe1d8;border-radius:14px;box-shadow:0 14px 40px rgba(10,55,39,.18);font:14px/1.45 system-ui,-apple-system,sans-serif;color:#17352b}.ph-cookie p{margin:0;flex:1}.ph-cookie strong{color:#063f2e}.ph-cookie a{color:#087b61;font-weight:700}.ph-cookie button{border:0;border-radius:9px;padding:10px 15px;background:#087b61;color:#fff;font-weight:700;cursor:pointer;white-space:nowrap}.ph-cookie button:hover{background:#075b49}.ph-cookie .ph-cookie-close{background:transparent;color:#087b61;padding:5px}@media(max-width:600px){.ph-cookie{left:10px;right:10px;bottom:10px;display:block;padding:15px}.ph-cookie button{margin-top:11px;width:100%}.ph-cookie .ph-cookie-close{position:absolute;right:7px;top:5px;width:auto;margin:0}}`;
  document.head.appendChild(style);
  function show() {
    if (document.querySelector(".ph-cookie")) return;
    const el = document.createElement("aside"); el.className = "ph-cookie"; el.setAttribute("role", "dialog"); el.setAttribute("aria-label", "Cookie notice");
    el.innerHTML = `<p><strong>PataHome uses cookies</strong><br>We use essential cookies to keep you signed in and remember important site preferences. <a href="/privacy.html">Learn more</a></p><button class="ph-cookie-close" aria-label="Dismiss cookie notice">Got it</button>`;
    el.querySelector("button").addEventListener("click", () => { try { localStorage.setItem(KEY, "1"); } catch {} el.remove(); });
    document.body.appendChild(el);
  }
  if (!seen) (document.readyState === "loading" ? document.addEventListener("DOMContentLoaded", show) : show());
})();
