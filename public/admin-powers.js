/* PataHome admin, people, listing controls, site settings, growth, messaging, audit log.
   Loaded after the main admin script; uses its helpers ($, api, esc, fmt, toast, cache, refresh, hasCap). */
(function () {
  const CAT = { rent: "Rent", sale: "Sale", shortlet: "Airbnb", land: "Land", commercial: "Commercial" };
  const STATUS = { active: "ok", under_review: "warn", suspended: "bad", removed: "bad", expired: "warn", rented: "ok", sold: "ok" };
  const statusPill = s => `<span class="pill ${STATUS[s] || "ok"}">${esc(String(s).replace("_", " "))}</span>`;
  const when = s => s ? esc(String(s).replace("T", " ").slice(0, 16)) : "-";
  let AREAS = null;
  const areas = async () => AREAS || (AREAS = await api("/api/areas"));

  /* ---------- modal ---------- */
  window.openModal = (html) => { $("mdlBody").innerHTML = html; $("mdl").classList.add("on"); document.body.style.overflow = "hidden"; };
  window.closeModal = () => { $("mdl").classList.remove("on"); document.body.style.overflow = ""; };
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeModal(); });

  /* ================= listings ================= */
  let selected = new Set(), listQ = "";
  window.renderListings = function () {
    const q = listQ.toLowerCase();
    const rows = (cache.listings || []).filter(x => !q || `${x.title} ${x.ownerName} ${x.area} ${x.county} #${x.id}`.toLowerCase().includes(q));
    const mod = hasCap("moderate");
    $("panel").innerHTML = `
      <div class="toolbar">
        <input id="lq" placeholder="Search title, owner, area or #id" value="${esc(listQ)}" oninput="listQ_(this.value)">
        <select id="lst" onchange="listStatus_(this.value)">
          ${[["", "Live & paused"], ["active", "Active"], ["under_review", "Paused / in review"], ["suspended", "Suspended owner"], ["expired", "Expired"], ["removed", "Removed"], ["all", "Everything"]]
            .map(([v, l]) => `<option value="${v}"${listStatus === v ? " selected" : ""}>${l}</option>`).join("")}
        </select>
        <span class="muted">${rows.length} listing${rows.length === 1 ? "" : "s"}</span>
      </div>
      ${mod ? `<div class="bulkbar${selected.size ? " on" : ""}" id="bulkbar"><b id="selN">${selected.size}</b> selected
        <button class="btn btn-ghost btn-sm" onclick="bulk('feature')">⭐ Feature</button>
        <button class="btn btn-ghost btn-sm" onclick="bulk('unfeature')">Unfeature</button>
        <button class="btn btn-ghost btn-sm" onclick="bulk('pause')">Pause</button>
        <button class="btn btn-ghost btn-sm" onclick="bulk('restore')">Restore</button>
        <button class="btn btn-danger btn-sm" onclick="bulk('remove')">Remove</button>
        <button class="btn btn-sm" style="background:none" onclick="selected.clear();renderListings()">Clear</button></div>` : ""}
      <table><tr>${mod ? `<th><input type="checkbox" aria-label="Select all" onchange="selAll(this.checked)"></th>` : ""}<th>Listing</th><th>Owner</th><th>Price</th><th>Leads</th><th>Status</th><th></th></tr>
      ${rows.slice(0, 400).map(x => `<tr>
        ${mod ? `<td><input type="checkbox" ${selected.has(x.id) ? "checked" : ""} onchange="selOne(${x.id},this.checked)" aria-label="Select #${x.id}"></td>` : ""}
        <td><b>${esc(x.title)}</b> <span class="pill ok">${CAT[x.category] || x.category}</span>${x.featured ? ' <span class="pill feat">⭐ featured</span>' : ""}
          ${x.adminBanner ? `<div><span class="pill bad">⚠ ${esc(x.adminBanner)}</span></div>` : ""}
          <div class="muted">${esc(x.area)}, ${esc(x.county)} · #${x.id} · <a href="/browse?open=${x.id}" target="_blank" rel="noopener">view ↗</a></div></td>
        <td><a href="#" onclick="openUser(${x.ownerId});return false">${esc(x.ownerName)}</a><div class="muted">${esc(x.ownerPhone)}</div></td>
        <td>${fmt(x.price)}</td><td><b>${x.leads}</b></td><td>${statusPill(x.status)}</td>
        <td style="white-space:nowrap">${mod ? `<button class="btn btn-ghost btn-sm" onclick="editListing(${x.id})">Edit</button>
          <button class="btn btn-ghost btn-sm" onclick="featureListing(${x.id},${x.featured})">${x.featured ? "Unfeature" : "⭐"}</button>
          ${x.status !== "removed" ? `<button class="btn btn-danger btn-sm" onclick="removeListing(${x.id})">Remove</button>` : ""}` : ""}</td>
      </tr>`).join("")}</table>
      ${rows.length > 400 ? '<div class="muted" style="padding:10px 14px">Showing the first 400, search to narrow down.</div>' : ""}`;
    if (document.activeElement && document.activeElement.id !== "lq") return;
  };
  let lqTimer;
  window.listQ_ = v => { listQ = v; clearTimeout(lqTimer); lqTimer = setTimeout(() => { renderListings(); const el = $("lq"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 250); };
  window.listStatus_ = async v => { listStatus = v; selected.clear(); cache.listings = await api("/api/admin/listings" + (v ? "?status=" + v : "")); renderListings(); };
  window.selOne = (id, on) => { on ? selected.add(id) : selected.delete(id); $("selN").textContent = selected.size; $("bulkbar").classList.toggle("on", selected.size > 0); };
  window.selAll = on => { const q = listQ.toLowerCase(); (cache.listings || []).filter(x => !q || `${x.title} ${x.ownerName} ${x.area} ${x.county} #${x.id}`.toLowerCase().includes(q)).slice(0, 400).forEach(x => on ? selected.add(x.id) : selected.delete(x.id)); renderListings(); };
  window.selected = selected;
  window.bulk = async (action, ids) => {
    ids = ids || [...selected];
    if (!ids.length) return;
    let days = 7, reason = "";
    if (action === "feature") { const d = prompt("Feature for how many days?", "7"); if (d === null) return; days = +d || 7; }
    if (action === "remove" || action === "pause") { reason = prompt(`${action === "remove" ? "Remove" : "Pause"} ${ids.length} listing(s). Reason (sent to the owners):`, ""); if (reason === null) return; }
    try { const r = await api("/api/admin/listings/bulk", { method: "POST", body: JSON.stringify({ ids, action, days, reason }) }); toast(`${r.changed} listing(s) updated`); selected.clear(); await refresh(); }
    catch (e) { toast(e.message); }
  };
  window.removeListing = id => bulk("remove", [id]);
  window.featureListing = async (id, on) => {
    let days = 0;
    if (!on) { const d = prompt("Feature this listing for how many days?", "7"); if (d === null) return; days = +d || 7; }
    try { await api(`/api/admin/listings/${id}/feature`, { method: "POST", body: JSON.stringify({ days }) }); toast(days ? `Featured for ${days} days ⭐` : "No longer featured"); await refresh(); }
    catch (e) { toast(e.message); }
  };
  const BANNERS = ["Under investigation, do not pay any money", "Owner not yet verified, view before paying", "Reported as already taken", "Price under review"];
  window.editListing = async id => {
    const x = (cache.listings || []).find(y => y.id === id); if (!x) return;
    const ar = await areas();
    openModal(`<h2>Edit listing #${x.id}</h2><div class="muted">${esc(x.ownerName)} · the owner is told when you change the title, price, description or area.</div>
      <label>Category</label>
      <select id="eC" onchange="catFields('${x.category}')">${[["rent", "House / room, for rent"], ["sale", "House, for sale"], ["shortlet", "Airbnb / short stay"], ["land", "Land, sale or lease"], ["commercial", "Commercial property"]]
        .map(([v, l]) => `<option value="${v}"${v === x.category ? " selected" : ""}>${l}</option>`).join("")}</select>
      <div id="eCatBox"></div>
      <label>Title</label><input id="eT" value="${esc(x.title)}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px">
        <div><label>Price (KES)</label><input id="eP" type="number" value="${x.price}"></div>
        <div><label>Area</label><select id="eA">${ar.map(a => `<option value="${a.id}"${a.id === x.areaId ? " selected" : ""}>${esc(a.name)}, ${esc(a.county)}</option>`).join("")}</select></div>
      </div>
      ${["rent", "sale", "shortlet"].includes(x.category) ? `<div id="eBWrap"><label>Bedrooms</label><select id="eB"><option value="">N/A</option>${[0, 1, 2, 3, 4, 5, 6].map(n => `<option value="${n}"${x.bedrooms === n ? " selected" : ""}>${n === 0 ? "Bedsitter" : n}</option>`).join("")}</select></div>` : ""}
      <label>Description</label><textarea id="eD" rows="4">${esc(x.description || "")}</textarea>
      <label>Warning banner on the listing <span class="muted">(shown in red to visitors, leave empty for none)</span></label>
      <input id="eBn" list="bnList" value="${esc(x.adminBanner || "")}" placeholder="e.g. Under investigation, do not pay"><datalist id="bnList">${BANNERS.map(b => `<option value="${esc(b)}">`).join("")}</datalist>
      <label>Note to the owner (optional)</label><input id="eN" placeholder="e.g. Your number was in the title, please use the Contact button">
      <label class="chk"><input type="checkbox" id="eNo" checked> Tell the owner about these changes</label>
      <div class="err" id="eErr"></div>
      <div class="actions"><button class="btn btn-primary" onclick="saveListingEdit(${x.id})">Save changes</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  };
  const opts = (o, sel) => Object.entries(o).map(([k, v]) => `<option value="${k}"${k === sel ? " selected" : ""}>${esc(typeof v === "string" ? v : v.many)}</option>`).join("");
  // extra fields needed when a listing moves category (size for land, type for commercial, bedrooms for houses)
  window.catFields = from => {
    const c = $("eC").value, box = $("eCatBox"), bw = $("eBWrap");
    if (bw) bw.style.display = ["rent", "sale", "shortlet"].includes(c) ? "" : "none";
    if (c === from) { box.innerHTML = ""; return; }
    const L = window.PH_LAND, C = window.PH_COMM;
    box.innerHTML = c === "land" ? `<div class="site-card" style="margin-top:8px"><b>Land details</b>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Deal</label><select id="cxDeal" onchange="cxBasis()"><option value="sale">For sale</option><option value="lease">For lease</option></select></div>
          <div><label>Price is</label><select id="cxBasis"></select></div>
          <div><label>Size</label><input id="cxSize" type="number" step="any" min="0" placeholder="e.g. 2"></div>
          <div><label>Unit</label><select id="cxUnit">${opts(L.UNITS, "acre")}</select></div></div></div>`
      : c === "commercial" ? `<div class="site-card" style="margin-top:8px"><b>Commercial details</b>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div><label>Type</label><select id="cxType">${opts(C.TYPES, "shop")}</select></div>
          <div><label>Deal</label><select id="cxDeal" onchange="cxBasis()"><option value="sale">For sale</option><option value="lease">To let</option></select></div>
          <div><label>Price is</label><select id="cxBasis"></select></div>
          <div><label>Floor area (optional)</label><div style="display:flex;gap:6px"><input id="cxSize" type="number" step="any" min="0"><select id="cxUnit" style="width:auto">${opts(C.UNITS, "sqft")}</select></div></div></div></div>`
      : ["rent", "sale", "shortlet"].includes(c) && !bw ? `<label>Bedrooms</label><select id="eB"><option value="">N/A</option>${[0, 1, 2, 3, 4, 5, 6].map(n => `<option value="${n}">${n === 0 ? "Bedsitter" : n}</option>`).join("")}</select>` : "";
    if (c === "land" || c === "commercial") cxBasis();
  };
  window.cxBasis = () => {
    const c = $("eC").value, B = (c === "land" ? PH_LAND : PH_COMM).BASIS[$("cxDeal").value];
    $("cxBasis").innerHTML = Object.entries(B).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("");
  };
  window.saveListingEdit = async id => {
    const x = (cache.listings || []).find(y => y.id === id), b = {};
    const c = $("eC").value;
    if (c !== x.category) {
      b.category = c;
      if (c === "land") Object.assign(b, { landDeal: $("cxDeal").value, priceBasis: $("cxBasis").value, sizeValue: +$("cxSize").value, sizeUnit: $("cxUnit").value });
      if (c === "commercial") Object.assign(b, { commType: $("cxType").value, deal: $("cxDeal").value, priceBasis: $("cxBasis").value, sizeValue: $("cxSize").value === "" ? "" : +$("cxSize").value, sizeUnit: $("cxUnit").value });
      if (c === "land" && !(b.sizeValue > 0)) { $("eErr").textContent = "Enter the land size"; return; }
    }
    if ($("eT").value.trim() !== x.title) b.title = $("eT").value.trim();
    if (+$("eP").value !== x.price) b.price = +$("eP").value;
    if (+$("eA").value !== x.areaId) b.areaId = +$("eA").value;
    if ($("eB") && ["rent", "sale", "shortlet"].includes(c) && (b.category || $("eB").value !== (x.bedrooms == null ? "" : String(x.bedrooms)))) b.bedrooms = $("eB").value;
    if ($("eD").value !== (x.description || "")) b.description = $("eD").value;
    if ($("eBn").value.trim() !== (x.adminBanner || "")) b.adminBanner = $("eBn").value.trim();
    if (!Object.keys(b).length) return closeModal();
    b.notifyOwner = $("eNo").checked; b.note = $("eN").value.trim();
    try { await api(`/api/admin/listings/${id}`, { method: "PATCH", body: JSON.stringify(b) }); closeModal(); toast("Listing updated"); await refresh(); }
    catch (e) { $("eErr").textContent = e.message; }
  };

  /* ================= people ================= */
  let userQ = "", userFilter = "";
  window.renderUsers = function () {
    const q = userQ.toLowerCase();
    const rows = (cache.users || []).filter(u => (!q || `${u.name} ${u.phone} #${u.id}`.toLowerCase().includes(q)) &&
      (!userFilter || (userFilter === "admins" ? u.role === "admin" : userFilter === "banned" ? u.banned : userFilter === "owners" ? u.listings > 0 : userFilter === "unverified" ? !u.verified : true)));
    $("panel").innerHTML = `<div class="toolbar">
        <input id="uq" placeholder="Search name, phone or #id" value="${esc(userQ)}" oninput="userQ_(this.value)">
        <select onchange="userFilter_(this.value)">${[["", "Everyone"], ["owners", "Owners with listings"], ["unverified", "Not verified"], ["banned", "Suspended / banned"], ["admins", "Team (admins)"]]
          .map(([v, l]) => `<option value="${v}"${userFilter === v ? " selected" : ""}>${l}</option>`).join("")}</select>
        <span class="muted">${rows.length} people</span></div>
      <table><tr><th>Person</th><th>Phone</th><th>Listings</th><th>Status</th><th>Joined</th><th></th></tr>
      ${rows.slice(0, 400).map(u => `<tr>
        <td><b>${esc(u.name)}</b> <span class="muted">#${u.id}</span>${u.role === "admin" ? ` <span class="pill feat">${esc((u.adminRole || "super").toUpperCase())}</span>` : ""}</td>
        <td>${esc(u.phone || "-")}</td><td>${u.listings}</td>
        <td>${u.banned ? `<span class="pill bad">${u.bannedUntil === "forever" ? "banned" : "suspended"}</span>` : u.verified ? '<span class="pill ok">✓ verified</span>' : '<span class="pill warn">unverified</span>'}</td>
        <td class="muted">${when(u.created_at)}</td>
        <td><button class="btn btn-ghost btn-sm" onclick="openUser(${u.id})">Open ›</button></td></tr>`).join("")}</table>`;
  };
  let uqTimer;
  window.userQ_ = v => { userQ = v; clearTimeout(uqTimer); uqTimer = setTimeout(() => { renderUsers(); const el = $("uq"); if (el) { el.focus(); el.setSelectionRange(v.length, v.length); } }, 250); };
  window.userFilter_ = v => { userFilter = v; renderUsers(); };

  window.openUser = async id => {
    openModal('<div class="muted" style="padding:20px">Loading…</div>');
    let d; try { d = await api("/api/admin/users/" + id); } catch (e) { $("mdlBody").innerHTML = `<div class="err">${esc(e.message)}</div>`; return; }
    const u = d.user, sup = hasCap("super"), usr = hasCap("users"), mod = hasCap("moderate");
    const tbl = (head, rows) => rows.length ? `<div class="mini"><table><tr>${head.map(h => `<th>${h}</th>`).join("")}</tr>${rows.join("")}</table></div>` : '<div class="muted">None</div>';
    const liveIds = d.listings.filter(l => ["active", "under_review"].includes(l.status)).map(l => l.id);
    $("mdlBody").innerHTML = `
      <h2>${esc(u.name)} <span class="muted">#${u.id}</span> ${u.adminRole ? `<span class="pill feat">${esc(u.adminRole.toUpperCase())}</span>` : ""}
        ${u.banned ? `<span class="pill bad">${u.bannedUntil === "forever" ? "Banned" : "Suspended until " + when(u.bannedUntil)}</span>` : ""}</h2>
      ${u.banned && u.banReason ? `<div class="muted">Reason: ${esc(u.banReason)}</div>` : ""}
      <div class="kv">
        <div><span>Phone</span>${esc(u.phone || "-")} ${u.phoneVerified ? "✓" : ""}</div><div><span>Email</span>${esc(u.email || "-")} ${u.emailVerified ? "✓" : ""}</div>
        <div><span>WhatsApp</span>${esc(u.whatsapp || "-")}</div><div><span>Location</span>${esc([u.town, u.county].filter(Boolean).join(", ") || "-")}</div>
        <div><span>Owner check</span>${u.verified ? "✓ Verified" : esc(u.verifyStatus)}</div><div><span>Joined</span>${when(u.createdAt)}</div>
      </div>
      <div class="actions">
        ${mod && !u.adminRole ? `<button class="btn btn-ghost btn-sm" onclick="uVerify(${u.id},${u.verified ? 0 : 1})">${u.verified ? "Remove verified badge" : "Mark verified ✓"}</button>` : ""}
        ${usr && !u.adminRole && !u.banned ? `<button class="btn btn-danger btn-sm" onclick="uBan(${u.id},false)">Suspend…</button>` : ""}
        ${sup && !u.adminRole && !u.banned ? `<button class="btn btn-danger btn-sm" onclick="uBan(${u.id},true)">Ban permanently…</button>` : ""}
        ${usr && u.banned ? `<button class="btn btn-primary btn-sm" onclick="uUnban(${u.id})">Lift ${u.bannedUntil === "forever" ? "ban" : "suspension"}</button>` : ""}
        ${usr ? `<button class="btn btn-ghost btn-sm" onclick="uSignout(${u.id})">Sign out all devices (${d.sessions.length})</button>` : ""}
        ${sup && !u.adminRole ? `<button class="btn btn-ghost btn-sm" onclick="uViewAs(${u.id})">👁 View as (read-only)</button>` : ""}
        ${sup ? `<button class="btn btn-ghost btn-sm" onclick="composeTo(${u.id},'${esc(u.name).replace(/'/g, "")}')">✉ Message</button>` : ""}
        ${mod && liveIds.length ? `<button class="btn btn-ghost btn-sm" onclick="bulk('pause',[${liveIds}])">Pause all ${liveIds.length} listings</button>
          <button class="btn btn-danger btn-sm" onclick="bulk('remove',[${liveIds}])">Remove all</button>` : ""}
      </div>
      ${sup ? `<div class="chk" style="font-weight:500">Team role:
        <select id="uRole" style="width:auto" onchange="uRole(${u.id},this.value)">${[["none", "Not on the team"], ["support", "Support"], ["moderator", "Moderator"], ["super", "Super admin"]]
          .map(([v, l]) => `<option value="${v}"${(u.adminRole || "none") === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>` : ""}
      <div class="sec"><h3>Listings (${d.listings.length})</h3>${tbl(["Listing", "Status", "Price", "Leads"], d.listings.map(l =>
        `<tr><td><a href="/browse?open=${l.id}" target="_blank" rel="noopener">${esc(l.title)}</a> <span class="muted">#${l.id} · ${esc(l.area)}</span>${l.featured ? " ⭐" : ""}${l.admin_banner ? ` <span class="pill bad">⚠</span>` : ""}</td><td>${statusPill(l.status)}</td><td>${fmt(l.price)}</td><td>${l.leads + l.inquiries}</td></tr>`))}</div>
      <div class="sec"><h3>Reports &amp; flags</h3>${tbl(["Listing", "What", "When"], [
        ...d.reports.map(r => `<tr><td>#${r.listingId}</td><td><b>${esc(r.reason)}</b> ${r.details ? ", " + esc(r.details) : ""} <span class="muted">(${esc(r.status)})</span></td><td>${when(r.at)}</td></tr>`),
        ...d.flags.map(f => `<tr><td>#${f.listingId}</td><td><span class="pill feat">${esc(f.kind)}</span> ${esc(f.detail)}${f.resolved ? ' <span class="muted">(resolved)</span>' : ""}</td><td>${when(f.at)}</td></tr>`)])}</div>
      <div class="sec"><h3>Messages from tenants (${d.inquiries.length})</h3>${tbl(["From", "Message", "Replied", "When"], d.inquiries.map(i =>
        `<tr><td>${esc(i.fromName)}<div class="muted">${esc(i.fromPhone || "")}</div></td><td>${esc(String(i.message).slice(0, 160))}${i.messages ? ` <span class="muted">(+${i.messages} in thread)</span>` : ""}</td><td>${i.reply ? "✓" : "-"}</td><td>${when(i.at)}</td></tr>`))}</div>
      <div class="sec"><h3>Viewings (${d.viewings.length})</h3>${tbl(["Listing", "Visitor", "Slot", "Status"], d.viewings.map(v =>
        `<tr><td>#${v.listingId}</td><td>${esc(v.name)}</td><td>${when(v.slotAt)}</td><td>${esc(v.status)}</td></tr>`))}</div>
      <div class="sec"><h3>Signed-in devices</h3>${tbl(["Device", "IP", "Started", "Last active"], d.sessions.map(s =>
        `<tr><td>${esc(s.device.slice(0, 70) || "-")}${s.viewAs ? ' <span class="pill warn">admin view-as</span>' : ""}</td><td>${esc(s.ip || "-")}</td><td>${when(s.started)}</td><td>${when(s.lastSeen)}</td></tr>`))}</div>
      <div class="sec"><h3>Admin history</h3>${tbl(["When", "Admin", "Action", "Detail"], d.history.map(h =>
        `<tr><td>${when(h.at)}</td><td>${esc(h.admin || "system")}</td><td>${esc(h.action)}</td><td class="muted">${esc(String(h.detail || "").slice(0, 140))}</td></tr>`))}</div>`;
  };
  const reopen = async id => { await refresh().catch(() => {}); openUser(id); };
  window.uVerify = async (id, v) => { try { await api("/api/admin/users/" + id, { method: "PATCH", body: JSON.stringify({ verified: v }) }); toast(v ? "Marked verified ✓" : "Badge removed"); reopen(id); } catch (e) { toast(e.message); } };
  window.uBan = async (id, forever) => {
    openModal(`<h2>${forever ? "Ban permanently" : "Suspend account"}</h2>
      <div class="muted">Their listings are hidden straight away and they're signed out everywhere. ${forever ? "Only you can lift a permanent ban." : "Everything comes back automatically when the suspension ends."}</div>
      ${forever ? "" : `<label>For how long?</label><select id="bDays">${[[1, "1 day"], [3, "3 days"], [7, "1 week"], [14, "2 weeks"], [30, "30 days"], [90, "90 days"]].map(([v, l]) => `<option value="${v}"${v === 7 ? " selected" : ""}>${l}</option>`).join("")}</select>`}
      <label>Reason (the user sees this)</label><input id="bReason" placeholder="e.g. Asked tenants for viewing fees">
      <label class="chk"><input type="checkbox" id="bBlock" ${forever ? "checked" : ""}> Also block their phone, email and WhatsApp from signing up again</label>
      <div class="err" id="bErr"></div>
      <div class="actions"><button class="btn btn-danger" onclick="doBan(${id},${forever})">${forever ? "Ban permanently" : "Suspend"}</button><button class="btn btn-ghost" onclick="openUser(${id})">Back</button></div>`);
  };
  window.doBan = async (id, forever) => {
    try {
      const r = await api(`/api/admin/users/${id}/ban`, { method: "POST", body: JSON.stringify({ forever, days: forever ? 0 : +$("bDays").value, reason: $("bReason").value.trim(), blockIdentifiers: $("bBlock").checked }) });
      toast(`${forever ? "Banned" : "Suspended"}: ${r.listingsHidden} listing(s) hidden`); reopen(id);
    } catch (e) { $("bErr").textContent = e.message; }
  };
  window.uUnban = async id => { if (!confirm("Lift this suspension/ban? Their listings go live again.")) return; try { const r = await api(`/api/admin/users/${id}/unban`, { method: "POST" }); toast(`Account active: ${r.listingsShown} listing(s) back`); reopen(id); } catch (e) { toast(e.message); } };
  window.uSignout = async id => { if (!confirm("Sign this person out on every device?")) return; try { const r = await api(`/api/admin/users/${id}/signout`, { method: "POST" }); toast(`Signed out of ${r.signedOut} device(s)`); reopen(id); } catch (e) { toast(e.message); } };
  window.uViewAs = async id => {
    if (!confirm("Open this person's dashboard in read-only mode for 30 minutes? This is recorded in the audit log.")) return;
    try { const r = await api(`/api/admin/users/${id}/view-as`, { method: "POST" }); window.open("/dashboard#viewas=" + encodeURIComponent(r.token), "_blank", "noopener"); }
    catch (e) { toast(e.message); }
  };
  window.uRole = async (id, role) => {
    const label = { none: "remove them from the team", support: "make them Support", moderator: "make them a Moderator", super: "make them a Super admin (full control)" }[role];
    if (!confirm(`Are you sure you want to ${label}? They'll be signed out and must log in again.`)) return openUser(id);
    try { await api(`/api/admin/users/${id}/role`, { method: "POST", body: JSON.stringify({ role }) }); toast("Role updated"); reopen(id); } catch (e) { toast(e.message); openUser(id); }
  };

  /* ================= loaders for the extra tabs ================= */
  window.NEW_LOADERS = {
    /* ---------- growth ---------- */
    async growth() {
      const g = await api("/api/admin/growth");
      const sum = k => g.weeks.slice(-4).reduce((s, w) => s + w[k], 0), prev = k => g.weeks.slice(-8, -4).reduce((s, w) => s + w[k], 0);
      const trend = k => { const a = sum(k), b = prev(k); const p = b ? Math.round((a - b) / b * 100) : (a ? 100 : 0); return `<span class="trend ${p > 0 ? "up" : p < 0 ? "down" : "flat"}">${p > 0 ? "▲" : p < 0 ? "▼" : "-"} ${Math.abs(p)}%</span>`; };
      $("panel").innerHTML = `<div style="padding:14px">
        <div class="stats">${[["users", "New people"], ["owners", "New owners"], ["listings", "New listings"], ["leads", "Leads & messages"], ["viewings", "Viewings booked"]]
          .map(([k, l]) => `<div class="stat"><div class="num">${sum(k)}${trend(k)}</div><div class="lbl">${l} · last 4 weeks</div></div>`).join("")}
          <div class="stat rev"><div class="num">${fmt(sum("revenue"))}</div><div class="lbl">Revenue · last 4 weeks</div></div></div>
        <div class="chart-card" style="margin-bottom:14px"><h3>Weekly growth<small>last 12 weeks</small></h3><div class="chart-wrap"><canvas id="gChart"></canvas></div></div>
        <div class="tr-grid">
          <div class="tr-card"><h4>Counties, new listings (30 days)</h4>${g.counties.map(c => `<div class="tr-row"><span>${esc(c.county)} <span class="muted">${c.active} live · ${c.leads30} leads</span></span><b>${c.now30}${c.prev30 !== c.now30 ? ` <span class="muted">(${c.now30 >= c.prev30 ? "+" : ""}${c.now30 - c.prev30})</span>` : ""}</b></div>`).join("") || '<div class="muted">No data yet</div>'}</div>
          <div class="tr-card"><h4>Top owners, leads (30 days)</h4>${g.topOwners.map(o => `<div class="tr-row"><a href="#" onclick="openUser(${o.id});return false">${esc(o.name)}${o.verified ? " ✓" : ""}</a><b>${o.leads30} <span class="muted">· ${o.listings} live</span></b></div>`).join("") || '<div class="muted">No data yet</div>'}</div>
          ${hasCap("super") ? `<div class="tr-card"><h4>Export (CSV for Excel)</h4><div class="muted" style="margin-bottom:8px">Every export is recorded in the audit log.</div>
            <div class="actions"><button class="btn btn-ghost btn-sm" onclick="exportCsv('users')">People</button><button class="btn btn-ghost btn-sm" onclick="exportCsv('listings')">Listings</button><button class="btn btn-ghost btn-sm" onclick="exportCsv('leads')">Leads</button></div></div>` : ""}
        </div></div>`;
      if (typeof Chart !== "undefined") new Chart($("gChart"), { type: "bar", data: { labels: g.weeks.map(w => w.week.slice(5).replace("-", "/")),
        datasets: [{ label: "New listings", data: g.weeks.map(w => w.listings), backgroundColor: "#0e8a68" }, { label: "Leads", data: g.weeks.map(w => w.leads), backgroundColor: "#c9a35c" }, { label: "New people", data: g.weeks.map(w => w.users), backgroundColor: "#3d4b56" }] },
        options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "top", align: "end", labels: { boxWidth: 10 } } }, scales: { x: { grid: { display: false } }, y: { beginAtZero: true, ticks: { precision: 0 } } } } });
    },
    /* ---------- site ---------- */
    async site() {
      const sup = hasCap("super");
      const [st, bl, ar, team] = await Promise.all([sup ? api("/api/admin/settings") : null, api("/api/admin/blocklist"), api("/api/admin/areas"), api("/api/admin/team")]);
      const on = k => st && st[k] === "1" ? "checked" : "";
      $("panel").innerHTML = `<div class="site-grid">
        ${sup ? `<div class="site-card"><h3>📣 Announcement bar</h3><div class="muted">Shown at the top of every page until visitors close it.</div>
          <label class="chk"><input type="checkbox" id="s_announce_on" ${on("announce_on")}> Show it</label>
          <label>Message</label><input id="s_announce_text" maxlength="240" value="${esc(st.announce_text)}" placeholder="We never ask for payment by M-Pesa before a viewing.">
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label>Style</label><select id="s_announce_level">${[["info", "Navy (info)"], ["warn", "Gold (warning)"], ["success", "Green (good news)"]].map(([v, l]) => `<option value="${v}"${st.announce_level === v ? " selected" : ""}>${l}</option>`).join("")}</select></div>
          <div><label>Link (optional)</label><input id="s_announce_link" value="${esc(st.announce_link)}" placeholder="/terms"></div></div>
          <div class="actions"><button class="btn btn-primary btn-sm" onclick="saveSettings(['announce_on','announce_text','announce_level','announce_link'])">Save</button></div></div>
        <div class="site-card"><h3>🛠 Maintenance</h3><div class="muted">Pause things during an incident. Browsing keeps working.</div>
          <label class="chk"><input type="checkbox" id="s_pause_listings" ${on("pause_listings")}> Pause new listings</label>
          <label class="chk"><input type="checkbox" id="s_pause_signups" ${on("pause_signups")}> Pause new sign-ups</label>
          <label>Message people see</label><input id="s_maintenance_message" maxlength="240" value="${esc(st.maintenance_message)}">
          <div class="actions"><button class="btn btn-primary btn-sm" onclick="saveSettings(['pause_listings','pause_signups','maintenance_message'])">Save</button></div></div>
        <div class="site-card"><h3>⚙️ Settings</h3>
          <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
            <div><label>Listing stays live (days)</label><input id="s_listing_ttl_days" type="number" min="7" max="365" value="${esc(st.listing_ttl_days)}"></div>
            <div><label>Max photos per listing</label><input id="s_max_photos" type="number" min="1" max="20" value="${esc(st.max_photos)}"></div>
            <div><label>Sign out after idle (hours)</label><input id="s_session_idle_hours" type="number" step="0.25" min="0.25" max="72" value="${esc(st.session_idle_hours)}"></div>
            <div><label>Longest login (days)</label><input id="s_session_max_days" type="number" min="1" max="90" value="${esc(st.session_max_days)}"></div>
          </div>
          <label class="chk"><input type="checkbox" id="s_alerts_enabled" ${on("alerts_enabled")}> Send new-listing alerts to saved searches</label>
          <label class="chk"><input type="checkbox" id="s_sms_enabled" ${on("sms_enabled")}> Send SMS (codes, alerts, reminders)</label>
          <div class="muted">Admins are always signed out after 30 minutes idle.</div>
          <div class="actions"><button class="btn btn-primary btn-sm" onclick="saveSettings(['listing_ttl_days','max_photos','session_idle_hours','session_max_days','alerts_enabled','sms_enabled'])">Save</button></div></div>` : ""}
        <div class="site-card"><h3>🚫 Blocked words &amp; numbers</h3><div class="muted">Listings containing these are held for review automatically, e.g. “pay viewing fee”, or a scammer's M-Pesa number.</div>
          <div style="display:flex;gap:8px"><input id="blTerm" placeholder="word, phrase or phone number" onkeydown="if(event.key==='Enter')addBlock()"><button class="btn btn-primary btn-sm" onclick="addBlock()">Add</button></div>
          <div class="mini" style="margin-top:10px">${bl.length ? `<table>${bl.map(b => `<tr><td><b>${esc(b.term)}</b><div class="muted">${esc(b.addedBy || "")} · ${when(b.at)}</div></td><td style="text-align:right"><button class="btn btn-danger btn-sm" onclick="delBlock(${b.id})">Remove</button></td></tr>`).join("")}</table>` : '<div class="muted" style="padding:10px">Nothing blocked yet.</div>'}</div></div>
        <div class="site-card"><h3>👥 Team</h3><div class="muted">Change roles from a person's page (People → Open). Admins log in with a code every time.</div>
          <div class="mini">${`<table>${team.map(t => `<tr><td><a href="#" onclick="openUser(${t.id});return false">${esc(t.name)}</a><div class="muted">${esc(t.email || "")}</div></td><td><span class="pill feat">${esc(t.roleLabel)}</span></td><td class="muted">${t.lastLogin ? "last in " + when(t.lastLogin) : "never"}</td></tr>`).join("")}</table>`}</div></div>
      </div>
      <div style="padding:0 14px 14px"><div class="site-card"><h3>📍 Areas (${ar.length})</h3><div class="muted">Add towns and estates, fix map positions, merge duplicates.</div>
        ${sup ? `<div style="display:grid;grid-template-columns:2fr 1.3fr 1fr 1fr auto;gap:8px;margin:8px 0"><input id="nName" placeholder="Name e.g. Kahawa Sukari"><input id="nCounty" placeholder="County" list="countyList"><input id="nLat" placeholder="lat e.g. -1.19"><input id="nLng" placeholder="lng e.g. 36.93"><button class="btn btn-primary btn-sm" onclick="addArea()">Add</button></div>
          <datalist id="countyList">${[...new Set(ar.map(a => a.county))].map(c => `<option value="${esc(c)}">`).join("")}</datalist>` : ""}
        <div class="mini" style="max-height:420px"><table><tr><th>Area</th><th>County</th><th>Map</th><th>Listings</th><th></th></tr>${ar.map(a => `<tr><td><b>${esc(a.name)}</b></td><td>${esc(a.county)}</td>
          <td class="muted"><a href="https://www.openstreetmap.org/?mlat=${a.lat}&mlon=${a.lng}#map=15/${a.lat}/${a.lng}" target="_blank" rel="noopener">${(+a.lat).toFixed(4)}, ${(+a.lng).toFixed(4)} ↗</a></td>
          <td>${a.active} live / ${a.listings}</td><td style="white-space:nowrap">${sup ? `<button class="btn btn-ghost btn-sm" onclick="editArea(${a.id})">Edit</button> <button class="btn btn-ghost btn-sm" onclick="mergeArea(${a.id})">Merge…</button>` : ""}</td></tr>`).join("")}</table></div></div></div>`;
      window._areas = ar;
    },
    /* ---------- audit ---------- */
    async audit(before) {
      const rows = await api("/api/admin/audit?limit=200" + (auditAction ? "&action=" + encodeURIComponent(auditAction) : "") + (before ? "&before=" + before : ""));
      const html = rows.map(r => `<tr><td class="muted" style="white-space:nowrap">${when(r.at)}</td><td>${esc(r.admin_name || "system")}</td><td><b>${esc(r.action)}</b></td>
        <td>${r.target_type === "user" ? `<a href="#" onclick="openUser(${+r.target_id});return false">user #${esc(r.target_id)}</a>` : r.target_type ? esc(r.target_type + (r.target_id ? " #" + String(r.target_id).slice(0, 40) : "")) : ""}</td>
        <td class="muted" style="white-space:normal;max-width:360px">${esc(String(r.detail || "").slice(0, 300))}</td><td class="muted">${esc(r.ip || "")}</td></tr>`).join("");
      if (before) { document.querySelector("#auditTbl tbody").insertAdjacentHTML("beforeend", html); }
      else $("panel").innerHTML = `<div class="toolbar"><select onchange="auditFilter(this.value)">${["", "login", "alert", "ban", "suspend", "unban", "force_signout", "view_as", "set_role", "edit_listing", "feature", "bulk_remove", "bulk_pause", "delete_listing", "moderation_remove", "settings", "export", "broadcast", "blocklist_add", "area_add", "area_merge", "backup_download"]
          .map(a => `<option value="${a}"${auditAction === a ? " selected" : ""}>${a || "All actions"}</option>`).join("")}</select>
          <span class="muted">Every admin action is recorded here and can't be edited or deleted.</span></div>
        <table id="auditTbl"><thead><tr><th>When (UTC)</th><th>Admin</th><th>Action</th><th>On</th><th>Detail</th><th>IP</th></tr></thead><tbody>${html || '<tr><td colspan="6" class="muted">Nothing yet</td></tr>'}</tbody></table>`;
      const more = $("auditMore"); if (more) more.remove();
      if (rows.length === 200) $("panel").insertAdjacentHTML("beforeend", `<div id="auditMore" style="padding:12px;text-align:center"><button class="btn btn-ghost btn-sm" onclick="NEW_LOADERS.audit(${rows[rows.length - 1].id})">Load older</button></div>`);
    },
    /* ---------- message users ---------- */
    async message() {
      const ar = await areas();
      const counties = [...new Set(ar.map(a => a.county))].sort();
      $("panel").innerHTML = `<div style="padding:16px;max-width:680px">
        <h3 style="margin-bottom:4px">Message people</h3><div class="muted">Everyone gets it in their PataHome notifications; tick email or SMS to also send it there. Suspended accounts are skipped.</div>
        <label>Who</label><select id="mAud" onchange="$('mUserWrap').style.display=this.value==='user'?'':'none'">
          <option value="owners">Owners with live listings</option><option value="all">Everyone</option><option value="user"${composeTarget ? " selected" : ""}>One person</option></select>
        <div id="mUserWrap" style="display:${composeTarget ? "" : "none"}"><label>Person (id)</label><input id="mUser" type="number" value="${composeTarget ? composeTarget.id : ""}" placeholder="User #id, find it under People">${composeTarget ? `<div class="muted">${esc(composeTarget.name)}</div>` : ""}</div>
        <label>County (optional)</label><select id="mCounty"><option value="">All counties</option>${counties.map(c => `<option>${esc(c)}</option>`).join("")}</select>
        <label>Send by</label><div class="actions" style="margin:4px 0"><label class="chk"><input type="checkbox" id="mN" checked disabled> In-app</label><label class="chk"><input type="checkbox" id="mE"> Email</label><label class="chk"><input type="checkbox" id="mS"> SMS <span class="muted">(costs credit)</span></label></div>
        <label>Title</label><input id="mTitle" maxlength="100" placeholder="e.g. New: list land and commercial property">
        <label>Message</label><textarea id="mBody" rows="5" maxlength="1000" placeholder="Keep it short and useful."></textarea>
        <div class="err" id="mErr"></div><div class="muted" id="mReach"></div>
        <div class="actions"><button class="btn btn-ghost" onclick="sendBroadcast(true)">Check who it reaches</button><button class="btn btn-primary" onclick="sendBroadcast(false)">Send</button></div></div>`;
      composeTarget = null;
    }
  };
  let auditAction = "", composeTarget = null;
  window.auditFilter = v => { auditAction = v; NEW_LOADERS.audit(); };
  window.exportCsv = async kind => {
    const r = await fetch("/api/admin/export?kind=" + kind, { headers: { Authorization: "Bearer " + token } });
    if (!r.ok) { const d = await r.json().catch(() => ({})); return toast(d.error || "Export failed"); }
    const blob = await r.blob(), a = document.createElement("a");
    a.href = URL.createObjectURL(blob); a.download = (r.headers.get("content-disposition") || "").match(/filename="([^"]+)"/)?.[1] || `patahome-${kind}.csv`; a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  };
  window.saveSettings = async keys => {
    const b = {};
    for (const k of keys) { const el = $("s_" + k); b[k] = el.type === "checkbox" ? (el.checked ? "1" : "0") : el.value; }
    try { await api("/api/admin/settings", { method: "PATCH", body: JSON.stringify(b) }); toast("Saved"); } catch (e) { toast(e.message); }
  };
  window.addBlock = async () => { const term = $("blTerm").value.trim(); if (!term) return; try { const r = await api("/api/admin/blocklist", { method: "POST", body: JSON.stringify({ term }) }); toast(r.held ? `Added: ${r.held} live listing(s) held for review` : "Added"); NEW_LOADERS.site(); } catch (e) { toast(e.message); } };
  window.delBlock = async id => { try { await api("/api/admin/blocklist/" + id, { method: "DELETE" }); toast("Removed"); NEW_LOADERS.site(); } catch (e) { toast(e.message); } };
  window.addArea = async () => {
    try { await api("/api/admin/areas", { method: "POST", body: JSON.stringify({ name: $("nName").value, county: $("nCounty").value, lat: $("nLat").value, lng: $("nLng").value }) }); AREAS = null; toast("Area added"); NEW_LOADERS.site(); }
    catch (e) { toast(e.message); }
  };
  window.editArea = id => {
    const a = window._areas.find(x => x.id === id);
    openModal(`<h2>Edit area</h2><label>Name</label><input id="xaN" value="${esc(a.name)}"><label>County</label><input id="xaC" value="${esc(a.county)}">
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px"><div><label>Latitude</label><input id="xaLat" value="${a.lat}"></div><div><label>Longitude</label><input id="xaLng" value="${a.lng}"></div></div>
      <div class="muted" style="margin-top:6px">Tip: in Google Maps, long-press the spot and copy the numbers.</div><div class="err" id="xaErr"></div>
      <div class="actions"><button class="btn btn-primary" onclick="saveArea(${id})">Save</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  };
  window.saveArea = async id => {
    try { await api("/api/admin/areas/" + id, { method: "PATCH", body: JSON.stringify({ name: $("xaN").value, county: $("xaC").value, lat: $("xaLat").value, lng: $("xaLng").value }) }); AREAS = null; closeModal(); toast("Area updated"); NEW_LOADERS.site(); }
    catch (e) { $("xaErr").textContent = e.message; }
  };
  window.mergeArea = id => {
    const a = window._areas.find(x => x.id === id);
    openModal(`<h2>Merge “${esc(a.name)}”</h2><div class="muted">Its ${a.listings} listing(s) move to the area you pick, then “${esc(a.name)}” is deleted. This can't be undone.</div>
      <label>Merge into</label><select id="mgInto">${window._areas.filter(x => x.id !== id).map(x => `<option value="${x.id}"${x.county === a.county ? "" : ""}>${esc(x.name)}: ${esc(x.county)}</option>`).join("")}</select>
      <div class="actions"><button class="btn btn-danger" onclick="doMerge(${id})">Merge</button><button class="btn btn-ghost" onclick="closeModal()">Cancel</button></div>`);
  };
  window.doMerge = async id => {
    try { const r = await api(`/api/admin/areas/${id}/merge`, { method: "POST", body: JSON.stringify({ into: +$("mgInto").value }) }); AREAS = null; closeModal(); toast(`Merged: ${r.moved} listing(s) moved`); NEW_LOADERS.site(); }
    catch (e) { toast(e.message); }
  };
  window.composeTo = (id, name) => { closeModal(); composeTarget = { id, name }; setTab("message"); };
  window.sendBroadcast = async dryRun => {
    $("mErr").textContent = "";
    const aud = $("mAud").value;
    const body = { audience: aud === "user" ? { type: "user", id: +$("mUser").value } : { type: aud, county: $("mCounty").value || undefined },
      channels: ["notification", ...($("mE").checked ? ["email"] : []), ...($("mS").checked ? ["sms"] : [])], title: $("mTitle").value.trim(), body: $("mBody").value.trim(), dryRun };
    try {
      if (!dryRun) {
        const chk = await api("/api/admin/broadcast", { method: "POST", body: JSON.stringify({ ...body, dryRun: true }) });
        if (!confirm(`Send to ${chk.reach.total} ${chk.reach.total === 1 ? "person" : "people"}?${chk.reach.email ? `\n• ${chk.reach.email} by email` : ""}${chk.reach.sms ? `\n• ${chk.reach.sms} by SMS` : ""}`)) return;
      }
      const r = await api("/api/admin/broadcast", { method: "POST", body: JSON.stringify(body) });
      $("mReach").textContent = `${dryRun ? "Would reach" : "Sent to"} ${r.reach.total} · in-app ${r.reach.notification} · email ${r.reach.email} · SMS ${r.reach.sms}`;
      if (!dryRun) toast("Message sent");
    } catch (e) { $("mErr").textContent = e.message; }
  };
})();
