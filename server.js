// PataHome API — zero-dependency Node.js backend (requires Node 22.5+)
// Run: node seed.js && node server.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter } = require("./lib");

const PORT = process.env.PORT || 3000;
const router = makeRouter();

/* ================= helpers ================= */
const LISTING_SQL = `
  SELECT l.*, a.name AS area_name, a.county, u.name AS owner_name, u.verified AS owner_verified
  FROM listings l JOIN areas a ON a.id = l.area_id JOIN users u ON u.id = l.owner_id`;

const listingView = (row, userLat, userLng) => ({
  id: row.id,
  category: row.category,
  title: row.title,
  description: row.description,
  price: row.price,
  bedrooms: row.bedrooms,
  area: row.area_name,
  county: row.county,
  lat: row.lat,
  lng: row.lng,
  status: row.status,
  featured: !!(row.featured_until && row.featured_until > new Date().toISOString()),
  ownerName: row.owner_name,
  ownerVerified: !!row.owner_verified,
  createdAt: row.created_at,
  distanceKm: (userLat != null && userLng != null)
    ? Math.round(km(userLat, userLng, row.lat, row.lng) * 10) / 10 : null
  // NOTE: owner phone deliberately excluded — request via POST /api/listings/:id/contact
});

function getUser(req) {
  const h = req.headers.authorization || "";
  if (!h.startsWith("Bearer ")) return null;
  return verifyToken(h.slice(7));
}
const requireAuth = (req, res) => {
  const u = getUser(req);
  if (!u) { send(res, 401, { error: "Login required" }); return null; }
  return u;
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(body);
}

/* ================= auth ================= */
router.add("POST", "/api/auth/register", (req, res) => {
  const { name, phone, email, password } = req.body || {};
  if (!name || !phone || !password) return send(res, 400, { error: "name, phone and password are required" });
  if (!/^0[17]\d{8}$/.test(phone)) return send(res, 400, { error: "Enter a valid Kenyan phone e.g. 0712345678" });
  if (password.length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
  try {
    const info = db.prepare("INSERT INTO users (name,phone,email,password_hash) VALUES (?,?,?,?)")
      .run(name.trim(), phone, email || null, hashPassword(password));
    const user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    send(res, 201, { token: signToken({ id: user.id, name: user.name, role: user.role }),
      user: { id: user.id, name: user.name, phone: user.phone, verified: !!user.verified } });
  } catch (e) {
    if (String(e).includes("UNIQUE")) return send(res, 409, { error: "Phone or email already registered" });
    throw e;
  }
});

router.add("POST", "/api/auth/login", (req, res) => {
  const { phone, password } = req.body || {};
  const user = db.prepare("SELECT * FROM users WHERE phone=?").get(phone || "");
  if (!user || !verifyPassword(password || "", user.password_hash))
    return send(res, 401, { error: "Wrong phone or password" });
  send(res, 200, { token: signToken({ id: user.id, name: user.name, role: user.role }),
    user: { id: user.id, name: user.name, phone: user.phone, verified: !!user.verified } });
});

router.add("GET", "/api/auth/me", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  send(res, 200, db.prepare("SELECT id,name,phone,email,verified,created_at FROM users WHERE id=?").get(u.id));
});

/* ================= areas ================= */
router.add("GET", "/api/areas", (req, res) => {
  send(res, 200, db.prepare("SELECT * FROM areas ORDER BY county, name").all());
});

