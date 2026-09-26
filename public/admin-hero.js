/* PataHome admin: "Homepage photos" studio.
   Picks the photos behind the homepage search. Every candidate (an upload, a
   listing photo or a pasted link) is checked in the browser before it goes
   live: resolution, orientation, sharpness, exposure, contrast, colour and
   near-duplicates. Each gets a 0-100 score, a grade and plain reasons, so the
   best photos rise to the top. Nothing is uploaded until you add it. */
(function () {
  const STOCK = ["photo-1658218635253-64728f6234be", "photo-1600210492493-0946911123ea", "photo-1651151084802-867d6a55dd25", "photo-1600494448850-6013c64ba722", "photo-1658218729615-167c32d70537"]
    .map(id => `https://images.unsplash.com/${id}`);
  const MAX = 8;
  let lineup = [], cands = [], busy = 0, scanning = false;
  const F = { min: 60, landscape: true, dupes: true, sort: "score" };

  const css = document.createElement("style");
  css.textContent = `
  .hs-wrap{display:grid;gap:18px}
  .hs-card{background:#fff;border:1px solid var(--line,#dfe6e2);border-radius:14px;padding:18px}
  .hs-card h3{margin:0 0 4px;font-size:1.05rem}
  .hs-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(210px,1fr));gap:14px;margin-top:12px}
  .hs-it{border:1px solid var(--line,#dfe6e2);border-radius:12px;overflow:hidden;background:#fafbfa;display:flex;flex-direction:column}
  .hs-ph{position:relative;aspect-ratio:16/10;background:#e9eeeb}
  .hs-ph img{width:100%;height:100%;object-fit:cover;display:block}
  .hs-ph .phone{position:absolute;right:8px;bottom:8px;width:30%;aspect-ratio:4/5;border:2px solid #fff;border-radius:6px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.35);background:#000}
  .hs-ph .phone img{object-fit:cover}
  .hs-badge{position:absolute;left:8px;top:8px;padding:3px 9px;border-radius:99px;font:700 .72rem system-ui,sans-serif;color:#fff}
  .g-a{background:#1f7a5c}.g-b{background:#3f8f56}.g-c{background:#b8862b}.g-d{background:#b3261e}.g-x{background:#6b7780}
  .hs-src{position:absolute;right:8px;top:8px;padding:2px 8px;border-radius:99px;background:rgba(0,0,0,.55);color:#fff;font-size:.66rem}
  .hs-bd{padding:10px 12px;display:flex;flex-direction:column;gap:6px;flex:1}
  .hs-m{display:flex;flex-wrap:wrap;gap:4px}
  .hs-m span{font-size:.68rem;padding:2px 7px;border-radius:99px;background:#eef2f0;color:#3a4a44}
  .hs-m span.bad{background:#fdecea;color:#9b2c24}.hs-m span.good{background:#e3f4ec;color:#1f6e52}
  .hs-why{font-size:.74rem;color:#5f6b66;line-height:1.4}
  .hs-capf{display:grid;gap:4px}.hs-capf input{font-size:.78rem;padding:6px 8px;margin:0}
  .hs-act{display:flex;gap:6px;flex-wrap:wrap;margin-top:auto}
  .hs-act .btn{min-height:30px;padding:4px 10px;font-size:.74rem}
  .hs-tools{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-top:10px;font-size:.84rem}
  .hs-drop{border:2px dashed var(--line,#cfd9d4);border-radius:12px;padding:22px;text-align:center;color:#5f6b66;cursor:pointer;margin-top:10px}
  .hs-drop.over{border-color:#1f7a5c;background:#eef8f3}
  .hs-num{position:absolute;left:8px;bottom:8px;width:24px;height:24px;border-radius:50%;background:#0e2a3b;color:#fff;display:grid;place-items:center;font:700 .74rem system-ui}
  .hs-legend{font-size:.76rem;color:#5f6b66;margin-top:8px}`;
  document.head.appendChild(css);

  const clamp = (v, a = 0, b = 100) => Math.max(a, Math.min(b, v));
  const stripT = u => String(u).replace(/(\/image\/upload\/)(?:[^/]*[,_][^/]*\/)+(?=patahome\/|v\d+\/)/, "$1");
  const analysisUrl = u => /images\.unsplash\.com/.test(u) ? u.split("?")[0] + "?w=1600&q=80&auto=format"
    : /res\.cloudinary\.com/.test(u) ? stripT(u).replace("/upload/", "/upload/c_limit,w_1600,q_auto:good/") : u;
  const thumbUrl = u => /images\.unsplash\.com/.test(u) ? u.split("?")[0] + "?w=640&h=400&fit=crop&q=70&auto=format"
    : /res\.cloudinary\.com/.test(u) ? stripT(u).replace("/upload/", "/upload/c_fill,g_auto,w_640,h_400,q_auto,f_auto/") : u;
  const phoneUrl = u => /images\.unsplash\.com/.test(u) ? u.split("?")[0] + "?w=240&h=300&fit=crop&q=70&auto=format"
    : /res\.cloudinary\.com/.test(u) ? stripT(u).replace("/upload/", "/upload/c_fill,g_auto,w_240,h_300,q_auto,f_auto/") : u;

  function loadImg(src) {
    return new Promise((ok, no) => { const i = new Image(); i.crossOrigin = "anonymous"; i.onload = () => ok(i); i.onerror = () => no(new Error("Couldn't load the image")); i.src = src; });
  }

  /* ---------- the checks ---------- */
  async function analyze(src, meta = {}) {
    const img = await loadImg(src);
    const W = img.naturalWidth, H = img.naturalHeight;
    const k = Math.min(1, 480 / Math.max(W, H)), w = Math.max(8, Math.round(W * k)), h = Math.max(8, Math.round(H * k));
    const cv = document.createElement("canvas"); cv.width = w; cv.height = h;
    const cx = cv.getContext("2d", { willReadFrequently: true }); cx.drawImage(img, 0, 0, w, h);
    let d; try { d = cx.getImageData(0, 0, w, h).data; } catch (e) { return { error: "This site blocks photo checks (no CORS)", W, H }; }
    const n = w * h, L = new Float32Array(n);
    let sL = 0, sL2 = 0, clipHi = 0, clipLo = 0, srg = 0, srg2 = 0, syb = 0, syb2 = 0;
    for (let i = 0, p = 0; i < n; i++, p += 4) {
      const r = d[p], g = d[p + 1], b = d[p + 2], l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      L[i] = l; sL += l; sL2 += l * l; if (l > 250) clipHi++; if (l < 6) clipLo++;
      const rg = r - g, yb = 0.5 * (r + g) - b; srg += rg; srg2 += rg * rg; syb += yb; syb2 += yb * yb;
    }
    const mean = sL / n, std = Math.sqrt(Math.max(0, sL2 / n - mean * mean));
    const mrg = srg / n, myb = syb / n, colour = Math.sqrt(Math.max(0, srg2 / n - mrg * mrg) + Math.max(0, syb2 / n - myb * myb)) + 0.3 * Math.sqrt(mrg * mrg + myb * myb);
    // sharpness: variance of the Laplacian
    let lS = 0, lS2 = 0, cnt = 0;
    for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
      const i = y * w + x, v = 4 * L[i] - L[i - 1] - L[i + 1] - L[i - w] - L[i + w];
      lS += v; lS2 += v * v; cnt++;
    }
    const lap = cnt ? lS2 / cnt - (lS / cnt) ** 2 : 0;
    // perceptual hash (dHash 9x8) for near-duplicates
    const hc = document.createElement("canvas"); hc.width = 9; hc.height = 8; const hx = hc.getContext("2d", { willReadFrequently: true });
    hx.drawImage(img, 0, 0, 9, 8); const hd = hx.getImageData(0, 0, 9, 8).data; let hash = "";
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { const a = (y * 9 + x) * 4, b = a + 4; hash += (hd[a] + hd[a + 1] + hd[a + 2]) > (hd[b] + hd[b + 1] + hd[b + 2]) ? "1" : "0"; }

    const long = Math.max(W, H), ratio = W / H;
    const sc = {
      resolution: meta.scalable ? 100 : long >= 1920 ? 100 : long >= 1600 ? 88 : long >= 1280 ? 72 : long >= 1000 ? 48 : 18,
      orientation: ratio >= 1.45 ? 100 : ratio >= 1.3 ? 90 : ratio >= 1.1 ? 62 : ratio >= 0.9 ? 40 : 12,
      sharpness: clamp((Math.log10(Math.max(lap, 1)) - 1.7) / (3.0 - 1.7) * 100),
      exposure: clamp(100 - Math.abs(mean - 145) * 1.1),
      contrast: clamp(std / 58 * 100),
      colour: clamp(colour / 48 * 100)
    };
    const clip = (clipHi + clipLo) / n;
    // shape matters most for a wide banner, so it scales the whole score (portrait photos can't score well)
    let score = (sc.resolution * .24 + sc.sharpness * .3 + sc.exposure * .22 + sc.contrast * .12 + sc.colour * .12) * (0.45 + 0.55 * sc.orientation / 100);
    if (clip > .08) score -= Math.min(15, (clip - .08) * 100);
    if (meta.bytes && meta.bytes < 120e3 && long >= 1200) score -= 6;
    // a small photo can't look great stretched across a big screen, however sharp it is
    if (!meta.scalable) score = Math.min(score, long >= 1600 ? 100 : long >= 1280 ? 79 : long >= 1000 ? 64 : 49);
    score = Math.round(clamp(score));
    const why = [];
    if (sc.orientation < 50) why.push(ratio < 0.9 ? "Portrait photo: most of it gets cropped on wide screens" : "Almost square: the top and bottom get cropped on desktop");
    else if (sc.orientation < 70) why.push("Only slightly wide: some cropping on desktop");
    if (sc.resolution < 50) why.push(`Small (${W}×${H}): looks soft when stretched`);
    else if (sc.resolution < 75) why.push(`Medium size (${W}×${H}): fine on phones, a bit soft on big screens`);
    if (sc.sharpness < 40) why.push("Blurry or out of focus");
    else if (sc.sharpness < 60) why.push("Slightly soft");
    if (mean < 95) why.push("Too dark"); else if (mean > 200) why.push("Too bright / washed out");
    if (clip > .08) why.push(`${Math.round(clip * 100)}% of the photo is pure white or black`);
    if (sc.contrast < 45) why.push("Flat, low contrast");
    if (sc.colour < 30) why.push("Dull, greyish colours");
    if (meta.bytes && meta.bytes < 120e3 && long >= 1200) why.push("Heavily compressed file");
    if (meta.bytes && meta.bytes > 15e6) why.push("File over 15 MB: too big to upload");
    if (!why.length) why.push("Sharp, bright, wide: a great homepage photo");
    const grade = score >= 80 ? ["Excellent", "g-a"] : score >= 65 ? ["Good", "g-b"] : score >= 50 ? ["Fair", "g-c"] : ["Poor", "g-d"];
    return { W, H, ratio, sc, score, grade, why, hash, clip, mean, tooBig: meta.bytes > 15e6, canEnhance: mean < 110 || sc.contrast < 55 || sc.colour < 40 };
  }
  const ham = (a, b) => { let d = 0; for (let i = 0; i < 64; i++) if (a[i] !== b[i]) d++; return d; };

  /* ---------- rendering ---------- */
  const chips = a => a && !a.error ? `<div class="hs-m">
      <span class="${a.sc.resolution >= 75 ? "good" : a.sc.resolution < 50 ? "bad" : ""}">${a.W}×${a.H}</span>
      <span class="${a.sc.orientation >= 90 ? "good" : a.sc.orientation < 50 ? "bad" : ""}">${a.ratio >= 1.1 ? "Landscape" : a.ratio >= .9 ? "Square" : "Portrait"}</span>
      <span class="${a.sc.sharpness >= 60 ? "good" : a.sc.sharpness < 40 ? "bad" : ""}">Sharp ${Math.round(a.sc.sharpness)}</span>
      <span class="${a.sc.exposure >= 70 ? "good" : a.sc.exposure < 45 ? "bad" : ""}">Light ${Math.round(a.sc.exposure)}</span>
      <span class="${a.sc.colour >= 50 ? "good" : a.sc.colour < 30 ? "bad" : ""}">Colour ${Math.round(a.sc.colour)}</span></div>` : "";
  const badge = a => a ? (a.error ? `<span class="hs-badge g-x">?</span>` : `<span class="hs-badge ${a.grade[1]}">${a.score} · ${a.grade[0]}</span>`) : `<span class="hs-badge g-x">Checking…</span>`;
  // banner text shown on the stock photos when nothing custom is set (same as the homepage)
  const STOCK_CAP = [["Homes worth coming home to", "Rentals across Kenya, straight from owners"], ["Light, space and room to settle", "Browse verified homes near you"], ["Your next home is on PataHome", "Free viewings. Never pay before you see it"], ["Find it, view it, move in", "Book a free viewing in a few taps"], ["Kwa sababu tunakujali", "Because we care about where you live"]];
  const srcLabel = it => it.listing ? `Listing #${it.listing}` : it.upload ? "Upload" : /unsplash/.test(it.url || "") ? "Stock" : "Link";

  function paint() {
    const el = $("hsLineup"); if (!el) return;
    el.innerHTML = lineup.length ? lineup.map((it, i) => `<div class="hs-it">
        <div class="hs-ph"><img src="${esc(thumbUrl(it.url))}" alt="" loading="lazy"><span class="phone"><img src="${esc(phoneUrl(it.url))}" alt="" loading="lazy"></span>${badge(it.a)}<span class="hs-src">${srcLabel(it)}</span><span class="hs-num">${i + 1}</span></div>
        <div class="hs-bd">${chips(it.a)}<div class="hs-why">${it.a ? esc(it.a.error || it.a.why.join(" · ")) : ""}</div>
        <div class="hs-capf"><input maxlength="60" placeholder="${it.listing ? "Banner label (optional, e.g. New this week)" : "Banner title, e.g. Modern living in Kilimani"}" value="${esc(it.caption || "")}" oninput="hsCap(${i},'caption',this.value)"><input maxlength="80" placeholder="${it.listing ? "Shows the price and home name" : "Short line under it (optional)"}" value="${esc(it.sub || "")}" ${it.listing ? "disabled" : ""} oninput="hsCap(${i},'sub',this.value)"></div>
        <label style="font-size:.76rem;display:flex;gap:6px;align-items:center;margin:0;text-transform:none;letter-spacing:0;font-weight:500"><input type="checkbox" ${it.enhance ? "checked" : ""} onchange="hsEnhance(${i},this.checked)"> Auto-enhance${it.a && it.a.canEnhance ? " (recommended)" : ""}</label>
        <div class="hs-act"><button class="btn btn-ghost" ${i === 0 ? "disabled" : ""} onclick="hsMove(${i},-1)">↑ Earlier</button><button class="btn btn-ghost" ${i === lineup.length - 1 ? "disabled" : ""} onclick="hsMove(${i},1)">↓ Later</button><button class="btn btn-ghost" onclick="hsRemove(${i})">Remove</button></div></div></div>`).join("")
      : `<div class="muted">No photos yet. The homepage will show the 5 stock photos.</div>`;
    const avg = lineup.filter(x => x.a && !x.a.error); $("hsAvg").textContent = avg.length ? `Average score ${Math.round(avg.reduce((s, x) => s + x.a.score, 0) / avg.length)} · ${lineup.length} of ${MAX}` : `${lineup.length} of ${MAX}`;
    paintCands();
  }
  function paintCands() {
    const el = $("hsCands"); if (!el) return;
    const inLine = new Set(lineup.map(x => stripT(x.url)));
    let list = cands.filter(c => !inLine.has(stripT(c.url || "")) || c.upload);
    if (F.landscape) list = list.filter(c => !c.a || c.a.error || c.a.ratio >= 1.1);
    list = list.filter(c => !c.a || c.a.error || c.a.score >= F.min);
    if (F.dupes) list = list.filter(c => !c.dupOf);
    list.sort((a, b) => F.sort === "score" ? ((b.a && b.a.score) || -1) - ((a.a && a.a.score) || -1) : 0);
    const hidden = cands.length - list.length;
    $("hsCandInfo").textContent = cands.length ? `${list.length} shown${hidden ? ` · ${hidden} hidden by the filters` : ""}${busy ? ` · checking ${busy}…` : ""}` : "";
    el.innerHTML = list.slice(0, 60).map(c => { const i = cands.indexOf(c); return `<div class="hs-it">
        <div class="hs-ph"><img src="${esc(c.preview || thumbUrl(c.url))}" alt="" loading="lazy">${badge(c.a)}<span class="hs-src">${srcLabel(c)}</span></div>
        <div class="hs-bd">${chips(c.a)}<div class="hs-why">${c.a ? esc(c.a.error || c.a.why.join(" · ")) : ""}${c.dupOf ? " · Looks like a photo you already have" : ""}</div>
        <div class="hs-act"><button class="btn btn-primary" ${!c.a || (c.a.tooBig) ? "disabled" : ""} onclick="hsAdd(${i})">${c.upload ? "Upload & add" : "Add to homepage"}</button>${c.listing ? `<a class="btn btn-ghost" href="/browse?open=${c.listing}" target="_blank">View listing</a>` : ""}</div></div></div>`; }).join("")
      || (cands.length ? `<div class="muted">No photos pass the filters. Lower the minimum score or untick "Landscape only".</div>` : `<div class="muted">Upload photos, scan your listings or paste a link to see scored suggestions here.</div>`);
  }
  function markDupes() {
    const pool = lineup.filter(x => x.a && x.a.hash);
    cands.forEach(c => {
      c.dupOf = null; if (!c.a || !c.a.hash) return;
      if (pool.some(x => ham(x.a.hash, c.a.hash) <= 6)) c.dupOf = "lineup";
      else { const better = cands.find(o => o !== c && o.a && o.a.hash && ham(o.a.hash, c.a.hash) <= 6 && (o.a.score > c.a.score || (o.a.score === c.a.score && cands.indexOf(o) < cands.indexOf(c)))); if (better) c.dupOf = "cand"; }
    });
  }

  // a small queue so we never check more than 3 photos at once
  const queue = []; let running = 0;
  function check(item, src, meta) {
    queue.push(async () => { try { item.a = await analyze(src, meta); } catch (e) { item.a = { error: e.message }; } });
    pump();
  }
  function pump() {
    while (running < 3 && queue.length) {
      const job = queue.shift(); running++; busy++;
      job().finally(() => { running--; busy--; markDupes(); paint(); pump(); });
    }
    paintCands();
  }

  /* ---------- sources ---------- */
  window.hsFiles = files => {
    for (const f of [...files]) {
      if (!/^image\/(jpeg|png|webp)$/.test(f.type)) { toast(`${f.name}: use JPG, PNG or WebP`); continue; }
      const c = { upload: true, file: f, preview: URL.createObjectURL(f) };
      cands.unshift(c); check(c, c.preview, { bytes: f.size });
    }
    paintCands();
  };
  window.hsScan = async () => {
    if (scanning) return; scanning = true; $("hsScanBtn").textContent = "Scanning…";
    try {
      let page = 1, seen = new Set(cands.map(c => stripT(c.url || ""))), added = 0;
      while (page <= 4 && added < 90) {
        const r = await api(`/api/search?perPage=50&page=${page}&sort=newest`);
        for (const l of r.listings) {
          if (l.category === "land" || !(l.photoUrls || []).length) continue;
          for (const p of l.photoUrls) {
            const base = stripT(p.full); if (seen.has(base)) continue; seen.add(base);
            const c = { url: base, listing: l.id }; cands.push(c); check(c, analysisUrl(base)); added++;
          }
        }
        if (!r.hasMore) break; page++;
      }
      toast(added ? `Checking ${added} listing photos` : "No new listing photos to check");
    } catch (e) { toast(e.message); }
    scanning = false; $("hsScanBtn").textContent = "Scan listing photos";
  };
  window.hsLink = () => {
    const u = ($("hsUrl").value || "").trim();
    if (!/^https:\/\//.test(u)) return toast("Paste a link starting with https://");
    const c = { url: u.split("#")[0] }; cands.unshift(c); check(c, analysisUrl(c.url), { scalable: /images\.unsplash\.com/.test(c.url) }); $("hsUrl").value = "";
  };
  window.hsStock = () => { STOCK.forEach(u => { if (!cands.some(c => c.url === u) && !lineup.some(x => x.url === u)) { const c = { url: u }; cands.push(c); check(c, analysisUrl(u), { scalable: true }); } }); };

  /* ---------- lineup actions ---------- */
  window.hsAdd = async i => {
    const c = cands[i]; if (!c) return;
    if (lineup.length >= MAX) return toast(`The homepage takes up to ${MAX} photos. Remove one first.`);
    if (c.a && !c.a.error && c.a.score < 50 && !confirm(`This photo scores ${c.a.score} (${c.a.why.join(", ")}). Add it anyway?`)) return;
    let url = c.url;
    if (c.upload) {
      let cfg; try { cfg = await api("/api/uploads/sign?kind=hero"); } catch (e) { return toast(e.message); }
      toast("Uploading…");
      const fd = new FormData();
      fd.append("file", c.file); fd.append("api_key", cfg.apiKey); fd.append("timestamp", cfg.timestamp); fd.append("signature", cfg.signature);
      fd.append("folder", cfg.folder); fd.append("transformation", cfg.transformation);
      try { const r = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, { method: "POST", body: fd }); const d = await r.json(); if (!d.secure_url) throw new Error((d.error && d.error.message) || "Upload failed"); url = d.secure_url; }
      catch (e) { return toast(e.message); }
    }
    lineup.push({ url, listing: c.listing || 0, enhance: !!(c.a && c.a.canEnhance && c.a.score < 75), a: c.a });
    cands.splice(i, 1); markDupes(); paint(); toast("Added. Save to put it live.");
  };
  window.hsMove = (i, d) => { const j = i + d; if (j < 0 || j >= lineup.length) return; [lineup[i], lineup[j]] = [lineup[j], lineup[i]]; paint(); };
  window.hsRemove = i => { const [it] = lineup.splice(i, 1); if (it && it.url) cands.push({ url: it.url, listing: it.listing, a: it.a }); markDupes(); paint(); };
  window.hsEnhance = (i, v) => { lineup[i].enhance = v; };
  window.hsCap = (i, k, v) => { lineup[i][k] = v; };
  window.hsBest = () => {
    // fill empty slots with the best-scoring, non-duplicate, wide photos
    const pick = cands.filter(c => c.a && !c.a.error && !c.dupOf && c.a.ratio >= 1.1 && c.a.score >= 70 && !c.upload).sort((a, b) => b.a.score - a.a.score);
    let n = 0; for (const c of pick) { if (lineup.length >= MAX) break; lineup.push({ url: c.url, listing: c.listing || 0, enhance: c.a.canEnhance && c.a.score < 75, a: c.a }); cands.splice(cands.indexOf(c), 1); n++; markDupes(); }
    paint(); toast(n ? `Added ${n} top photo${n === 1 ? "" : "s"}. Save to put them live.` : "No checked photos scored 70+ yet");
  };
  window.hsSave = async () => {
    const lines = lineup.map(it => { const o = { ...(it.listing ? { listing: it.listing } : {}), ...(it.enhance ? { enhance: 1 } : {}),
      ...((it.caption || "").trim() ? { caption: it.caption.trim().slice(0, 60) } : {}), ...(!it.listing && (it.sub || "").trim() ? { sub: it.sub.trim().slice(0, 80) } : {}) };
      return it.url + (Object.keys(o).length ? "#" + new URLSearchParams(o) : ""); });
    try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ hero_images: lines.join("\n") }) }); toast(lines.length ? "Homepage photos are live" : "Back to the 5 stock photos"); }
    catch (e) { toast(e.message); }
  };
  window.hsReset = () => { if (!confirm("Go back to the 5 stock photos?")) return; lineup = STOCK.map((u, i) => ({ url: u, caption: STOCK_CAP[i % STOCK_CAP.length][0], sub: STOCK_CAP[i % STOCK_CAP.length][1] })); lineup.forEach(it => check(it, analysisUrl(it.url), { scalable: /images\.unsplash\.com/.test(it.url) })); paint(); };
  window.hsFilter = () => { F.min = +$("hsMin").value; F.landscape = $("hsLand").checked; F.dupes = $("hsDup").checked; $("hsMinV").textContent = F.min; paintCands(); };

  /* ---------- the tab ---------- */
  window.NEW_LOADERS = window.NEW_LOADERS || {};
  NEW_LOADERS.hero = async function () {
    let st = {}; try { st = await api("/api/admin/settings"); } catch (e) { $("panel").innerHTML = `<div style="padding:30px;color:var(--red)">Only the super admin can change homepage photos.</div>`; return; }
    const saved = (st.hero_images || "").split("\n").filter(Boolean);
    lineup = (saved.length ? saved : STOCK).map(line => { const [u, frag] = line.split("#"); const o = Object.fromEntries(new URLSearchParams(frag || "")); return { url: u, listing: +o.listing || 0, enhance: o.enhance === "1", caption: o.caption || "", sub: o.sub || "" }; });
    if (!saved.length) lineup.forEach((it, i) => { const c = STOCK_CAP[i % STOCK_CAP.length]; it.caption = c[0]; it.sub = c[1]; });
    $("panel").innerHTML = `<div class="hs-wrap">
      <div class="hs-card"><h3>🏠 On the homepage now <small class="muted" id="hsAvg"></small></h3>
        <div class="muted">Shown in this order, fading every 7 seconds. The small inset shows how each photo crops on a phone. Each photo gets a banner card with the PataHome logo: listing photos show that home's price, other photos show the title and line you type.</div>
        <div class="hs-row" id="hsLineup"></div>
        <div class="hs-tools"><button class="btn btn-primary" onclick="hsSave()">Save &amp; put live</button><button class="btn btn-ghost" onclick="hsBest()">Fill with the best photos</button><button class="btn btn-ghost" onclick="hsReset()">Reset to stock photos</button></div>
      </div>
      <div class="hs-card"><h3>➕ Find better photos</h3>
        <div class="muted">Every photo is checked for size, shape (wide works best), sharpness, light, contrast and colour, then scored out of 100. Near-duplicates are hidden.</div>
        <div class="hs-drop" id="hsDrop" onclick="$('hsFile').click()">Drop photos here or click to choose<br><small>JPG, PNG or WebP · wide photos at least 1600px across work best</small></div>
        <input type="file" id="hsFile" accept="image/jpeg,image/png,image/webp" multiple style="display:none" onchange="hsFiles(this.files);this.value=''">
        <div class="hs-tools">
          <button class="btn btn-ghost" id="hsScanBtn" onclick="hsScan()">Scan listing photos</button>
          <button class="btn btn-ghost" onclick="hsStock()">Show stock photos</button>
          <input id="hsUrl" placeholder="or paste a photo link (https://…)" style="flex:1;min-width:200px"><button class="btn btn-ghost" onclick="hsLink()">Check link</button>
        </div>
        <div class="hs-tools">
          <label style="margin:0;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0">Minimum score <input type="range" id="hsMin" min="0" max="90" step="5" value="${F.min}" oninput="hsFilter()" style="width:120px"> <b id="hsMinV">${F.min}</b></label>
          <label style="margin:0;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0"><input type="checkbox" id="hsLand" ${F.landscape ? "checked" : ""} onchange="hsFilter()"> Landscape only</label>
          <label style="margin:0;display:flex;gap:6px;align-items:center;text-transform:none;letter-spacing:0"><input type="checkbox" id="hsDup" ${F.dupes ? "checked" : ""} onchange="hsFilter()"> Hide near-duplicates</label>
          <span class="muted" id="hsCandInfo"></span>
        </div>
        <div class="hs-legend"><span class="hs-badge g-a" style="position:static">80+ Excellent</span> <span class="hs-badge g-b" style="position:static">65+ Good</span> <span class="hs-badge g-c" style="position:static">50+ Fair</span> <span class="hs-badge g-d" style="position:static">Poor</span></div>
        <div class="hs-row" id="hsCands"></div>
      </div></div>`;
    const drop = $("hsDrop");
    ["dragenter", "dragover"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach(ev => drop.addEventListener(ev, e => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", e => hsFiles(e.dataTransfer.files));
    lineup.forEach(it => check(it, analysisUrl(it.url), { scalable: /images\.unsplash\.com/.test(it.url) }));
    paint();
  };
})();
