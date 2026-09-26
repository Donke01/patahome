/* PataHome end-to-end tests — run with:  npm test
   Starts the real server on a random port with a throwaway database, and
   replaces outside services (email, Cloudinary, OpenStreetMap) with local
   fakes so nothing real is sent. Uses only Node's built-in test runner. */
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patahome-test-"));
Object.assign(process.env, {
  NODE_ENV: "test", DB_PATH: path.join(tmp, "test.db"), JWT_SECRET: "test-secret",
  ADMIN_PHONE: "0700000001", ADMIN_PASSWORD: "adminpass123", SEED_DEMO: "0",
  RESEND_API_KEY: "test", MAIL_FROM: "info@patahome.co.ke",
  CLOUDINARY_CLOUD_NAME: "c", CLOUDINARY_API_KEY: "k", CLOUDINARY_API_SECRET: "s",
  BASE_URL: "http://localhost", BACKUP_DIR: path.join(tmp, "backups")
});

/* ---- fakes for outside services ---- */
const mails = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (u.includes("api.resend.com")) { const b = JSON.parse(opts.body); mails.push({ to: b.to[0], subject: b.subject, text: b.text }); return new Response('{"id":"x"}', { status: 200 }); }
  if (u.includes("overpass-api")) return new Response(JSON.stringify({ elements: [{ lat: -1.2051, lon: 36.7771, tags: { highway: "bus_stop", name: "Stage" } }] }), { status: 200 });
  if (u.includes("api.cloudinary.com")) {
    if (u.includes("/resources/image/upload/")) { const id = decodeURIComponent(u.split("/resources/image/upload/")[1]); return new Response(JSON.stringify({ etag: id.includes("dup") ? "SAME" : "E_" + id }), { status: 200 }); }
    return new Response(JSON.stringify({ public_id: "patahome/backups/x" }), { status: 200 });
  }
  return realFetch(url, opts);
};

