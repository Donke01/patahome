/* PataHome photo ordering, shared by the owner dashboard and the admin dashboard.
   - PhotoOrder.sortable(grid, onMove): drag to reorder. Mouse: drag straight away.
     Phone: press and hold a photo for a moment, then drag (a quick swipe still scrolls).
   - PhotoOrder.rank(urls): checks each photo in the browser (sharpness, light,
     contrast, colour, wide vs tall) and returns scores, best first. */
(function () {
  const clamp = v => Math.max(0, Math.min(100, v));

  function analyse(url) {
    return new Promise(resolve => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.decoding = "async";
      img.onload = () => {
        try {
          const W = img.naturalWidth, H = img.naturalHeight, k = Math.min(1, 256 / Math.max(W, H));
          const w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
          const c = document.createElement("canvas"); c.width = w; c.height = h;
          const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(img, 0, 0, w, h);
          const d = x.getImageData(0, 0, w, h).data, n = w * h, L = new Float32Array(n);
          let sum = 0, sq = 0, rg = 0, rg2 = 0, yb = 0, yb2 = 0, clip = 0;
          for (let i = 0, j = 0; i < d.length; i += 4, j++) {
            const r = d[i], g = d[i + 1], b = d[i + 2], l = .299 * r + .587 * g + .114 * b;
            L[j] = l; sum += l; sq += l * l; if (l > 250 || l < 5) clip++;
            const a = r - g, e = .5 * (r + g) - b; rg += a; rg2 += a * a; yb += e; yb2 += e * e;
          }
          const mean = sum / n, std = Math.sqrt(Math.max(0, sq / n - mean * mean));
          const colour = Math.sqrt(Math.max(0, rg2 / n - (rg / n) ** 2) + Math.max(0, yb2 / n - (yb / n) ** 2)) + .3 * Math.sqrt((rg / n) ** 2 + (yb / n) ** 2);
          let lap = 0, lm = 0, cnt = 0;
          for (let y = 1; y < h - 1; y++) for (let q = 1; q < w - 1; q++) {
            const i = y * w + q, v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w]; lap += v * v; lm += v; cnt++;
          }
          const lapVar = cnt ? lap / cnt - (lm / cnt) ** 2 : 0, ratio = W / H;
          const sc = {
            sharp: clamp((Math.log10(Math.max(lapVar, 1)) - 1.6) / 1.4 * 100),
            light: clamp(100 - Math.abs(mean - 140) * 1.15),
            contrast: clamp(std / 58 * 100),
            colour: clamp(colour / 48 * 100),
            shape: ratio >= 1.25 ? 100 : ratio >= 1.05 ? 75 : ratio >= .9 ? 55 : 30
          };
          let score = (sc.sharp * .35 + sc.light * .27 + sc.contrast * .2 + sc.colour * .18) * (.55 + .45 * sc.shape / 100);
          if (clip / n > .1) score -= Math.min(12, (clip / n - .1) * 80);
          const why = [];
          if (sc.shape >= 100) why.push("wide"); if (sc.sharp >= 65) why.push("sharp"); if (sc.light >= 70) why.push("well lit"); if (sc.colour >= 60) why.push("colourful");
          resolve({ score: Math.round(clamp(score)), why, sc });
        } catch (e) { resolve({ score: 0, why: [], failed: true }); }
      };
      img.onerror = () => resolve({ score: 0, why: [], failed: true });
      img.src = url;
    });
  }

  async function rank(urls) {
    const out = new Array(urls.length); let next = 0;
    await Promise.all(Array.from({ length: Math.min(4, urls.length) }, async () => {
      while (next < urls.length) { const i = next++; out[i] = { i, ...(await analyse(urls[i])) }; }
    }));
    return out.slice().sort((a, b) => b.score - a.score);
  }

  function sortable(grid, onMove) {
    if (grid._phSortable) return; grid._phSortable = true;
    let drag = null, timer = 0, start = null;
    const items = () => [...grid.querySelectorAll("[data-pi]")];
    const itemAt = (x, y) => { const el = document.elementFromPoint(x, y); return el && el.closest && el.closest("[data-pi]"); };
    function begin(el, x, y) {
      const r = el.getBoundingClientRect(), ghost = el.cloneNode(true);
      ghost.className += " ph-ghost";
      Object.assign(ghost.style, { position: "fixed", left: r.left + "px", top: r.top + "px", width: r.width + "px", height: r.height + "px", zIndex: 99999, pointerEvents: "none", opacity: ".92", transform: "scale(1.05)", boxShadow: "0 12px 30px rgba(14,42,59,.3)", borderRadius: "12px", overflow: "hidden" });
      document.body.appendChild(ghost);
      el.classList.add("ph-dragging");
      drag = { el, from: +el.dataset.pi, to: +el.dataset.pi, ghost, dx: x - r.left, dy: y - r.top };
      if (navigator.vibrate) try { navigator.vibrate(12); } catch (e) {}
    }
    function move(x, y) {
      drag.ghost.style.left = x - drag.dx + "px"; drag.ghost.style.top = y - drag.dy + "px";
      const t = itemAt(x, y);
      items().forEach(e => e.classList.toggle("ph-target", e === t && e !== drag.el));
      if (t) drag.to = +t.dataset.pi;
    }
    function end() {
      if (!drag) return;
      const { from, to, ghost, el } = drag; drag = null;
      ghost.remove(); el.classList.remove("ph-dragging"); items().forEach(e => e.classList.remove("ph-target"));
      if (from !== to) onMove(from, to);
    }
    const skip = t => t.closest("button,select,input,a");
    // mouse / pen
    grid.addEventListener("pointerdown", e => {
      if (e.pointerType === "touch" || e.button !== 0 || skip(e.target)) return;
      const el = e.target.closest("[data-pi]"); if (!el) return;
      start = { x: e.clientX, y: e.clientY, el }; e.preventDefault();
      const mv = ev => { if (!drag && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) > 6) begin(start.el, start.x, start.y); if (drag) move(ev.clientX, ev.clientY); };
      const up = () => { removeEventListener("pointermove", mv); removeEventListener("pointerup", up); end(); };
      addEventListener("pointermove", mv); addEventListener("pointerup", up);
    });
    // touch: hold ~0.35s, then drag
    grid.addEventListener("touchstart", e => {
      if (e.touches.length !== 1 || skip(e.target)) return;
      const el = e.target.closest("[data-pi]"); if (!el) return;
      const t = e.touches[0]; start = { x: t.clientX, y: t.clientY, el };
      clearTimeout(timer); timer = setTimeout(() => begin(el, start.x, start.y), 350);
    }, { passive: true });
    grid.addEventListener("touchmove", e => {
      const t = e.touches[0];
      if (!drag) { if (start && Math.hypot(t.clientX - start.x, t.clientY - start.y) > 8) clearTimeout(timer); return; }
      e.preventDefault(); move(t.clientX, t.clientY);
    }, { passive: false });
    const tEnd = () => { clearTimeout(timer); start = null; end(); };
    grid.addEventListener("touchend", tEnd); grid.addEventListener("touchcancel", tEnd);
    grid.addEventListener("contextmenu", e => { if (drag || e.target.closest("[data-pi]")) e.preventDefault(); });
  }

  const move = (arr, from, to) => { const a = arr.slice(); const [v] = a.splice(from, 1); a.splice(to, 0, v); return a; };
  window.PhotoOrder = { analyse, rank, sortable, move };
})();