/* ================= listings ================= */
router.add("GET", "/api/listings", (req, res) => {
  const q = req.query;
  const where = ["l.status = 'active'"], params = [];
  if (q.category) { where.push("l.category = ?"); params.push(q.category); }
  if (q.county) { where.push("a.county = ?"); params.push(q.county); }
  if (q.minPrice) { where.push("l.price >= ?"); params.push(+q.minPrice); }
  if (q.maxPrice) { where.push("l.price <= ?"); params.push(+q.maxPrice); }
  if (q.bedrooms !== undefined && q.bedrooms !== "") {
    if (q.bedrooms === "3+") where.push("l.bedrooms >= 3");
    else { where.push("l.bedrooms = ?"); params.push(+q.bedrooms); }
  }
  if (q.q) { where.push("(l.title LIKE ? OR l.description LIKE ? OR a.name LIKE ?)"); params.push(`%${q.q}%`, `%${q.q}%`, `%${q.q}%`); }

  let rows = db.prepare(`${LISTING_SQL} WHERE ${where.join(" AND ")}`).all(...params);

  const lat = q.lat ? +q.lat : null, lng = q.lng ? +q.lng : null;
  if (lat != null && lng != null && q.radiusKm)
    rows = rows.filter(r => km(lat, lng, r.lat, r.lng) <= +q.radiusKm);

  let out = rows.map(r => listingView(r, lat, lng));
  const sort = q.sort || (lat != null ? "distance" : "newest");
  const by = {
    distance: (a, b) => (a.distanceKm ?? 1e9) - (b.distanceKm ?? 1e9),
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    newest: (a, b) => b.id - a.id
  }[sort] || ((a, b) => b.id - a.id);
  // Featured listings always float to the top — this is the monetization hook
  out.sort((a, b) => (b.featured - a.featured) || by(a, b));

  const perPage = Math.min(+q.perPage || 20, 100), page = Math.max(+q.page || 1, 1);
  send(res, 200, { total: out.length, page, perPage, listings: out.slice((page - 1) * perPage, page * perPage) });
});

router.add("GET", "/api/listings/:id", (req, res, p) => {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  send(res, 200, listingView(row, req.query.lat ? +req.query.lat : null, req.query.lng ? +req.query.lng : null));
});

router.add("POST", "/api/listings", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { category, title, description, areaId, price, bedrooms } = req.body || {};
  if (!["rent", "sale"].includes(category)) return send(res, 400, { error: "Invalid category" });
  if (!title || !areaId || !price) return send(res, 400, { error: "title, areaId and price are required" });
  const area = db.prepare("SELECT * FROM areas WHERE id=?").get(areaId);
  if (!area) return send(res, 400, { error: "Unknown areaId — see GET /api/areas" });
  const lat = area.lat + (Math.random() - 0.5) * 0.01, lng = area.lng + (Math.random() - 0.5) * 0.01;
  const info = db.prepare(`INSERT INTO listings (owner_id,category,title,description,area_id,price,bedrooms,lat,lng)
    VALUES (?,?,?,?,?,?,?,?,?)`)
    .run(u.id, category, title.trim(), description || "", areaId, +price,
         bedrooms == null || bedrooms === "" ? null : +bedrooms, lat, lng);
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(info.lastInsertRowid);
  send(res, 201, listingView(row));
});

router.add("PATCH", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && u.role !== "admin") return send(res, 403, { error: "Not your listing" });
  const allowed = ["title", "description", "price", "bedrooms", "status"];
  const sets = [], params = [];
  for (const k of allowed) if (req.body[k] !== undefined) { sets.push(`${k}=?`); params.push(req.body[k]); }
  if (!sets.length) return send(res, 400, { error: "Nothing to update" });
  db.prepare(`UPDATE listings SET ${sets.join(",")} WHERE id=?`).run(...params, row.id);
  send(res, 200, listingView(db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(row.id)));
});

router.add("DELETE", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && u.role !== "admin") return send(res, 403, { error: "Not your listing" });
  db.prepare("UPDATE listings SET status='removed' WHERE id=?").run(row.id);
  send(res, 200, { ok: true });
});

/* -------- contact owner (records a lead, returns phone) -------- */
router.add("POST", "/api/listings/:id/contact", (req, res, p) => {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=? AND l.status='active'`).get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  const u = getUser(req);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,?)").run(row.id, u ? u.id : null);
  const owner = db.prepare("SELECT name, phone, verified FROM users WHERE id=?").get(row.owner_id);
  send(res, 200, { ownerName: owner.name, ownerPhone: owner.phone, ownerVerified: !!owner.verified });
});

/* -------- inquiries: tenant/buyer feedback to the owner -------- */
router.add("POST", "/api/listings/:id/inquire", (req, res, p) => {
  const row = db.prepare("SELECT id FROM listings WHERE id=? AND status='active'").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  const { name, phone, message } = req.body || {};
  if (!name || !phone || !message) return send(res, 400, { error: "name, phone and message are required" });
  if (String(message).length > 1000) return send(res, 400, { error: "Message too long (max 1000 chars)" });
  const info = db.prepare("INSERT INTO inquiries (listing_id,from_name,from_phone,message) VALUES (?,?,?,?)")
    .run(row.id, String(name).trim(), String(phone).trim(), String(message).trim());
  // an inquiry is also a lead
  const u = getUser(req);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,?)").run(row.id, u ? u.id : null);
  send(res, 201, { ok: true, inquiryId: info.lastInsertRowid });
});

router.add("GET", "/api/my/inquiries", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`
    SELECT i.*, l.title AS listing_title, l.category
    FROM inquiries i JOIN listings l ON l.id = i.listing_id
    WHERE l.owner_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(u.id);
  send(res, 200, rows.map(r => ({
    id: r.id, listingId: r.listing_id, listingTitle: r.listing_title, category: r.category,
    fromName: r.from_name, fromPhone: r.from_phone, message: r.message,
    reply: r.owner_reply, repliedAt: r.replied_at, createdAt: r.created_at
  })));
});

