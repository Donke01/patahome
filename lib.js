// lib.js — zero-dependency helpers: password hashing, JWT-style tokens, tiny router
const crypto = require("node:crypto");

const SECRET = process.env.JWT_SECRET || "dev-secret-change-in-production";

/* ---------- passwords (scrypt) ---------- */
function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.scryptSync(pw, salt, 32).toString("hex");
  return `${salt}:${hash}`;
}
function verifyPassword(pw, stored) {
  const [salt, hash] = String(stored).split(":");
  if (!salt || !hash) return false;
  const check = crypto.scryptSync(pw, salt, 32).toString("hex");
  return crypto.timingSafeEqual(Buffer.from(hash, "hex"), Buffer.from(check, "hex"));
}

/* ---------- tokens (HMAC-SHA256, JWT-compatible shape) ---------- */
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signToken(payload, days = 30) {
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + days * 86400 };
  const head = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const data = `${head}.${b64u(JSON.stringify(body))}`;
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  return `${data}.${sig}`;
}
function verifyToken(token) {
  const parts = String(token).split(".");
  if (parts.length !== 3) return null;
  const data = `${parts[0]}.${parts[1]}`;
  const sig = crypto.createHmac("sha256", SECRET).update(data).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(parts[2]);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    if (payload.exp && payload.exp < Date.now() / 1000) return null;
    return payload;
  } catch { return null; }
}

/* ---------- geo ---------- */
function km(a, b, c, d) {
  const r = Math.PI / 180, R = 6371;
  const h = Math.sin((c - a) * r / 2) ** 2 + Math.cos(a * r) * Math.cos(c * r) * Math.sin((d - b) * r / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/* ---------- tiny router ---------- */
// route("GET", "/api/listings/:id", handler) — handler(req, res, params)
function makeRouter() {
  const routes = [];
  function add(method, pattern, handler) {
    const keys = [];
    const rx = new RegExp("^" + pattern.replace(/:[^/]+/g, (m) => { keys.push(m.slice(1)); return "([^/]+)"; }) + "$");
    routes.push({ method, rx, keys, handler });
  }
  function match(method, pathname) {
    for (const r of routes) {
      if (r.method !== method) continue;
      const m = r.rx.exec(pathname);
      if (m) return { handler: r.handler, params: Object.fromEntries(r.keys.map((k, i) => [k, decodeURIComponent(m[i + 1])])) };
    }
    return null;
  }
  return { add, match };
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter };
