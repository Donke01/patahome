// PataHome API — zero-dependency Node.js backend (requires Node 22.5+)
// Run: node seed.js && node server.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter } = require("./lib");

const PORT = process.env.PORT || 3000;
const FEATURE_PRICES = { feature_7d: { amount: 300, days: 7 }, feature_30d: { amount: 1000, days: 30 } };
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
  if (!["rent", "sale", "land", "vehicle"].includes(category)) return send(res, 400, { error: "Invalid category" });
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
    plotsForSale: rows.filter(r => r.category === "land").length,
    vehicles: rows.filter(r => r.category === "vehicle").length,
    byCategory: Object.fromEntries(["rent", "sale", "land", "vehicle"].map(c => [c, rows.filter(r => r.category === c).length]))
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

/* ---- feature a listing (mock M-Pesa STK push) — monetization ---- */
router.add("POST", "/api/listings/:id/feature", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const { plan } = req.body || {};
  const price = FEATURE_PRICES[plan];
  if (!price) return send(res, 400, { error: "plan must be feature_7d (KES 300) or feature_30d (KES 1000)" });
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id) return send(res, 403, { error: "Not your listing" });

  // MOCK: in production, trigger a real M-Pesa STK push (Daraja API) here and
  // complete the payment in the callback webhook instead of immediately.
  const ref = "MPESA-MOCK-" + Date.now();
  const until = new Date(Date.now() + price.days * 86400000).toISOString();
  db.prepare(`INSERT INTO payments (user_id,listing_id,amount,purpose,provider_ref,status)
    VALUES (?,?,?,?,?,'completed')`).run(u.id, row.id, price.amount, plan, ref);
  db.prepare("UPDATE listings SET featured_until=? WHERE id=?").run(until, row.id);
  send(res, 200, { ok: true, amount: price.amount, providerRef: ref, featuredUntil: until,
    note: "Mock payment. Wire up M-Pesa Daraja STK push + callback for production." });
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

router.add("GET", "/api/health", (req, res) => {
  send(res, 200, { ok: true, listings: db.prepare("SELECT COUNT(*) n FROM listings WHERE status='active'").get().n });
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