router.add("POST", "/api/inquiries/:id/reply", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare(`
    SELECT i.id, l.owner_id FROM inquiries i JOIN listings l ON l.id = i.listing_id WHERE i.id=?`).get(p.id);
  if (!row) return send(res, 404, { error: "Inquiry not found" });
  if (row.owner_id !== u.id && u.role !== "admin") return send(res, 403, { error: "Not your inquiry" });
  const { reply } = req.body || {};
  if (!reply || !String(reply).trim()) return send(res, 400, { error: "reply is required" });
  db.prepare("UPDATE inquiries SET owner_reply=?, replied_at=datetime('now') WHERE id=?")
    .run(String(reply).trim(), row.id);
  send(res, 200, { ok: true });
});

/* ================= insights (location-based) ================= */
router.add("GET", "/api/insights", (req, res) => {
  const lat = +req.query.lat, lng = +req.query.lng, radius = +req.query.radiusKm || 10;
  if (isNaN(lat) || isNaN(lng)) return send(res, 400, { error: "lat and lng are required" });
  const rows = db.prepare(`${LISTING_SQL} WHERE l.status='active'`).all()
    .filter(r => km(lat, lng, r.lat, r.lng) <= radius);
  const rents = rows.filter(r => r.category === "rent").map(r => r.price);
  send(res, 200, {
    radiusKm: radius,
    totalNearby: rows.length,
    avgRent: rents.length ? Math.round(rents.reduce((s, x) => s + x, 0) / rents.length) : null,
    cheapestRent: rents.length ? Math.min(...rents) : null,
    forSaleNearby: rows.filter(r => r.category === "sale").length,
    byCategory: Object.fromEntries(["rent", "sale"].map(c => [c, rows.filter(r => r.category === c).length]))
  });
});

/* ================= favorites ================= */
router.add("GET", "/api/favorites", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`${LISTING_SQL} JOIN favorites f ON f.listing_id = l.id WHERE f.user_id=? AND l.status='active'`).all(u.id);
  send(res, 200, rows.map(r => listingView(r)));
});
router.add("PUT", "/api/favorites/:listingId", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const exists = db.prepare("SELECT 1 AS x FROM listings WHERE id=? AND status='active'").get(p.listingId);
  if (!exists) return send(res, 404, { error: "Listing not found" });
  db.prepare("INSERT OR IGNORE INTO favorites (user_id,listing_id) VALUES (?,?)").run(u.id, p.listingId);
  send(res, 200, { ok: true });
});
router.add("DELETE", "/api/favorites/:listingId", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  db.prepare("DELETE FROM favorites WHERE user_id=? AND listing_id=?").run(u.id, p.listingId);
  send(res, 200, { ok: true });
});

/* ================= owner dashboard ================= */
router.add("GET", "/api/my/listings", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`${LISTING_SQL} WHERE l.owner_id=? AND l.status != 'removed'`).all(u.id);
  const leadCount = {};
  for (const r of db.prepare("SELECT listing_id, COUNT(*) n FROM leads GROUP BY listing_id").all())
    leadCount[r.listing_id] = r.n;
  send(res, 200, rows.map(r => ({ ...listingView(r), leads: leadCount[r.id] || 0 })));
});

/* -------- owner stats: daily leads/inquiries for the live dashboard -------- */
router.add("GET", "/api/my/stats", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const days = Math.min(90, Math.max(7, +req.query.days || 30));
  const leadRows = db.prepare(`
    SELECT date(le.created_at) d, COUNT(*) n
    FROM leads le JOIN listings l ON l.id = le.listing_id
    WHERE l.owner_id = ? AND le.created_at >= datetime('now', ?)
    GROUP BY date(le.created_at)`).all(u.id, `-${days} days`);
  const inqRows = db.prepare(`
    SELECT date(i.created_at) d, COUNT(*) n
    FROM inquiries i JOIN listings l ON l.id = i.listing_id
    WHERE l.owner_id = ? AND i.created_at >= datetime('now', ?)
    GROUP BY date(i.created_at)`).all(u.id, `-${days} days`);
  const leadMap = Object.fromEntries(leadRows.map(r => [r.d, r.n]));
  const inqMap = Object.fromEntries(inqRows.map(r => [r.d, r.n]));
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ date: d, leads: leadMap[d] || 0, inquiries: inqMap[d] || 0 });
  }
  const week = arr => arr.reduce((s, x) => s + x.leads + x.inquiries, 0);
  const thisWeek = week(series.slice(-7));
  const prevWeek = week(series.slice(-14, -7));
  const top = db.prepare(`
    SELECT l.id, l.title, COUNT(le.id) n
    FROM listings l LEFT JOIN leads le ON le.listing_id = l.id
    WHERE l.owner_id = ? AND l.status = 'active'
    GROUP BY l.id ORDER BY n DESC, l.id DESC LIMIT 1`).get(u.id);
  send(res, 200, {
    days, series, thisWeek, prevWeek,
    trendPct: prevWeek ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek ? 100 : 0),
    topListing: top && top.n > 0 ? { id: top.id, title: top.title, leads: top.n } : null
  });
});

/* ================= admin (role: admin only) ================= */
function requireAdmin(req, res) {
  const u = requireAuth(req, res);
  if (!u) return null;
  if (u.role !== "admin") { send(res, 403, { error: "Admin access only" }); return null; }
  return u;
}

router.add("GET", "/api/admin/overview", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const one = (sql) => Object.values(db.prepare(sql).get())[0];
  send(res, 200, {
    users: one("SELECT COUNT(*) FROM users WHERE role='user'"),
    verifiedOwners: one("SELECT COUNT(*) FROM users WHERE role='user' AND verified=1"),
    activeListings: one("SELECT COUNT(*) FROM listings WHERE status='active'"),
    totalLeads: one("SELECT COUNT(*) FROM leads"),
    inquiries: one("SELECT COUNT(*) FROM inquiries"),
    unrepliedInquiries: one("SELECT COUNT(*) FROM inquiries WHERE owner_reply IS NULL"),
    byCategory: Object.fromEntries(db.prepare("SELECT category, COUNT(*) n FROM listings WHERE status='active' GROUP BY category").all().map(r => [r.category, r.n]))
  });
});

/* -------- platform-wide daily stats for the live admin dashboard -------- */
router.add("GET", "/api/admin/stats", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const days = Math.min(90, Math.max(7, +req.query.days || 30));
  const daily = (table) => Object.fromEntries(
    db.prepare(`SELECT date(created_at) d, COUNT(*) n FROM ${table}
                WHERE created_at >= datetime('now', ?) GROUP BY date(created_at)`)
      .all(`-${days} days`).map(r => [r.d, r.n]));
  const leads = daily("leads"), inqs = daily("inquiries"),
        lst = daily("listings"), usr = daily("users");
  const series = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(Date.now() - i * 86400000).toISOString().slice(0, 10);
    series.push({ date: d, leads: leads[d] || 0, inquiries: inqs[d] || 0, listings: lst[d] || 0, users: usr[d] || 0 });
  }
  const week = arr => arr.reduce((s, x) => s + x.leads + x.inquiries, 0);
  const thisWeek = week(series.slice(-7)), prevWeek = week(series.slice(-14, -7));
  const rev = db.prepare("SELECT COALESCE(SUM(amount),0) t FROM payments WHERE status='completed'").get().t;
  const hot = db.prepare(`
    SELECT l.id, l.title, l.area_id, COUNT(le.id) n
    FROM listings l JOIN leads le ON le.listing_id = l.id
    WHERE l.status='active' AND le.created_at >= datetime('now', '-7 days')
    GROUP BY l.id ORDER BY n DESC LIMIT 1`).get();
  send(res, 200, {
    days, series, thisWeek, prevWeek,
    trendPct: prevWeek ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek ? 100 : 0),
    revenue: rev,
    hotListing: hot ? { id: hot.id, title: hot.title, leads: hot.n } : null
  });
});