let server, base;
const lastCode = (to) => { const m = [...mails].reverse().find(x => !to || x.to === to); return m && (m.subject.match(/\b(\d{6})\b/) || [])[1]; };
async function call(method, p, body, token, headers = {}) {
  const r = await fetch(base + p, { method, redirect: "manual",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: "Bearer " + token } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined });
  const text = await r.text(); let d; try { d = JSON.parse(text); } catch { d = { html: text }; }
  return { status: r.status, body: d, location: r.headers.get("location") };
}
let db;
const areaId = (name) => db.prepare("SELECT id FROM areas WHERE name=?").get(name).id;
async function owner(identifier, name = "Owner") {
  const r = await call("POST", "/api/auth/register", { name, identifier, password: "password123" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  if (identifier.includes("@")) db.prepare("UPDATE users SET email_verified=1 WHERE email=?").run(identifier);
  return r.body.token;
}

before(async () => {
  execFileSync(process.execPath, [path.join(__dirname, "..", "seed.js")], { env: process.env, stdio: "ignore" });
  server = require("../server.js");
  db = require("../db.js");
  await new Promise(res => server.listen(0, res));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test("health + public config", async () => {
  assert.equal((await call("GET", "/api/health")).status, 200);
  const c = await call("GET", "/api/config");
  assert.equal(typeof c.body.sessionIdleMinutes, "number");
});

test("sign-up, login, sessions and logout", async () => {
  const t = await owner("s1@example.com");
  assert.equal((await call("GET", "/api/auth/me", null, t)).status, 200);
  const l = await call("POST", "/api/auth/login", { email: "s1@example.com", password: "password123" });
  assert.equal(l.status, 200);
  await call("POST", "/api/auth/logout", null, l.body.token);
  const after = await call("GET", "/api/auth/me", null, l.body.token);
  assert.equal(after.status, 401);
  assert.equal(after.body.code, "SESSION_EXPIRED");
  assert.equal((await call("POST", "/api/auth/login", { email: "s1@example.com", password: "wrong" })).status, 401);
});

test("idle sessions expire", async () => {
  const t = await owner("idle@example.com");
  db.prepare("UPDATE sessions SET last_seen=? WHERE user_id=(SELECT id FROM users WHERE email='idle@example.com')").run(Date.now() - 5 * 3600e3);
  const r = await call("GET", "/api/auth/me", null, t);
  assert.equal(r.status, 401);
  assert.match(r.body.error, /inactivity/);
});

test("changing phone needs an emailed security code", async () => {
  const t = await owner("sec@example.com");
  assert.equal((await call("POST", "/api/account/change-phone", { phone: "0712000001" }, t)).status, 200); // first phone: no code
  const ask = await call("POST", "/api/account/change-phone", { phone: "0712000002" }, t);
  assert.equal(ask.status, 403);
  assert.equal(ask.body.stepUp.channel, "email");
  assert.equal((await call("POST", "/api/account/change-phone", { phone: "0712000002", securityCode: "000000" }, t)).status, 400);
  const ok = await call("POST", "/api/account/change-phone", { phone: "0712000002", securityCode: lastCode("sec@example.com") }, t);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.phone, "0712000002");
});

test("listings: create, search, paging, direct-owner filter", async () => {
  const t = await owner("lister@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000010" }, t);
  const bad = await call("POST", "/api/listings", { category: "rent", title: "x", areaId: areaId("Ruaka"), price: 1000, listerRole: "agent" }, t);
  assert.equal(bad.status, 400, "agents must state a fee");
  for (let i = 0; i < 23; i++) {
    const r = await call("POST", "/api/listings", { category: "rent", title: `Test bedsitter ${i}`, areaId: areaId("Ruaka"), price: 5000 + i, bedrooms: 0,
      features: { deposit: "1 month", parking: true, bogus: "x" } }, t);
    assert.equal(r.status, 201);
    if (i === 0) assert.deepEqual(r.body.features, { deposit: "1 month", parking: true });
  }
  const agent = await call("POST", "/api/listings", { category: "rent", title: "Agent flat", areaId: areaId("Ruaka"), price: 20000, bedrooms: 1, listerRole: "agent", agentFee: "KES 5,000" }, t);
  assert.equal(agent.body.listerRole, "agent");
  const p1 = await call("GET", "/api/search?perPage=20");
  assert.equal(p1.body.listings.length, 20);
  assert.equal(p1.body.hasMore, true);
  assert.ok(p1.body.pins.length >= 24);
  const p2 = await call("GET", "/api/search?perPage=20&page=2");
  assert.ok(p2.body.listings.length >= 4);
  const q = await call("GET", "/api/search?q=bedsitter%20under%205010");
  assert.ok(q.body.total >= 1 && q.body.listings.every(l => l.price <= 5010));
  const direct = await call("GET", "/api/search?direct=1&perPage=50");
  assert.ok(!direct.body.listings.some(l => l.listerRole === "agent"));
});

test("listing details: type, bathrooms, move-in terms, amenities, photo labels, ref and similar homes", async () => {
  const t = await owner("details@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000077" }, t);
  const r = await call("POST", "/api/listings", { category: "rent", title: "Nice 2br", areaId: areaId("Ruaka"), price: 25000, bedrooms: 2,
    description: "Bright two bedroom apartment with water all day and a quiet compound.",
    features: { propType: "apartment", bathrooms: 2, depositMonths: 2, serviceChargeKes: 1500, water247: true, pool: true, lift: true,
      photoLabels: { "patahome/listings/abc123": "Kitchen", "bad id!": "Kitchen", "patahome/listings/x9": "Garage" }, propTypeX: "castle", bathroomsBad: 99 } }, t);
  assert.equal(r.status, 201);
  assert.deepEqual(r.body.features, { propType: "apartment", bathrooms: 2, depositMonths: 2, serviceChargeKes: 1500, water247: true, pool: true, lift: true,
    photoLabels: { "patahome/listings/abc123": "Kitchen" } });
  assert.match(r.body.ref, /^PH-\d{4,}$/);
  assert.ok(r.body.confirmedAt);
  const bad = await call("POST", "/api/listings", { category: "rent", title: "Odd", areaId: areaId("Ruaka"), price: 9000, bedrooms: 1,
    features: { propType: "castle", bathrooms: 40, depositMonths: 12 } }, t);
  assert.deepEqual(bad.body.features, {});
  const sim = await call("GET", `/api/listings/${r.body.id}/similar`);
  assert.equal(sim.status, 200);
  assert.ok(sim.body.listings.length >= 1 && sim.body.listings.every(l => l.id !== r.body.id && l.category === "rent"));
});

test("reports pause a listing and admin can restore it", async () => {
  const t = await owner("rep@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000020" }, t);
  const l = (await call("POST", "/api/listings", { category: "rent", title: "Report me", areaId: areaId("Kilimani, Nairobi"), price: 9000, bedrooms: 1 }, t)).body;
  for (const ip of ["1.1.1.1", "2.2.2.2", "3.3.3.3"]) await call("POST", `/api/listings/${l.id}/report`, { reason: "scam" }, null, { "cf-connecting-ip": ip });
  assert.equal(db.prepare("SELECT status FROM listings WHERE id=?").get(l.id).status, "under_review");
  const admin = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const mod = await call("GET", "/api/admin/moderation", null, admin);
  assert.ok(mod.body.some(x => x.id === l.id));
  await call("POST", `/api/admin/moderation/${l.id}`, { action: "clear" }, admin);
  assert.equal(db.prepare("SELECT status FROM listings WHERE id=?").get(l.id).status, "active");
});

