/* PataHome admin: "Listed for owners": post a listing on behalf of an owner who
   can't list themselves. The listing lives on the owner's own account and shows
   nothing about PataHome/admin. Uses helpers from the main admin scripts. */
(function () {
  const CAT = { rent: "Rent", sale: "Sale", shortlet: "Airbnb", land: "Land", commercial: "Commercial" };
  const HOW = { call: "Phone call", whatsapp: "WhatsApp", sms: "SMS", in_person: "In person", written: "Written / signed" };
  const when = s => s ? esc(String(s).replace("T", " ").slice(0, 16)) : "-";
  let photos = [], uploading = 0, signCfg = null;

  NEW_LOADERS.assisted = async function () {
    const rows = await api("/api/admin/assisted");
    $("panel").innerHTML = `<div class="toolbar"><b>Listed for owners</b>
        <span class="muted">Listings PataHome posted for owners. Visitors see an ordinary owner listing, nothing mentions PataHome or admin.</span>
        <button class="btn btn-primary btn-sm" style="margin-left:auto" onclick="assistForm()">+ List for an owner</button></div>
      ${rows.length ? `<table><tr><th>Listing</th><th>Owner</th><th>Visitors reach</th><th>Activity</th><th>Status</th><th></th></tr>
      ${rows.map(r => `<tr>
        <td><b>${esc(r.title)}</b> <span class="pill ok">${CAT[r.category] || r.category}</span><div class="muted">#${r.id} · ${esc(r.area)} · ${fmt(r.price)} · <a href="/browse?open=${r.id}" target="_blank" rel="noopener">view ↗</a></div>
          <div class="muted">Consent: ${esc(HOW[r.consent.how] || r.consent.how || "-")}${r.consent.note ? ": " + esc(r.consent.note) : ""} · by ${esc(r.listedBy)} ${when(r.createdAt)}</div></td>
        <td><a href="#" onclick="openUser(${r.owner.id});return false">${esc(r.owner.name)}</a><div class="muted">${esc(r.owner.phone)}${r.owner.managed ? " · account made by us" : ""}</div></td>
        <td>${r.contact.phone ? `<b>${esc(r.contact.name || "Other contact")}</b><div class="muted">${esc(r.contact.phone)}${r.contact.whatsapp && r.contact.whatsapp !== r.contact.phone ? " · WA " + esc(r.contact.whatsapp) : ""}</div>` : '<span class="muted">Owner\'s phone</span>'}
          <div class="muted">Shown as: ${esc(r.contact.role)}${r.relaySms ? " · enquiries by SMS" : ""}${r.relayCopy ? " · copy to you" : ""}</div></td>
        <td class="muted">${r.leads} contacts · ${r.inquiries} messages · ${r.viewings} viewings</td>
        <td><span class="pill ${r.status === "active" ? "ok" : "warn"}">${esc(r.status)}</span></td>
        <td style="white-space:nowrap"><button class="btn btn-ghost btn-sm" onclick="assistEdit(${r.id})">Contact…</button>
          <button class="btn btn-ghost btn-sm" onclick="editListing(${r.id})">Edit</button>
          ${r.status === "active" ? `<button class="btn btn-ghost btn-sm" onclick="assistStatus(${r.id},'${["rent", "shortlet"].includes(r.category) ? "rented" : "sold"}')">Mark ${["rent", "shortlet"].includes(r.category) ? "let" : "sold"}</button>
            <button class="btn btn-ghost btn-sm" onclick="assistStatus(${r.id},'renew')">Renew</button>` : `<button class="btn btn-ghost btn-sm" onclick="assistStatus(${r.id},'active')">Relist</button>`}</td>
      </tr>`).join("")}</table>` : `<div style="padding:34px;text-align:center;color:var(--muted)">Nothing yet. Use <b>List for an owner</b> when an owner asks PataHome to post for them.</div>`}`;
    window._assisted = rows;
  };

  const contactFields = (c = {}) => `
    <label>Who do visitors reach?</label>
    <select id="asWho" onchange="$('asOther').style.display=this.value==='other'?'':'none'">
      <option value="owner"${c.phone ? "" : " selected"}>The owner's phone</option>
      <option value="other"${c.phone ? " selected" : ""}>Another number (caretaker, relative, agent, PataHome line…)</option>
    </select>
    <div id="asOther" style="display:${c.phone ? "" : "none"}">
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px">
        <div><label>Name shown</label><input id="asCName" value="${esc(c.name || "")}" placeholder="e.g. Mama Wanjiru"></div>
        <div><label>Phone</label><input id="asCPhone" value="${esc(c.phone || "")}" placeholder="0712… or +254…"></div>
        <div><label>WhatsApp (if different)</label><input id="asCWa" value="${esc(c.whatsapp && c.whatsapp !== c.phone ? c.whatsapp : "")}" placeholder="optional"></div>
      </div>
    </div>
    <label>Label on the listing</label>
    <select id="asRole" onchange="$('asFeeWrap').style.display=this.value==='agent'?'':'none'">
      ${[["owner", "Direct owner"], ["caretaker", "Caretaker / manager"], ["agent", "Agent"]].map(([v, l]) => `<option value="${v}"${(c.role || "owner") === v ? " selected" : ""}>${l}</option>`).join("")}
    </select>
    <div id="asFeeWrap" style="display:${c.role === "agent" ? "" : "none"}"><label>Agent's fee to the tenant</label><input id="asFee" value="${esc(c.fee || "")}" placeholder="e.g. No fee to tenant, or KES 5,000"></div>
    <label class="chk"><input type="checkbox" id="asRelay" ${c.relaySms ? "checked" : ""}> Also send enquiries and viewing requests to that number by SMS</label>
    <label class="chk"><input type="checkbox" id="asCopy" ${c.relayCopy ? "checked" : ""}> Email me a copy of every enquiry</label>`;
  const readContact = () => {
    const other = $("asWho").value === "other";
    return { contact: other ? { name: $("asCName").value.trim(), phone: $("asCPhone").value.trim(), whatsapp: $("asCWa").value.trim() } : {},
      relaySms: $("asRelay").checked, relayCopy: $("asCopy").checked, listerRole: $("asRole").value, agentFee: $("asFee").value.trim() };
  };

  window.assistForm = async function () {
    photos = []; uploading = 0;
    const ar = await api("/api/areas");
    openModal(`<h2>List for an owner</h2>
      <div class="muted">The listing goes on the owner's own PataHome account (made quietly if they don't have one). Visitors see an ordinary listing.</div>
      <div class="sec"><h3>1 · Owner</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Owner's name</label><input id="asOName" placeholder="Full name"></div>
          <div><label>Owner's phone (Kenyan)</label><input id="asOPhone" placeholder="0712345678"></div>
          <div><label>Email (optional)</label><input id="asOEmail" placeholder="owner@email.com"></div>
          <div><label>WhatsApp (optional)</label><input id="asOWa" placeholder="if different"></div>
        </div>
        <div style="display:grid;grid-template-columns:1fr 2fr;gap:8px">
          <div><label>How did they agree?</label><select id="asHow"><option value="">Choose…</option>${Object.entries(HOW).map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div><label>Consent note</label><input id="asNote" placeholder="e.g. Called 26 Sep, OK to show caretaker's number"></div>
        </div>
        <label class="chk"><input type="checkbox" id="asTell" checked> Text the owner that their listing is live (with how to manage it)</label></div>
      <div class="sec"><h3>2 · Contact on the listing</h3>${contactFields()}</div>
      <div class="sec"><h3>3 · The property</h3>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Category</label><select id="asCat" onchange="asCatFields()">${[["rent", "House / room, for rent"], ["sale", "House, for sale"], ["shortlet", "Airbnb / short stay"], ["land", "Land, sale or lease"], ["commercial", "Commercial property"]].map(([v, l]) => `<option value="${v}">${l}</option>`).join("")}</select></div>
          <div><label>Area</label><select id="asArea">${ar.map(a => `<option value="${a.id}">${esc(a.name)}, ${esc(a.county)}</option>`).join("")}</select></div>
        </div>
        <label>Title</label><input id="asTitle" placeholder="e.g. Spacious 2 bedroom near the stage">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Price (KES)</label><input id="asPrice" type="number" min="0"></div>
          <div id="asBedsWrap"><label>Bedrooms</label><select id="asBeds"><option value="">N/A</option><option value="0">Bedsitter</option>${[1, 2, 3, 4, 5].map(n => `<option>${n}</option>`).join("")}</select></div>
        </div>
        <div id="asCatBox"></div>
        <label>Description</label><textarea id="asDesc" rows="3" placeholder="What the owner told you: water, parking, deposit, directions…"></textarea>
        <label>Photos (up to 60)</label><div class="ph-wall" id="asPhotos" style="grid-template-columns:repeat(auto-fill,minmax(110px,1fr))"></div>
        <input type="file" id="asFile" accept="image/jpeg,image/png,image/webp" multiple style="display:none" onchange="asUpload(this.files);this.value=''"></div>
      <div class="err" id="asErr"></div>
      <div class="actions"><button class="btn btn-primary" id="asSave" onclick="assistSave()">Publish listing</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
    asCatFields(); asPaint();
  };
  const opts = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(typeof v === "string" ? v : v.many)}</option>`).join("");
  window.asCatFields = () => {
    const c = $("asCat").value;
    $("asBedsWrap").style.display = ["rent", "sale", "shortlet"].includes(c) ? "" : "none";
    $("asCatBox").innerHTML = c === "land" ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div><label>Deal</label><select id="asDeal" onchange="asBasis()"><option value="sale">For sale</option><option value="lease">For lease</option></select></div>
        <div><label>Price is</label><select id="asBasisSel"></select></div>
        <div><label>Size</label><input id="asSize" type="number" step="any" min="0"></div>
        <div><label>Unit</label><select id="asUnit">${opts(PH_LAND.UNITS, "acre")}</select></div></div>`
      : c === "commercial" ? `<div style="display:grid;grid-template-columns:repeat(4,1fr);gap:8px">
        <div><label>Type</label><select id="asType">${opts(PH_COMM.TYPES, "shop")}</select></div>
        <div><label>Deal</label><select id="asDeal" onchange="asBasis()"><option value="sale">For sale</option><option value="lease">To let</option></select></div>
        <div><label>Price is</label><select id="asBasisSel"></select></div>
        <div><label>Floor area</label><div style="display:flex;gap:4px"><input id="asSize" type="number" step="any" min="0"><select id="asUnit" style="width:auto">${opts(PH_COMM.UNITS, "sqft")}</select></div></div></div>` : "";
    if (c === "land" || c === "commercial") asBasis();
  };
  window.asBasis = () => {
    const B = ($("asCat").value === "land" ? PH_LAND : PH_COMM).BASIS[$("asDeal").value];
    $("asBasisSel").innerHTML = Object.entries(B).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  };

  /* photos straight to Cloudinary, like the owner dashboard */
  function asPaint() {
    $("asPhotos").innerHTML = photos.map((p, i) => `<div class="ph-item"><img src="https://res.cloudinary.com/${signCfg ? signCfg.cloudName : ""}/image/upload/c_fill,w_220,h_165/${p}" alt=""><button class="btn btn-danger btn-sm" onclick="asDrop(${i})">Remove</button></div>`).join("") +
      (uploading ? `<div class="ph-item" style="justify-content:center;align-items:center;min-height:90px"><span class="muted">Uploading ${uploading}…</span></div>` : "") +
      (photos.length + uploading < ((typeof signCfg !== "undefined" && signCfg && signCfg.maxPhotos) || 60) ? `<button type="button" class="btn btn-ghost" style="min-height:90px" onclick="$('asFile').click()">+ Add photos</button>` : "");
  }
  window.asDrop = i => { photos.splice(i, 1); asPaint(); };
  window.asUpload = async files => {
    try { signCfg = await api("/api/uploads/sign"); } catch (e) { return toast(e.message); }
    const list = [...files].slice(0, (signCfg.maxPhotos || 60) - photos.length - uploading).filter(f => /^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= (signCfg.maxBytes || 8e6));
    uploading += list.length; asPaint();
    await Promise.all(list.map(async f => {
      const fd = new FormData();
      fd.append("file", f); fd.append("api_key", signCfg.apiKey); fd.append("timestamp", signCfg.timestamp); fd.append("signature", signCfg.signature);
      fd.append("folder", signCfg.folder); fd.append("transformation", signCfg.transformation); if (signCfg.moderation) fd.append("moderation", signCfg.moderation); if (signCfg.tags) fd.append("tags", signCfg.tags);
      try { const r = await fetch(`https://api.cloudinary.com/v1_1/${signCfg.cloudName}/image/upload`, { method: "POST", body: fd }); const d = await r.json(); if (d.public_id) photos.push(d.public_id); else toast("A photo failed to upload"); }
      catch (e) { toast("A photo failed to upload"); }
      finally { uploading--; asPaint(); }
    }));
  };

  window.assistSave = async function () {
    $("asErr").textContent = "";
    if (uploading) { $("asErr").textContent = "Wait for the photos to finish uploading"; return; }
    const c = $("asCat").value, ct = readContact();
    const listing = { category: c, areaId: +$("asArea").value, title: $("asTitle").value.trim(), price: +$("asPrice").value,
      description: $("asDesc").value.trim(), photos, listerRole: ct.listerRole, agentFee: ct.agentFee };
    if (["rent", "sale", "shortlet"].includes(c) && $("asBeds").value !== "") listing.bedrooms = +$("asBeds").value;
    if (c === "land") Object.assign(listing, { landDeal: $("asDeal").value, priceBasis: $("asBasisSel").value, sizeValue: +$("asSize").value, sizeUnit: $("asUnit").value });
    if (c === "commercial") Object.assign(listing, { commType: $("asType").value, deal: $("asDeal").value, priceBasis: $("asBasisSel").value, sizeValue: $("asSize").value === "" ? "" : +$("asSize").value, sizeUnit: $("asUnit").value });
    const body = { owner: { name: $("asOName").value.trim(), phone: $("asOPhone").value.trim(), email: $("asOEmail").value.trim(), whatsapp: $("asOWa").value.trim() },
      consent: { how: $("asHow").value, note: $("asNote").value.trim() }, textOwner: $("asTell").checked,
      contact: ct.contact, relaySms: ct.relaySms, relayCopy: ct.relayCopy, listing };
    const btn = $("asSave"); btn.disabled = true; btn.textContent = "Publishing…";
    try {
      const r = await api("/api/admin/assisted", { method: "POST", body: JSON.stringify(body) });
      closeModal(); toast(`Listing #${r.listing.id} is live${r.newAccount ? ", owner account created" : ""}`);
      NEW_LOADERS.assisted();
    } catch (e) { $("asErr").textContent = e.message; btn.disabled = false; btn.textContent = "Publish listing"; }
  };

  window.assistEdit = function (id) {
    const r = (window._assisted || []).find(x => x.id === id); if (!r) return;
    openModal(`<h2>Contact for #${r.id}</h2><div class="muted">${esc(r.title)} · owner ${esc(r.owner.name)}</div>
      ${contactFields({ ...r.contact, relaySms: r.relaySms, relayCopy: r.relayCopy })}
      <div class="err" id="asErr"></div>
      <div class="actions"><button class="btn btn-primary" onclick="assistEditSave(${id})">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  };
  window.assistEditSave = async function (id) {
    const ct = readContact();
    try { await api("/api/admin/assisted/" + id, { method: "PATCH", body: JSON.stringify(ct) }); closeModal(); toast("Contact updated"); NEW_LOADERS.assisted(); }
    catch (e) { $("asErr").textContent = e.message; }
  };
  window.assistStatus = async function (id, st) {
    try { await api("/api/admin/assisted/" + id, { method: "PATCH", body: JSON.stringify(st === "renew" ? { renew: true } : { status: st }) }); toast(st === "renew" ? "Renewed" : "Updated"); NEW_LOADERS.assisted(); }
    catch (e) { toast(e.message); }
  };
})();

/* ---------- Site tab: watermark card (super admin) ---------- */
(function () {
  const origSite = NEW_LOADERS.site;
  NEW_LOADERS.site = async function () {
    await origSite();
    if (!hasCap("super")) return;
    let w; try { w = await api("/api/admin/watermark"); } catch (e) { return; }
    const grid = document.querySelector("#panel .site-grid"); if (!grid) return;
    const j = w.job || {};
    grid.insertAdjacentHTML("afterbegin", `<div class="site-card"><h3>🖼 Watermark</h3>
      <div class="muted">The PataHome logo is stamped in the middle of every new photo (so it can't be cropped off) the moment it's uploaded, and on every video.</div>
      <div style="display:flex;gap:10px;align-items:center;margin:8px 0"><img src="/watermark.png" alt="" style="height:44px;background:#5b6b64;border-radius:8px;padding:4px">
        <span class="muted">${!w.cloudinary ? "Cloudinary isn't set up" : w.ready ? "✓ Logo stored in Cloudinary" : "Storing the logo in Cloudinary…"}</span></div>
      <label class="chk"><input type="checkbox" id="s_watermark_on" ${w.enabled ? "checked" : ""} onchange="saveSettings(['watermark_on'])"> Watermark new photos and videos</label>
      <div class="actions"><button class="btn btn-ghost btn-sm" ${j.running ? "disabled" : ""} onclick="wmExisting()">${j.running ? "Stamping older photos…" : "Add centre watermark to older photos"}</button></div>
      <div class="muted" id="wmStatus">${j.total || j.finishedAt ? `${j.done} of ${j.total} done${j.failed ? `, ${j.failed} failed` : ""}${j.finishedAt && !j.running ? " · finished" : ""}` : ""}</div></div>`);
    if (j.running) setTimeout(() => { if (tab === "site") NEW_LOADERS.site(); }, 4000);
  };
  let heroList = [], heroBusy = 0;
  function heroPaint() {
    const g = $("heroGrid"); if (!g) return;
    g.innerHTML = heroList.map((u, i) => `<div style="position:relative;aspect-ratio:16/10;border-radius:8px;overflow:hidden;background:#eee"><img src="${esc(u.replace("/upload/", "/upload/c_fill,w_300,h_190/"))}" style="width:100%;height:100%;object-fit:cover"><button class="btn btn-ghost btn-sm" style="position:absolute;top:4px;right:4px;min-height:0;padding:2px 8px" onclick="heroDrop(${i})">✕</button></div>`).join("")
      + (heroBusy ? `<div class="muted" style="align-self:center">Uploading ${heroBusy}…</div>` : "") + (!heroList.length && !heroBusy ? `<div class="muted">No photos yet.</div>` : "");
  }
  window.heroDrop = i => { heroList.splice(i, 1); heroPaint(); };
  window.heroUpload = async files => {
    let cfg; try { cfg = await api("/api/uploads/sign?kind=hero"); } catch (e) { return toast(e.message); }
    const list = [...files].slice(0, 6 - heroList.length).filter(f => /^image\/(jpeg|png|webp)$/.test(f.type) && f.size <= cfg.maxBytes);
    heroBusy += list.length; heroPaint();
    await Promise.all(list.map(async f => {
      const fd = new FormData();
      fd.append("file", f); fd.append("api_key", cfg.apiKey); fd.append("timestamp", cfg.timestamp); fd.append("signature", cfg.signature);
      fd.append("folder", cfg.folder); fd.append("transformation", cfg.transformation);
      try { const r = await fetch(`https://api.cloudinary.com/v1_1/${cfg.cloudName}/image/upload`, { method: "POST", body: fd }); const d = await r.json(); if (d.secure_url) heroList.push(d.secure_url); else toast("A photo failed to upload"); }
      catch (e) { toast("A photo failed to upload"); }
      finally { heroBusy--; heroPaint(); }
    }));
  };
  window.heroSave = async () => {
    try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify({ hero_images: heroList.join("\n") }) }); toast("Homepage photos saved"); }
    catch (e) { toast(e.message); }
  };
  window.wmExisting = async function () {
    if (!confirm("Stamp the PataHome logo in the middle of every older listing photo? Photos with the old corner logo keep it too. This permanently changes those photos.")) return;
    try { await api("/api/admin/watermark/existing", { method: "POST" }); toast("Started, this can take a few minutes"); NEW_LOADERS.site(); }
    catch (e) { toast(e.message); }
  };
})();