router.add("GET", "/api/admin/listings", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const leads = {};
  for (const r of db.prepare("SELECT listing_id, COUNT(*) n FROM leads GROUP BY listing_id").all()) leads[r.listing_id] = r.n;
  const rows = db.prepare(`SELECT l.*, a.name AS area_name, a.county, u.name AS owner_name, u.phone AS owner_phone
    FROM listings l JOIN areas a ON a.id=l.area_id JOIN users u ON u.id=l.owner_id
    WHERE l.status != 'removed' ORDER BY l.id DESC`).all();
  send(res, 200, rows.map(r => ({
    id: r.id, category: r.category, title: r.title, area: r.area_name, county: r.county,
    price: r.price, status: r.status, featured: !!(r.featured_until && r.featured_until > new Date().toISOString()),
    ownerName: r.owner_name, ownerPhone: r.owner_phone, leads: leads[r.id] || 0, createdAt: r.created_at
  })));
});

router.add("GET", "/api/admin/users", (req, res) => {
  if (!requireAdmin(req, res)) return;
  const rows = db.prepare(`SELECT u.id, u.name, u.phone, u.verified, u.role, u.created_at,
      (SELECT COUNT(*) FROM listings l WHERE l.owner_id=u.id AND l.status!='removed') AS listings
    FROM users u ORDER BY u.id`).all();
  send(res, 200, rows);
});

