/* PataHome photo viewer, full-screen, zoomable, swipeable.
   Usage: PataLightbox.open(["url1","url2"], startIndex)
   - Pinch or double-tap (mobile), scroll wheel or double-click (desktop) to zoom
   - Drag to pan while zoomed; swipe / arrow keys to change photo; Esc or ✕ to close
   No dependencies. */
(function () {
  const MAX = 5, MIN = 1;
  let root, img, counter, urls = [], idx = 0;
  let scale = 1, tx = 0, ty = 0;
  const pointers = new Map();
  let pinchStart = null, panStart = null, swipeStart = null, lastTap = 0;

  function build() {
    if (root) return;
    const css = document.createElement("style");
    css.textContent = `
.plb{position:fixed;inset:0;z-index:100000;background:rgba(6,12,10,.96);display:none;touch-action:none;user-select:none;-webkit-user-select:none}
.plb.on{display:block}
.plb-stage{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;overflow:hidden}
.plb-img{max-width:100vw;max-height:100vh;max-height:100dvh;object-fit:contain;transform-origin:0 0;will-change:transform;cursor:zoom-in;-webkit-user-drag:none}
.plb.zoomed .plb-img{cursor:grab}
.plb-btn{position:absolute;z-index:2;border:0;border-radius:50%;width:44px;height:44px;display:grid;place-items:center;background:rgba(255,255,255,.14);color:#fff;font-size:1.3rem;cursor:pointer;backdrop-filter:blur(6px)}
.plb-btn:hover{background:rgba(255,255,255,.26)}
.plb-close{top:max(12px,env(safe-area-inset-top));right:12px}
.plb-prev{left:12px;top:50%;margin-top:-22px;font-size:1.8rem}
.plb-next{right:12px;top:50%;margin-top:-22px;font-size:1.8rem}
.plb-zoom{bottom:max(14px,env(safe-area-inset-bottom));right:12px;font-size:1rem}
.plb-count{position:absolute;z-index:2;top:max(20px,calc(env(safe-area-inset-top) + 8px));left:50%;transform:translateX(-50%);color:#fff;font:600 .82rem system-ui,sans-serif;background:rgba(255,255,255,.12);padding:5px 12px;border-radius:99px}
.plb-hint{position:absolute;z-index:2;bottom:max(20px,env(safe-area-inset-bottom));left:50%;transform:translateX(-50%);color:rgba(255,255,255,.7);font:500 .74rem system-ui,sans-serif;white-space:nowrap;transition:opacity .4s}
.plb.zoomed .plb-hint{opacity:0}
.plb.single .plb-prev,.plb.single .plb-next{display:none}
@media(max-width:640px){.plb-prev,.plb-next{display:none}}`;
    document.head.appendChild(css);
    root = document.createElement("div");
    root.className = "plb";
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-modal", "true");
    root.setAttribute("aria-label", "Photo viewer");
    root.innerHTML = `
      <div class="plb-stage"><img class="plb-img" alt="Listing photo" draggable="false"></div>
      <div class="plb-count"></div>
      <button class="plb-btn plb-close" aria-label="Close">✕</button>
      <button class="plb-btn plb-prev" aria-label="Previous photo">‹</button>
      <button class="plb-btn plb-next" aria-label="Next photo">›</button>
      <button class="plb-btn plb-zoom" aria-label="Zoom">⤢</button>
      <div class="plb-hint">Pinch or double-tap to zoom</div>`;
    document.body.appendChild(root);
    img = root.querySelector(".plb-img");
    counter = root.querySelector(".plb-count");
    root.querySelector(".plb-close").onclick = close;
    root.querySelector(".plb-prev").onclick = () => go(-1);
    root.querySelector(".plb-next").onclick = () => go(1);
    root.querySelector(".plb-zoom").onclick = () => zoomAt(scale > 1 ? 1 : 2.5, innerWidth / 2, innerHeight / 2);
    const stage = root.querySelector(".plb-stage");
    stage.addEventListener("click", e => { if (e.target === stage && scale === 1) close(); });
    stage.addEventListener("wheel", onWheel, { passive: false });
    stage.addEventListener("pointerdown", onDown);
    stage.addEventListener("pointermove", onMove);
    stage.addEventListener("pointerup", onUp);
    stage.addEventListener("pointercancel", onUp);
    img.addEventListener("dblclick", e => { e.preventDefault(); zoomAt(scale > 1 ? 1 : 2.5, e.clientX, e.clientY); });
    img.addEventListener("load", reset);
    addEventListener("keydown", e => {
      if (!root.classList.contains("on")) return;
      if (e.key === "Escape") close();
      else if (e.key === "ArrowLeft") go(-1);
      else if (e.key === "ArrowRight") go(1);
      else if (e.key === "+" || e.key === "=") zoomAt(scale * 1.5, innerWidth / 2, innerHeight / 2);
      else if (e.key === "-") zoomAt(scale / 1.5, innerWidth / 2, innerHeight / 2);
    });
    addEventListener("resize", () => root.classList.contains("on") && reset());
  }

  // The image is laid out centred by flexbox; we apply translate/scale on top.
  function base() { const r = img.getBoundingClientRect(); return { x: r.left - tx, y: r.top - ty, w: r.width / scale, h: r.height / scale }; }
  function apply() {
    clamp();
    img.style.transform = `translate(${tx}px,${ty}px) scale(${scale})`;
    root.classList.toggle("zoomed", scale > 1.01);
  }
  function clamp() {
    if (scale <= 1) { scale = 1; tx = 0; ty = 0; return; }
    const b = base(), W = b.w * scale, H = b.h * scale;
    // keep the photo covering the screen (or centred on an axis where it's smaller)
    const minX = Math.min(innerWidth - W - b.x, (innerWidth - W) / 2 - b.x), maxX = Math.max(-b.x, (innerWidth - W) / 2 - b.x);
    const minY = Math.min(innerHeight - H - b.y, (innerHeight - H) / 2 - b.y), maxY = Math.max(-b.y, (innerHeight - H) / 2 - b.y);
    tx = Math.min(maxX, Math.max(minX, tx));
    ty = Math.min(maxY, Math.max(minY, ty));
  }
  function zoomAt(next, cx, cy) {
    next = Math.min(MAX, Math.max(MIN, next));
    const b = base();
    // keep the point under the cursor/fingers fixed while scaling
    const px = (cx - b.x - tx) / scale, py = (cy - b.y - ty) / scale;
    scale = next;
    tx = cx - b.x - px * scale;
    ty = cy - b.y - py * scale;
    img.style.transition = "transform .2s ease";
    apply();
    setTimeout(() => (img.style.transition = ""), 220);
  }
  function reset() { scale = 1; tx = 0; ty = 0; img.style.transition = ""; apply(); }

  function onWheel(e) {
    e.preventDefault();
    const b = base();
    const px = (e.clientX - b.x - tx) / scale, py = (e.clientY - b.y - ty) / scale;
    scale = Math.min(MAX, Math.max(MIN, scale * Math.exp(-e.deltaY * 0.0022)));
    tx = e.clientX - b.x - px * scale;
    ty = e.clientY - b.y - py * scale;
    apply();
  }
  function onDown(e) {
    if (e.target.closest(".plb-btn")) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, c] = [...pointers.values()];
      pinchStart = { d: Math.hypot(a.x - c.x, a.y - c.y), scale, tx, ty, cx: (a.x + c.x) / 2, cy: (a.y + c.y) / 2 };
      panStart = swipeStart = null;
    } else if (pointers.size === 1) {
      if (scale > 1) panStart = { x: e.clientX, y: e.clientY, tx, ty };
      else swipeStart = { x: e.clientX, y: e.clientY, t: Date.now() };
      // double-tap to zoom (touch / pen)
      const now = Date.now();
      if (e.pointerType !== "mouse" && now - lastTap < 300) { zoomAt(scale > 1 ? 1 : 2.5, e.clientX, e.clientY); lastTap = 0; swipeStart = null; }
      else lastTap = now;
    }
  }
  function onMove(e) {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pinchStart && pointers.size >= 2) {
      const [a, c] = [...pointers.values()];
      const d = Math.hypot(a.x - c.x, a.y - c.y);
      const b = base();
      const next = Math.min(MAX, Math.max(MIN, pinchStart.scale * d / pinchStart.d));
      const px = (pinchStart.cx - b.x - pinchStart.tx) / pinchStart.scale, py = (pinchStart.cy - b.y - pinchStart.ty) / pinchStart.scale;
      const cx = (a.x + c.x) / 2, cy = (a.y + c.y) / 2;
      scale = next; tx = cx - b.x - px * scale; ty = cy - b.y - py * scale;
      apply();
    } else if (panStart) {
      tx = panStart.tx + e.clientX - panStart.x;
      ty = panStart.ty + e.clientY - panStart.y;
      apply();
    } else if (swipeStart) {
      img.style.transform = `translateX(${e.clientX - swipeStart.x}px)`;
    }
  }
  function onUp(e) {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchStart = null;
    if (swipeStart) {
      const dx = e.clientX - swipeStart.x, dy = e.clientY - swipeStart.y;
      swipeStart = null;
      if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) && urls.length > 1) go(dx < 0 ? 1 : -1);
      else if (dy > 110 && Math.abs(dy) > Math.abs(dx)) close(); // swipe down to close
      else { img.style.transition = "transform .2s ease"; apply(); setTimeout(() => (img.style.transition = ""), 220); }
    }
    if (!pointers.size) panStart = null;
    else if (scale > 1) { const p = [...pointers.values()][0]; panStart = { x: p.x, y: p.y, tx, ty }; }
  }

  function show() {
    img.style.transform = "";
    img.src = urls[idx];
    counter.textContent = urls.length > 1 ? `${idx + 1} / ${urls.length}` : "";
    counter.style.display = urls.length > 1 ? "" : "none";
    root.classList.toggle("single", urls.length < 2);
    // warm the neighbours so swiping feels instant
    [idx + 1, idx - 1].forEach(i => { const u = urls[(i + urls.length) % urls.length]; if (u) new Image().src = u; });
  }
  function go(n) { if (urls.length < 2) return; idx = (idx + n + urls.length) % urls.length; reset(); show(); }
  let prevOverflow = "";
  function open(list, start) {
    if (!list || !list.length) return;
    build();
    urls = list.slice(); idx = Math.max(0, Math.min(list.length - 1, start || 0));
    prevOverflow = document.documentElement.style.overflow;
    document.documentElement.style.overflow = "hidden";
    root.classList.add("on");
    reset(); show();
    root.querySelector(".plb-close").focus({ preventScroll: true });
  }
  function close() {
    if (!root) return;
    root.classList.remove("on");
    document.documentElement.style.overflow = prevOverflow;
    img.removeAttribute("src");
  }
  window.PataLightbox = { open, close };
})();