test("viewings, message threads and alerts", async () => {
  const t = await owner("host@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000030" }, t);
  const alert = await call("POST", "/api/alerts", { email: "tenant@example.com", criteria: { cat: "rent", q: "nyali" } });
  assert.equal(alert.status, 201);
  const confirm = mails.find(m => m.subject.includes("Confirm your PataHome alert")).text.match(/\/api\/alerts\/\S+\/confirm/)[0];
  assert.equal((await call("GET", confirm)).status, 302);
  const l = (await call("POST", "/api/listings", { category: "rent", title: "Sea view flat Nyali", areaId: areaId("Nyali"), price: 30000, bedrooms: 2 }, t)).body;
  await new Promise(r => setTimeout(r, 300));
  assert.ok(mails.some(m => m.subject.startsWith("New on PataHome") && m.to === "tenant@example.com"), "alert email sent");
  const day = new Date(Date.now() + 2 * 864e5).toLocaleDateString("en-CA", { timeZone: "Africa/Nairobi" });
  const v = await call("POST", `/api/listings/${l.id}/viewings`, { name: "Tenant", phone: "0799000111", email: "tenant@example.com", date: day, time: "10:00" });
  assert.equal(v.status, 201);
  const mine = await call("GET", "/api/my/viewings", null, t);
  assert.equal((await call("POST", `/api/viewings/${mine.body[0].id}/respond`, { action: "confirm" }, t)).body.status, "confirmed");
  const inq = await call("POST", `/api/listings/${l.id}/inquire`, { name: "Tenant", phone: "0799000111", email: "tenant@example.com", message: "Available?" });
  const thread = inq.body.threadToken;
  const iq = (await call("GET", "/api/my/inquiries", null, t)).body[0];
  await call("POST", `/api/inquiries/${iq.id}/reply`, { reply: "Yes" }, t);
  await call("POST", `/api/threads/${thread}`, { body: "Great" });
  const th = await call("GET", `/api/threads/${thread}`);
  assert.deepEqual(th.body.messages.map(m => m.sender), ["tenant", "owner", "tenant"]);
});

test("referral gives both a featured week", async () => {
  const inviter = await owner("inviter@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000040" }, inviter);
  const mine = (await call("POST", "/api/listings", { category: "rent", title: "Inviter home", areaId: areaId("Ruiru"), price: 12000, bedrooms: 1 }, inviter)).body;
  const code = (await call("GET", "/api/my/referral", null, inviter)).body.code;
  const r = await call("POST", "/api/auth/register", { name: "New", identifier: "invitee@example.com", password: "password123", ref: code });
  db.prepare("UPDATE users SET email_verified=1 WHERE email='invitee@example.com'").run();
  await call("POST", "/api/account/change-phone", { phone: "0712000041" }, r.body.token);
  const theirs = (await call("POST", "/api/listings", { category: "rent", title: "Invitee home", areaId: areaId("Ruiru"), price: 11000, bedrooms: 1 }, r.body.token)).body;
  const f = (id) => db.prepare("SELECT featured_until FROM listings WHERE id=?").get(id).featured_until;
  assert.ok(f(theirs.id) > new Date().toISOString(), "invitee featured");
  assert.ok(f(mine.id) > new Date().toISOString(), "inviter featured");
});

test("traffic stats are recorded without cookies", async () => {
  await call("POST", "/api/pv", { path: "/browse", ref: "https://www.google.com/search" }, null, { "user-agent": "Mozilla/5.0 test" });
  await call("POST", "/api/pv", { path: "/" }, null, { "user-agent": "Googlebot/2.1" }); // bots ignored
  await call("GET", "/api/search?q=zzznothing");
  const admin = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const a = await call("GET", "/api/admin/analytics", null, admin);
  assert.ok(a.body.referrers.some(r => r.k === "google.com"));
  assert.ok(a.body.noResults.some(r => r.k === "zzznothing"));
});

test("backups can be made and downloaded", async () => {
  const admin = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const b = await call("POST", "/api/admin/backups", null, admin);
  assert.equal(b.status, 200, JSON.stringify(b.body));
  const r = await fetch(base + "/api/admin/backups/latest", { headers: { Authorization: "Bearer " + admin } });
  assert.equal(r.status, 200);
  const buf = Buffer.from(await r.arrayBuffer());
  const raw = require("node:zlib").gunzipSync(buf);
  assert.equal(raw.subarray(0, 15).toString(), "SQLite format 3");
});

test("SEO pages, share cards, legal pages and app files", async () => {
  assert.equal((await call("GET", "/rentals/ruaka")).status, 200);
  assert.equal((await call("GET", "/rentals/ruaka/bedsitters")).status, 200);
  assert.equal((await call("GET", "/for-sale/ruaka/bedsitters")).status, 404);
  const sm = await call("GET", "/sitemap.xml");
  assert.match(sm.body.html, /rentals\/ruaka\/bedsitters/);
  for (const f of ["/privacy", "/terms", "/manifest.webmanifest", "/sw.js", "/offline.html", "/i18n.js", "/app.js"])
    assert.equal((await call("GET", f)).status, 200, f);
  for (const f of ["/admin", "/browse", "/dashboard"]) assert.match((await call("GET", f)).body.html, /<html/i, f);
  // old .html links redirect to the clean address, keeping the query string
  let rd = await call("GET", "/dashboard.html?notice=hi");
  assert.equal(rd.status, 301); assert.equal(rd.location, "/dashboard?notice=hi");
  rd = await call("GET", "/index.html"); assert.equal(rd.status, 301); assert.equal(rd.location, "/");
  assert.equal((await call("GET", "/browse.html?open=5")).location, "/browse?open=5");
  assert.equal((await call("GET", "/nope.html")).status, 404);
});

test("land: units, price per acre, lease, filters, pages and document checks", async () => {
  const t = (await call("POST", "/api/auth/register", { name: "Farmer", identifier: "0711999000", password: "password123" })).body.token;
  const L = (b) => call("POST", "/api/listings", { category: "land", ...b }, t);
  assert.equal((await L({ title: "No size", areaId: areaId("Kitale Town CBD"), price: 1000000 })).status, 400);

  let r = await L({ title: "4 plots town", areaId: areaId("Kitale Town CBD"), price: 2400000, landDeal: "sale", sizeValue: 4, sizeUnit: "plot_50x100",
    priceBasis: "total", features: { title: "ready", use: "residential", road: "murram", roadKm: 0.5, beacons: true, bogus: 1 }, titleRef: "LR/123" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.ok(Math.abs(r.body.sizeAcres - 0.459) < 0.001);
  assert.equal(Math.round(r.body.pricePerAcre), 5227200);
  assert.equal(r.body.titleRef, undefined, "title number stays private");
  assert.equal(r.body.features.bogus, undefined);
  const saleId = r.body.id;

  r = await L({ title: "20 acres farm for lease", areaId: areaId("Endebess"), price: 12000, landDeal: "lease", sizeValue: 20, sizeUnit: "acre",
    priceBasis: "acre_season", leaseMin: "1 year", pinLat: 1.07, pinLng: 34.84, features: { use: "agricultural", suits: ["crops", "grazing", "x"] } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pricePerAcre, 24000, "2 seasons a year");
  assert.equal(r.body.exactPin, true);
  const leaseId = r.body.id;

  assert.equal((await L({ title: "far pin", areaId: areaId("Endebess"), price: 5, landDeal: "sale", sizeValue: 1, sizeUnit: "acre", pinLat: -1.28, pinLng: 36.8 })).status, 400);
  r = await L({ title: "Five points", areaId: areaId("Endebess"), price: 300000, landDeal: "sale", sizeValue: 5, sizeUnit: "point", priceBasis: "per_acre" });
  assert.equal(r.body.sizeAcres, 0.5, "10 points = 1 acre");

  r = await call("GET", "/api/search?cat=land&landDeal=lease");
  assert.deepEqual(r.body.listings.map(x => x.title), ["20 acres farm for lease"]);
  r = await call("GET", "/api/search?cat=land&minAcres=1");
  assert.ok(r.body.listings.every(x => x.sizeAcres >= 1));
  r = await call("GET", "/api/search?cat=land&titleReady=1");
  assert.deepEqual(r.body.listings.map(x => x.title), ["4 plots town"]);
  r = await call("GET", "/api/search?q=shamba%20lease");
  assert.ok(r.body.listings.some(x => x.title === "20 acres farm for lease"));
  assert.ok(!r.body.listings.some(x => x.title === "4 plots town"));

  r = await call("GET", "/land-for-lease/endebess");
  assert.equal(r.status, 200); assert.match(r.body.html, /20 acres farm/);
  r = await call("GET", "/land-for-sale/kitale-town-cbd");
  assert.equal(r.status, 200); assert.match(r.body.html, /plots \(50×100\)/);
  assert.equal((await call("GET", "/land-for-sale/kitale-town-cbd/bedsitters")).status, 404);
  assert.match((await call("GET", "/listing/" + saleId)).body.html, /Ardhisasa/);

  r = await call("POST", `/api/listings/${saleId}/land-docs`, { titleRef: "LR/123", docs: ["patahome/verify/test-search"] }, t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const admin = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  r = await call("GET", "/api/admin/land-docs", null, admin);
  assert.equal(r.body[0].titleRef, "LR/123");
  await call("POST", `/api/admin/land-docs/${saleId}`, { action: "approve" }, admin);
  assert.equal((await call("GET", "/api/listings/" + saleId)).body.docsChecked, true);

  assert.equal((await call("PATCH", "/api/listings/" + leaseId, { status: "rented" }, t)).status, 200, "lease land can be marked leased");
  assert.match((await call("GET", "/sitemap.xml")).body.html, /land-for-sale\/kitale-town-cbd/);
});

test("commercial: shops, offices and buildings for sale or to let", async () => {
  const t = (await call("POST", "/api/auth/register", { name: "Landlord Biz", identifier: "0711888000", password: "password123" })).body.token;
  const C = (b) => call("POST", "/api/listings", { category: "commercial", areaId: areaId("Westlands, Nairobi"), ...b }, t);
  assert.equal((await C({ title: "No type", price: 50000, deal: "lease" })).status, 400);
  assert.equal((await C({ title: "Per sq ft without area", price: 120, deal: "lease", commType: "office", priceBasis: "sqft_month" })).status, 400);

  let r = await C({ title: "Ground-floor shop on Waiyaki Way", price: 80000, deal: "lease", commType: "shop", sizeValue: 800, sizeUnit: "sqft",
    priceBasis: "month", leaseMin: "2 years", features: { frontage: "main", fit: "shell", parking: true, floors: 1, bogus: "x" } });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.pricePerSqft, 100);
  assert.equal(r.body.leaseMin, "2 years");
  assert.equal(r.body.features.bogus, undefined);
  assert.equal(r.body.bedrooms, null);
  const shopId = r.body.id;

  r = await C({ title: "Office floor 200 m²", price: 110, deal: "lease", commType: "office", sizeValue: 200, sizeUnit: "sqm", priceBasis: "sqft_month" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.areaSqft, 2153);

  r = await C({ title: "Rental block with 24 units", price: 48000000, deal: "sale", commType: "rental_block", incomeMonth: 400000,
    features: { tenancy: "tenanted", units: 24 }, titleRef: "NAIROBI/BLOCK 1/99" });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.incomeMonth, 400000);
  assert.equal(r.body.titleRef, undefined, "title number stays private");
  const blockId = r.body.id;

  r = await call("GET", "/api/search?cat=commercial&deal=lease");
  assert.deepEqual(r.body.listings.map(x => x.title).sort(), ["Ground-floor shop on Waiyaki Way", "Office floor 200 m²"]);
  r = await call("GET", "/api/search?cat=commercial&commType=rental_block");
  assert.deepEqual(r.body.listings.map(x => x.title), ["Rental block with 24 units"]);
  r = await call("GET", "/api/search?cat=commercial&minSqft=1000");
  assert.deepEqual(r.body.listings.map(x => x.title), ["Office floor 200 m²"]);
  r = await call("GET", "/api/search?q=duka%20westlands");
  assert.ok(r.body.listings.some(x => x.title.startsWith("Ground-floor shop")));

  r = await call("GET", "/commercial-to-let/westlands-nairobi");
  assert.equal(r.status, 200); assert.match(r.body.html, /Ground-floor shop/); assert.doesNotMatch(r.body.html, /Rental block/);
  r = await call("GET", "/commercial-for-sale/westlands-nairobi");
  assert.equal(r.status, 200); assert.match(r.body.html, /Rental block/); assert.match(r.body.html, /yield/);
  assert.equal((await call("GET", "/commercial-for-sale/westlands-nairobi/bedsitters")).status, 404);
  assert.match((await call("GET", "/sitemap.xml")).body.html, /commercial-to-let\/westlands-nairobi/);

  // documents check for a building on sale
  assert.equal((await call("POST", `/api/listings/${blockId}/land-docs`, { titleRef: "NAIROBI/BLOCK 1/99", docs: ["patahome/verify/block-search"] }, t)).status, 200);
  const admin = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  r = await call("GET", "/api/admin/land-docs", null, admin);
  assert.ok(r.body.some(x => x.id === blockId && x.category === "commercial"));
  await call("POST", `/api/admin/land-docs/${blockId}`, { action: "approve" }, admin);
  assert.equal((await call("GET", "/api/listings/" + blockId)).body.docsChecked, true);

  // editing re-normalises; a let shop can be marked let
  r = await call("PATCH", "/api/listings/" + shopId, { price: 96000 }, t);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal((await call("GET", "/api/listings/" + shopId)).body.pricePerSqft, 120);
  assert.equal((await call("PATCH", "/api/listings/" + shopId, { status: "rented" }, t)).status, 200);
});

test("admin powers: roles, bans, sign-out, view-as, listing controls, blocklist, settings, audit", async () => {
  const sup = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  assert.equal((await call("GET", "/api/admin/me", null, sup)).body.role, "super");

  // a moderator can moderate but not change site settings
  const modTok = await owner("mod@example.com", "Mo Derator");
  const modId = db.prepare("SELECT id FROM users WHERE email='mod@example.com'").get().id;
  assert.equal((await call("POST", `/api/admin/users/${modId}/role`, { role: "moderator" }, sup)).status, 200);
  assert.equal((await call("GET", "/api/admin/me", null, modTok)).status, 401, "role change signs them out");
  const mod = (await call("POST", "/api/auth/login/verify", { challenge: (await call("POST", "/api/auth/login", { email: "mod@example.com", password: "password123" })).body.twoFactor.challenge, code: lastCode("mod@example.com") })).body.token;
  assert.ok(mod, "moderator logs in with an emailed code");
  assert.equal((await call("GET", "/api/admin/me", null, mod)).body.role, "moderator");
  assert.equal((await call("GET", "/api/admin/settings", null, mod)).status, 403);
  assert.equal((await call("GET", "/api/admin/moderation", null, mod)).status, 200);

  // an owner with a live listing
  const t = await owner("scammer@example.com", "Scam Owner");
  await call("POST", "/api/account/change-phone", { phone: "0712999111" }, t);
  const uid = db.prepare("SELECT id FROM users WHERE email='scammer@example.com'").get().id;
  const l = (await call("POST", "/api/listings", { category: "rent", title: "Cheap bedsitter", areaId: areaId("Ruaka"), price: 3000, bedrooms: 0 }, t)).body;

  // edit, banner, feature
  let r = await call("PATCH", `/api/admin/listings/${l.id}`, { price: 3500, adminBanner: "Under investigation — do not pay" }, mod);
  assert.equal(r.status, 200); assert.equal(r.body.notice, "Under investigation — do not pay"); assert.equal(r.body.price, 3500);
  assert.equal((await call("POST", `/api/admin/listings/${l.id}/feature`, { days: 3 }, mod)).status, 200);
  assert.equal((await call("GET", "/api/listings/" + l.id)).body.featured, true);

  // view as user: can read, can't change anything
  assert.equal((await call("POST", `/api/admin/users/${uid}/view-as`, null, mod)).status, 403, "only the super admin can view as");
  const ro = (await call("POST", `/api/admin/users/${uid}/view-as`, null, sup)).body.token;
  assert.equal((await call("GET", "/api/auth/me", null, ro)).body.id, uid);
  assert.equal((await call("PATCH", "/api/listings/" + l.id, { price: 1 }, ro)).body.code, "READ_ONLY");

  // suspend: listings hidden, can't log in, identifiers blocked; unban restores
  r = await call("POST", `/api/admin/users/${uid}/ban`, { days: 7, reason: "Asked for viewing fees", blockIdentifiers: true }, mod);
  assert.equal(r.status, 200, JSON.stringify(r.body)); assert.equal(r.body.listingsHidden, 1);
  assert.equal((await call("GET", "/api/auth/me", null, t)).status, 401, "signed out everywhere");
  assert.equal((await call("POST", "/api/auth/login", { email: "scammer@example.com", password: "password123" })).body.code, "BANNED");
  assert.equal((await call("POST", "/api/auth/register", { name: "Again", identifier: "0712999111", password: "password123" })).status, 403);
  assert.ok(!(await call("GET", "/api/search?q=cheap%20bedsitter")).body.listings.some(x => x.id === l.id));
  assert.equal((await call("POST", `/api/admin/users/${uid}/ban`, { forever: true, reason: "x" }, mod)).status, 403, "permanent bans are super-only");
  r = await call("POST", `/api/admin/users/${uid}/unban`, null, mod);
  assert.equal(r.body.listingsShown, 1);
  const t2 = (await call("POST", "/api/auth/login", { email: "scammer@example.com", password: "password123" })).body.token;
  assert.ok(t2);
  assert.equal((await call("POST", `/api/admin/users/${uid}/signout`, null, mod)).body.signedOut >= 1, true);
  assert.equal((await call("GET", "/api/auth/me", null, t2)).status, 401);

  // blocklist holds matching listings
  assert.equal((await call("POST", "/api/admin/blocklist", { term: "pay viewing fee" }, mod)).status, 201);
  const t3 = (await call("POST", "/api/auth/login", { email: "scammer@example.com", password: "password123" })).body.token;
  const bad = (await call("POST", "/api/listings", { category: "rent", title: "Nice 1BR", description: "Please pay viewing fee to 0711 222 333 first", areaId: areaId("Ruaka"), price: 9000, bedrooms: 1 }, t3)).body;
  assert.equal((await call("GET", "/api/listings/" + bad.id)).body.status, "under_review", "held for review, not public");
  assert.ok((await call("GET", "/api/admin/moderation", null, mod)).body.some(x => x.id === bad.id && x.flags.some(f => f.kind === "blocked_term")));

  // bulk actions
  r = await call("POST", "/api/admin/listings/bulk", { ids: [l.id, bad.id], action: "remove", reason: "Scam" }, mod);
  assert.equal(r.body.changed, 2);

  // settings: pause new listings + announcement
  assert.equal((await call("PATCH", "/api/admin/settings", { pause_listings: "1", announce_on: "1", announce_text: "We never ask for M-Pesa before viewing" }, sup)).status, 200);
  const cfg = (await call("GET", "/api/config")).body;
  assert.equal(cfg.announcement.text, "We never ask for M-Pesa before viewing"); assert.equal(cfg.pauseListings, true);
  assert.equal((await call("POST", "/api/listings", { category: "rent", title: "x", areaId: areaId("Ruaka"), price: 5000 }, t3)).status, 400);
  await call("PATCH", "/api/admin/settings", { pause_listings: "0", announce_on: "0" }, sup);

  // areas, growth, export, broadcast
  r = await call("POST", "/api/admin/areas", { name: "Kahawa Sukari", county: "Nairobi", lat: -1.19, lng: 36.93 }, sup);
  assert.equal(r.status, 201);
  assert.equal((await call("POST", "/api/admin/areas", { name: "Nowhere", county: "X", lat: 40, lng: 1 }, sup)).status, 400);
  assert.equal((await call("POST", `/api/admin/areas/${r.body.id}/merge`, { into: areaId("Ruaka") }, sup)).status, 200);
  assert.equal((await call("GET", "/api/admin/growth", null, mod)).body.weeks.length, 12);
  assert.equal((await call("GET", "/api/admin/export?kind=users", null, mod)).status, 403);
  const csv = await fetch(base + "/api/admin/export?kind=listings", { headers: { Authorization: "Bearer " + sup } });
  assert.equal(csv.status, 200); assert.match(await csv.text(), /^\ufeff?id,category,title/);
  r = await call("POST", "/api/admin/broadcast", { audience: { type: "user", id: uid }, channels: ["notification"], title: "Hello", body: "Test message", dryRun: true }, sup);
  assert.equal(r.body.reach.total, 1);

  // move a wrongly-categorised listing: "bedsitter" that is really land
  const wrong = (await call("POST", "/api/listings", { category: "rent", title: "Plot near the road", areaId: areaId("Ruaka"), price: 1200000, bedrooms: 0 }, t3)).body;
  assert.equal((await call("PATCH", `/api/admin/listings/${wrong.id}`, { category: "land" }, mod)).status, 400, "land needs a size");
  r = await call("PATCH", `/api/admin/listings/${wrong.id}`, { category: "land", landDeal: "sale", sizeValue: 2, sizeUnit: "acre", priceBasis: "total" }, mod);
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.category, "land"); assert.equal(r.body.bedrooms, null); assert.equal(r.body.sizeAcres, 2); assert.equal(r.body.pricePerAcre, 600000);
  r = await call("PATCH", `/api/admin/listings/${wrong.id}`, { category: "commercial", commType: "plot", deal: "sale" }, mod);
  assert.equal(r.body.category, "commercial"); assert.equal(r.body.commType, "plot"); assert.equal(r.body.sizeAcres, undefined);
  r = await call("PATCH", `/api/admin/listings/${wrong.id}`, { category: "rent", bedrooms: 1, price: 15000 }, mod);
  assert.equal(r.body.category, "rent"); assert.equal(r.body.bedrooms, 1); assert.equal(r.body.price, 15000);

  // the audit log saw it all and can't be rewritten
  const log = (await call("GET", "/api/admin/audit", null, sup)).body.map(x => x.action);
  for (const a of ["set_role", "edit_listing", "feature", "view_as", "suspend", "unban", "force_signout", "blocklist_add", "bulk_remove", "settings", "area_add", "area_merge", "export"])
    assert.ok(log.includes(a), "audit has " + a);
  assert.equal((await call("GET", "/api/admin/audit", null, mod)).status, 403);
  assert.throws(() => db.prepare("DELETE FROM admin_audit").run());
});

test("assisted listings: PataHome lists for an owner, nothing public mentions admin", async () => {
  const sup = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const base = { owner: { name: "Grace Atieno", phone: "0722555444" }, consent: { how: "call", note: "Called on 26 Sep" },
    listing: { category: "rent", areaId: areaId("Ruaka"), title: "Quiet 2BR near the stage", price: 18000, bedrooms: 2 } };
  assert.equal((await call("POST", "/api/admin/assisted", { ...base, consent: {} }, sup)).status, 400, "consent is required");
  assert.equal((await call("POST", "/api/admin/assisted", { ...base, contact: { phone: "12ab" } }, sup)).status, 400);

  let r = await call("POST", "/api/admin/assisted", { ...base, contact: { name: "Mama Wanjiru", phone: "+254 711 000 222" }, relaySms: true }, sup);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.newAccount, true);
  const id = r.body.listing.id;

  // the public sees an ordinary listing
  const pub = await call("GET", "/api/listings/" + id);
  assert.equal(pub.body.ownerName, "Mama Wanjiru");
  assert.doesNotMatch(JSON.stringify(pub.body), /assist|admin|consent|contact_phone|relay/i);
  const page = (await call("GET", "/listing/" + id)).body.html;
  assert.match(page, /Mama Wanjiru/); assert.doesNotMatch(page, /admin|assisted/i);
  const found = (await call("GET", "/api/search?q=quiet%202br")).body.listings.find(x => x.id === id);
  assert.ok(found); assert.doesNotMatch(JSON.stringify(found), /assist|admin/i);

  // visitors reach the chosen number
  const c = await call("POST", `/api/listings/${id}/contact`);
  assert.equal(c.body.ownerPhone, "+254711000222"); assert.equal(c.body.whatsapp, "+254711000222");

  // the owner's account is theirs: a second assisted listing attaches to it
  r = await call("POST", "/api/admin/assisted", { ...base, listing: { ...base.listing, title: "Bedsitter at the back", price: 6000, bedrooms: 0 } }, sup);
  assert.equal(r.body.newAccount, false);
  assert.equal((await call("POST", `/api/listings/${r.body.listing.id}/contact`)).body.ownerPhone, "0722555444", "owner's phone by default");

  // admin list, contact change, mark let
  const list = (await call("GET", "/api/admin/assisted", null, sup)).body;
  assert.equal(list.length, 2); assert.equal(list.find(x => x.id === id).consent.how, "call");
  assert.equal((await call("PATCH", `/api/admin/assisted/${id}`, { contact: { name: "", phone: "0733111222" }, listerRole: "caretaker" }, sup)).status, 200);
  assert.equal((await call("POST", `/api/listings/${id}/contact`)).body.ownerPhone, "0733111222");
  assert.equal((await call("GET", "/api/listings/" + id)).body.listerRole, "caretaker");
  assert.equal((await call("PATCH", `/api/admin/assisted/${id}`, { status: "rented" }, sup)).status, 200);
  assert.ok((await call("GET", "/api/admin/audit?action=assisted_create", null, sup)).body.length >= 2);
});

test("watermark: new photos and videos get the PataHome logo", async () => {
  const t = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const w = await call("GET", "/api/admin/watermark", null, t);
  assert.equal(w.body.ready, true, "logo stored in Cloudinary at start-up");
  const img = (await call("GET", "/api/uploads/sign", null, t)).body;
  assert.match(img.transformation, /l_patahome:brand:watermark/); assert.equal(img.tags, "wm");
  const vid = (await call("GET", "/api/uploads/sign?kind=video", null, t)).body;
  assert.match(vid.eager, /l_patahome:brand:watermark.*\/mp4$/); assert.equal(vid.eager_async, "true");
  const doc = (await call("GET", "/api/uploads/sign?kind=verify", null, t)).body;
  assert.doesNotMatch(doc.transformation, /watermark/, "ID documents aren't stamped");
  // switching it off
  await call("PATCH", "/api/admin/settings", { watermark_on: "0" }, t);
  assert.doesNotMatch((await call("GET", "/api/uploads/sign", null, t)).body.transformation, /watermark/);
  await call("PATCH", "/api/admin/settings", { watermark_on: "1" }, t);
});
test("photos: up to 60 per listing, lists carry a few plus the true count", async () => {
  const t = await owner("photos60@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000161" }, t);
  const ids = n => Array.from({ length: n }, (_, i) => `patahome/listings/p60_${i}`);
  const cfg = (await call("GET", "/api/config")).body;
  assert.equal(cfg.maxPhotos, 60);
  const tooMany = await call("POST", "/api/listings", { category: "rent", title: "Many photos", areaId: areaId("Ruaka"), price: 30000, bedrooms: 2, photos: ids(61) }, t);
  assert.equal(tooMany.status, 400);
  const r = await call("POST", "/api/listings", { category: "rent", title: "Many photos flat", areaId: areaId("Ruaka"), price: 30500, bedrooms: 2, photos: ids(12) }, t);
  assert.equal(r.status, 201);
  assert.equal(r.body.photoCount, 12);
  assert.equal(r.body.photoUrls.length, 12);
  const full = (await call("GET", `/api/listings/${r.body.id}`)).body;
  assert.equal(full.photoUrls.length, 12);
  const s = (await call("GET", "/api/search?q=Ruaka&perPage=50")).body.listings.find(x => x.id === r.body.id);
  assert.ok(s, "listing shows in search");
  assert.equal(s.photoCount, 12);
  assert.ok(s.photoUrls.length <= 6, "search results stay light");
});
test("photos: owners and the team can reorder so the best photo is the cover", async () => {
  const t = await owner("reorder@example.com");
  await call("POST", "/api/account/change-phone", { phone: "0712000162" }, t);
  const ids = ["a", "b", "c", "d"].map(k => `patahome/listings/ro_${k}`);
  const r = await call("POST", "/api/listings", { category: "rent", title: "Reorder flat", areaId: areaId("Ruaka"), price: 21000, bedrooms: 1, photos: ids }, t);
  assert.equal(r.status, 201);
  // owner moves photo 3 to the front
  const o = await call("PATCH", `/api/listings/${r.body.id}`, { photos: [ids[2], ids[0], ids[1], ids[3]] }, t);
  assert.equal(o.status, 200);
  assert.deepEqual(o.body.photos, [ids[2], ids[0], ids[1], ids[3]]);
  assert.match(o.body.photoUrls[0].thumb, /ro_c/, "cover follows the order");
  // admin reorders and drops one
  const at = (await call("POST", "/api/auth/login", { phone: "0700000001", password: "adminpass123" })).body.token;
  const bad = await call("PATCH", `/api/admin/listings/${r.body.id}`, { photos: [ids[1], "patahome/listings/not_theirs"] }, at);
  assert.equal(bad.status, 400, "can't add photos that aren't on the listing");
  const a = await call("PATCH", `/api/admin/listings/${r.body.id}`, { photos: [ids[3], ids[2], ids[0]] }, at);
  assert.equal(a.status, 200);
  assert.deepEqual(a.body.photos, [ids[3], ids[2], ids[0]]);
  assert.equal(a.body.photoCount, 3);
});