router.add("PATCH", "/api/admin/users/:id", (req, res, p) => {
  if (!requireAdmin(req, res)) return;
  const row = db.prepare("SELECT id FROM users WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "User not found" });
  if (req.body.verified !== undefined)
    db.prepare("UPDATE users SET verified=? WHERE id=?").run(req.body.verified ? 1 : 0, p.id);
  send(res, 200, { ok: true });
});

router.add("GET", "/api/health", (req, res) => {
  send(res, 200, { ok: true, listings: db.prepare("SELECT COUNT(*) n FROM listings WHERE status='active'").get().n });
});

/* ============================================================
   SEO: server-rendered pages, sitemap.xml, robots.txt
   ============================================================ */
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const CATS = {
  rentals:  { db: "rent",    label: "Houses & Rooms for Rent", unit: "/month" },
  "for-sale":{ db: "sale",   label: "Houses for Sale",         unit: "" }
};
const CAT_SLUG = { rent: "rentals", sale: "for-sale" };
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtKes = (n) => "KES " + Number(n).toLocaleString("en-KE");

function areaBySlug(slug) {
  return db.prepare("SELECT * FROM areas").all().find((a) => slugify(a.name) === slug) || null;
}

function pageShell({ title, description, canonical, jsonLd, bodyHtml }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(title)}</title>
<meta name="description" content="${escapeHtml(description)}">
<link rel="canonical" href="${canonical}">
<meta property="og:title" content="${escapeHtml(title)}">
<meta property="og:description" content="${escapeHtml(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="PataHome">
${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>` : ""}
<style>
  body{font-family:'Segoe UI',system-ui,sans-serif;margin:0;background:#f7faf8;color:#1c2320;line-height:1.6}
  a{color:#0e7c5a}
  header{background:#fff;border-bottom:1px solid #e3e8e5;padding:12px 20px}
  header a.logo{font-size:1.2rem;font-weight:800;color:#0e7c5a;text-decoration:none}
  header a.logo b{color:#e8a13a}
  .wrap{max-width:900px;margin:0 auto;padding:24px 20px 50px}
  h1{font-size:1.5rem;color:#0a5c43}
  .card{background:#fff;border:1px solid #e3e8e5;border-radius:12px;padding:16px 18px;margin:12px 0;box-shadow:0 2px 10px rgba(20,40,30,.06)}
  .card a{font-weight:700;text-decoration:none;font-size:1.02rem}
  .price{font-weight:800;color:#0a5c43}
  .meta{font-size:.85rem;color:#5f6b66}
  .links{font-size:.85rem;color:#5f6b66;margin-top:30px;border-top:1px solid #e3e8e5;padding-top:16px}
  .links a{margin-right:12px;white-space:nowrap;display:inline-block}
  .cta{display:inline-block;background:#0e7c5a;color:#fff;border-radius:10px;padding:10px 20px;text-decoration:none;font-weight:700;margin-top:10px}
  footer{text-align:center;color:#5f6b66;font-size:.8rem;padding:20px}
</style>
</head>
<body>
<header><a class="logo" href="/">Pata<b>Home</b></a></header>
<div class="wrap">${bodyHtml}</div>
<footer>PataHome · Houses for rent &amp; sale across Kenya</footer>
</body>
</html>`;
}

function areaLinksHtml() {
  const areas = db.prepare("SELECT * FROM areas ORDER BY county, name").all();
  return `<div class="links"><strong>Browse by area:</strong><br>` +
    Object.keys(CATS).map((cs) =>
      areas.map((a) => `<a href="/${cs}/${slugify(a.name)}">${escapeHtml(CATS[cs].label.split(" ")[0])} ${escapeHtml(a.name)}</a>`).join(" ")
    ).join("<br>") + `</div>`;
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

/* ---- per-listing page: /listing/:id/:slug? ---- */
function listingPage(req, res, p) {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=? AND l.status='active'`).get(p.id);
  if (!row) return sendHtml(res, 404, pageShell({
    title: "Listing not found — PataHome", description: "This listing is no longer available.",
    canonical: `${BASE_URL}/`, bodyHtml: `<h1>Listing not found</h1><p>It may have been rented or sold. <a href="/">Browse current listings</a>.</p>` }));
  const catSlug = CAT_SLUG[row.category];
  const unit = row.category === "rent" ? "/month" : "";
  const canonical = `${BASE_URL}/listing/${row.id}/${slugify(row.title)}`;
  const desc = `${row.title} in ${row.area_name}, ${row.county} County — ${fmtKes(row.price)}${unit}. Contact the verified owner directly on PataHome. No middlemen, no viewing fees.`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: row.title,
    description: desc,
    offers: { "@type": "Offer", price: row.price, priceCurrency: "KES", availability: "https://schema.org/InStock", url: canonical },
    additionalType: "https://schema.org/RealEstateListing"
  };
  const bodyHtml = `
    <h1>${escapeHtml(row.title)}</h1>
    <div class="card">
      <div class="price">${fmtKes(row.price)}${unit}</div>
      <div class="meta">📍 ${escapeHtml(row.area_name)}, ${escapeHtml(row.county)} County
        ${row.bedrooms != null ? ` · 🛏 ${row.bedrooms === 0 ? "Bedsitter" : row.bedrooms + " bedroom(s)"}` : ""}
        · Listed by ${escapeHtml(row.owner_name)}${row.owner_verified ? " ✓ verified owner" : ""}</div>
      ${row.description ? `<p>${escapeHtml(row.description)}</p>` : ""}
      <a class="cta" href="/#listing-${row.id}">View on PataHome &amp; contact owner</a>
    </div>
    <p><a href="/${catSlug}/${slugify(row.area_name)}">More ${escapeHtml(CATS[catSlug].label.toLowerCase())} in ${escapeHtml(row.area_name)} →</a></p>
    ${areaLinksHtml()}`;
  sendHtml(res, 200, pageShell({ title: `${row.title} — ${row.area_name} | PataHome`, description: desc, canonical, jsonLd, bodyHtml }));
}
router.add("GET", "/listing/:id", listingPage);
router.add("GET", "/listing/:id/:slug", listingPage);

/* ---- category+area landing pages: /rentals/kitale-town-cbd etc ---- */
router.add("GET", "/:catSlug/:areaSlug", (req, res, p) => {
  const cat = CATS[p.catSlug];
  const area = cat ? areaBySlug(p.areaSlug) : null;
  if (!cat || !area) return send(res, 404, { error: "Not found" });
  const rows = db.prepare(`${LISTING_SQL} WHERE l.status='active' AND l.category=? AND l.area_id=? ORDER BY l.featured_until DESC, l.id DESC`)
    .all(cat.db, area.id);
  const canonical = `${BASE_URL}/${p.catSlug}/${p.areaSlug}`;
  const minPrice = rows.length ? Math.min(...rows.map((r) => r.price)) : null;
  const title = `${cat.label} in ${area.name}, ${area.county} | PataHome`;
  const desc = rows.length
    ? `${rows.length} ${cat.label.toLowerCase()} in ${area.name}, ${area.county} County from ${fmtKes(minPrice)}${cat.unit}. Deal directly with verified owners on PataHome.`
    : `Find ${cat.label.toLowerCase()} in ${area.name}, ${area.county} County on PataHome. New listings added daily by verified owners.`;
  const jsonLd = {
    "@context": "https://schema.org", "@type": "ItemList",
    name: title,
    itemListElement: rows.map((r, i) => ({ "@type": "ListItem", position: i + 1, url: `${BASE_URL}/listing/${r.id}/${slugify(r.title)}` }))
  };
  const bodyHtml = `
    <h1>${escapeHtml(cat.label)} in ${escapeHtml(area.name)}, ${escapeHtml(area.county)} County</h1>
    <p class="meta">${rows.length} listing(s)${minPrice ? ` · from ${fmtKes(minPrice)}${cat.unit}` : ""} · updated daily</p>
    ${rows.length ? rows.map((r) => `
      <div class="card">
        <a href="/listing/${r.id}/${slugify(r.title)}">${escapeHtml(r.title)}</a>
        <div class="price">${fmtKes(r.price)}${cat.unit}</div>
        <div class="meta">📍 ${escapeHtml(r.area_name)}${r.bedrooms != null ? ` · 🛏 ${r.bedrooms === 0 ? "Bedsitter" : r.bedrooms + " BR"}` : ""}</div>
      </div>`).join("") : `<div class="card">No listings here yet — <a href="/dashboard.html">be the first to post</a>.</div>`}
    <a class="cta" href="/">Search all listings on PataHome</a>
    ${areaLinksHtml()}`;
  sendHtml(res, 200, pageShell({ title, description: desc, canonical, jsonLd, bodyHtml }));
});

/* ---- browse index (crawl entry point) ---- */
router.add("GET", "/browse", (req, res) => {
  sendHtml(res, 200, pageShell({
    title: "Browse Homes, Land & Vehicles by Area | PataHome",
    description: "Browse rentals, houses for sale, land and vehicles across Kenyan counties on PataHome — direct from verified owners.",
    canonical: `${BASE_URL}/browse`,
    bodyHtml: `<h1>Browse by area</h1>${areaLinksHtml()}`
  }));
});

/* ---- sitemap.xml + robots.txt ---- */
router.add("GET", "/sitemap.xml", (req, res) => {
  const areas = db.prepare("SELECT * FROM areas").all();
  const listings = db.prepare("SELECT id, title FROM listings WHERE status='active'").all();
  const urls = [`${BASE_URL}/`, `${BASE_URL}/browse`]
    .concat(Object.keys(CATS).flatMap((cs) => areas.map((a) => `${BASE_URL}/${cs}/${slugify(a.name)}`)))
    .concat(listings.map((l) => `${BASE_URL}/listing/${l.id}/${slugify(l.title)}`));
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map((u) => `  <url><loc>${u}</loc></url>`).join("\n")}
</urlset>`;
  res.writeHead(200, { "Content-Type": "application/xml" });
  res.end(xml);
});

router.add("GET", "/robots.txt", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/plain" });
  res.end(`User-agent: *\nAllow: /\nDisallow: /dashboard.html\nDisallow: /admin.html\nDisallow: /api/\n\nSitemap: ${BASE_URL}/sitemap.xml\n`);
});

/* ================= server ================= */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  req.query = Object.fromEntries(url.searchParams);

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization"
    });
    return res.end();
  }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
    const m = router.match(req.method, url.pathname);
    try {
      if (m) return m.handler(req, res, m.params);
      // static files from ./public (put patahome.html there as index.html)
      if (req.method === "GET") {
        let file = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
        if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { "Content-Type": MIME[path.extname(file)] || "application/octet-stream" });
          return res.end(fs.readFileSync(file));
        }
      }
      send(res, 404, { error: "Not found" });
    } catch (e) {
      console.error(e);
      send(res, 500, { error: "Something went wrong" });
    }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`PataHome API running on http://localhost:${PORT}`));
}
module.exports = server;
