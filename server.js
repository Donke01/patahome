// PataHome API — zero-dependency Node.js backend (requires Node 22.5+)
// Run: node seed.js && node server.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter, sendMail, mailConfigured, sendSms, smsConfigured: smsConfiguredRaw } = require("./lib");

const PORT = process.env.PORT || 3000;
const router = makeRouter();

/* ================= site settings (editable by the super admin) =================
   Stored in the settings table; anything not set falls back to the default
   (which itself usually comes from an environment variable). */
const SETTINGS_DEFAULTS = {
  listing_ttl_days: () => Math.max(7, +process.env.LISTING_TTL_DAYS || 60),
  max_photos: () => 5,
  session_idle_hours: () => Math.max(0.25, +process.env.SESSION_IDLE_HOURS || 4),
  session_max_days: () => Math.max(1, +process.env.SESSION_MAX_DAYS || 14),
  alerts_enabled: () => "1",          // new-listing alerts (email/SMS) to saved searches
  sms_enabled: () => "1",             // master switch for all outgoing SMS
  announce_on: () => "0", announce_text: () => "", announce_level: () => "info", announce_link: () => "",
  pause_listings: () => "0", pause_signups: () => "0",
  maintenance_message: () => "We're doing some quick maintenance — please try again in a little while."
};
const SETTING_RULES = {
  listing_ttl_days: v => Math.min(365, Math.max(7, Math.round(+v))), max_photos: v => Math.min(20, Math.max(1, Math.round(+v))),
  session_idle_hours: v => Math.min(72, Math.max(0.25, +v)), session_max_days: v => Math.min(90, Math.max(1, +v)),
  alerts_enabled: v => (v === true || v === "1" || v === 1) ? "1" : "0", sms_enabled: v => (v === true || v === "1" || v === 1) ? "1" : "0",
  announce_on: v => (v === true || v === "1" || v === 1) ? "1" : "0", announce_text: v => String(v || "").trim().slice(0, 240),
  announce_level: v => ["info", "warn", "success"].includes(v) ? v : "info", announce_link: v => /^(https?:\/\/|\/)[^\s"<>]{0,300}$/.test(String(v || "")) ? String(v) : "",
  pause_listings: v => (v === true || v === "1" || v === 1) ? "1" : "0", pause_signups: v => (v === true || v === "1" || v === 1) ? "1" : "0",
  maintenance_message: v => String(v || "").trim().slice(0, 240)
};
const settingsCache = new Map();
function setting(key) {
  if (!settingsCache.has(key)) {
    let row = null; try { row = db.prepare("SELECT value FROM settings WHERE key=?").get(key); } catch (e) {}
    settingsCache.set(key, row && row.value != null ? row.value : String(SETTINGS_DEFAULTS[key] ? SETTINGS_DEFAULTS[key]() : ""));
  }
  return settingsCache.get(key);
}
const settingOn = (key) => setting(key) === "1";
const smsConfigured = () => smsConfiguredRaw() && settingOn("sms_enabled");

// Never let a stray rejection kill the server (Railway would answer 502 while it restarts)
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e));
process.on("uncaughtException", (e) => console.error("uncaughtException:", e));

/* ================= Cloudinary (photo storage — zero local disk) ================= */
const crypto = require("node:crypto");
const CLD = {
  cloud: process.env.CLOUDINARY_CLOUD_NAME || "",
  key: process.env.CLOUDINARY_API_KEY || "",
  secret: process.env.CLOUDINARY_API_SECRET || "",
  folder: "patahome/listings",
  maxPhotos: 5
};
const cldEnabled = () => !!(CLD.cloud && CLD.key && CLD.secret);
// Cloudinary signature: sha1 of sorted params + api_secret
function cldSign(params) {
  const str = Object.keys(params).sort().map(k => `${k}=${params[k]}`).join("&");
  return crypto.createHash("sha1").update(str + CLD.secret).digest("hex");
}
// Incoming transformation: cap at 1280px, auto quality — keeps every stored image small
const CLD_TRANSFORM = "c_limit,w_1280,h_1280,q_auto:good";
const photoUrl = (id, t) => `https://res.cloudinary.com/${CLD.cloud}/image/upload/${t}/${id}`;
require("./public/land.js"); // defines globalThis.PH_LAND (units, conversions, labels) — same file the browser uses
const LAND = globalThis.PH_LAND;
require("./public/commercial.js"); // defines globalThis.PH_COMM (types, units, labels)
const COMM = globalThis.PH_COMM;
const parseJson = (s, dflt) => { try { const v = JSON.parse(s); return v && typeof v === "object" ? v : dflt; } catch { return dflt; } };
const parsePhotos = (s) => { try { const a = JSON.parse(s || "[]"); return Array.isArray(a) ? a : []; } catch { return []; } };
const validPhotoId = (id) => typeof id === "string" && id.startsWith(CLD.folder + "/") &&
  /^[\w\-/]{1,200}$/.test(id);
// fire-and-forget delete of a Cloudinary image (used when listings/photos are removed)
async function cldDestroy(publicId) {
  if (!cldEnabled() || !validPhotoId(publicId)) return;
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    const signature = cldSign({ public_id: publicId, timestamp });
    await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/image/destroy`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ public_id: publicId, timestamp, api_key: CLD.key, signature })
    });
  } catch (e) { console.error("cloudinary destroy failed:", e.message); }
}

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
  statusChangedAt: row.status_changed_at || null,
  photos: parsePhotos(row.photos),
  photoUrls: cldEnabled() ? parsePhotos(row.photos).map(id => ({
    thumb: photoUrl(id, "c_limit,w_720,h_720,q_auto:eco"), // whole photo, no crop
    full: photoUrl(id, "c_limit,w_1280,q_auto:good")
  })) : [],
  featured: !!(row.featured_until && row.featured_until > new Date().toISOString()),
  features: parseJson(row.features, {}),
  video: row.video && cldEnabled() ? {
    url: `https://res.cloudinary.com/${CLD.cloud}/video/upload/q_auto,vc_auto,c_limit,w_1280/${row.video}.mp4`,
    poster: `https://res.cloudinary.com/${CLD.cloud}/video/upload/so_1,c_limit,w_720/${row.video}.jpg`
  } : null,
  nearby: row.nearby ? parseJson(row.nearby, null) : null,
  videoId: row.video || "",
  ...(row.category === "land" ? {
    landDeal: row.land_deal || "sale", sizeValue: row.size_value, sizeUnit: row.size_unit, sizeAcres: row.size_acres,
    priceBasis: row.price_basis, pricePerAcre: row.price_per_acre, leaseMin: row.lease_min || "",
    exactPin: !!row.exact_pin, docsChecked: row.docs_status === "checked"
    // title_ref and land_docs are private — never sent to the public
  } : {}),
  ...(row.category === "commercial" ? {
    deal: row.land_deal || "sale", commType: row.comm_type, sizeValue: row.size_value, sizeUnit: row.size_unit, areaSqft: row.area_sqft,
    priceBasis: row.price_basis, pricePerSqft: row.price_per_sqft, leaseMin: row.lease_min || "", incomeMonth: row.income_month || null,
    exactPin: !!row.exact_pin, docsChecked: row.docs_status === "checked"
  } : {}),
  adminBanner: row.admin_banner || "",
  ownerId: row.owner_id,
  ownerName: row.owner_name,
  ownerVerified: !!row.owner_verified,
  listerRole: row.lister_role || "owner",
  expiresAt: row.status === "active" ? expiryOf(row) : null,
  agentFee: row.agent_fee || "",
  createdAt: row.created_at,
  distanceKm: (userLat != null && userLng != null)
    ? Math.round(km(userLat, userLng, row.lat, row.lng) * 10) / 10 : null
  // NOTE: owner phone deliberately excluded — request via POST /api/listings/:id/contact
});

/* ================= sessions =================
   Every login creates a server-side session; the token only carries its id.
   A session ends when:
   - it has been idle for SESSION_IDLE_HOURS (default 4),
   - it is older than SESSION_MAX_DAYS (default 14), or
   - it is revoked (logout, sign-out-everywhere, password/phone/email change).
   Tokens issued before sessions existed have no sid and are no longer accepted. */
let SESSION_IDLE_MS = Math.max(0.25, +process.env.SESSION_IDLE_HOURS || 4) * 3600e3;
let SESSION_MAX_MS = Math.max(1, +process.env.SESSION_MAX_DAYS || 14) * 86400e3;
const ADMIN_IDLE_MS = 30 * 60e3;          // admins are signed out after 30 min idle
const VIEW_AS_MS = 30 * 60e3;             // read-only "view as user" sessions last 30 min
const clientIp = (req) => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64);
function createSession(u, req, viewer) {
  const sid = crypto.randomBytes(24).toString("base64url"), now = Date.now();
  db.prepare("INSERT INTO sessions (id,user_id,created_at,last_seen,expires_at,ua,ip,readonly,viewer_id) VALUES (?,?,?,?,?,?,?,?,?)")
    .run(sid, u.id, now, now, now + (viewer ? VIEW_AS_MS : SESSION_MAX_MS), String(req?.headers?.["user-agent"] || "").slice(0, 200), req ? clientIp(req) : "",
         viewer ? 1 : 0, viewer ? viewer.id : null);
  if (viewer) return signToken({ id: u.id, name: u.name, role: "user", sid, ro: 1, viewer: viewer.id }, 1);
  // housekeeping: drop this user's dead sessions
  db.prepare("DELETE FROM sessions WHERE user_id=? AND (expires_at<? OR last_seen<?)").run(u.id, now, now - SESSION_IDLE_MS);
  return signToken({ id: u.id, name: u.name, role: u.role, sid }, Math.ceil(SESSION_MAX_MS / 86400e3));
}
const revokeSessions = (userId, keepSid) => keepSid
  ? db.prepare("DELETE FROM sessions WHERE user_id=? AND id!=?").run(userId, keepSid)
  : db.prepare("DELETE FROM sessions WHERE user_id=?").run(userId);

// returns the token payload, or null; sets req._authFail to explain why
function getUser(req) {
  const h = req.headers.authorization || "";
  const cookieHeader = req.headers.cookie || "";
  const cookies = Object.fromEntries(cookieHeader.split(";").map(x=>x.trim().split("=")).filter(x=>x.length===2).map(([k,...v])=>[k,decodeURIComponent(v.join("="))]));
  const raw = h.startsWith("Bearer ") ? h.slice(7) : cookies.ph_session;
  if (!raw) return null;
  const p = verifyToken(raw);
  if (!p || !p.sid) { req._authFail = "expired"; return null; }
  const row = db.prepare("SELECT * FROM sessions WHERE id=? AND user_id=?").get(p.sid, p.id);
  const now = Date.now();
  if (!row) { req._authFail = "expired"; return null; }
  const idle = p.role === "admin" ? Math.min(ADMIN_IDLE_MS, SESSION_IDLE_MS) : SESSION_IDLE_MS;
  if (now - row.last_seen > idle) { db.prepare("DELETE FROM sessions WHERE id=?").run(row.id); req._authFail = p.role === "admin" ? "admin_idle" : "idle"; return null; }
  if (now > row.expires_at) { db.prepare("DELETE FROM sessions WHERE id=?").run(row.id); req._authFail = "expired"; return null; }
  if (now - row.last_seen > 60e3) db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(now, row.id);
  if (row.readonly) p.ro = 1;
  return p;
}
const requireAuth = (req, res) => {
  const u = getUser(req);
  if (!u) {
    const idleH = Math.round(SESSION_IDLE_MS / 3600e3 * 10) / 10;
    const msg = req._authFail === "idle" ? `You were signed out after ${idleH} hour${idleH === 1 ? "" : "s"} of inactivity — please log in again`
      : req._authFail === "admin_idle" ? "Admin sessions end after 30 minutes of inactivity — please log in again"
      : req._authFail ? "Your session has ended — please log in again" : "Login required";
    send(res, 401, { error: msg, code: req._authFail ? "SESSION_EXPIRED" : "LOGIN_REQUIRED" });
    return null;
  }
  // "View as user" sessions can look but never change anything
  if (u.ro && req.method !== "GET") { send(res, 403, { error: "Read-only view — changes are disabled", code: "READ_ONLY" }); return null; }
  return u;
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Credentials": "true" });
  res.end(body);
}

/* ================= auth ================= */
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || "";
// Google-only accounts get a placeholder phone ("g.<googleid>") until they add a real one,
// because the phone column is NOT NULL UNIQUE. A "real" phone matches the Kenyan format.
const realPhone = (p) => /^0[17]\d{8}$/.test(p || "") ? p : "";
const publicUser = (u) => ({
  id: u.id, name: u.name, phone: realPhone(u.phone), email: u.email,
  verified: !!u.verified, verifyStatus: u.verify_status || "none",
  businessName: u.business_name || "", businessType: u.business_type || "",
  bio: u.bio || "", language: u.language || "en", avatarUrl: u.avatar_url || "",
  dob: u.dob || "", country: u.country || "Kenya", county: u.county || "", town: u.town || "",
  idNumber: u.id_number || "", legalName: u.legal_name || "",
  gender: u.gender || "", contactPref: u.contact_pref || "", whatsapp: u.whatsapp || "",
  businessRole: u.business_role || "", businessSince: u.business_since || "", website: u.website || "", businessAddress: u.business_address || "",
  idType: u.id_type || "", kraPin: u.kra_pin || "",
  emailVerified: !!u.email_verified,
  phoneVerified: !!u.phone_verified,
  hasPassword: !!u.password_hash, needsSetup: !realPhone(u.phone),
  role: u.role
});
// send a fresh email verification code to a user; returns true if a mail was sent
async function sendEmailCode(userId, email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='email'").run(userId);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+3 minutes'))")
    .run(userId, "email", email, code);
  const user=db.prepare("SELECT name FROM users WHERE id=?").get(userId);
  const first=String(user?.name||"there").trim().split(/\s+/)[0];
  const hour=new Date().getHours(), greeting=hour<12?"Good morning":hour<18?"Good afternoon":"Good evening";
  const html=authEmailHtml({greeting:`${greeting} ${first}!`,code,kind:"verification"});
  await sendMail({
    to: email,
    subject: "PataHome code",
    text: `${greeting} ${first}!\n\nYour PataHome verification code is ${code}. It expires in 3 minutes.\n\n— PataHome · patahome.co.ke`, html
  });
  return true;
}
function authEmailHtml({greeting,code,kind="verification"}) {
  const intro=kind==="reset"?"Use this code to reset your PataHome password.":"Use this code to verify your PataHome account.";
  return `<!doctype html><html><body style="margin:0;background:#f4faf7;font-family:Arial,sans-serif;color:#17352b"><div style="max-width:560px;margin:28px auto;background:#fff;border:1px solid #d9e9e0;border-radius:18px;overflow:hidden"><div style="padding:24px 28px;background:#063f2e;color:#fff"><img src="https://patahome.co.ke/patahome-logo-transparent.png" alt="PataHome" style="height:54px;width:auto;display:block;background:#fff;border-radius:10px;padding:4px"><p style="margin:16px 0 0;color:#bff3db;font-size:14px;font-weight:700;letter-spacing:.04em">Kwa sababu tunakujali</p></div><div style="padding:30px 28px"><h1 style="font-size:24px;margin:0 0 12px;color:#063f2e">${greeting}</h1><p style="font-size:16px;line-height:1.6;margin:0 0 8px">${intro}</p><p style="font-size:14px;color:#63766d;margin:0 0 22px">This code expires in <b>3 minutes</b>.</p><div style="font-size:36px;letter-spacing:10px;text-align:center;font-weight:800;color:#087b61;background:#e8f8f0;border:1px dashed #73c7a4;border-radius:14px;padding:18px 10px;margin:0 0 22px">${code}</div><p style="font-size:13px;color:#63766d;line-height:1.6">If you didn’t request this email, you can safely ignore it.</p></div><div style="padding:18px 28px;background:#f4faf7;color:#63766d;font-size:12px">Connect with homes that fit your life.<br><b style="color:#087b61">PataHome · patahome.co.ke</b></div></div></body></html>`;
}
/* Phone verification can be switched off without touching the Infobip config —
   useful while a sender ID is still pending operator approval. Set
   PHONE_VERIFY=off in the environment to disable; remove it to re-enable.
   When off: phone signups still work, no codes are sent, and posting a listing
   no longer requires a verified phone. Existing phone_verified flags are left
   untouched, so re-enabling picks up exactly where it left off. */
const phoneVerifyEnabled = () =>
  smsConfigured() && String(process.env.PHONE_VERIFY || "").toLowerCase() !== "off";

// send a fresh SMS verification code to a user's phone
async function sendPhoneCode(userId, phone) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='phone'").run(userId);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+3 minutes'))")
    .run(userId, "phone", phone, code);
  await sendSms({
    to: phone,
    text: `${code} is your PataHome verification code. It expires in 15 minutes. Do not share it with anyone.`
  });
  return true;
}
const age = (dob) => { const d = new Date(dob); return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 31557600000); };
const authResponse = (res, code, u, req) => {
  const token=createSession(u,req);
  res.setHeader("Set-Cookie", `ph_session=${encodeURIComponent(token)}; Path=/; Max-Age=${Math.ceil(SESSION_MAX_MS/1000)}; HttpOnly; SameSite=Lax${req.headers["x-forwarded-proto"] === "https" || req.socket.encrypted ? "; Secure" : ""}`);
  send(res, code, { token, user: publicUser(u) });
};

/* ================= step-up confirmation for critical actions =================
   Changing phone/email/password or deleting the account needs a fresh 6-digit
   code (10 min, 5 tries, single use) sent to the account's email. If the
   account has no usable email: verified phone by SMS, else the current password.
   Flow: call the action → 403 {stepUp:{...}} (code already sent) → call again
   with {securityCode} (or {currentPassword}). */
const STEP_UP_ACTIONS = { phone: "change your phone number", email: "change your email", password: "change your password", delete: "delete your account" };
const maskEmail = (e) => { const [a, d] = String(e).split("@"); return (a.length <= 2 ? a[0] + "*" : a.slice(0, 2) + "***") + "@" + d; };
const maskPhone = (p) => String(p).slice(0, 4) + "***" + String(p).slice(-2);
function stepUpChannel(row) {
  if (row.email && row.email_verified) return { channel: "email", to: row.email, target: maskEmail(row.email) };
  if (realPhone(row.phone) && row.phone_verified && phoneVerifyEnabled()) return { channel: "sms", to: row.phone, target: maskPhone(row.phone) };
  if (row.password_hash) return { channel: "password" };
  if (row.email) return { channel: "email", to: row.email, target: maskEmail(row.email) };
  return null;
}
async function sendStepUpCode(row, action, ch) {
  const code = String(crypto.randomInt(100000, 1000000));
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='stepup'").run(row.id);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+10 minutes'))")
    .run(row.id, "stepup", action, code);
  const what = STEP_UP_ACTIONS[action];
  if (ch.channel === "sms") await sendSms({ to: ch.to, text: `${code} is your PataHome security code to ${what}. Never share it. If this wasn't you, change your password.` });
  else await sendMail({ to: ch.to, subject: `${code} is your PataHome security code`,
    text: `Hi ${row.name || ""},\n\nSomeone (hopefully you) asked to ${what} on PataHome.\n\nYour security code is: ${code}\n\nIt expires in 10 minutes. If this wasn't you, don't share the code — change your password and contact us at info@patahome.co.ke.\n\n— PataHome · patahome.co.ke` });
}
// Returns true when the request carries valid proof; otherwise responds and returns false.
async function requireStepUp(req, res, u, action) {
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  const ch = stepUpChannel(row);
  if (!ch) return true; // nothing to verify against (shouldn't happen for real accounts)
  const b = req.body || {};
  if (ch.channel === "password") {
    if (b.currentPassword && verifyPassword(String(b.currentPassword), row.password_hash)) return true;
    send(res, b.currentPassword ? 401 : 403, b.currentPassword ? { error: "That password is wrong" }
      : { error: "Confirm it's you", stepUp: { action, channel: "password" } });
    return false;
  }
  const pending = db.prepare("SELECT * FROM verify_codes WHERE user_id=? AND kind='stepup'").get(u.id);
  if (b.securityCode) {
    if (!pending || pending.target !== action) { send(res, 400, { error: "No pending code — tap Resend" }); return false; }
    if (new Date(pending.expires_at + "Z") < new Date()) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(pending.id); send(res, 400, { error: "Code expired — tap Resend" }); return false; }
    if (pending.attempts >= 5) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(pending.id); send(res, 400, { error: "Too many attempts — tap Resend for a new code" }); return false; }
    if (pending.code !== String(b.securityCode).trim()) { db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(pending.id); send(res, 400, { error: "Wrong code — check and try again" }); return false; }
    db.prepare("DELETE FROM verify_codes WHERE id=?").run(pending.id);
    return true;
  }
  // No code yet: send one (unless a fresh one for this action went out < 60 s ago)
  const fresh = pending && pending.target === action && (Date.now() - new Date(pending.created_at + "Z").getTime()) < 60e3;
  let sent = !!fresh;
  if (!fresh) {
    try { await sendStepUpCode(row, action, ch); sent = true; }
    catch (e) { console.error("step-up send failed:", e.message); send(res, 400, { error: "Couldn't send your security code — please try again shortly" }); return false; }
  }
  send(res, 403, { error: "Confirm it's you", stepUp: { action, channel: ch.channel, target: ch.target, sent } });
  return false;
}
router.add("POST", "/api/account/security-code", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const action = String((req.body || {}).action || "");
  if (!STEP_UP_ACTIONS[action]) return send(res, 400, { error: "Unknown action" });
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  const ch = stepUpChannel(row);
  if (!ch || ch.channel === "password") return send(res, 200, { channel: ch ? "password" : null });
  const pending = db.prepare("SELECT created_at FROM verify_codes WHERE user_id=? AND kind='stepup'").get(u.id);
  if (pending) {
    const wait = 60 - Math.floor((Date.now() - new Date(pending.created_at + "Z").getTime()) / 1000);
    if (wait > 0) return send(res, 429, { error: `Please wait ${wait}s before requesting another code`, retryIn: wait });
  }
  try { await sendStepUpCode(row, action, ch); }
  catch (e) { console.error("step-up send failed:", e.message); return send(res, 400, { error: "Couldn't send the code — try again shortly" }); }
  send(res, 200, { channel: ch.channel, target: ch.target, sent: true });
});
// Best-effort "your account changed" notice to the account email.
function securityNotice(row, what) {
  if (!row || !row.email || !mailConfigured()) return;
  sendMail({ to: row.email, subject: "PataHome security notice",
    text: `Hi ${row.name || ""},\n\n${what} on your PataHome account just now.\n\nIf this was you, no action is needed. If it wasn't, reset your password immediately and contact info@patahome.co.ke.\n\n— PataHome · patahome.co.ke` })
    .catch(e => console.error("security notice failed:", e.message));
}

/* Sign up with ONE identifier — either a Kenyan phone or an email.
   Whichever they give is the one we verify; the other is added later in
   profile settings. Everything else (birthday, county, town) moved there too. */
router.add("POST", "/api/auth/register", async (req, res) => {
  const { name, password } = req.body || {};
  const identifier = String((req.body && (req.body.identifier ?? req.body.phone ?? req.body.email)) || "").trim();
  if (!name || !identifier || !password)
    return send(res, 400, { error: "Name, phone or email, and password are required" });
  if (password.length < 8) return send(res, 400, { error: "Password must be at least 8 characters" });
  if (settingOn("pause_signups")) return send(res, 400, { error: "New sign-ups are paused for a short while. " + setting("maintenance_message") });

  const isEmail = identifier.includes("@");
  let phone = null, email = null;
  if (isEmail) {
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(identifier))
      return send(res, 400, { error: "Enter a valid email address" });
    if (!mailConfigured())
      return send(res, 400, { error: "Email sign-up isn't available right now — please use your phone number" });
    email = identifier.toLowerCase();
    // phone is NOT NULL UNIQUE, so park a placeholder until they add a real one.
    // realPhone() rejects it, which is what gates listing creation.
    phone = "e." + email;
  } else {
    if (!/^0[17]\d{8}$/.test(identifier))
      return send(res, 400, { error: "Enter a valid Kenyan phone e.g. 0712345678, or an email address" });
    phone = identifier;
  }
  if (isBlockedIdentifier(isEmail ? "email" : "phone", isEmail ? email : phone))
    return send(res, 403, { error: "This " + (isEmail ? "email" : "phone number") + " can't be used to create an account. Contact info@patahome.co.ke if you think this is a mistake." });
  // Only ask for an SMS code when phone verification is actually switched on.
  const verifyPhone = !isEmail && phoneVerifyEnabled();

  let user;
  try {
    // The identifier they signed up with starts unverified; the absent one is
    // marked verified so it never shows a stale "verify me" prompt.
    const info = db.prepare("INSERT INTO users (name,phone,email,password_hash,country,email_verified,phone_verified) VALUES (?,?,?,?,?,?,?)")
      .run(name.trim(), phone, email, hashPassword(password), "Kenya",
           isEmail ? 0 : 1, isEmail ? 1 : 0);
    user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
    applyReferral(user.id, req.body.ref);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(user.id, "system", "Karibu to PataHome", "Your account is ready. Post your first listing to start receiving leads.");
  } catch (e) {
    if (String(e).includes("UNIQUE"))
      return send(res, 409, { error: isEmail ? "That email is already registered" : "That phone number is already registered" });
    throw e;
  }

  // Send the code for whichever identifier they used. A gateway failure must not
  // lose the signup — the account exists and they can resend from settings.
  const willVerify = isEmail || verifyPhone;
  if (willVerify) {
    try {
      if (isEmail) await sendEmailCode(user.id, email);
      else await sendPhoneCode(user.id, phone);
    } catch (e) {
      console.error(`signup ${isEmail ? "mail" : "sms"} failed:`, e.message);
    }
  }

  send(res, 201, {
    token: createSession(user, req),
    user: publicUser(user),
    verifyKind: willVerify ? (isEmail ? "email" : "phone") : null,
    verifyTarget: willVerify ? identifier : null,
    // kept for older clients still reading the previous field names
    emailVerifyRequired: isEmail, emailTarget: isEmail ? email : null,
    phoneVerifyRequired: verifyPhone, phoneTarget: verifyPhone ? phone : null
  });
});

/* verify the signed-in user's own email with a code (used at signup + resend) */
router.add("POST", "/api/auth/verify-email/send", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (!row || !row.email) return send(res, 400, { error: "No email on file" });
  if (row.email_verified) return send(res, 200, { alreadyVerified: true });
  if (!mailConfigured()) return send(res, 503, { error: "Email sending isn't configured yet" });
  try { await sendEmailCode(u.id, row.email); send(res, 200, { ok: true, target: row.email }); }
  catch (e) { console.error("verify-email send failed:", e.message); send(res, 400, { error: "Couldn't send the code (" + String(e.message).slice(0, 90) + ")" }); }
});

router.add("POST", "/api/auth/verify-email/confirm", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const code = String(req.body.code || "").trim();
  const row = db.prepare("SELECT * FROM verify_codes WHERE user_id=? AND kind='email'").get(u.id);
  if (!row) return send(res, 400, { error: "No pending code — request a new one" });
  if (new Date(row.expires_at + "Z") < new Date()) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id); return send(res, 400, { error: "Code expired — request a new one" }); }
  if (row.attempts >= 5) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id); return send(res, 400, { error: "Too many attempts — request a new code" }); }
  if (row.code !== code) { db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(row.id); return send(res, 400, { error: "Wrong code — check the email and try again" }); }
  db.prepare("UPDATE users SET email_verified=1 WHERE id=?").run(u.id);
  db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
  send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

/* verify the signed-in user's own phone with an SMS code */
router.add("POST", "/api/auth/verify-phone/send", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  const phone = realPhone(row && row.phone);
  if (!phone) return send(res, 400, { error: "No phone number on file" });
  if (row.phone_verified) return send(res, 200, { alreadyVerified: true });
  if (!phoneVerifyEnabled()) return send(res, 400, { error: "Phone verification is temporarily unavailable" });
  // Cooldown: repeat taps burn SMS credit and can trip carrier throttling.
  const last = db.prepare("SELECT created_at FROM verify_codes WHERE user_id=? AND kind='phone'").get(u.id);
  if (last) {
    const secs = Math.round((Date.now() - new Date(last.created_at + "Z").getTime()) / 1000);
    if (secs < 60) return send(res, 429, { error: `Please wait ${60 - secs}s before requesting another code`, retryIn: 60 - secs });
  }
  try { await sendPhoneCode(u.id, phone); send(res, 200, { ok: true, target: phone }); }
  catch (e) { console.error("verify-phone send failed:", e.message); send(res, 400, { error: "Couldn't send the code (" + String(e.message).slice(0, 90) + ")" }); }
});

router.add("POST", "/api/auth/verify-phone/confirm", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const code = String(req.body.code || "").trim();
  const row = db.prepare("SELECT * FROM verify_codes WHERE user_id=? AND kind='phone'").get(u.id);
  if (!row) return send(res, 400, { error: "No pending code — request a new one" });
  if (new Date(row.expires_at + "Z") < new Date()) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id); return send(res, 400, { error: "Code expired — request a new one" }); }
  if (row.attempts >= 5) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id); return send(res, 400, { error: "Too many attempts — request a new code" }); }
  if (row.code !== code) { db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(row.id); return send(res, 400, { error: "Wrong code — check the SMS and try again" }); }
  db.prepare("UPDATE users SET phone_verified=1 WHERE id=?").run(u.id);
  db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
  send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.add("POST", "/api/auth/login", (req, res) => {
  const { phone, email, password } = req.body || {};
  const id = (phone || email || "").trim();
  const user = db.prepare("SELECT * FROM users WHERE phone=? OR (email IS NOT NULL AND email=?)").get(id, id.toLowerCase());
  if (!user || !user.password_hash || !verifyPassword(password || "", user.password_hash))
    return send(res, 401, { error: "Wrong phone/email or password" });
  const ban = banMessage(user); if (ban) return send(res, 403, { error: ban, code: "BANNED" });
  if (user.role === "admin") return startAdmin2fa(req, res, user);
  authResponse(res, 200, user, req);
});

/* Admins confirm every login with a one-time code (email, else SMS). If no channel
   is available the login still works, but the super admin is alerted. */
async function startAdmin2fa(req, res, user) {
  const ch = user.email && mailConfigured() ? { channel: "email", to: user.email, target: maskEmail(user.email) }
    : realPhone(user.phone) && smsConfigured() ? { channel: "sms", to: user.phone, target: maskPhone(user.phone) } : null;
  if (!ch) {
    adminAlert("Admin signed in without a second step", `${user.name} (#${user.id}) — add an email to this admin account so logins need a code.`);
    return finishAdminLogin(req, res, user, "password only");
  }
  const code = String(crypto.randomInt(100000, 1000000)), challenge = crypto.randomBytes(18).toString("base64url");
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='admin2fa'").run(user.id);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+10 minutes'))").run(user.id, "admin2fa", challenge, code);
  try {
    if (ch.channel === "sms") await sendSms({ to: ch.to, text: `${code} is your PataHome admin login code. Never share it.` });
    else await sendMail({ to: ch.to, subject: `${code} is your PataHome admin login code`,
      text: `Your PataHome admin login code is ${code}. It expires in 10 minutes.\n\nIf you didn't just try to sign in, change your password now.\n\nIP: ${clientIp(req)}\nDevice: ${String(req.headers["user-agent"] || "").slice(0, 160)}` });
  } catch (e) { console.error("admin 2fa send failed:", e.message); return send(res, 400, { error: "Couldn't send your login code — please try again" }); }
  send(res, 200, { twoFactor: { challenge, channel: ch.channel, target: ch.target } });
}
function finishAdminLogin(req, res, user, how) {
  const ip = clientIp(req);
  const seen = ip && db.prepare("SELECT 1 FROM admin_audit WHERE admin_id=? AND action='login' AND ip=? LIMIT 1").get(user.id, ip);
  audit(req, user, "login", "user", user.id, how);
  if (ip && !seen) adminAlert("Admin login from a new place", `${user.name} (#${user.id}) signed in from ${ip}${req.headers["cf-ipcity"] ? " (" + req.headers["cf-ipcity"] + ")" : ""}.\nDevice: ${String(req.headers["user-agent"] || "").slice(0, 160)}`);
  authResponse(res, 200, user, req);
}
router.add("POST", "/api/auth/login/verify", (req, res) => {
  const b = req.body || {};
  const row = db.prepare("SELECT * FROM verify_codes WHERE kind='admin2fa' AND target=?").get(String(b.challenge || ""));
  if (!row) return send(res, 400, { error: "This login attempt has expired — log in again" });
  if (new Date(row.expires_at + "Z") < new Date() || row.attempts >= 5) { db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id); return send(res, 400, { error: "Code expired or too many tries — log in again" }); }
  if (row.code !== String(b.code || "").trim()) { db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(row.id); return send(res, 400, { error: "Wrong code — check and try again" }); }
  db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
  const user = db.prepare("SELECT * FROM users WHERE id=?").get(row.user_id);
  if (!user) return send(res, 400, { error: "Account not found" });
  const ban = banMessage(user); if (ban) return send(res, 403, { error: ban, code: "BANNED" });
  finishAdminLogin(req, res, user, "password + code");
});

router.add("POST", "/api/auth/forgot-password", async (req, res) => {
  const id=String(req.body?.identifier||"").trim();
  const user=db.prepare("SELECT * FROM users WHERE email=? OR phone=?").get(id.toLowerCase(),id);
  // Always return the same response so the endpoint cannot reveal whether an account exists.
  if(!user||!user.email)return send(res,200,{ok:true});
  const code=String(Math.floor(100000+Math.random()*900000));
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='password_reset'").run(user.id);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+3 minutes'))").run(user.id,"password_reset",user.email,code);
  try{await sendMail({to:user.email,subject:"PataHome code",text:`Your PataHome password reset code is ${code}. It expires in 3 minutes.`,html:authEmailHtml({greeting:`Good day ${String(user.name||"there").split(/\s+/)[0]}!`,code,kind:"reset"})});}catch(e){console.error("password reset email failed:",e.message)}
  send(res,200,{ok:true});
});
router.add("POST", "/api/auth/reset-password", (req,res) => {
  const {identifier,code,password}=req.body||{};
  if(!password||password.length<8)return send(res,400,{error:"Password must be at least 8 characters"});
  const user=db.prepare("SELECT * FROM users WHERE email=? OR phone=?").get(String(identifier||"").toLowerCase(),String(identifier||""));
  const row=user&&db.prepare("SELECT * FROM verify_codes WHERE user_id=? AND kind='password_reset'").get(user.id);
  if(!row)return send(res,400,{error:"No pending code — request a new one"});
  if(new Date(row.expires_at+"Z")<new Date()){db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);return send(res,400,{error:"Code expired — request a new one"});}
  if(row.attempts>=5)return send(res,400,{error:"Too many attempts — request a new code"});
  if(String(code||"")!==row.code){db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(row.id);return send(res,400,{error:"Wrong code"});}
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(password),user.id);db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);send(res,200,{ok:true});
});

/* Google Sign-In: browser sends the Google ID token; we verify it via Google's tokeninfo. */
router.add("POST", "/api/auth/google", async (req, res) => {
  if (!GOOGLE_CLIENT_ID) return send(res, 503, { error: "Google sign-in is not configured yet" });
  const { credential } = req.body || {};
  if (!credential) return send(res, 400, { error: "Missing Google credential" });
  try {
    const r = await fetch("https://oauth2.googleapis.com/tokeninfo?id_token=" + encodeURIComponent(credential),
      { signal: AbortSignal.timeout(8000) });
    const p = await r.json();
    if (!r.ok || p.aud !== GOOGLE_CLIENT_ID || !p.email_verified) return send(res, 401, { error: "Google sign-in failed" });
    let user = db.prepare("SELECT * FROM users WHERE google_id=? OR email=?").get(p.sub, (p.email || "").toLowerCase());
    if (user && user.role === "admin") return send(res, 403, { error: "Admin accounts sign in with a password and code at /admin" });
    if (user) { const ban = banMessage(user); if (ban) return send(res, 403, { error: ban, code: "BANNED" }); }
    if (!user && settingOn("pause_signups")) return send(res, 400, { error: "New sign-ups are paused for a short while. " + setting("maintenance_message") });
    if (!user && isBlockedIdentifier("email", (p.email || "").toLowerCase())) return send(res, 403, { error: "This email can't be used to create an account." });
    if (user) {
      if (!user.google_id) db.prepare("UPDATE users SET google_id=?, avatar_url=COALESCE(avatar_url,?) WHERE id=?").run(p.sub, p.picture || null, user.id);
    } else {
      const info = db.prepare("INSERT INTO users (name,phone,email,password_hash,google_id,avatar_url,email_verified) VALUES (?,?,?,?,?,?,1)")
        .run(p.name || "PataHome User", "g." + p.sub, (p.email || "").toLowerCase(), "", p.sub, p.picture || null);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
      applyReferral(user.id, (req.body || {}).ref);
      db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
        .run(user.id, "system", "Karibu to PataHome", "Add your phone number in Settings to start posting listings.");
    }
    authResponse(res, 200, user, req);
  } catch (e) {
    console.error("google auth error:", e.message);
    // 401 (not 502) — Cloudflare replaces 502 responses with its own HTML page
    send(res, 401, { error: "Could not verify Google sign-in — please try again" });
  }
});

router.add("POST", "/api/auth/logout", (req, res) => {
  const u = getUser(req);
  if (u && u.sid) db.prepare("DELETE FROM sessions WHERE id=?").run(u.sid);
  res.setHeader("Set-Cookie", "ph_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Lax");
  send(res, 200, { ok: true });
});
router.add("POST", "/api/auth/logout-all", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const n = revokeSessions(u.id).changes;
  send(res, 200, { ok: true, signedOut: n });
});

router.add("GET", "/api/auth/me", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (!row) return send(res, 404, { error: "Account not found" });
  send(res, 200, publicUser(row));
});

/* ================= account settings ================= */
router.add("PATCH", "/api/account", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const map = { name: "name", businessName: "business_name", businessType: "business_type", bio: "bio", language: "language",
    county: "county", town: "town", country: "country", dob: "dob",
    gender: "gender", contactPref: "contact_pref", whatsapp: "whatsapp", avatarUrl: "avatar_url",
    businessRole: "business_role", businessSince: "business_since", website: "website", businessAddress: "business_address" };
  // Birthday is collected here rather than at signup, so the 18+ rule lives here.
  if (req.body.dob !== undefined && String(req.body.dob).trim() !== "") {
    const a = age(req.body.dob);
    if (a === null || a > 120) return send(res, 400, { error: "Enter a valid date of birth" });
    if (a < 18) return send(res, 400, { error: "You must be at least 18 years old to use PataHome" });
  }
  if (req.body.whatsapp && isBlockedIdentifier("whatsapp", req.body.whatsapp))
    return send(res, 403, { error: "That WhatsApp number can't be used on PataHome." });
  const sets = [], params = [];
  for (const [k, col] of Object.entries(map)) if (req.body[k] !== undefined) {
    sets.push(`${col}=?`); params.push(String(req.body[k]).slice(0, 400));
  }
  if (!sets.length) return send(res, 400, { error: "Nothing to update" });
  db.prepare(`UPDATE users SET ${sets.join(",")} WHERE id=?`).run(...params, u.id);
  send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.add("POST", "/api/account/change-phone", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const phone = (req.body.phone || "").trim();
  if (!/^0[17]\d{8}$/.test(phone)) return send(res, 400, { error: "Enter a valid Kenyan phone e.g. 0712345678" });
  const before = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (before && before.phone === phone)
    return send(res, 200, publicUser(before));
  // Replacing an existing number is critical; adding a first one (new or Google accounts) isn't.
  const replacing = !!realPhone(before && before.phone);
  // check before asking for a security code, so a code isn't spent on a number that can't be used
  if (db.prepare("SELECT id FROM users WHERE phone=? AND id!=?").get(phone, u.id)) return send(res, 409, { error: "That phone is already registered" });
  if (replacing && !(await requireStepUp(req, res, u, "phone"))) return;
  try {
    // A new number is unverified until proven — otherwise someone could verify
    // one phone then swap in another and keep the trusted badge.
    db.prepare("UPDATE users SET phone=?, phone_verified=0 WHERE id=?").run(phone, u.id);
  } catch (e) { return send(res, 409, { error: "That phone is already registered" }); }
  if (replacing) { revokeSessions(u.id, u.sid); securityNotice(before, `Your phone number was changed to ${maskPhone(phone)}`); }
  let codeSent = false;
  const wantVerify = phoneVerifyEnabled();
  if (wantVerify) {
    try { await sendPhoneCode(u.id, phone); codeSent = true; }
    catch (e) { console.error("change-phone sms failed:", e.message); }
  }
  const user = publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id));
  send(res, 200, Object.assign(user, { verifyKind: wantVerify ? "phone" : null, verifyTarget: wantVerify ? phone : null, codeSent }));
});

router.add("POST", "/api/account/change-email", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const email = (req.body.email || "").trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return send(res, 400, { error: "Enter a valid email address" });
  const taken = db.prepare("SELECT id FROM users WHERE email=? AND id!=?").get(email, u.id);
  if (taken) return send(res, 409, { error: "That email is already registered" });
  const cur = db.prepare("SELECT email FROM users WHERE id=?").get(u.id);
  // Resending the code for a change that already passed step-up shouldn't ask again.
  const pendingNew = db.prepare("SELECT target FROM verify_codes WHERE user_id=? AND kind='email'").get(u.id);
  const alreadyAuthorised = pendingNew && pendingNew.target === email;
  if (cur && cur.email && cur.email !== email && !alreadyAuthorised && !(await requireStepUp(req, res, u, "email"))) return;
  if (!mailConfigured()) {
    // no mail provider configured yet — apply directly (legacy behavior)
    db.prepare("UPDATE users SET email=? WHERE id=?").run(email, u.id);
    return send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  db.prepare("DELETE FROM verify_codes WHERE user_id=? AND kind='email'").run(u.id);
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+3 minutes'))")
    .run(u.id, "email", email, code);
  try {
    await sendMail({
      to: email,
      subject: "PataHome code",
      text: `Your PataHome verification code is ${code}. It expires in 3 minutes.`,
      html: authEmailHtml({greeting:`Good day ${String(u.name||"there").trim().split(/\s+/)[0]}!`,code})
    });
  } catch (e) {
    console.error("sendMail failed:", e.message);
    // 400 (not 502/503) — Cloudflare replaces 5xx responses with its own error page
    return send(res, 400, { error: "Couldn't send the code (" + String(e.message).slice(0, 90) + ")" });
  }
  send(res, 200, { codeRequired: true, target: email });
});

router.add("POST", "/api/account/change-email/confirm", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const code = String(req.body.code || "").trim();
  const row = db.prepare("SELECT * FROM verify_codes WHERE user_id=? AND kind='email'").get(u.id);
  if (!row) return send(res, 400, { error: "No pending code — request a new one" });
  if (new Date(row.expires_at + "Z") < new Date()) {
    db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
    return send(res, 400, { error: "Code expired — request a new one" });
  }
  if (row.attempts >= 5) {
    db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
    return send(res, 400, { error: "Too many attempts — request a new code" });
  }
  if (row.code !== code) {
    db.prepare("UPDATE verify_codes SET attempts=attempts+1 WHERE id=?").run(row.id);
    return send(res, 400, { error: "Wrong code — check the email and try again" });
  }
  const prev = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  try {
    db.prepare("UPDATE users SET email=?, email_verified=1 WHERE id=?").run(row.target, u.id);
  } catch (e) { return send(res, 409, { error: "That email is already registered" }); }
  db.prepare("DELETE FROM verify_codes WHERE id=?").run(row.id);
  if (prev.email && prev.email !== row.target) { revokeSessions(u.id, u.sid); securityNotice(prev, `Your email was changed to ${maskEmail(row.target)}`); }
  send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.add("POST", "/api/account/change-password", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { currentPassword, newPassword } = req.body || {};
  if (!newPassword || newPassword.length < 8) return send(res, 400, { error: "New password must be at least 8 characters" });
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (row.password_hash) {
    if (!verifyPassword(currentPassword || "", row.password_hash)) return send(res, 401, { error: "Current password is wrong" });
  }
  if (!(await requireStepUp(req, res, u, "password"))) return;
  db.prepare("UPDATE users SET password_hash=? WHERE id=?").run(hashPassword(newPassword), u.id);
  revokeSessions(u.id, u.sid); // sign out every other device
  securityNotice(row, row.password_hash ? "Your password was changed" : "A password was added");
  send(res, 200, { ok: true });
});

router.add("POST", "/api/account/request-verification", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { legalName, idType, idNumber, kraPin, docs } = req.body || {};
  if (!legalName || !String(legalName).trim()) return send(res, 400, { error: "Enter your full legal name as it appears on your ID" });
  const type = ["National ID", "Passport", "Alien ID"].includes(idType) ? idType : "National ID";
  const idn = String(idNumber || "").trim();
  if (type === "National ID" && !/^\d{6,10}$/.test(idn)) return send(res, 400, { error: "Enter a valid national ID number" });
  if (type !== "National ID" && idn.length < 5) return send(res, 400, { error: "Enter a valid ID/passport number" });
  const docList = Array.isArray(docs) ? docs.filter(d => typeof d === "string" && d.startsWith("patahome/") && /^[\w\-/]{1,200}$/.test(d)).slice(0, 4) : [];
  if (cldEnabled() && !docList.length) return send(res, 400, { error: "Upload a photo of your ID document" });
  db.prepare("UPDATE users SET verify_status='pending', legal_name=?, id_type=?, id_number=?, kra_pin=?, verify_docs=? WHERE id=? AND verified=0")
    .run(String(legalName).trim().slice(0, 120), type, idn, String(kraPin || "").trim().slice(0, 20), JSON.stringify(docList), u.id);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
    .run(u.id, "verify", "Verification submitted", "Our team will review your details and verify your account shortly.");
  send(res, 200, publicUser(db.prepare("SELECT * FROM users WHERE id=?").get(u.id)));
});

router.add("DELETE", "/api/account", async (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM users WHERE id=?").get(u.id);
  if (row.role === "admin") return send(res, 403, { error: "Admin accounts can't be self-deleted" });
  if (row.password_hash && !verifyPassword((req.body && req.body.password) || "", row.password_hash))
    return send(res, 401, { error: "Enter your current password to delete your account" });
  if (!(await requireStepUp(req, res, u, "delete"))) return;
  // reclaim listing photos, then remove the account (cascades to listings/followers/notifications)
  for (const l of db.prepare("SELECT photos, video FROM listings WHERE owner_id=?").all(u.id)) {
    for (const id of parsePhotos(l.photos)) cldDestroy(id);
    if (l.video) cldDestroyVideo(l.video);
  }
  // ID documents go too (privacy policy: deleted with the account)
  for (const id of parsePhotos(row.verify_docs)) cldDestroy(id);
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  send(res, 200, { ok: true });
});

/* ================= public config ================= */
router.add("GET", "/api/config", (req, res) => {
  send(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, cloudinary: cldEnabled(), phoneVerify: phoneVerifyEnabled(),
    sessionIdleMinutes: Math.round(SESSION_IDLE_MS / 60e3), maxPhotos: CLD.maxPhotos,
    announcement: settingOn("announce_on") && setting("announce_text") ? { text: setting("announce_text"), level: setting("announce_level"), link: setting("announce_link") } : null,
    pauseListings: settingOn("pause_listings"), pauseSignups: settingOn("pause_signups"),
    maintenanceMessage: settingOn("pause_listings") || settingOn("pause_signups") ? setting("maintenance_message") : "" });
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

/* ================= search (browse page) =================
   The browse page used to download up to 100 listings and filter them in the
   browser, so listing #101+ never appeared. Filtering, keyword ranking, sorting
   and paging now happen here; the page asks for 20 at a time.
   Returns: { total, page, perPage, hasMore, counts, listings, pins }
   - counts: active listings per category (for the tabs), ignores other filters
   - pins:   lightweight {id,lat,lng,price,category,title,area} for EVERY match
             (page 1 only) so the map can show all results, not just the page. */
const SEARCH_CAT_LABEL = { rent: "for rent", sale: "for sale", shortlet: "airbnb short stay", land: "land plot plots acre acres shamba farm", commercial: "commercial business premises" };
const SEARCH_STOP = new Set(["in","near","at","the","a","an","for","and","with","to","of","under","below","max","na","ya","kwa","karibu","house","houses","home","homes","nyumba","property","kenya"]);
const SEARCH_EXPAND = {
  keja:["for rent"],kejas:["for rent"],rent:["for rent"],rental:["for rent"],rentals:["for rent"],kukodi:["for rent"],
  sale:["for sale"],buy:["for sale"],buying:["for sale"],sell:["for sale"],selling:["for sale"],kununua:["for sale"],
  bedsitter:["bedsitter","studio"],bedsitters:["bedsitter","studio"],studio:["bedsitter","studio"],
  "1br":["1 bedroom"],one:["1 bedroom"],"2br":["2 bedroom"],two:["2 bedroom"],"3br":["3 bedroom"],three:["3 bedroom"],
  flat:["apartment"],apt:["apartment"],airbnb:["airbnb"],bnb:["airbnb"],
  shamba:["land","farm"],ardhi:["land"],plots:["plot"],acres:["acre"],lease:["lease"],leasing:["lease"],kukodisha:["lease"],farm:["farm","land"],
  duka:["shop"],shops:["shop"],stall:["shop"],ofisi:["office"],offices:["office"],godown:["warehouse","godown"],godowns:["warehouse","godown"],
  warehouses:["warehouse"],commercial:["commercial"],business:["commercial","business"],premises:["premises","commercial"],
  let:["lease"],"to-let":["lease"],hotel:["hotel"],restaurant:["restaurant","hotel"],factory:["factory","industrial"],building:["building"]
};
function parseSearch(q) {
  const tokens = [], caps = [];
  for (const raw of String(q || "").toLowerCase().split(/[\s,]+/).filter(Boolean).slice(0, 12)) {
    const k = raw.match(/^(\d+(?:\.\d+)?)k$/);           // "10k"
    if (k) { caps.push(+k[1] * 1000); continue; }
    if (/^\d{4,}$/.test(raw)) { caps.push(+raw); continue; } // "15000"
    if (SEARCH_STOP.has(raw)) continue;
    tokens.push(raw.slice(0, 40));
  }
  return { tokens, priceCap: caps.length ? Math.min(...caps) : null };
}
// every keyword must match somewhere; title > area > bedrooms > description > category
function searchScore(r, tokens) {
  const title = (r.title || "").toLowerCase(), area = `${r.area_name}, ${r.county}`.toLowerCase();
  const desc = (r.description || "").toLowerCase(), cat = (SEARCH_CAT_LABEL[r.category] || "") + (r.category === "land" || r.category === "commercial" ? (r.land_deal === "lease" ? " lease for lease to let for rent" : " for sale") : "")
    + (r.category === "commercial" ? " " + (COMM.TYPES[r.comm_type] || "").toLowerCase() + " " + (r.comm_type || "") : "");
  const b = r.bedrooms;
  const beds = b === 0 ? "bedsitter studio 0 bedroom" : b != null ? `${b} bedroom ${b} br ${b}br` : "";
  let score = 0;
  for (const t of tokens) {
    let s = 0;
    for (const f of (SEARCH_EXPAND[t] || [t])) {
      if (title.includes(f)) s = Math.max(s, 3);
      if (area.includes(f)) s = Math.max(s, 2.5);
      if (beds.includes(f)) s = Math.max(s, 2.2);
      if (desc.includes(f)) s = Math.max(s, 1.5);
      if (cat.includes(f)) s = Math.max(s, 1);
    }
    if (!s) return 0;
    score += s;
  }
  return score;
}
router.add("GET", "/api/search", (req, res) => {
  const q = req.query;
  const where = ["l.status = 'active'"], params = [];
  if (q.cat && q.cat !== "all") { where.push("l.category = ?"); params.push(String(q.cat)); }
  if (q.price) {
    const [lo, hi] = String(q.price).split("-").map(Number);
    if (Number.isFinite(lo)) { where.push("l.price >= ?"); params.push(lo); }
    if (Number.isFinite(hi)) { where.push("l.price <= ?"); params.push(hi); }
  }
  if (q.beds !== undefined && q.beds !== "") {
    if (String(q.beds) === "3") where.push("l.bedrooms >= 3");
    else { where.push("l.bedrooms = ?"); params.push(+q.beds); }
  }
  if (q.direct === "1") where.push("COALESCE(l.lister_role,'owner') = 'owner'");
  // land-only filters
  if (q.landDeal === "sale" || q.landDeal === "lease") { where.push("l.land_deal = ?"); params.push(q.landDeal); }
  if (+q.minAcres > 0) { where.push("l.size_acres >= ?"); params.push(+q.minAcres); }
  if (+q.maxAcres > 0) { where.push("l.size_acres <= ?"); params.push(+q.maxAcres); }
  if (+q.maxPerAcre > 0) { where.push("l.price_per_acre <= ?"); params.push(+q.maxPerAcre); }
  if (q.landUse && LAND.DETAILS.use[q.landUse]) { where.push("json_extract(l.features,'$.use') = ?"); params.push(q.landUse); }
  if (q.titleReady === "1") where.push("json_extract(l.features,'$.title') = 'ready'");
  // commercial-only filters (deal also accepted as ?deal=)
  if ((q.deal === "sale" || q.deal === "lease") && q.landDeal === undefined) { where.push("l.land_deal = ?"); params.push(q.deal); }
  if (q.commType && COMM.TYPES[q.commType]) { where.push("l.comm_type = ?"); params.push(q.commType); }
  if (+q.minSqft > 0) { where.push("l.area_sqft >= ?"); params.push(+q.minSqft); }
  if (+q.maxSqft > 0) { where.push("l.area_sqft <= ?"); params.push(+q.maxSqft); }
  if (q.ids !== undefined) { // favourites view
    const ids = String(q.ids).split(",").map(Number).filter(n => Number.isInteger(n) && n > 0).slice(0, 200);
    where.push(ids.length ? `l.id IN (${ids.map(() => "?").join(",")})` : "0");
    params.push(...ids);
  }
  const { tokens, priceCap } = parseSearch(q.q);
  if (priceCap !== null) { where.push("l.price <= ?"); params.push(priceCap); }

  let rows = db.prepare(`${LISTING_SQL} WHERE ${where.join(" AND ")}`).all(...params);
  const scores = new Map();
  if (tokens.length) rows = rows.filter(r => { const s = searchScore(r, tokens); if (s) scores.set(r.id, s); return s > 0; });

  const lat = q.lat ? +q.lat : null, lng = q.lng ? +q.lng : null;
  const hasLoc = Number.isFinite(lat) && Number.isFinite(lng) && lat !== null && lng !== null;
  const d = new Map(hasLoc ? rows.map(r => [r.id, km(lat, lng, r.lat, r.lng)]) : []);
  const sort = q.sort || "newest";
  const base = {
    distance: (a, b) => hasLoc ? d.get(a.id) - d.get(b.id) : b.id - a.id,
    "price-asc": (a, b) => a.price - b.price,
    "price-desc": (a, b) => b.price - a.price,
    "acre-asc": (a, b) => (a.price_per_acre ?? 1e15) - (b.price_per_acre ?? 1e15),
    "size-desc": (a, b) => ((b.size_acres ?? 0) - (a.size_acres ?? 0)) || ((b.area_sqft ?? 0) - (a.area_sqft ?? 0)),
    "sqft-asc": (a, b) => (a.price_per_sqft ?? 1e15) - (b.price_per_sqft ?? 1e15),
    newest: (a, b) => b.id - a.id
  }[sort] || ((a, b) => b.id - a.id);
  const now = new Date().toISOString();
  const feat = r => (r.featured_until && r.featured_until > now) ? 1 : 0;
  rows.sort((a, b) => (tokens.length ? (scores.get(b.id) - scores.get(a.id)) : 0) || (feat(b) - feat(a)) || base(a, b));

  const perPage = Math.min(Math.max(+q.perPage || 20, 1), 50), page = Math.max(+q.page || 1, 1);
  const slice = rows.slice((page - 1) * perPage, page * perPage);
  const out = { total: rows.length, page, perPage, hasMore: page * perPage < rows.length,
    listings: slice.map(r => listingView(r, hasLoc ? lat : null, hasLoc ? lng : null)) };
  if (page === 1 && q.q && !q.ids) logSearch(q.q, rows.length);
  if (page === 1) {
    out.pins = rows.map(r => ({ id: r.id, lat: r.lat, lng: r.lng, price: r.price, category: r.category, title: r.title, area: `${r.area_name}, ${r.county}`,
      ...(r.land_deal ? { deal: r.land_deal, landDeal: r.land_deal, priceBasis: r.price_basis, pricePerAcre: r.price_per_acre, pricePerSqft: r.price_per_sqft, areaSqft: r.area_sqft, sizeAcres: r.size_acres } : {}) }));
    const c = { all: 0 };
    for (const x of db.prepare("SELECT category, COUNT(*) n FROM listings WHERE status='active' GROUP BY category").all()) { c[x.category] = x.n; c.all += x.n; }
    out.counts = c;
  }
  send(res, 200, out);
});

/* Approximate visitor location (city-level) from Cloudflare's visitor-location
   headers — lets the homepage sort areas nearest-first without a GPS prompt.
   Requires Cloudflare → Rules → Transform Rules → Managed Transforms →
   "Add visitor location headers" to be ON. Returns {} when unavailable.
   Nothing is stored. */
router.add("GET", "/api/geo", (req, res) => {
  const h = req.headers, lat = parseFloat(h["cf-iplatitude"]), lng = parseFloat(h["cf-iplongitude"]);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return send(res, 200, {});
  send(res, 200, { lat, lng, city: String(h["cf-ipcity"] || "").slice(0, 60), country: String(h["cf-ipcountry"] || "").slice(0, 2) });
});

/* Site-wide numbers for the homepage (totals + per-area counts), independent of paging. */
router.add("GET", "/api/stats/listings", (req, res) => {
  const t = db.prepare("SELECT COUNT(*) n, COUNT(DISTINCT owner_id) owners FROM listings WHERE status='active'").get();
  const byArea = db.prepare(`SELECT a.name area, a.county, COUNT(*) n FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.status='active' GROUP BY a.id ORDER BY n DESC`).all();
  send(res, 200, { total: t.n, owners: t.owners, byArea });
});

router.add("GET", "/api/listings/:id", (req, res, p) => {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  send(res, 200, listingView(row, req.query.lat ? +req.query.lat : null, req.query.lng ? +req.query.lng : null));
});

router.add("POST", "/api/listings", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const me = db.prepare("SELECT phone, email, email_verified, phone_verified FROM users WHERE id=?").get(u.id);
  // A reachable, verified phone is the core trust signal for a listing.
  if (!me || !realPhone(me.phone))
    return send(res, 400, { error: "Add your phone number first (account menu → Change phone number) so tenants can reach you" });
  if (phoneVerifyEnabled() && !me.phone_verified)
    return send(res, 400, { error: "Verify your phone number first (account menu → Verify phone) before posting" });
  if (mailConfigured() && me.email && !me.email_verified)
    return send(res, 400, { error: "Verify your email first (account menu → Verify email) before posting" });
  if (settingOn("pause_listings")) return send(res, 400, { error: "Posting new listings is paused for a short while. " + setting("maintenance_message") });
  const { category, title, description, areaId, price, bedrooms } = req.body || {};
  if (!["rent", "sale", "shortlet", "land", "commercial"].includes(category)) return send(res, 400, { error: "Invalid category" });
  const land = category === "land" ? landFields(req.body) : null;
  if (land && land.error) return send(res, 400, { error: land.error });
  const comm = category === "commercial" ? commFields(req.body) : null;
  if (comm && comm.error) return send(res, 400, { error: comm.error });
  const lister = listerFields(req.body || {});
  if (lister.error) return send(res, 400, { error: lister.error });
  if (!title || !areaId || !price) return send(res, 400, { error: "title, areaId and price are required" });
  const area = db.prepare("SELECT * FROM areas WHERE id=?").get(areaId);
  if (!area) return send(res, 400, { error: "Unknown areaId — see GET /api/areas" });
  let lat = area.lat + (Math.random() - 0.5) * 0.01, lng = area.lng + (Math.random() - 0.5) * 0.01, pinned = 0;
  if (land || comm) {
    const pin = exactPin(req.body, area);
    if (pin && pin.error) return send(res, 400, { error: pin.error });
    if (pin) { lat = pin.lat; lng = pin.lng; pinned = 1; }
  }
  const photos = req.body.photos;
  if (photos !== undefined) {
    if (!Array.isArray(photos) || photos.length > CLD.maxPhotos || !photos.every(validPhotoId))
      return send(res, 400, { error: `photos must be up to ${CLD.maxPhotos} uploaded photo ids` });
  }
  const video = req.body.video ? String(req.body.video) : "";
  if (video && !validVideoId(video)) return send(res, 400, { error: "Invalid video" });
  const info = db.prepare(`INSERT INTO listings (owner_id,category,title,description,area_id,price,bedrooms,lat,lng,photos,lister_role,agent_fee,features,video)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
    .run(u.id, category, title.trim(), description || "", areaId, +price,
         bedrooms == null || bedrooms === "" ? null : +bedrooms, lat, lng,
         JSON.stringify(photos || []), lister.role, lister.fee,
         JSON.stringify(land ? cleanLandFeatures(req.body.features) : comm ? cleanCommFeatures(req.body.features) : cleanFeatures(req.body.features)), video);
  if (land) {
    db.prepare(`UPDATE listings SET bedrooms=NULL, land_deal=?, size_value=?, size_unit=?, size_acres=?, price_basis=?, price_per_acre=?, lease_min=?, exact_pin=?, title_ref=? WHERE id=?`)
      .run(land.deal, land.sizeValue, land.sizeUnit, land.sizeAcres, land.basis, land.perAcre, land.leaseMin, pinned,
           String(req.body.titleRef || "").trim().slice(0, 60) || null, info.lastInsertRowid);
  }
  if (comm) {
    db.prepare(`UPDATE listings SET bedrooms=NULL, land_deal=?, comm_type=?, size_value=?, size_unit=?, area_sqft=?, price_basis=?, price_per_sqft=?, lease_min=?, income_month=?, exact_pin=?, title_ref=? WHERE id=?`)
      .run(comm.deal, comm.type, comm.sizeValue, comm.sizeUnit, comm.areaSqft, comm.basis, comm.perSqft, comm.leaseMin, comm.income, pinned,
           String(req.body.titleRef || "").trim().slice(0, 60) || null, info.lastInsertRowid);
  }
  checkBlocklist(info.lastInsertRowid);
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(info.lastInsertRowid);
  notifyFollowers(u.id, "New listing from an owner you follow", `${row.title} is now live in ${row.area_name}.`).catch(e=>console.error("follower notification failed:",e.message));
  runScamChecks(row.id);
  try { onListingPublished(u.id, row.id); } catch (e) { console.error("referral reward failed:", e.message); }
  fetchNearby(row.id).catch(e => console.error("nearby failed:", e.message));
  setTimeout(() => matchAlerts(row.id), 0);
  send(res, 201, listingView(row));
});

/* ================= listing freshness =================
   A listing stays live for LISTING_TTL_DAYS (default 60) after the owner last
   confirmed it (posting, editing, relisting or tapping "Still available").
   REMIND_DAYS before that the owner gets an email/SMS/in-app nudge with
   one-tap links; at the deadline it's paused (status 'expired', hidden from
   search) until renewed. The sweep runs at boot and then hourly. */
let LISTING_TTL_DAYS = Math.max(7, +process.env.LISTING_TTL_DAYS || 60);
const REMIND_DAYS = 7;
const lastConfirmed = (row) => new Date(String(row.confirmed_at || row.created_at).replace(" ", "T") + "Z").getTime();
const expiryOf = (row) => new Date(lastConfirmed(row) + LISTING_TTL_DAYS * 86400e3).toISOString();
// Signed one-tap link token: valid only for this listing's current confirmation cycle.
const freshToken = (row, action) => crypto.createHmac("sha256", process.env.JWT_SECRET || "dev")
  .update(`fresh:${row.id}:${action}:${row.confirmed_at || row.created_at}`).digest("base64url").slice(0, 32);
function freshnessSweep() {
  const base = process.env.BASE_URL || "https://patahome.co.ke";
  // 1) reminders
  const due = db.prepare(`SELECT l.*, u.email, u.email_verified, u.phone, u.phone_verified, u.name AS owner_name FROM listings l JOIN users u ON u.id=l.owner_id
    WHERE l.status='active' AND datetime(COALESCE(l.confirmed_at,l.created_at)) <= datetime('now', ?)
      AND (l.reminded_at IS NULL OR datetime(l.reminded_at) < datetime(COALESCE(l.confirmed_at,l.created_at)))`)
    .all(`-${LISTING_TTL_DAYS - REMIND_DAYS} days`);
  for (const r of due) {
    db.prepare("UPDATE listings SET reminded_at=datetime('now') WHERE id=?").run(r.id);
    const yes = `${base}/api/listings/${r.id}/fresh?a=yes&t=${freshToken(r, "yes")}`;
    const taken = `${base}/api/listings/${r.id}/fresh?a=taken&t=${freshToken(r, "taken")}`;
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(r.owner_id, "listing", "Is your listing still available?", `"${r.title}" will be paused in ${REMIND_DAYS} days unless you confirm it's still available.`);
    if (r.email && mailConfigured()) sendMail({ to: r.email, subject: `Is "${r.title}" still available?`,
      text: `Hi ${r.owner_name || ""},\n\nYour PataHome listing "${r.title}" has been live for a while. To keep the site accurate for tenants, it will be paused in ${REMIND_DAYS} days unless you confirm it's still available.\n\n✓ Still available — keep it live:\n${yes}\n\n✗ It's taken — mark it rented/sold:\n${taken}\n\n— PataHome · patahome.co.ke` })
      .catch(e => console.error("freshness mail failed:", e.message));
    else if (realPhone(r.phone) && phoneVerifyEnabled()) sendSms({ to: r.phone, text: `PataHome: is "${r.title.slice(0, 40)}" still available? Keep it live: ${yes}` })
      .catch(e => console.error("freshness sms failed:", e.message));
  }
  // 2) expiry
  const stale = db.prepare(`SELECT id, owner_id, title FROM listings WHERE status='active'
    AND datetime(COALESCE(confirmed_at,created_at)) <= datetime('now', ?)`).all(`-${LISTING_TTL_DAYS} days`);
  for (const r of stale) {
    db.prepare("UPDATE listings SET status='expired', status_changed_at=datetime('now') WHERE id=?").run(r.id);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(r.owner_id, "listing", "Listing paused", `"${r.title}" was paused because it hadn't been confirmed in ${LISTING_TTL_DAYS} days. Renew it from your dashboard in one tap.`);
  }
  if (due.length || stale.length) console.log(`[freshness] reminded ${due.length}, paused ${stale.length}`);
}
setTimeout(() => { try { freshnessSweep(); } catch (e) { console.error("freshness sweep:", e.message); } }, 5000);
setInterval(() => { try { freshnessSweep(); } catch (e) { console.error("freshness sweep:", e.message); } }, 3600e3);

// Owner taps "Still available" (logged in) — also used to renew a paused listing.
router.add("POST", "/api/listings/:id/confirm", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your listing" });
  if (!["active", "expired"].includes(row.status)) return send(res, 409, { error: "Only live or paused listings can be confirmed" });
  db.prepare(`UPDATE listings SET confirmed_at=datetime('now'), reminded_at=NULL, status='active'${row.status !== "active" ? ", status_changed_at=datetime('now')" : ""} WHERE id=?`).run(row.id);
  send(res, 200, listingView(db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(row.id)));
});
// One-tap links from the reminder email/SMS (no login needed; signed per cycle).
router.add("GET", "/api/listings/:id/fresh", (req, res, p) => {
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  const a = req.query.a === "taken" ? "taken" : "yes";
  const redirect = (msg) => { res.writeHead(302, { Location: "/dashboard?notice=" + encodeURIComponent(msg) }); res.end(); };
  if (!row || !req.query.t || req.query.t !== freshToken(row, a)) return redirect("That link has expired — manage the listing from your dashboard.");
  if (a === "yes") {
    if (!["active", "expired"].includes(row.status)) return redirect("This listing is no longer live.");
    db.prepare("UPDATE listings SET confirmed_at=datetime('now'), reminded_at=NULL, status='active', status_changed_at=CASE WHEN status='active' THEN status_changed_at ELSE datetime('now') END WHERE id=?").run(row.id);
    return redirect(`Thanks! "${row.title}" stays live for another ${LISTING_TTL_DAYS} days.`);
  }
  const done = (row.category === "sale") ? "sold" : "rented";
  db.prepare("UPDATE listings SET status=?, status_changed_at=datetime('now') WHERE id=?").run(done, row.id);
  redirect(`"${row.title}" is marked ${done} and hidden from search. Relist it anytime.`);
});

/* ================= trust & safety =================
   Tenants can report a listing. Enough independent reports pause it
   ('under_review', hidden) until an admin clears or removes it. Separately,
   every new/edited listing is checked for common scam patterns; hits are
   recorded as flags for admin review and lower the report threshold. */
const REPORT_REASONS = { scam: "Scam or asks for money before viewing", taken: "Already rented / sold", price: "Wrong or misleading price",
  photos: "Fake or stolen photos", location: "Wrong location", other: "Something else" };
const SERIOUS = ["scam", "photos"];
function addFlag(listingId, kind, detail) {
  if (db.prepare("SELECT 1 FROM listing_flags WHERE listing_id=? AND kind=? AND resolved=0").get(listingId, kind)) return false;
  db.prepare("INSERT INTO listing_flags (listing_id,kind,detail) VALUES (?,?,?)").run(listingId, kind, String(detail).slice(0, 300));
  console.log(`[trust] flag ${kind} on listing #${listingId}: ${detail}`);
  const n = db.prepare("SELECT COUNT(*) n FROM listing_flags WHERE listing_id=? AND resolved=0").get(listingId).n;
  if (n === 2) adminAlert("Listing looks like a scam", `Listing #${listingId} now has ${n} automatic scam flags (latest: ${kind} — ${detail}). Review it: ${SITE()}/admin`);
  return true;
}
function evaluateReports(listingId) {
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);
  if (!l || l.status !== "active") return;
  const open = db.prepare("SELECT reason, ip FROM reports WHERE listing_id=? AND status='open'").all(listingId);
  const people = (list) => new Set(list.map(r => r.ip || Math.random())).size;
  const serious = people(open.filter(r => SERIOUS.includes(r.reason)));
  const all = people(open);
  const flagged = !!db.prepare("SELECT 1 FROM listing_flags WHERE listing_id=? AND resolved=0").get(listingId);
  const takenCount = people(open.filter(r => r.reason === "taken"));
  if (serious >= (flagged ? 2 : 3) || all >= (flagged ? 3 : 5)) {
    db.prepare("UPDATE listings SET status='under_review', status_changed_at=datetime('now') WHERE id=?").run(listingId);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(l.owner_id, "listing", "Listing under review", `"${l.title}" was paused after several reports from visitors. Our team will review it shortly — reply to info@patahome.co.ke if you think this is a mistake.`);
    console.log(`[trust] listing #${listingId} paused for review (${all} reporters, ${serious} serious)`);
  } else if (takenCount >= 2) {
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(l.owner_id, "listing", "Is your listing still available?", `Visitors say "${l.title}" is already taken. Mark it rented/sold, or confirm it's still available, from your dashboard.`);
  }
}
router.add("POST", "/api/listings/:id/report", (req, res, p) => {
  const b = req.body || {};
  const reason = String(b.reason || "");
  if (!REPORT_REASONS[reason]) return send(res, 400, { error: "Choose a reason for the report" });
  const l = db.prepare("SELECT id, status FROM listings WHERE id=?").get(p.id);
  if (!l || l.status !== "active") return send(res, 404, { error: "Listing not found" });
  const ip = clientIp(req);
  const recent = db.prepare("SELECT COUNT(*) n FROM reports WHERE ip=? AND created_at > datetime('now','-1 hour')").get(ip).n;
  if (ip && recent >= 10) return send(res, 429, { error: "Too many reports — please try again later" });
  if (ip && db.prepare("SELECT 1 FROM reports WHERE ip=? AND listing_id=? AND created_at > datetime('now','-1 day')").get(ip, l.id))
    return send(res, 200, { ok: true, duplicate: true });
  db.prepare("INSERT INTO reports (listing_id,reason,details,contact,ip) VALUES (?,?,?,?,?)")
    .run(l.id, reason, String(b.details || "").trim().slice(0, 1000), String(b.contact || "").trim().slice(0, 80), ip);
  evaluateReports(l.id);
  const burst = db.prepare("SELECT COUNT(*) n FROM reports WHERE listing_id=? AND created_at > datetime('now','-1 hour')").get(l.id).n;
  if (burst === 3) adminAlert("Burst of reports on a listing", `Listing #${l.id} got ${burst} reports in the last hour. Review it: ${SITE()}/admin`);
  send(res, 201, { ok: true });
});

// Cloudinary's etag is an MD5 of the uploaded file — identical photos share it.
async function photoEtag(publicId) {
  if (!cldEnabled()) return null;
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/resources/image/upload/${publicId.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { Authorization: "Basic " + Buffer.from(`${CLD.key}:${CLD.secret}`).toString("base64") }, signal: AbortSignal.timeout(10000) });
  if (!r.ok) return null;
  const d = await r.json();
  return d.etag || null;
}
async function scamChecks(listingId) {
  const l = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(listingId);
  if (!l) return;
  // 1) the same photo already used by a different account
  for (const pid of parsePhotos(l.photos)) {
    let h = db.prepare("SELECT etag FROM photo_hashes WHERE public_id=?").get(pid);
    if (!h || CLD_MODERATION()) {
      const resrc = await cldResource(pid).catch(() => null);
      const mod = resrc && Array.isArray(resrc.moderation) ? resrc.moderation.find(m => m.status === "rejected") : null;
      if (mod) {
        addFlag(l.id, "photo_moderation", `Cloudinary ${mod.kind || "moderation"} rejected a photo`);
        if (l.status === "active") db.prepare("UPDATE listings SET status='under_review', status_changed_at=datetime('now') WHERE id=?").run(l.id);
      }
      if (h) continue;
      const etag = resrc && resrc.etag;
      if (!etag) continue;
      db.prepare("INSERT OR REPLACE INTO photo_hashes (public_id,listing_id,owner_id,etag) VALUES (?,?,?,?)").run(pid, l.id, l.owner_id, etag);
      h = { etag };
    }
    const other = db.prepare("SELECT listing_id FROM photo_hashes WHERE etag=? AND owner_id!=? LIMIT 1").get(h.etag, l.owner_id);
    if (other) addFlag(l.id, "photo_reuse", `A photo is identical to one in listing #${other.listing_id} posted by another account`);
  }
  // 2) suspiciously cheap for the county (classic bait)
  if (l.category !== "sale" && l.bedrooms != null) {
    const comps = db.prepare(`SELECT l.price FROM listings l JOIN areas a ON a.id=l.area_id
      WHERE l.status='active' AND l.category=? AND l.bedrooms=? AND a.county=? AND l.id!=? ORDER BY l.price`).all(l.category, l.bedrooms, l.county, l.id).map(r => r.price);
    if (comps.length >= 5) {
      const median = comps[Math.floor(comps.length / 2)];
      if (l.price < median * 0.4) addFlag(l.id, "price_outlier", `KES ${l.price} vs typical KES ${median} for similar homes in ${l.county}`);
    }
  }
  // 2b) land: price per acre far below similar land in the county; same title number from another account
  if (l.category === "land" && l.price_per_acre) {
    const comps = db.prepare(`SELECT l.price_per_acre p FROM listings l JOIN areas a ON a.id=l.area_id
      WHERE l.status='active' AND l.category='land' AND l.land_deal=? AND a.county=? AND l.id!=? AND l.price_per_acre > 0 ORDER BY p`).all(l.land_deal, l.county, l.id).map(r => r.p);
    if (comps.length >= 5) {
      const median = comps[Math.floor(comps.length / 2)];
      if (l.price_per_acre < median * 0.35) addFlag(l.id, "price_outlier", `KES ${Math.round(l.price_per_acre)}/acre vs typical KES ${Math.round(median)}/acre for land in ${l.county}`);
    }
  }
  if ((l.category === "land" || l.category === "commercial") && l.title_ref) {
    const dup = db.prepare("SELECT id FROM listings WHERE title_ref=? AND owner_id!=? AND status IN ('active','under_review','expired') LIMIT 1").get(l.title_ref, l.owner_id);
    if (dup) addFlag(l.id, "duplicate_title", `Same title/LR number as listing #${dup.id} posted by another account`);
  }
  // 2c) commercial: price per sq ft far below similar property of the same type in the county
  if (l.category === "commercial" && l.price_per_sqft) {
    const comps = db.prepare(`SELECT l.price_per_sqft p FROM listings l JOIN areas a ON a.id=l.area_id
      WHERE l.status='active' AND l.category='commercial' AND l.land_deal=? AND l.comm_type=? AND a.county=? AND l.id!=? AND l.price_per_sqft > 0 ORDER BY p`).all(l.land_deal, l.comm_type, l.county, l.id).map(r => r.p);
    if (comps.length >= 5) {
      const median = comps[Math.floor(comps.length / 2)];
      if (l.price_per_sqft < median * 0.35) addFlag(l.id, "price_outlier", `KES ${Math.round(l.price_per_sqft)}/sq ft vs typical KES ${Math.round(median)}/sq ft in ${l.county}`);
    }
  }
  // 3) a self-described owner with live listings in many counties
  if ((l.lister_role || "owner") === "owner") {
    const counties = db.prepare(`SELECT COUNT(DISTINCT a.county) n FROM listings x JOIN areas a ON a.id=x.area_id WHERE x.owner_id=? AND x.status='active'`).get(l.owner_id).n;
    if (counties >= 4) addFlag(l.id, "many_counties", `Posted as owner, with live listings in ${counties} different counties`);
  }
  // 4) the same WhatsApp number on more than one account
  const me = db.prepare("SELECT whatsapp FROM users WHERE id=?").get(l.owner_id);
  const wa = String(me && me.whatsapp || "").replace(/\D/g, "").slice(-9);
  if (wa.length === 9) {
    const dupe = db.prepare("SELECT id FROM users WHERE id!=? AND whatsapp IS NOT NULL AND whatsapp!='' AND substr(replace(replace(whatsapp,' ',''),'+',''),-9)=? LIMIT 1").get(l.owner_id, wa);
    if (dupe) addFlag(l.id, "shared_contact", `WhatsApp number also used by account #${dupe.id}`);
  }
}
const runScamChecks = (id) => scamChecks(id).catch(e => console.error("scam checks failed:", e.message));

/* ================= land =================
   Size is stored as typed (value + unit) and converted to acres. Price is
   stored exactly as the owner typed it, with its basis; price_per_acre is a
   normalised figure (sale: KES per acre; lease: KES per acre per year) used
   for filtering, sorting and scam checks. Two farming seasons per year. */
const LAND_DETAIL_KEYS = ["title", "use", "road", "water", "power", "terrain"];
function landFields(b, existing) {
  const e = existing || {};
  const deal = b.landDeal !== undefined ? String(b.landDeal) : (e.land_deal || "sale");
  if (!["sale", "lease"].includes(deal)) return { error: "Choose whether the land is for sale or for lease" };
  const sizeValue = b.sizeValue !== undefined ? +b.sizeValue : e.size_value;
  const sizeUnit = b.sizeUnit !== undefined ? String(b.sizeUnit) : e.size_unit;
  if (!(sizeValue > 0) || !LAND.UNITS[sizeUnit]) return { error: "Enter the land size and pick a unit (acres, plots, hectares…)" };
  const sizeAcres = LAND.acres(sizeValue, sizeUnit);
  if (sizeAcres > 1e6) return { error: "That land size looks too large — check the unit" };
  const basis = b.priceBasis !== undefined ? String(b.priceBasis) : (e.price_basis || (deal === "lease" ? "acre_year" : "total"));
  if (!LAND.BASIS[deal][basis]) return { error: "Choose how the price is quoted (total, per acre, per year…)" };
  const price = b.price !== undefined ? +b.price : e.price;
  if (!(price > 0)) return { error: "Enter a price" };
  const plotAcres = (LAND.UNITS[sizeUnit].acres < 0.5 && /^plot/.test(sizeUnit)) ? LAND.UNITS[sizeUnit].acres : LAND.UNITS.plot_50x100.acres;
  const perAcre = {
    total: price / sizeAcres, per_acre: price, per_plot: price / plotAcres,
    acre_year: price, acre_season: price * 2, month: price * 12 / sizeAcres, year: price / sizeAcres
  }[basis];
  const leaseMin = deal === "lease" ? String(b.leaseMin ?? e.lease_min ?? "").trim().slice(0, 40) : "";
  return { deal, sizeValue, sizeUnit, sizeAcres, basis, perAcre: Math.round(perAcre), leaseMin };
}
function cleanLandFeatures(f) {
  const out = {};
  if (!f || typeof f !== "object") return out;
  for (const k of LAND_DETAIL_KEYS) if (LAND.DETAILS[k][f[k]]) out[k] = f[k];
  if (f.leaseYears && out.title === "leasehold") out.leaseYears = Math.max(0, Math.min(999, parseInt(f.leaseYears, 10) || 0));
  if (f.roadKm !== undefined && f.roadKm !== "") out.roadKm = Math.max(0, Math.min(200, Math.round(+f.roadKm * 10) / 10 || 0));
  for (const k of ["fenced", "beacons", "surveyed", "subdivisible", "controlledDev"]) if (f[k] === true || f[k] === "true") out[k] = true;
  if (Array.isArray(f.suits)) out.suits = f.suits.filter(x => LAND.DETAILS.suits[x]).slice(0, 5);
  return out;
}
// An exact pin must fall within ~40 km of the chosen area (stops obvious mistakes).
function exactPin(b, area) {
  const lat = +b.pinLat, lng = +b.pinLng;
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || !b.pinLat) return null;
  if (km(area.lat, area.lng, lat, lng) > 40) return { error: "That map pin is far from the area you chose — check the area or move the pin" };
  return { lat, lng };
}

/* ================= commercial =================
   Floor area stored as typed and in sq ft. price_per_sqft is normalised
   (sale: KES per sq ft; lease: KES per sq ft per month) for sorting and scam checks. */
const COMM_DETAIL_KEYS = ["title", "frontage", "fit", "power", "tenancy"];
function commFields(b, existing) {
  const e = existing || {};
  const deal = b.deal !== undefined ? String(b.deal) : (e.land_deal || "sale");
  if (!["sale", "lease"].includes(deal)) return { error: "Choose whether the property is for sale or to let" };
  const type = b.commType !== undefined ? String(b.commType) : e.comm_type;
  if (!COMM.TYPES[type]) return { error: "Choose the type of property (shop, office, warehouse…)" };
  const sizeValue = b.sizeValue !== undefined && b.sizeValue !== "" ? +b.sizeValue : (b.sizeValue === "" ? null : e.size_value);
  const sizeUnit = b.sizeUnit !== undefined ? String(b.sizeUnit) : (e.size_unit || "sqft");
  if (sizeValue != null && (!(sizeValue > 0) || !COMM.UNITS[sizeUnit])) return { error: "Enter the floor area and pick sq ft or m²" };
  const areaSqft = sizeValue ? COMM.sqft(sizeValue, sizeUnit) : null;
  if (areaSqft > 5e7) return { error: "That floor area looks too large — check the unit" };
  const basis = b.priceBasis !== undefined ? String(b.priceBasis) : (e.price_basis && COMM.BASIS[deal][e.price_basis] ? e.price_basis : (deal === "lease" ? "month" : "total"));
  if (!COMM.BASIS[deal][basis]) return { error: "Choose how the price is quoted (per month, per sq ft…)" };
  if (basis === "sqft_month" && !areaSqft) return { error: "Enter the floor area to quote a price per sq ft" };
  const price = b.price !== undefined ? +b.price : e.price;
  if (!(price > 0)) return { error: "Enter a price" };
  const per = COMM.perSqft(deal, basis, price, areaSqft);
  const leaseMin = deal === "lease" ? String(b.leaseMin ?? e.lease_min ?? "").trim().slice(0, 40) : "";
  const incomeRaw = b.incomeMonth !== undefined ? b.incomeMonth : e.income_month;
  const income = deal === "sale" && +incomeRaw > 0 ? Math.round(+incomeRaw) : null;
  return { deal, type, sizeValue: sizeValue || null, sizeUnit: sizeValue ? sizeUnit : null, areaSqft: areaSqft ? Math.round(areaSqft) : null,
           basis, perSqft: per ? Math.round(per * 100) / 100 : null, leaseMin, income };
}
function cleanCommFeatures(f) {
  const out = {};
  if (!f || typeof f !== "object") return out;
  for (const k of COMM_DETAIL_KEYS) if (COMM.DETAILS[k][f[k]]) out[k] = f[k];
  for (const k of Object.keys(COMM.TICKS)) if (f[k] === true || f[k] === "true") out[k] = true;
  if (f.floors !== undefined && f.floors !== "") out.floors = Math.max(0, Math.min(100, parseInt(f.floors, 10) || 0));
  if (f.parkingSlots !== undefined && f.parkingSlots !== "") out.parkingSlots = Math.max(0, Math.min(5000, parseInt(f.parkingSlots, 10) || 0));
  if (f.units !== undefined && f.units !== "") out.units = Math.max(0, Math.min(2000, parseInt(f.units, 10) || 0));
  if (f.serviceCharge) out.serviceCharge = String(f.serviceCharge).trim().slice(0, 60);
  if (f.deposit) out.deposit = String(f.deposit).trim().slice(0, 60);
  if (f.leaseYears && out.title === "leasehold") out.leaseYears = Math.max(0, Math.min(999, parseInt(f.leaseYears, 10) || 0));
  return out;
}

/* ---- land documents: owner submits privately; admin checks; badge shows "Documents checked" ---- */
router.add("POST", "/api/listings/:id/land-docs", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!l || (l.category !== "land" && l.category !== "commercial")) return send(res, 404, { error: "Land or commercial listing not found" });
  if (l.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your listing" });
  const b = req.body || {};
  const ref = String(b.titleRef || l.title_ref || "").trim().slice(0, 60);
  if (!ref) return send(res, 400, { error: "Enter the title deed / LR number" });
  const docs = Array.isArray(b.docs) ? b.docs.filter(d => typeof d === "string" && d.startsWith("patahome/verify/") && /^[\w\-/]{1,200}$/.test(d)).slice(0, 4) : [];
  if (cldEnabled() && !docs.length) return send(res, 400, { error: "Upload a photo of the official search or title deed" });
  db.prepare("UPDATE listings SET title_ref=?, land_docs=?, docs_status='pending', docs_note=NULL WHERE id=?").run(ref, JSON.stringify(docs), l.id);
  setTimeout(() => runScamChecks(l.id), 0);
  send(res, 200, { ok: true, docsStatus: "pending" });
});
router.add("GET", "/api/admin/land-docs", (req, res) => {
  if (!requireAdmin(req, res, "moderate")) return;
  const rows = db.prepare(`${LISTING_SQL} WHERE l.category IN ('land','commercial') AND l.docs_status='pending' ORDER BY l.id`).all();
  send(res, 200, rows.map(r => ({ id: r.id, title: r.title, area: `${r.area_name}, ${r.county}`, owner: r.owner_name, titleRef: r.title_ref, category: r.category,
    size: r.category === "land" ? LAND.sizeLabel(r.size_value, r.size_unit, r.size_acres) : (COMM.TYPES[r.comm_type] || "Commercial") + (r.size_value ? " · " + COMM.areaLabel(r.size_value, r.size_unit, r.area_sqft) : ""), price: priceText(r),
    docs: parsePhotos(r.land_docs).map(d => cldEnabled() ? photoUrl(d, "c_limit,w_1600") : d) })));
});
router.add("POST", "/api/admin/land-docs/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return; auditOnSuccess(req, res, a, "docs_review", "listing", p.id, req.body);
  const l = db.prepare("SELECT * FROM listings WHERE id=? AND category IN ('land','commercial')").get(p.id);
  if (!l) return send(res, 404, { error: "Land or commercial listing not found" });
  const ok = (req.body || {}).action === "approve", note = String((req.body || {}).note || "").slice(0, 200);
  db.prepare("UPDATE listings SET docs_status=?, docs_note=? WHERE id=?").run(ok ? "checked" : "rejected", note || null, l.id);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "verify",
    ok ? "Property documents checked ✓" : "Property documents not accepted",
    ok ? `"${l.title}" now shows a "Documents checked" badge.` : `We couldn't confirm the documents for "${l.title}"${note ? `: ${note}` : ""}. You can upload clearer copies from your dashboard.`);
  send(res, 200, { ok: true });
});

/* Agents and caretakers may post for owners, but tenants must always see who
   they're dealing with — and an agent must state their fee up front. */
function listerFields(body) {
  const role = body.listerRole === undefined ? "owner" : String(body.listerRole);
  if (!["owner", "agent", "caretaker"].includes(role)) return { error: "Choose who is posting: owner, agent or caretaker" };
  let fee = String(body.agentFee || "").trim().slice(0, 60);
  if (role === "agent" && !fee) return { error: "Agents must state their fee to tenants (or choose \"No fee to tenant\")" };
  if (role === "owner") fee = "";
  return { role, fee };
}

router.add("PATCH", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your listing" });
  const body = req.body || {};
  if (row.owner_id !== u.id) auditOnSuccess(req, res, u, "owner_edit_as_admin", "listing", row.id, Object.keys(body).join(","));
  const allowed = ["title", "description", "price", "bedrooms"];
  const sets = [], params = [];
  for (const k of allowed) if (body[k] !== undefined) { sets.push(`${k}=?`); params.push(body[k]); }
  if (body.features !== undefined) { sets.push("features=?"); params.push(JSON.stringify(row.category === "land" ? cleanLandFeatures(body.features) : row.category === "commercial" ? cleanCommFeatures(body.features) : cleanFeatures(body.features))); }
  if (row.category === "land" && ["landDeal", "sizeValue", "sizeUnit", "priceBasis", "price", "leaseMin", "pinLat", "titleRef"].some(k => body[k] !== undefined)) {
    const land = landFields(body, row);
    if (land.error) return send(res, 400, { error: land.error });
    sets.push("land_deal=?", "size_value=?", "size_unit=?", "size_acres=?", "price_basis=?", "price_per_acre=?", "lease_min=?");
    params.push(land.deal, land.sizeValue, land.sizeUnit, land.sizeAcres, land.basis, land.perAcre, land.leaseMin);
    if (body.pinLat !== undefined) {
      const area = db.prepare("SELECT * FROM areas WHERE id=?").get(row.area_id);
      const pin = body.pinLat === "" || body.pinLat === null ? null : exactPin(body, area);
      if (pin && pin.error) return send(res, 400, { error: pin.error });
      if (pin) { sets.push("lat=?", "lng=?", "exact_pin=1"); params.push(pin.lat, pin.lng); }
    }
    if (body.titleRef !== undefined) {
      const ref = String(body.titleRef || "").trim().slice(0, 60) || null;
      if (ref !== row.title_ref) { sets.push("title_ref=?"); params.push(ref); if (row.docs_status === "checked") { sets.push("docs_status='none'"); } }
    }
  }
  if (row.category === "commercial" && ["deal", "commType", "sizeValue", "sizeUnit", "priceBasis", "price", "leaseMin", "incomeMonth", "pinLat", "titleRef"].some(k => body[k] !== undefined)) {
    const c = commFields(body, row);
    if (c.error) return send(res, 400, { error: c.error });
    sets.push("land_deal=?", "comm_type=?", "size_value=?", "size_unit=?", "area_sqft=?", "price_basis=?", "price_per_sqft=?", "lease_min=?", "income_month=?");
    params.push(c.deal, c.type, c.sizeValue, c.sizeUnit, c.areaSqft, c.basis, c.perSqft, c.leaseMin, c.income);
    if (body.pinLat !== undefined) {
      const area = db.prepare("SELECT * FROM areas WHERE id=?").get(row.area_id);
      const pin = body.pinLat === "" || body.pinLat === null ? null : exactPin(body, area);
      if (pin && pin.error) return send(res, 400, { error: pin.error });
      if (pin) { sets.push("lat=?", "lng=?", "exact_pin=1"); params.push(pin.lat, pin.lng); }
    }
    if (body.titleRef !== undefined) {
      const ref = String(body.titleRef || "").trim().slice(0, 60) || null;
      if (ref !== row.title_ref) { sets.push("title_ref=?"); params.push(ref); if (row.docs_status === "checked") { sets.push("docs_status='none'"); } }
    }
  }
  if (body.video !== undefined) {
    const v = String(body.video || "");
    if (v && !validVideoId(v)) return send(res, 400, { error: "Invalid video" });
    if (row.video && row.video !== v) cldDestroyVideo(row.video);
    sets.push("video=?"); params.push(v);
  }
  if (body.listerRole !== undefined || body.agentFee !== undefined) {
    const lister = listerFields({ listerRole: body.listerRole ?? row.lister_role, agentFee: body.agentFee ?? row.agent_fee });
    if (lister.error) return send(res, 400, { error: lister.error });
    sets.push("lister_role=?", "agent_fee=?"); params.push(lister.role, lister.fee);
  }

  // A listing can be relisted, but it cannot be both rented and sold. Validate
  // the lifecycle on the server as well as in the owner UI so direct API calls
  // cannot make a listing disappear under an incompatible status.
  if (row.status === "under_review" && !can(u, "moderate"))
    return send(res, 409, { error: "This listing is under review after visitor reports. We'll email you once it's checked." });
  if (body.status !== undefined) {
    if (row.status === "removed")
      return send(res, 409, { error: "Removed listings cannot be relisted. Create a new listing instead." });
    const status = String(body.status);
    const rentable = row.category === "rent" || row.category === "shortlet" || ((row.category === "land" || row.category === "commercial") && row.land_deal === "lease");
    const permitted = rentable ? ["active", "rented"] : ["active", "sold"];
    if (!permitted.includes(status))
      return send(res, 400, { error: rentable ? "Rental listings can be marked rented or relisted" : "Sale listings can be marked sold or relisted" });
    sets.push("status=?"); params.push(status);
    if (status !== row.status) sets.push("status_changed_at=datetime('now')");
  }
  if (body.photos !== undefined) {
    const photos = body.photos;
    if (!Array.isArray(photos) || photos.length > CLD.maxPhotos || !photos.every(validPhotoId))
      return send(res, 400, { error: `photos must be up to ${CLD.maxPhotos} uploaded photo ids` });
    // free storage for photos the owner removed
    for (const old of parsePhotos(row.photos)) if (!photos.includes(old)) cldDestroy(old);
    sets.push("photos=?"); params.push(JSON.stringify(photos));
  }
  if (!sets.length) return send(res, 400, { error: "Nothing to update" });
  if (body.photos !== undefined || body.price !== undefined) setTimeout(() => runScamChecks(row.id), 0);
  // Any owner edit (or relisting) counts as "still available".
  if (body.status === undefined || String(body.status) === "active") sets.push("confirmed_at=datetime('now')", "reminded_at=NULL");
  db.prepare(`UPDATE listings SET ${sets.join(",")} WHERE id=?`).run(...params, row.id);
  if (body.status !== undefined && String(body.status) !== row.status) {
    const status = String(body.status);
    const verb = status === "active" ? "relisted" : `marked ${status}`;
    const next = status === "active"
      ? "It is visible to new renters and buyers again."
      : "It is now hidden from public search. You can relist it at any time.";
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(row.owner_id, "system", `Listing ${verb}`, `“${row.title}” was ${verb}. ${next}`);
  }
  if (!can(u, "moderate") && ["title", "description", "agentFee", "features"].some(k => body[k] !== undefined)) checkBlocklist(row.id);
  const updated = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(row.id);
  notifyFollowers(updated.owner_id, "A followed listing was updated", `${updated.title} has new details on PataHome.`).catch(e=>console.error("follower notification failed:",e.message));
  send(res, 200, listingView(updated));
});

router.add("DELETE", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your listing" });
  if (row.owner_id !== u.id) auditOnSuccess(req, res, u, "delete_listing", "listing", row.id, row.title);
  // reclaim photo storage before soft-deleting
  for (const id of parsePhotos(row.photos)) cldDestroy(id);
  db.prepare("UPDATE listings SET status='removed', status_changed_at=datetime('now'), photos='[]' WHERE id=?").run(row.id);
  send(res, 200, { ok: true });
});

/* -------- photo uploads: browser uploads straight to Cloudinary (no server disk) -------- */
router.add("GET", "/api/uploads/sign", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!cldEnabled()) return send(res, 503, { error: "Photo uploads are not configured yet" });
  if (req.query.kind === "video") {
    // Videos: no image transformation; Cloudinary transcodes on delivery.
    const timestamp = Math.floor(Date.now() / 1000), folder = VIDEO_FOLDER;
    return send(res, 200, { cloudName: CLD.cloud, apiKey: CLD.key, timestamp, folder,
      signature: cldSign({ folder, timestamp }), maxBytes: 80 * 1024 * 1024, maxSeconds: 90 });
  }
  const folder = req.query.kind === "verify" ? "patahome/verify" : CLD.folder;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp, transformation: CLD_TRANSFORM };
  const moderation = folder === CLD.folder && CLD_MODERATION() ? CLD_MODERATION() : "";
  if (moderation) params.moderation = moderation;
  send(res, 200, {
    cloudName: CLD.cloud, apiKey: CLD.key, moderation,
    timestamp, folder, transformation: CLD_TRANSFORM,
    signature: cldSign(params),
    maxPhotos: CLD.maxPhotos, maxBytes: 8 * 1024 * 1024
  });
});

/* -------- contact owner (records a lead, returns phone) -------- */
router.add("POST", "/api/listings/:id/contact", (req, res, p) => {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=? AND l.status='active'`).get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  const u = getUser(req);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,?)").run(row.id, u ? u.id : null);
  const requester = u ? `${u.name || "A signed-in user"}${realPhone(u.phone) ? ` (${realPhone(u.phone)})` : ""}` : "A visitor";
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
    .run(row.owner_id, "lead", "New contact request", `${requester} requested your contact for "${row.title}".`);
  const owner = db.prepare("SELECT name, phone, verified FROM users WHERE id=?").get(row.owner_id);
  send(res, 200, { ownerName: owner.name, ownerPhone: owner.phone, ownerVerified: !!owner.verified });
});

/* -------- inquiries: tenant/buyer feedback to the owner -------- */
router.add("POST", "/api/listings/:id/inquire", (req, res, p) => {
  const row = db.prepare("SELECT id, owner_id, title FROM listings WHERE id=? AND status='active'").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  const { name, phone, message, email } = req.body || {};
  if (!name || !phone || !message) return send(res, 400, { error: "name, phone and message are required" });
  if (String(message).length > 1000) return send(res, 400, { error: "Message too long (max 1000 chars)" });
  const fromEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(email || "").trim()) ? String(email).trim().toLowerCase() : "";
  const threadToken = crypto.randomBytes(18).toString("base64url");
  const info = db.prepare("INSERT INTO inquiries (listing_id,from_name,from_phone,message,thread_token,from_email,owner_unread,updated_at) VALUES (?,?,?,?,?,?,1,datetime('now'))")
    .run(row.id, String(name).trim(), String(phone).trim(), String(message).trim(), threadToken, fromEmail);
  db.prepare("INSERT INTO messages (inquiry_id,sender,body) VALUES (?,?,?)").run(info.lastInsertRowid, "tenant", String(message).trim());
  // an inquiry is also a lead
  const u = getUser(req);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,?)").run(row.id, u ? u.id : null);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
    .run(row.owner_id, "inquiry", "New message", `${String(name).trim()} asked about "${row.title}".`);
  send(res, 201, { ok: true, inquiryId: info.lastInsertRowid, threadToken, threadUrl: `/messages?t=${threadToken}` });
});

/* -------- followers: renters/buyers follow an owner for updates -------- */
async function notifyFollowers(ownerId, title, body) {
  const owner = db.prepare("SELECT name FROM users WHERE id=?").get(ownerId);
  if (!owner) return;
  const followers = db.prepare("SELECT follower_phone, follower_email FROM followers WHERE owner_id=? AND verified=1").all(ownerId);
  for (const follower of followers) {
    if (smsConfigured() && realPhone(follower.follower_phone)) {
      sendSms({to:follower.follower_phone,text:`PataHome: ${title}. ${body}`}).catch(e=>console.error("follower SMS failed:",e.message));
    }
    if (mailConfigured() && follower.follower_email) {
      sendMail({to:follower.follower_email,subject:`PataHome — ${title}`,text:body}).catch(e=>console.error("follower email failed:",e.message));
    }
  }
}

router.add("GET", "/api/owners/:id/profile", (req, res, p) => {
  const owner = db.prepare("SELECT id,name,business_name,bio,avatar_url,verified,created_at FROM users WHERE id=? AND role='user'").get(p.id);
  if (!owner) return send(res, 404, {error:"Owner not found"});
  const listings = db.prepare(`${LISTING_SQL} WHERE l.owner_id=? AND l.status='active' ORDER BY l.id DESC`).all(owner.id).map(listingView);
  const followers = db.prepare("SELECT COUNT(*) n FROM followers WHERE owner_id=? AND verified=1").get(owner.id).n;
  send(res, 200, {id:owner.id,name:owner.name,businessName:owner.business_name||"",bio:owner.bio||"",avatarUrl:owner.avatar_url||"",verified:!!owner.verified,followers,listings});
});

router.add("POST", "/api/owners/:id/follow/start", async (req, res, p) => {
  const owner = db.prepare("SELECT id,name FROM users WHERE id=? AND role='user'").get(p.id);
  if (!owner) return send(res, 404, {error:"Owner not found"});
  const {name, phone, email} = req.body || {};
  if (!name || !realPhone(String(phone||""))) return send(res, 400, {error:"Enter your name and a valid Kenyan phone number"});
  if (!smsConfigured()) return send(res, 503, {error:"Phone verification is temporarily unavailable. Please try again later."});
  const challenge=crypto.randomUUID(), code=String(Math.floor(100000+Math.random()*900000));
  db.prepare("DELETE FROM follower_codes WHERE follower_phone=? AND owner_id=?").run(phone,owner.id);
  const viewer=getUser(req);
  db.prepare("INSERT INTO follower_codes (challenge,owner_id,follower_name,follower_phone,follower_email,code,expires_at) VALUES (?,?,?,?,?,?,datetime('now','+15 minutes'))")
    .run(challenge,owner.id,String(name).trim(),String(phone).trim(),email?String(email).trim():null,code);
  try { await sendSms({to:String(phone).trim(),text:`${code} is your PataHome follow verification code. It expires in 15 minutes.`}); }
  catch (e) { db.prepare("DELETE FROM follower_codes WHERE challenge=?").run(challenge); return send(res, 400, {error:"Couldn't send the verification code"}); }
  send(res,200,{ok:true,challenge,owner:owner.name});
});

router.add("POST", "/api/owners/:id/follow/confirm", (req, res, p) => {
  const {challenge,code}=req.body||{};
  const row=db.prepare("SELECT * FROM follower_codes WHERE challenge=? AND owner_id=?").get(challenge,p.id);
  if(!row)return send(res,400,{error:"Follow request expired — start again"});
  if(new Date(row.expires_at+"Z")<new Date()) { db.prepare("DELETE FROM follower_codes WHERE id=?").run(row.id); return send(res,400,{error:"Code expired — start again"}); }
  if(row.attempts>=5)return send(res,400,{error:"Too many attempts — request a new code"});
  if(String(code||"")!==row.code){db.prepare("UPDATE follower_codes SET attempts=attempts+1 WHERE id=?").run(row.id);return send(res,400,{error:"Incorrect code"});}
  const viewer=getUser(req);
  db.prepare("INSERT INTO followers (owner_id,follower_name,follower_phone,follower_email,follower_user_id,verified) VALUES (?,?,?,?,?,1) ON CONFLICT(owner_id,follower_phone) DO UPDATE SET follower_name=excluded.follower_name,follower_email=excluded.follower_email,follower_user_id=excluded.follower_user_id,verified=1")
    .run(row.owner_id,row.follower_name,row.follower_phone,row.follower_email,viewer?viewer.id:null);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(row.owner_id,"follower","New follower",`${row.follower_name} is now following your listings.`);
  db.prepare("DELETE FROM follower_codes WHERE id=?").run(row.id);
  send(res,200,{ok:true,following:row.owner_id});
});

router.add("POST", "/api/owners/:id/follow", (req, res, p) => {
  const owner = db.prepare("SELECT id, name FROM users WHERE id=? AND role='user'").get(p.id);
  if (!owner) return send(res, 404, { error: "Owner not found" });
  const { name, phone } = req.body || {};
  if (!name || !phone) return send(res, 400, { error: "name and phone are required" });
  try {
    db.prepare("INSERT INTO followers (owner_id,follower_name,follower_phone,verified) VALUES (?,?,?,0)")
      .run(owner.id, String(name).trim(), String(phone).trim());
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(owner.id, "follower", "New follower", `${String(name).trim()} is now following your listings.`);
  } catch (e) { /* UNIQUE: already following — treat as success */ }
  send(res, 200, { ok: true, following: owner.name });
});

router.add("GET", "/api/my/followers", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare("SELECT id, follower_name, follower_phone, follower_email, verified, created_at FROM followers WHERE owner_id=? ORDER BY id DESC").all(u.id);
  send(res, 200, rows.map(r => ({ id: r.id, name: r.follower_name, phone: r.follower_phone, since: r.created_at })));
});

router.add("GET", "/api/my/following", (req, res) => {
  const u=requireAuth(req,res); if(!u)return;
  const rows=db.prepare("SELECT f.owner_id, u.name, u.business_name, u.verified, COUNT(l.id) AS listings FROM followers f JOIN users u ON u.id=f.owner_id LEFT JOIN listings l ON l.owner_id=u.id AND l.status='active' WHERE f.follower_user_id=? AND f.verified=1 GROUP BY f.owner_id ORDER BY f.id DESC").all(u.id);
  send(res,200,rows);
});

/* -------- notifications -------- */
router.add("GET", "/api/my/notifications", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare("SELECT * FROM notifications WHERE user_id=? ORDER BY id DESC LIMIT 50").all(u.id);
  const unread = db.prepare("SELECT COUNT(*) n FROM notifications WHERE user_id=? AND read=0").get(u.id).n;
  send(res, 200, { unread, notifications: rows.map(r => ({ id: r.id, kind: r.kind, title: r.title, body: r.body, read: !!r.read, at: r.created_at })) });
});

router.add("POST", "/api/my/notifications/read", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  db.prepare("UPDATE notifications SET read=1 WHERE user_id=?").run(u.id);
  send(res, 200, { ok: true });
});

/* -------- public live chat: stored as a support ticket, replied via WhatsApp/SMS -------- */
router.add("POST", "/api/chat", (req, res) => {
  const { name, phone, message } = req.body || {};
  if (!name || !phone || !message) return send(res, 400, { error: "name, phone and message are required" });
  db.prepare("INSERT INTO support_tickets (user_id,subject,message) VALUES (NULL,?,?)")
    .run(`Live chat — ${String(name).trim().slice(0, 80)} (${String(phone).trim().slice(0, 20)})`, String(message).slice(0, 2000));
  send(res, 201, { ok: true });
});

/* -------- support tickets (Request Help) -------- */
router.add("POST", "/api/support", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const { subject, message } = req.body || {};
  if (!subject || !message) return send(res, 400, { error: "subject and message are required" });
  const info = db.prepare("INSERT INTO support_tickets (user_id,subject,message) VALUES (?,?,?)")
    .run(u.id, String(subject).slice(0, 200), String(message).slice(0, 2000));
  send(res, 201, { ok: true, ticketId: info.lastInsertRowid });
});

router.add("GET", "/api/my/support", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare("SELECT id, subject, message, status, created_at FROM support_tickets WHERE user_id=? ORDER BY id DESC").all(u.id);
  send(res, 200, rows);
});

router.add("GET", "/api/my/inquiries", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`
    SELECT i.*, l.title AS listing_title, l.category
    FROM inquiries i JOIN listings l ON l.id = i.listing_id
    WHERE l.owner_id = ? ORDER BY i.created_at DESC, i.id DESC`).all(u.id);
  send(res, 200, rows.map(r => ({
    id: r.id, listingId: r.listing_id, listingTitle: r.listing_title, category: r.category,
    fromName: r.from_name, fromPhone: r.from_phone, fromEmail: r.from_email || "", message: r.message,
    reply: r.owner_reply, repliedAt: r.replied_at, createdAt: r.created_at,
    unread: !!r.owner_unread, updatedAt: r.updated_at || r.created_at,
    messages: threadMessages(r)
  })));
});

router.add("POST", "/api/inquiries/:id/reply", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare(`
    SELECT i.id, l.owner_id FROM inquiries i JOIN listings l ON l.id = i.listing_id WHERE i.id=?`).get(p.id);
  if (!row) return send(res, 404, { error: "Inquiry not found" });
  if (row.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your inquiry" });
  if ((req.body || {}).markRead) { db.prepare("UPDATE inquiries SET owner_unread=0 WHERE id=?").run(row.id); return send(res, 200, { ok: true }); }
  const { reply } = req.body || {};
  if (!reply || !String(reply).trim()) return send(res, 400, { error: "reply is required" });
  const text = String(reply).trim().slice(0, 2000);
  db.prepare("UPDATE inquiries SET owner_reply=?, replied_at=datetime('now'), owner_unread=0, tenant_unread=1, updated_at=datetime('now') WHERE id=?")
    .run(text, row.id);
  db.prepare("INSERT INTO messages (inquiry_id,sender,body) VALUES (?,?,?)").run(row.id, "owner", text);
  notifyTenantOfReply(row.id).catch(e => console.error("tenant reply notice failed:", e.message));
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
    shortletNearby: rows.filter(r => r.category === "shortlet").length,
    byCategory: Object.fromEntries(["rent", "sale", "shortlet"].map(c => [c, rows.filter(r => r.category === c).length]))
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
  send(res, 200, rows.map(r => ({ ...listingView(r), leads: leadCount[r.id] || 0,
    ...(r.category === "land" || r.category === "commercial" ? { titleRef: r.title_ref || "", docsStatus: r.docs_status, docsNote: r.docs_note || "" } : {}) })));
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
  const followerTotals = db.prepare("SELECT COUNT(*) n FROM followers WHERE owner_id=? AND verified=1").get(u.id).n;
  const followerThisWeek = db.prepare("SELECT COUNT(*) n FROM followers WHERE owner_id=? AND verified=1 AND created_at>=datetime('now','-7 days')").get(u.id).n;
  const followerPrevWeek = db.prepare("SELECT COUNT(*) n FROM followers WHERE owner_id=? AND verified=1 AND created_at>=datetime('now','-14 days') AND created_at<datetime('now','-7 days')").get(u.id).n;
  const top = db.prepare(`
    SELECT l.id, l.title, COUNT(le.id) n
    FROM listings l LEFT JOIN leads le ON le.listing_id = l.id
    WHERE l.owner_id = ? AND l.status = 'active'
    GROUP BY l.id ORDER BY n DESC, l.id DESC LIMIT 1`).get(u.id);
  send(res, 200, {
    days, series, thisWeek, prevWeek,
    trendPct: prevWeek ? Math.round(((thisWeek - prevWeek) / prevWeek) * 100) : (thisWeek ? 100 : 0),
    followers: followerTotals, followersThisWeek: followerThisWeek,
    followerTrendPct: followerPrevWeek ? Math.round(((followerThisWeek-followerPrevWeek)/followerPrevWeek)*100) : (followerThisWeek?100:0),
    topListing: top && top.n > 0 ? { id: top.id, title: top.title, leads: top.n } : null
  });
});

/* =====================================================================
   Listing details, video, neighbourhood, viewings, message threads,
   saved-search alerts and owner analytics.
   ===================================================================== */
const SITE = () => process.env.BASE_URL || "https://patahome.co.ke";
const VIDEO_FOLDER = "patahome/videos";
const validVideoId = (id) => typeof id === "string" && id.startsWith(VIDEO_FOLDER + "/") && /^[\w\-/]{1,200}$/.test(id);
function cldDestroyVideo(publicId) {
  if (!cldEnabled() || !validVideoId(publicId)) return;
  const timestamp = Math.floor(Date.now() / 1000);
  const body = new URLSearchParams({ public_id: publicId, timestamp, api_key: CLD.key, signature: cldSign({ public_id: publicId, timestamp }) });
  fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/video/destroy`, { method: "POST", body, signal: AbortSignal.timeout(10000) })
    .catch(e => console.error("video destroy failed:", e.message));
}

/* ---------- 8 · structured listing details ---------- */
const FEATURE_ENUMS = {
  water: ["included", "metered", "borehole", "tank"],
  power: ["token", "postpaid", "included", "solar"]
};
const FEATURE_BOOLS = ["parking", "pets", "furnished", "security", "borehole", "wifi", "gated", "backupPower"];
function cleanFeatures(f) {
  const out = {};
  if (!f || typeof f !== "object") return out;
  if (f.deposit) out.deposit = String(f.deposit).trim().slice(0, 40);
  if (f.serviceCharge) out.serviceCharge = String(f.serviceCharge).trim().slice(0, 40);
  if (f.floor) out.floor = String(f.floor).trim().slice(0, 20);
  for (const [k, allowed] of Object.entries(FEATURE_ENUMS)) if (allowed.includes(f[k])) out[k] = f[k];
  for (const k of FEATURE_BOOLS) if (f[k] === true || f[k] === "true" || f[k] === 1) out[k] = true;
  return out;
}

/* ---------- 10 · neighbourhood: nearest places from OpenStreetMap ----------
   Listing pins are approximate (area centre ± ~500 m), so distances are
   shown as "about". Results are cached on the listing; a few missing ones
   are backfilled each hour. */
const NEARBY_KINDS = {
  stage:       { label: "Matatu stage", test: t => t.highway === "bus_stop" || t.amenity === "bus_station" || t.public_transport === "platform" },
  supermarket: { label: "Supermarket",  test: t => t.shop === "supermarket" || t.shop === "mall" },
  health:      { label: "Hospital / clinic", test: t => ["hospital", "clinic", "doctors"].includes(t.amenity) },
  school:      { label: "School",       test: t => ["school", "college", "university"].includes(t.amenity) }
};
async function fetchNearby(listingId) {
  const l = db.prepare("SELECT id, lat, lng FROM listings WHERE id=?").get(listingId);
  if (!l || l.lat == null) return;
  const q = `[out:json][timeout:20];(
    nwr(around:2500,${l.lat},${l.lng})[highway=bus_stop];nwr(around:2500,${l.lat},${l.lng})[amenity=bus_station];
    nwr(around:3000,${l.lat},${l.lng})[shop~"^(supermarket|mall)$"];
    nwr(around:4000,${l.lat},${l.lng})[amenity~"^(hospital|clinic|doctors)$"];
    nwr(around:2500,${l.lat},${l.lng})[amenity~"^(school|college|university)$"];);out center 120;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST", body: new URLSearchParams({ data: q }),
    headers: { "User-Agent": "PataHome/1.0 (info@patahome.co.ke)" }, signal: AbortSignal.timeout(25000)
  });
  if (!r.ok) throw new Error("overpass " + r.status);
  const d = await r.json();
  const best = {};
  for (const el of d.elements || []) {
    const lat = el.lat ?? el.center?.lat, lng = el.lon ?? el.center?.lon, t = el.tags || {};
    if (lat == null) continue;
    for (const [k, def] of Object.entries(NEARBY_KINDS)) {
      if (!def.test(t)) continue;
      const m = Math.round(km(l.lat, l.lng, lat, lng) * 1000);
      if (!best[k] || m < best[k].m) best[k] = { name: String(t.name || def.label).slice(0, 60), m };
    }
  }
  db.prepare("UPDATE listings SET nearby=? WHERE id=?").run(JSON.stringify({ ...best, at: new Date().toISOString() }), l.id);
}
async function backfillNearby() {
  const rows = db.prepare("SELECT id FROM listings WHERE status='active' AND nearby IS NULL ORDER BY id DESC LIMIT 4").all();
  for (const r of rows) { try { await fetchNearby(r.id); } catch (e) { console.error("nearby backfill:", e.message); break; } }
}

/* ---------- 16 · analytics counters ---------- */
const trackSeen = new Map(); // "ip|listing|event|day" → true (in memory; resets on restart)
router.add("POST", "/api/listings/:id/track", (req, res, p) => {
  const ev = String((req.body || {}).event || "");
  if (!["view", "save", "unsave", "share"].includes(ev)) return send(res, 400, { error: "Unknown event" });
  const l = db.prepare("SELECT id FROM listings WHERE id=? AND status='active'").get(p.id);
  if (!l) return send(res, 404, { error: "Listing not found" });
  const day = new Date().toISOString().slice(0, 10);
  const key = `${clientIp(req)}|${l.id}|${ev}|${day}`;
  if (trackSeen.has(key)) return send(res, 200, { ok: true });
  trackSeen.set(key, 1);
  if (trackSeen.size > 50000) trackSeen.clear();
  const col = ev === "view" ? "views" : ev === "share" ? "shares" : "saves";
  const delta = ev === "unsave" ? -1 : 1;
  db.prepare(`INSERT INTO listing_stats (listing_id, day, ${col}) VALUES (?,?,?)
    ON CONFLICT(listing_id, day) DO UPDATE SET ${col} = MAX(0, ${col} + ?)`).run(l.id, day, Math.max(delta, 0), delta);
  send(res, 200, { ok: true });
});
function priceComparison(row) {
  if (row.bedrooms == null) return null;
  const comps = db.prepare(`SELECT l.price FROM listings l JOIN areas a ON a.id=l.area_id
    WHERE l.status='active' AND l.category=? AND l.bedrooms=? AND a.county=? AND l.id!=? ORDER BY l.price`)
    .all(row.category, row.bedrooms, row.county, row.id).map(r => r.price);
  if (comps.length < 3) return null;
  const median = comps[Math.floor(comps.length / 2)];
  return { median, count: comps.length, pct: Math.round((row.price - median) / median * 100), county: row.county };
}
router.add("GET", "/api/my/listing-stats", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const days = Math.min(90, Math.max(7, +req.query.days || 30));
  const since = `-${days} days`;
  const rows = db.prepare(`${LISTING_SQL} WHERE l.owner_id=? AND l.status != 'removed'`).all(u.id);
  const out = rows.map(r => {
    const st = db.prepare("SELECT COALESCE(SUM(views),0) v, COALESCE(SUM(saves),0) s, COALESCE(SUM(shares),0) sh FROM listing_stats WHERE listing_id=? AND day >= date('now', ?)").get(r.id, since);
    const contacts = db.prepare("SELECT COUNT(*) n FROM leads WHERE listing_id=? AND created_at >= datetime('now', ?)").get(r.id, since).n;
    const messages = db.prepare("SELECT COUNT(*) n FROM inquiries WHERE listing_id=? AND created_at >= datetime('now', ?)").get(r.id, since).n;
    const viewings = db.prepare("SELECT COUNT(*) n FROM viewings WHERE listing_id=? AND created_at >= datetime('now', ?)").get(r.id, since).n;
    return { id: r.id, title: r.title, views: st.v, saves: st.s, shares: st.sh, contacts, messages, viewings,
      conversion: st.v ? Math.round((contacts + messages) / st.v * 100) : 0, price: priceComparison(r) };
  });
  send(res, 200, { days, listings: out });
});

/* ---------- 5 · book a viewing ---------- */
const eatLabel = (iso) => new Date(iso).toLocaleString("en-KE", { timeZone: "Africa/Nairobi", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
async function tellTenant(v, subject, text) {
  if (v.email && mailConfigured()) return sendMail({ to: v.email, subject, text }).catch(e => console.error("viewing mail:", e.message));
  if (realPhone(v.phone) && smsConfigured()) return sendSms({ to: v.phone, text: text.split("\n\n").slice(0, 2).join(" ").slice(0, 300) }).catch(e => console.error("viewing sms:", e.message));
}
async function tellOwner(ownerId, title, body) {
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(ownerId, "viewing", title, body);
  const o = db.prepare("SELECT email, email_verified, phone FROM users WHERE id=?").get(ownerId);
  if (o && o.email && mailConfigured()) sendMail({ to: o.email, subject: `PataHome — ${title}`, text: `${body}\n\nManage it from your dashboard: ${SITE()}/dashboard\n\n— PataHome` })
    .catch(e => console.error("owner mail:", e.message));
}
router.add("POST", "/api/listings/:id/viewings", async (req, res, p) => {
  const l = db.prepare("SELECT id, owner_id, title FROM listings WHERE id=? AND status='active'").get(p.id);
  if (!l) return send(res, 404, { error: "Listing not found" });
  const b = req.body || {};
  const name = String(b.name || "").trim().slice(0, 80), phone = String(b.phone || "").trim();
  const email = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(String(b.email || "").trim()) ? String(b.email).trim().toLowerCase() : "";
  if (!name) return send(res, 400, { error: "Enter your name" });
  if (!/^0[17]\d{8}$/.test(phone)) return send(res, 400, { error: "Enter a valid Kenyan phone e.g. 0712345678" });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(b.date || "") || !/^\d{2}:\d{2}$/.test(b.time || "")) return send(res, 400, { error: "Pick a date and time" });
  const slot = new Date(`${b.date}T${b.time}:00+03:00`);
  const hr = +b.time.slice(0, 2);
  if (isNaN(slot) || slot < Date.now() + 30 * 60e3 || slot > Date.now() + 31 * 86400e3) return send(res, 400, { error: "Pick a time from 30 minutes to 30 days from now" });
  if (hr < 7 || hr > 18) return send(res, 400, { error: "Viewings can be booked between 7am and 7pm" });
  if (db.prepare("SELECT 1 FROM viewings WHERE listing_id=? AND phone=? AND status IN ('requested','confirmed') AND slot_at > ?").get(l.id, phone, new Date().toISOString()))
    return send(res, 409, { error: "You already have a viewing request for this home — check your messages or cancel it first" });
  const token = crypto.randomBytes(18).toString("base64url");
  const info = db.prepare("INSERT INTO viewings (listing_id,name,phone,email,slot_at,note,token) VALUES (?,?,?,?,?,?,?)")
    .run(l.id, name, phone, email, slot.toISOString(), String(b.note || "").trim().slice(0, 500), token);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,NULL)").run(l.id);
  tellOwner(l.owner_id, "New viewing request", `${name} (${phone}) would like to view "${l.title}" on ${eatLabel(slot)}.${b.note ? ` Note: "${String(b.note).slice(0, 200)}"` : ""} Confirm or decline it in your dashboard.`);
  if (email) tellTenant({ email, phone }, `Viewing requested — ${l.title}`,
    `Hi ${name},\n\nYour request to view "${l.title}" on ${eatLabel(slot)} has been sent to the owner. We'll let you know when they confirm.\n\nSee or cancel your request: ${SITE()}/viewing?t=${token}\n\nStay safe: never pay before you've seen the house and met the owner.\n\n— PataHome`);
  send(res, 201, { ok: true, id: info.lastInsertRowid, token, manageUrl: `/viewing?t=${token}` });
});
router.add("GET", "/api/viewings/:token", (req, res, p) => {
  const v = db.prepare(`SELECT v.*, l.title, l.price, l.category, a.name area, a.county, u.name owner_name FROM viewings v
    JOIN listings l ON l.id=v.listing_id JOIN areas a ON a.id=l.area_id JOIN users u ON u.id=l.owner_id WHERE v.token=?`).get(p.token);
  if (!v) return send(res, 404, { error: "Viewing not found" });
  send(res, 200, { listingId: v.listing_id, title: v.title, area: `${v.area}, ${v.county}`, price: v.price, category: v.category,
    ownerName: v.owner_name, name: v.name, slotAt: v.slot_at, slotLabel: eatLabel(v.slot_at), status: v.status, note: v.note });
});
router.add("POST", "/api/viewings/:token/cancel", (req, res, p) => {
  const v = db.prepare("SELECT v.*, l.owner_id, l.title FROM viewings v JOIN listings l ON l.id=v.listing_id WHERE v.token=?").get(p.token);
  if (!v) return send(res, 404, { error: "Viewing not found" });
  if (!["requested", "confirmed"].includes(v.status)) return send(res, 409, { error: "This viewing is already " + v.status });
  db.prepare("UPDATE viewings SET status='cancelled' WHERE id=?").run(v.id);
  tellOwner(v.owner_id, "Viewing cancelled", `${v.name} cancelled their viewing of "${v.title}" on ${eatLabel(v.slot_at)}.`);
  send(res, 200, { ok: true });
});
router.add("GET", "/api/my/viewings", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const rows = db.prepare(`SELECT v.*, l.title FROM viewings v JOIN listings l ON l.id=v.listing_id
    WHERE l.owner_id=? AND (v.slot_at >= datetime('now','-2 days') OR v.status='requested') ORDER BY v.slot_at`).all(u.id);
  send(res, 200, rows.map(v => ({ id: v.id, listingId: v.listing_id, title: v.title, name: v.name, phone: v.phone, email: v.email,
    slotAt: v.slot_at, slotLabel: eatLabel(v.slot_at), note: v.note, status: v.status, past: new Date(v.slot_at) < Date.now() })));
});
router.add("POST", "/api/viewings/:id/respond", async (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const v = db.prepare("SELECT v.*, l.owner_id, l.title FROM viewings v JOIN listings l ON l.id=v.listing_id WHERE v.id=?").get(p.id);
  if (!v) return send(res, 404, { error: "Viewing not found" });
  if (v.owner_id !== u.id && !can(u, "moderate")) return send(res, 403, { error: "Not your listing" });
  const action = String((req.body || {}).action || ""), msg = String((req.body || {}).message || "").trim().slice(0, 300);
  if (!["confirm", "decline"].includes(action)) return send(res, 400, { error: "action must be confirm or decline" });
  if (v.status !== "requested" && !(v.status === "confirmed" && action === "decline")) return send(res, 409, { error: "This viewing is already " + v.status });
  const status = action === "confirm" ? "confirmed" : "declined";
  db.prepare("UPDATE viewings SET status=? WHERE id=?").run(status, v.id);
  const owner = db.prepare("SELECT name, phone FROM users WHERE id=?").get(v.owner_id);
  await tellTenant(v, status === "confirmed" ? `Viewing confirmed — ${v.title}` : `Viewing not available — ${v.title}`,
    status === "confirmed"
      ? `Hi ${v.name},\n\n${owner.name} confirmed your viewing of "${v.title}" on ${eatLabel(v.slot_at)}.${msg ? `\n\nMessage from the owner: "${msg}"` : ""}\n\nOwner's phone: ${realPhone(owner.phone) || "shared on the day"}\nDetails or cancel: ${SITE()}/viewing?t=${v.token}\n\nStay safe: never pay before you've seen the house and met the owner.\n\n— PataHome`
      : `Hi ${v.name},\n\nSorry — the owner can't do ${eatLabel(v.slot_at)} for "${v.title}".${msg ? `\n\nMessage from the owner: "${msg}"` : ""}\n\nYou can pick another time on PataHome: ${SITE()}/browse?open=${v.listing_id}\n\n— PataHome`);
  send(res, 200, { ok: true, status });
});
async function viewingReminders() {
  const due = db.prepare(`SELECT v.*, l.owner_id, l.title FROM viewings v JOIN listings l ON l.id=v.listing_id
    WHERE v.status='confirmed' AND v.reminded=0 AND v.slot_at > ? AND v.slot_at <= ?`).all(new Date().toISOString(), new Date(Date.now() + 26 * 3600e3).toISOString());
  for (const v of due) {
    db.prepare("UPDATE viewings SET reminded=1 WHERE id=?").run(v.id);
    tellTenant(v, `Reminder: viewing ${eatLabel(v.slot_at)}`, `Hi ${v.name},\n\nA reminder that you're viewing "${v.title}" on ${eatLabel(v.slot_at)}.\n\nDetails or cancel: ${SITE()}/viewing?t=${v.token}\n\n— PataHome`);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(v.owner_id, "viewing", "Viewing coming up", `${v.name} (${v.phone}) is viewing "${v.title}" on ${eatLabel(v.slot_at)}.`);
  }
}

/* ---------- 6 · message threads ---------- */
function threadMessages(inq) {
  const rows = db.prepare("SELECT sender, body, created_at FROM messages WHERE inquiry_id=? ORDER BY id").all(inq.id);
  if (rows.length) return rows.map(m => ({ sender: m.sender, body: m.body, at: m.created_at }));
  // inquiries created before threads existed
  const legacy = [{ sender: "tenant", body: inq.message, at: inq.created_at }];
  if (inq.owner_reply) legacy.push({ sender: "owner", body: inq.owner_reply, at: inq.replied_at || inq.created_at });
  return legacy;
}
async function notifyTenantOfReply(inquiryId) {
  const i = db.prepare("SELECT i.*, l.title FROM inquiries i JOIN listings l ON l.id=i.listing_id WHERE i.id=?").get(inquiryId);
  if (!i) return;
  if (!i.thread_token) { i.thread_token = crypto.randomBytes(18).toString("base64url"); db.prepare("UPDATE inquiries SET thread_token=? WHERE id=?").run(i.thread_token, i.id); }
  const link = `${SITE()}/messages?t=${i.thread_token}`;
  if (i.from_email && mailConfigured())
    return sendMail({ to: i.from_email, subject: `Reply about "${i.title}"`, text: `Hi ${i.from_name},\n\nThe owner replied to your message about "${i.title}":\n\n"${i.owner_reply}"\n\nReply here: ${link}\n\n— PataHome` });
  if (realPhone(i.from_phone) && smsConfigured())
    return sendSms({ to: i.from_phone, text: `PataHome: the owner replied about "${i.title.slice(0, 40)}". Read & reply: ${link}` });
}
router.add("GET", "/api/threads/:token", (req, res, p) => {
  const i = db.prepare(`SELECT i.*, l.title, l.price, l.category, l.status lstatus, a.name area, a.county, u.name owner_name, u.verified owner_verified
    FROM inquiries i JOIN listings l ON l.id=i.listing_id JOIN areas a ON a.id=l.area_id JOIN users u ON u.id=l.owner_id WHERE i.thread_token=?`).get(p.token);
  if (!i) return send(res, 404, { error: "Conversation not found" });
  db.prepare("UPDATE inquiries SET tenant_unread=0 WHERE id=?").run(i.id);
  send(res, 200, { listing: { id: i.listing_id, title: i.title, price: i.price, category: i.category, area: `${i.area}, ${i.county}`, live: i.lstatus === "active" },
    ownerName: i.owner_name, ownerVerified: !!i.owner_verified, you: i.from_name, messages: threadMessages(i) });
});
router.add("POST", "/api/threads/:token", (req, res, p) => {
  const i = db.prepare("SELECT i.*, l.owner_id, l.title FROM inquiries i JOIN listings l ON l.id=i.listing_id WHERE i.thread_token=?").get(p.token);
  if (!i) return send(res, 404, { error: "Conversation not found" });
  const body = String((req.body || {}).body || "").trim();
  if (!body) return send(res, 400, { error: "Write a message" });
  if (body.length > 2000) return send(res, 400, { error: "Message too long" });
  const recent = db.prepare("SELECT COUNT(*) n FROM messages WHERE inquiry_id=? AND sender='tenant' AND created_at > datetime('now','-1 hour')").get(i.id).n;
  if (recent >= 20) return send(res, 429, { error: "Too many messages — please wait a bit" });
  db.prepare("INSERT INTO messages (inquiry_id,sender,body) VALUES (?,?,?)").run(i.id, "tenant", body);
  db.prepare("UPDATE inquiries SET owner_unread=1, updated_at=datetime('now') WHERE id=?").run(i.id);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(i.owner_id, "inquiry", "New message", `${i.from_name} replied about "${i.title}".`);
  send(res, 201, { ok: true });
});

/* ---------- 7 · saved searches / alerts ---------- */
function alertMatches(c, r) {
  if (r.status !== "active") return false;
  if (c.cat && c.cat !== "all" && r.category !== c.cat) return false;
  if (c.direct && (r.lister_role || "owner") !== "owner") return false;
  if (c.price) { const [lo, hi] = String(c.price).split("-").map(Number); if ((Number.isFinite(lo) && r.price < lo) || (Number.isFinite(hi) && r.price > hi)) return false; }
  if (c.beds !== undefined && c.beds !== "") { if (r.bedrooms == null) return false; if (String(c.beds) === "3" ? r.bedrooms < 3 : r.bedrooms !== +c.beds) return false; }
  if (c.q) { const { tokens, priceCap } = parseSearch(c.q); if (priceCap !== null && r.price > priceCap) return false; if (tokens.length && !searchScore(r, tokens)) return false; }
  return true;
}
function describeAlert(c) {
  const bits = [];
  if (c.cat === "land" || c.cat === "commercial") bits.push(c.cat === "land" ? "Land" : "Commercial property");
  else {
    bits.push(c.beds === "0" ? "Bedsitters" : c.beds === "3" ? "3+ bedroom homes" : c.beds ? `${c.beds} bedroom homes` : "Homes");
    bits.push(c.cat === "sale" ? "for sale" : c.cat === "shortlet" ? "(Airbnb)" : c.cat === "rent" ? "for rent" : "");
  }
  if (c.q) bits.push(`matching “${c.q}”`);
  if (c.price) { const [lo, hi] = String(c.price).split("-").map(Number); bits.push(hi >= 999999999 ? `above KES ${lo.toLocaleString("en-KE")}` : lo ? `KES ${lo.toLocaleString("en-KE")}–${hi.toLocaleString("en-KE")}` : `under KES ${hi.toLocaleString("en-KE")}`); }
  if (c.direct) bits.push("direct from owners");
  return bits.filter(Boolean).join(" ").slice(0, 140);
}
router.add("POST", "/api/alerts", async (req, res) => {
  const b = req.body || {};
  const email = String(b.email || "").trim().toLowerCase(), phone = String(b.phone || "").trim();
  const useEmail = /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email), usePhone = /^0[17]\d{8}$/.test(phone);
  if (!useEmail && !usePhone) return send(res, 400, { error: "Enter your email (or phone) for alerts" });
  if (useEmail && !mailConfigured()) return send(res, 400, { error: "Email alerts aren't available yet" });
  if (!useEmail && !smsConfigured()) return send(res, 400, { error: "SMS alerts aren't available yet — use your email" });
  const c = b.criteria || {};
  const criteria = { cat: ["rent", "sale", "shortlet", "land", "commercial"].includes(c.cat) ? c.cat : "all", q: String(c.q || "").trim().slice(0, 80),
    price: /^\d+-\d+$/.test(c.price || "") ? c.price : "", beds: ["0", "1", "2", "3"].includes(String(c.beds)) ? String(c.beds) : "", direct: !!c.direct };
  const who = useEmail ? email : phone;
  if (db.prepare(`SELECT COUNT(*) n FROM saved_searches WHERE ${useEmail ? "email" : "phone"}=?`).get(who).n >= 10)
    return send(res, 400, { error: "You already have 10 alerts — remove one first (link in any alert email)" });
  const token = crypto.randomBytes(18).toString("base64url"), label = describeAlert(criteria);
  db.prepare("INSERT INTO saved_searches (email,phone,criteria,label,token) VALUES (?,?,?,?,?)").run(useEmail ? email : "", useEmail ? "" : phone, JSON.stringify(criteria), label, token);
  const confirm = `${SITE()}/api/alerts/${token}/confirm`;
  try {
    if (useEmail) await sendMail({ to: email, subject: "Confirm your PataHome alert", text: `Karibu!\n\nConfirm you'd like an email when new listings match:\n\n${label}\n\nConfirm alert: ${confirm}\n\nIf you didn't ask for this, ignore this email — nothing will be sent.\n\n— PataHome` });
    else await sendSms({ to: phone, text: `PataHome: confirm alerts for "${label.slice(0, 60)}": ${confirm}` });
  } catch (e) { console.error("alert confirm send:", e.message); return send(res, 400, { error: "Couldn't send the confirmation — try again shortly" }); }
  send(res, 201, { ok: true, label, pendingConfirm: true });
});
const noticeRedirect = (res, msg, to = "/browse") => { res.writeHead(302, { Location: `${to}?notice=${encodeURIComponent(msg)}` }); res.end(); };
router.add("GET", "/api/alerts/:token/confirm", (req, res, p) => {
  const a = db.prepare("SELECT * FROM saved_searches WHERE token=?").get(p.token);
  if (!a) return noticeRedirect(res, "That alert link has expired.");
  db.prepare("UPDATE saved_searches SET confirmed=1 WHERE id=?").run(a.id);
  noticeRedirect(res, `Alert on: we'll tell you about new ${a.label}.`);
});
router.add("GET", "/api/alerts/:token/unsubscribe", (req, res, p) => {
  db.prepare("DELETE FROM saved_searches WHERE token=?").run(p.token);
  noticeRedirect(res, "Alert removed — you won't get these emails any more.");
});
function matchAlerts(listingId) {
  if (!settingOn("alerts_enabled")) return;
  const r = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(listingId);
  if (!r || r.status !== "active") return;
  const today = new Date().toISOString().slice(0, 10);
  const url = `${SITE()}/listing/${r.id}/${slugify(r.title)}`;
  const unit = r.category === "rent" ? "/month" : r.category === "shortlet" ? "/night" : "";
  for (const a of db.prepare("SELECT * FROM saved_searches WHERE confirmed=1").all()) {
    let c; try { c = JSON.parse(a.criteria); } catch { continue; }
    if (!alertMatches(c, r)) continue;
    const sent = a.sent_day === today ? a.sent_today : 0;
    if (sent >= 5) continue; // daily cap per alert
    db.prepare("UPDATE saved_searches SET sent_day=?, sent_today=? WHERE id=?").run(today, sent + 1, a.id);
    const off = `${SITE()}/api/alerts/${a.token}/unsubscribe`;
    if (a.email && mailConfigured()) sendMail({ to: a.email, subject: `New on PataHome: ${r.title} — ${priceText(r)}`,
      text: `A new listing matches your alert (${a.label}):\n\n${r.title}\n${priceText(r)} · ${r.area_name}, ${r.county}${r.bedrooms != null ? ` · ${r.bedrooms === 0 ? "Bedsitter" : r.bedrooms + " bedroom"}` : ""}\n\nSee it: ${url}\n\nStay safe: never pay before you've seen the house and met the owner.\n\nStop this alert: ${off}\n\n— PataHome` })
      .catch(e => console.error("alert mail:", e.message));
    else if (a.phone && smsConfigured()) sendSms({ to: a.phone, text: `PataHome: new ${r.title.slice(0, 40)} ${priceText(r)} in ${r.area_name}. ${url} Stop: ${off}` })
      .catch(e => console.error("alert sms:", e.message));
  }
}

/* hourly jobs for this block (reminders + neighbourhood backfill) */
setTimeout(() => { viewingReminders().catch(() => {}); backfillNearby().catch(() => {}); }, 8000);
setInterval(() => { viewingReminders().catch(e => console.error("viewing reminders:", e.message)); backfillNearby().catch(() => {}); }, 3600e3);


/* =====================================================================
   Operations: error alerts, database backups, traffic stats, referrals,
   photo moderation.
   ===================================================================== */

/* ---------- 12 · error alerts ----------
   Emails ALERT_EMAIL (default info@patahome.co.ke) when something breaks.
   The same problem alerts at most once per 30 min, and at most 20 a day. */
const ALERT_TO = () => process.env.ALERT_EMAIL || "info@patahome.co.ke";
const alertSeen = new Map(); let alertDay = "", alertCount = 0;
function alertAdmin(subject, detail) {
  try {
    console.error(`[alert] ${subject}\n${detail || ""}`);
    if (!mailConfigured() || process.env.NODE_ENV === "test") return;
    const key = subject.slice(0, 120), now = Date.now(), day = new Date().toISOString().slice(0, 10);
    if (day !== alertDay) { alertDay = day; alertCount = 0; }
    if (alertCount >= 20 || (alertSeen.get(key) || 0) > now - 30 * 60e3) return;
    alertSeen.set(key, now); alertCount++;
    sendMail({ to: ALERT_TO(), subject: `⚠️ PataHome: ${subject}`.slice(0, 180),
      text: `${subject}\n\n${String(detail || "").slice(0, 4000)}\n\nTime: ${new Date().toISOString()}\nServer: ${SITE()}\n\n(Same alert is muted for 30 minutes.)` })
      .catch(e => console.error("alert mail failed:", e.message));
  } catch (e) { console.error("alertAdmin failed:", e); }
}
process.on("unhandledRejection", (e) => alertAdmin("Unhandled error (server kept running)", (e && e.stack) || String(e)));
process.on("uncaughtException", (e) => {
  alertAdmin("Server crashed and is restarting", (e && e.stack) || String(e));
  setTimeout(() => process.exit(1), 2500); // Railway restarts the process
});

/* ---------- 2 · database backups ----------
   Once a day: a consistent snapshot (VACUUM INTO), gzipped, kept on the
   volume (last 7) and uploaded to Cloudinary as a private file (last 30).
   Admin can trigger one and download the latest from the admin panel. */
const zlib = require("node:zlib");
const DB_FILE = process.env.DB_PATH || path.join(__dirname, "patahome.db");
const BACKUP_DIR = process.env.BACKUP_DIR || path.join(path.dirname(DB_FILE), "backups");
let backupRunning = false;
async function runBackup(reason = "scheduled") {
  if (backupRunning) return { ok: false, error: "A backup is already running" };
  backupRunning = true;
  const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 16);
  const raw = path.join(BACKUP_DIR, `patahome-${stamp}.db`), gz = raw + ".gz";
  try {
    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    if (fs.existsSync(raw)) fs.unlinkSync(raw);
    db.exec(`VACUUM INTO '${raw.replace(/'/g, "''")}'`);
    fs.writeFileSync(gz, zlib.gzipSync(fs.readFileSync(raw), { level: 9 }));
    fs.unlinkSync(raw);
    const bytes = fs.statSync(gz).size;
    // keep the newest 7 local copies
    const local = fs.readdirSync(BACKUP_DIR).filter(f => /^patahome-.*\.db\.gz$/.test(f)).sort();
    for (const f of local.slice(0, Math.max(0, local.length - 7))) fs.unlinkSync(path.join(BACKUP_DIR, f));
    let remote = "";
    if (cldEnabled()) {
      const publicId = `patahome-${stamp}.db.gz`, folder = "patahome/backups", timestamp = Math.floor(Date.now() / 1000);
      const params = { folder, public_id: publicId, timestamp, type: "authenticated" };
      const fd = new FormData();
      fd.append("file", new Blob([fs.readFileSync(gz)]), publicId);
      for (const [k, v] of Object.entries(params)) fd.append(k, String(v));
      fd.append("api_key", CLD.key); fd.append("signature", cldSign(params));
      const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/raw/upload`, { method: "POST", body: fd, signal: AbortSignal.timeout(120000) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error("Cloudinary upload failed: " + ((d.error && d.error.message) || r.status));
      remote = d.public_id || publicId;
      pruneRemoteBackups().catch(e => console.error("backup prune:", e.message));
    }
    db.prepare("INSERT INTO backups (file,bytes,remote,ok) VALUES (?,?,?,1)").run(path.basename(gz), bytes, remote);
    console.log(`[backup] ${reason}: ${path.basename(gz)} (${Math.round(bytes / 1024)} KB)${remote ? " → Cloudinary" : ""}`);
    return { ok: true, file: path.basename(gz), bytes, remote };
  } catch (e) {
    db.prepare("INSERT INTO backups (file,ok,error) VALUES (?,0,?)").run(path.basename(gz), String(e.message).slice(0, 300));
    alertAdmin("Database backup failed", e.stack || e.message);
    return { ok: false, error: e.message };
  } finally { backupRunning = false; }
}
async function pruneRemoteBackups() {
  const auth = { Authorization: "Basic " + Buffer.from(`${CLD.key}:${CLD.secret}`).toString("base64") };
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/resources/raw/authenticated?prefix=patahome/backups/&max_results=100`, { headers: auth });
  if (!r.ok) return;
  const list = ((await r.json()).resources || []).map(x => x.public_id).sort();
  const old = list.slice(0, Math.max(0, list.length - 30));
  if (!old.length) return;
  const q = old.map(id => "public_ids[]=" + encodeURIComponent(id)).join("&");
  await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/resources/raw/authenticated?${q}`, { method: "DELETE", headers: auth });
}
function backupDue() {
  const last = db.prepare("SELECT at FROM backups WHERE ok=1 ORDER BY id DESC LIMIT 1").get();
  return !last || Date.now() - new Date(last.at.replace(" ", "T") + "Z").getTime() > 20 * 3600e3;
}
if (process.env.NODE_ENV !== "test" && process.env.BACKUPS !== "off") {
  setTimeout(() => { if (backupDue()) runBackup("startup"); }, 60e3);
  setInterval(() => { if (backupDue()) runBackup(); }, 3600e3);
}
router.add("GET", "/api/admin/backups", (req, res) => {
  if (!requireAdmin(req, res, "super")) return;
  send(res, 200, { cloud: cldEnabled(), dir: BACKUP_DIR, backups: db.prepare("SELECT * FROM backups ORDER BY id DESC LIMIT 20").all() });
});
router.add("POST", "/api/admin/backups", async (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return; auditOnSuccess(req, res, a, "backup_now", "backup", null, null);
  const r = await runBackup("manual");
  send(res, r.ok ? 200 : 400, r.ok ? r : { error: r.error });
});
router.add("GET", "/api/admin/backups/latest", (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return; auditOnSuccess(req, res, a, "backup_download", "backup", null, null);
  const files = fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter(f => /^patahome-.*\.db\.gz$/.test(f)).sort() : [];
  if (!files.length) return send(res, 404, { error: "No backup yet — run one first" });
  const f = files[files.length - 1];
  res.writeHead(200, { "Content-Type": "application/gzip", "Content-Disposition": `attachment; filename="${f}"`, "Cache-Control": "no-store" });
  res.end(fs.readFileSync(path.join(BACKUP_DIR, f)));
});

/* ---------- data retention (matches the privacy policy) ---------- */
function retentionSweep() {
  const del = (sql) => { try { return db.prepare(sql).run().changes; } catch (e) { console.error("retention:", e.message); return 0; } };
  const n = del("DELETE FROM inquiries WHERE COALESCE(updated_at, created_at) < datetime('now','-24 months')")
    + del("DELETE FROM viewings WHERE created_at < datetime('now','-24 months')")
    + del("DELETE FROM reports WHERE created_at < datetime('now','-24 months')")
    + del("DELETE FROM verify_codes WHERE expires_at < datetime('now','-1 day')")
    + del("DELETE FROM pv_uniques WHERE day < date('now','-90 days')")
    + del("DELETE FROM sessions WHERE expires_at < " + Date.now())
    + del("DELETE FROM notifications WHERE created_at < datetime('now','-12 months')");
  if (n) console.log(`[retention] removed ${n} old rows`);
}
if (process.env.NODE_ENV !== "test") { setTimeout(retentionSweep, 90e3); setInterval(retentionSweep, 6 * 3600e3); }

/* ---------- 9 · traffic stats (cookieless) ----------
   No cookies, no third parties, no raw IPs stored: a visitor is counted as
   a daily hash of IP + browser with a salt that changes every day. */
const BOT_RX = /bot|crawl|spider|slurp|preview|facebookexternalhit|whatsapp|curl|wget|python|headless|lighthouse/i;
const daySalt = () => crypto.createHmac("sha256", process.env.JWT_SECRET || "dev").update("pv:" + new Date().toISOString().slice(0, 10)).digest("hex");
function refHost(ref) {
  try { const h = new URL(ref).hostname.replace(/^www\./, ""); return /patahome\.co\.ke$/.test(h) ? "" : h.slice(0, 80); } catch { return ""; }
}
router.add("POST", "/api/pv", (req, res) => {
  const ua = String(req.headers["user-agent"] || "");
  if (!ua || BOT_RX.test(ua)) return send(res, 204, {});
  const b = req.body || {};
  const p0 = String(b.path || "/").split("?")[0].slice(0, 120);
  const pathKey = p0.startsWith("/listing/") ? "/listing/*" : p0.replace(/\/\d+(?=\/|$)/g, "/*");
  const day = new Date().toISOString().slice(0, 10);
  db.prepare("INSERT INTO pv_daily (day,path,views) VALUES (?,?,1) ON CONFLICT(day,path) DO UPDATE SET views=views+1").run(day, pathKey);
  const host = refHost(b.ref);
  if (host) db.prepare("INSERT INTO pv_ref (day,host,n) VALUES (?,?,1) ON CONFLICT(day,host) DO UPDATE SET n=n+1").run(day, host);
  const city = String(req.headers["cf-ipcity"] || "").slice(0, 60);
  if (city) db.prepare("INSERT INTO pv_city (day,city,n) VALUES (?,?,1) ON CONFLICT(day,city) DO UPDATE SET n=n+1").run(day, city);
  const h = crypto.createHash("sha256").update(daySalt() + clientIp(req) + ua).digest("hex").slice(0, 20);
  db.prepare("INSERT OR IGNORE INTO pv_uniques (day,h) VALUES (?,?)").run(day, h);
  send(res, 204, {});
});
function logSearch(q, results) {
  const norm = String(q || "").toLowerCase().replace(/\s+/g, " ").trim().slice(0, 80);
  if (norm.length < 2) return;
  db.prepare("INSERT INTO search_log (day,q,results,n) VALUES (?,?,?,1) ON CONFLICT(day,q) DO UPDATE SET n=n+1, results=?")
    .run(new Date().toISOString().slice(0, 10), norm, results, results);
}
router.add("GET", "/api/admin/analytics", (req, res) => {
  if (!requireAdmin(req, res, "view")) return;
  const days = Math.min(90, Math.max(7, +req.query.days || 30)), since = `-${days} days`;
  const series = [];
  const v = Object.fromEntries(db.prepare("SELECT day, SUM(views) n FROM pv_daily WHERE day >= date('now', ?) GROUP BY day").all(since).map(r => [r.day, r.n]));
  const u = Object.fromEntries(db.prepare("SELECT day, COUNT(*) n FROM pv_uniques WHERE day >= date('now', ?) GROUP BY day").all(since).map(r => [r.day, r.n]));
  for (let i = days - 1; i >= 0; i--) { const d = new Date(Date.now() - i * 864e5).toISOString().slice(0, 10); series.push({ day: d, views: v[d] || 0, visitors: u[d] || 0 }); }
  const top = (sql) => db.prepare(sql).all(since);
  send(res, 200, {
    days, series,
    totals: { views: series.reduce((a, x) => a + x.views, 0), visitors: series.reduce((a, x) => a + x.visitors, 0) },
    pages: top("SELECT path k, SUM(views) n FROM pv_daily WHERE day >= date('now', ?) GROUP BY path ORDER BY n DESC LIMIT 12"),
    referrers: top("SELECT host k, SUM(n) n FROM pv_ref WHERE day >= date('now', ?) GROUP BY host ORDER BY n DESC LIMIT 12"),
    towns: top("SELECT city k, SUM(n) n FROM pv_city WHERE day >= date('now', ?) GROUP BY city ORDER BY n DESC LIMIT 12"),
    searches: top("SELECT q k, SUM(n) n, MAX(results) results FROM search_log WHERE day >= date('now', ?) GROUP BY q ORDER BY n DESC LIMIT 15"),
    noResults: top("SELECT q k, SUM(n) n FROM search_log WHERE day >= date('now', ?) AND results=0 GROUP BY q ORDER BY n DESC LIMIT 15")
  });
});

/* ---------- 10 · owner referrals ----------
   Every account gets an invite link. When someone who signed up through it
   publishes their first listing, both get a free featured week: the new
   listing is featured straight away, and the inviter's newest live listing
   is featured (or they get a credit used on their next listing). */
const REF_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
function referralCode(userId) {
  const u = db.prepare("SELECT referral_code FROM users WHERE id=?").get(userId);
  if (u && u.referral_code) return u.referral_code;
  for (let i = 0; i < 20; i++) {
    const code = Array.from(crypto.randomBytes(6), b => REF_ALPHABET[b % REF_ALPHABET.length]).join("");
    try { db.prepare("UPDATE users SET referral_code=? WHERE id=?").run(code, userId); return code; } catch { /* collision */ }
  }
  throw new Error("could not create referral code");
}
function applyReferral(newUserId, code) {
  if (!code) return;
  const ref = db.prepare("SELECT id FROM users WHERE referral_code=?").get(String(code).toUpperCase().slice(0, 12));
  if (ref && ref.id !== newUserId) db.prepare("UPDATE users SET referred_by=? WHERE id=? AND referred_by IS NULL").run(ref.id, newUserId);
}
const FEATURE_WEEK = 7 * 86400e3;
function featureFor(listingId, ms) {
  const l = db.prepare("SELECT featured_until FROM listings WHERE id=?").get(listingId);
  const base = l && l.featured_until && l.featured_until > new Date().toISOString() ? new Date(l.featured_until).getTime() : Date.now();
  db.prepare("UPDATE listings SET featured_until=? WHERE id=?").run(new Date(base + ms).toISOString(), listingId);
}
function onListingPublished(userId, listingId) {
  const u = db.prepare("SELECT id, name, referred_by, referral_rewarded, featured_credits FROM users WHERE id=?").get(userId);
  if (!u) return;
  // spend a credit earned by inviting someone
  if (u.featured_credits > 0) {
    featureFor(listingId, FEATURE_WEEK);
    db.prepare("UPDATE users SET featured_credits=featured_credits-1 WHERE id=?").run(u.id);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(u.id, "system", "Featured for a week ★", "Your invite reward was used — this listing is featured at the top of search for 7 days.");
  }
  if (!u.referred_by || u.referral_rewarded) return;
  const n = db.prepare("SELECT COUNT(*) n FROM listings WHERE owner_id=?").get(u.id).n;
  if (n !== 1) return; // only the first listing earns the reward
  db.prepare("UPDATE users SET referral_rewarded=1 WHERE id=?").run(u.id);
  featureFor(listingId, FEATURE_WEEK);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(u.id, "system", "Welcome gift: featured for a week ★", "You joined through an invite, so your first listing is featured at the top of search for 7 days.");
  const inviterListing = db.prepare("SELECT id FROM listings WHERE owner_id=? AND status='active' ORDER BY id DESC LIMIT 1").get(u.referred_by);
  if (inviterListing) {
    featureFor(inviterListing.id, FEATURE_WEEK);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(u.referred_by, "system", "Thanks for the invite ★", `${u.name} posted their first listing — your newest listing is featured for 7 days.`);
  } else {
    db.prepare("UPDATE users SET featured_credits=featured_credits+1 WHERE id=?").run(u.referred_by);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(u.referred_by, "system", "You earned a featured week ★", `${u.name} posted their first listing. Your next listing will be featured for 7 days.`);
  }
}
router.add("GET", "/api/my/referral", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  const code = referralCode(u.id);
  const me = db.prepare("SELECT featured_credits FROM users WHERE id=?").get(u.id);
  send(res, 200, { code, link: `${SITE()}/r/${code}`,
    invited: db.prepare("SELECT COUNT(*) n FROM users WHERE referred_by=?").get(u.id).n,
    rewarded: db.prepare("SELECT COUNT(*) n FROM users WHERE referred_by=? AND referral_rewarded=1").get(u.id).n,
    credits: me ? me.featured_credits : 0 });
});
router.add("GET", "/r/:code", (req, res, p) => {
  const code = String(p.code || "").toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 12);
  res.writeHead(302, { Location: `/dashboard?ref=${code}&signup=1`, "Cache-Control": "no-store" });
  res.end();
});

/* ---------- 11 · photo moderation ----------
   Admin gets a "Photos" review wall of the newest uploads with one-tap
   removal. Optionally, set CLOUDINARY_MODERATION (e.g. "aws_rek") to have
   Cloudinary's paid moderation add-on screen uploads; rejected photos flag
   the listing and pause it for review. */
const CLD_MODERATION = () => String(process.env.CLOUDINARY_MODERATION || "").trim();
async function cldResource(publicId) {
  if (!cldEnabled()) return null;
  const r = await fetch(`https://api.cloudinary.com/v1_1/${CLD.cloud}/resources/image/upload/${publicId.split("/").map(encodeURIComponent).join("/")}`,
    { headers: { Authorization: "Basic " + Buffer.from(`${CLD.key}:${CLD.secret}`).toString("base64") }, signal: AbortSignal.timeout(10000) });
  return r.ok ? r.json() : null;
}
router.add("GET", "/api/admin/photos", (req, res) => {
  if (!requireAdmin(req, res, "moderate")) return;
  const rows = db.prepare(`${LISTING_SQL} WHERE l.status IN ('active','under_review','expired') AND l.photos != '[]' ORDER BY l.id DESC LIMIT 60`).all();
  const out = [];
  for (const r of rows) for (const id of parsePhotos(r.photos)) out.push({ listingId: r.id, title: r.title, owner: r.owner_name, status: r.status, publicId: id,
    thumb: cldEnabled() ? photoUrl(id, "c_fill,w_300,h_225,q_auto:eco") : id, full: cldEnabled() ? photoUrl(id, "c_limit,w_1280,q_auto") : id });
  send(res, 200, out.slice(0, 180));
});
router.add("POST", "/api/admin/photos/remove", (req, res) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return; auditOnSuccess(req, res, a, "photo_remove", "listing", (req.body || {}).listingId, req.body);
  const { listingId, publicId, reason } = req.body || {};
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);
  if (!l) return send(res, 404, { error: "Listing not found" });
  const photos = parsePhotos(l.photos);
  if (!photos.includes(publicId)) return send(res, 404, { error: "Photo not on this listing" });
  db.prepare("UPDATE listings SET photos=? WHERE id=?").run(JSON.stringify(photos.filter(x => x !== publicId)), l.id);
  cldDestroy(publicId);
  db.prepare("DELETE FROM photo_hashes WHERE public_id=?").run(publicId);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "A photo was removed",
    `One photo on "${l.title}" was removed by our team${reason ? ` (${String(reason).slice(0, 120)})` : ""}. Photos must show the actual property and follow our listing rules.`);
  send(res, 200, { ok: true });
});


/* ================= admin: team roles, audit log, alerts =================
   Roles: super (everything), moderator (listings, reports, documents, users),
   support (tickets + read-only user info). Only the super admin sees contact
   details in bulk, exports data, changes settings, grants roles or views as a user. */
const ADMIN_ROLES = { super: "Super admin", moderator: "Moderator", support: "Support" };
const ROLE_CAPS = {
  super: ["view", "moderate", "support", "users", "super"],
  moderator: ["view", "moderate", "users"],
  support: ["view", "support"]
};
function adminRoleOf(id) {
  const r = db.prepare("SELECT role, admin_role FROM users WHERE id=?").get(id);
  return r && r.role === "admin" ? (ROLE_CAPS[r.admin_role] ? r.admin_role : "super") : null;
}
function can(u, cap) {
  if (!u || u.ro) return false;
  const r = adminRoleOf(u.id);
  return !!(r && ROLE_CAPS[r].includes(cap));
}
function requireAdmin(req, res, cap = "view") {
  const u = requireAuth(req, res); if (!u) return null;
  const r = u.ro ? null : adminRoleOf(u.id);
  if (!r) { send(res, 403, { error: "Admin access only" }); return null; }
  if (!ROLE_CAPS[r].includes(cap)) { send(res, 403, { error: `Your role (${ADMIN_ROLES[r]}) can't do this` }); return null; }
  u.adminRole = r;
  return u;
}
// Append-only record of every admin action (the table refuses UPDATE and DELETE).
function audit(req, u, action, targetType, targetId, detail) {
  try {
    db.prepare("INSERT INTO admin_audit (admin_id,admin_name,action,target_type,target_id,detail,ip,ua) VALUES (?,?,?,?,?,?,?,?)")
      .run(u ? u.id : null, u ? (u.name || "") : "system", action, targetType || null, targetId == null ? null : String(targetId),
           detail == null ? null : (typeof detail === "string" ? detail : JSON.stringify(detail)).slice(0, 1000),
           req ? clientIp(req) : "", req ? String(req.headers["user-agent"] || "").slice(0, 200) : "");
  } catch (e) { console.error("audit failed:", e.message); }
}
// log an admin action once the request has succeeded
function auditOnSuccess(req, res, a, action, type, id, detail) {
  res.once("finish", () => { if (res.statusCode < 300) audit(req, a, action, type, id, detail); });
}
// Serious events: email ALERT_EMAIL (muted per subject for 30 min) and, if set, SMS ADMIN_ALERT_PHONE.
const smsAlertSeen = new Map();
function adminAlert(subject, detail) {
  alertAdmin(subject, detail);
  audit(null, null, "alert", null, null, subject + (detail ? " — " + String(detail).slice(0, 300) : ""));
  const to = process.env.ADMIN_ALERT_PHONE;
  if (to && smsConfigured() && process.env.NODE_ENV !== "test" && (smsAlertSeen.get(subject) || 0) < Date.now() - 30 * 60e3) {
    smsAlertSeen.set(subject, Date.now());
    sendSms({ to, text: `PataHome alert: ${subject}`.slice(0, 160) }).catch(e => console.error("alert sms failed:", e.message));
  }
}

/* ---------- bans & suspensions ---------- */
const lastNine = (s) => String(s || "").replace(/\D/g, "").slice(-9);
function isBlockedIdentifier(kind, value) {
  const v = kind === "email" ? String(value || "").trim().toLowerCase() : lastNine(value);
  if (!v || (kind !== "email" && v.length < 9)) return false;
  return !!db.prepare("SELECT 1 FROM banned_identifiers WHERE kind=? AND value=?").get(kind === "email" ? "email" : "phone", v);
}
function isBanned(row) {
  if (!row || !row.banned_until) return false;
  if (row.banned_until === "forever") return true;
  if (row.banned_until > new Date().toISOString()) return true;
  unbanUser(row.id, null, null, "ban period ended");
  return false;
}
function banMessage(row) {
  if (!isBanned(row)) return "";
  return row.banned_until === "forever"
    ? "This account has been closed for breaking PataHome's rules. Contact info@patahome.co.ke if you think this is a mistake."
    : `This account is suspended until ${new Date(row.banned_until).toLocaleString("en-KE", { dateStyle: "medium", timeStyle: "short", timeZone: "Africa/Nairobi" })}${row.ban_reason ? " — " + row.ban_reason : ""}.`;
}
function banUser(userId, until, reason, blockIds, adminU, req) {
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(userId);
  db.prepare("UPDATE users SET banned_until=?, ban_reason=?, banned_at=datetime('now'), banned_by=? WHERE id=?").run(until, reason || null, adminU ? adminU.id : null, userId);
  const hidden = db.prepare("UPDATE listings SET status='suspended', status_changed_at=datetime('now') WHERE owner_id=? AND status IN ('active','under_review')").run(userId).changes;
  revokeSessions(userId);
  if (blockIds) {
    const add = db.prepare("INSERT OR IGNORE INTO banned_identifiers (kind,value,user_id) VALUES (?,?,?)");
    if (lastNine(u.phone).length === 9 && realPhone(u.phone)) add.run("phone", lastNine(u.phone), userId);
    if (u.email) add.run("email", u.email.toLowerCase(), userId);
    if (lastNine(u.whatsapp).length === 9) add.run("phone", lastNine(u.whatsapp), userId);
  }
  audit(req, adminU, until === "forever" ? "ban" : "suspend", "user", userId, { until, reason, blockIds: !!blockIds, listingsHidden: hidden });
  return hidden;
}
function unbanUser(userId, adminU, req, why) {
  db.prepare("UPDATE users SET banned_until=NULL, ban_reason=NULL, banned_at=NULL, banned_by=NULL WHERE id=?").run(userId);
  const shown = db.prepare("UPDATE listings SET status='active', confirmed_at=datetime('now'), status_changed_at=datetime('now') WHERE owner_id=? AND status='suspended'").run(userId).changes;
  db.prepare("DELETE FROM banned_identifiers WHERE user_id=?").run(userId);
  audit(req, adminU, "unban", "user", userId, why || null);
  return shown;
}
setInterval(() => {
  try { for (const r of db.prepare("SELECT * FROM users WHERE banned_until IS NOT NULL AND banned_until!='forever' AND banned_until<=?").all(new Date().toISOString())) isBanned(r); }
  catch (e) { console.error("ban expiry:", e.message); }
}, 15 * 60e3).unref();

/* ---------- word / number blocklist for listings ---------- */
function blocklistHit(text) {
  const terms = db.prepare("SELECT term FROM blocklist").all().map(r => r.term);
  if (!terms.length) return null;
  const low = String(text || "").toLowerCase(), digits = low.replace(/[\s\-().+]/g, "");
  for (const t of terms) {
    const nine = lastNine(t);
    if (/^[\d\s\-+()]+$/.test(t) && nine.length === 9) { if (digits.includes(nine)) return t; }
    else if (low.includes(t.toLowerCase())) return t;
  }
  return null;
}
function checkBlocklist(listingId) {
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(listingId);
  if (!l) return;
  const hit = blocklistHit([l.title, l.description, l.agent_fee, l.features].join(" \n "));
  if (!hit) return;
  if (l.status === "active") db.prepare("UPDATE listings SET status='under_review', status_changed_at=datetime('now') WHERE id=?").run(l.id);
  addFlag(l.id, "blocked_term", `Contains blocked term “${hit}”`);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "Listing held for review",
    `"${l.title}" is being checked by our team before it goes live. This usually takes less than a day.`);
  adminAlert("Listing held: blocked term", `Listing #${l.id} "${l.title}" contains “${hit}”. Review it: ${SITE()}/admin`);
}

/* ---------- apply saved settings to the running server ---------- */
function applySettings() {
  settingsCache.clear();
  LISTING_TTL_DAYS = +setting("listing_ttl_days");
  CLD.maxPhotos = +setting("max_photos");
  SESSION_IDLE_MS = +setting("session_idle_hours") * 3600e3;
  SESSION_MAX_MS = +setting("session_max_days") * 86400e3;
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
    openTickets: one("SELECT COUNT(*) FROM support_tickets WHERE status='open'"),
    moderation: one("SELECT COUNT(*) FROM (SELECT listing_id FROM reports WHERE status='open' UNION SELECT listing_id FROM listing_flags WHERE resolved=0)"),
    byCategory: Object.fromEntries(db.prepare("SELECT category, COUNT(*) n FROM listings WHERE status='active' GROUP BY category").all().map(r => [r.category, r.n]))
  });
});

/* -------- moderation: tenant reports + automatic flags -------- */
router.add("GET", "/api/admin/moderation", (req, res) => {
  if (!requireAdmin(req, res, "moderate")) return;
  const ids = db.prepare(`SELECT listing_id id FROM reports WHERE status='open' UNION SELECT listing_id FROM listing_flags WHERE resolved=0`).all().map(r => r.id);
  const out = ids.map(id => {
    const l = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(id);
    if (!l) return null;
    const owner = db.prepare("SELECT phone, email FROM users WHERE id=?").get(l.owner_id) || {};
    return {
      id: l.id, title: l.title, status: l.status, price: l.price, category: l.category, area: l.area_name, county: l.county,
      ownerId: l.owner_id, ownerName: l.owner_name, ownerPhone: realPhone(owner.phone), ownerEmail: owner.email || "", listerRole: l.lister_role || "owner",
      reports: db.prepare("SELECT reason, details, contact, created_at FROM reports WHERE listing_id=? AND status='open' ORDER BY id DESC").all(id)
        .map(r => ({ reason: REPORT_REASONS[r.reason] || r.reason, details: r.details, contact: r.contact, at: r.created_at })),
      flags: db.prepare("SELECT kind, detail, created_at FROM listing_flags WHERE listing_id=? AND resolved=0").all(id)
    };
  }).filter(Boolean).sort((a, b) => (b.status === "under_review") - (a.status === "under_review") || b.reports.length - a.reports.length);
  send(res, 200, out);
});
router.add("POST", "/api/admin/moderation/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return; auditOnSuccess(req, res, a, "moderation_" + String((req.body || {}).action || ""), "listing", p.id, null);
  const l = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!l) return send(res, 404, { error: "Listing not found" });
  const action = String((req.body || {}).action || "");
  if (action === "clear") {
    db.prepare("UPDATE reports SET status='dismissed' WHERE listing_id=? AND status='open'").run(l.id);
    db.prepare("UPDATE listing_flags SET resolved=1 WHERE listing_id=?").run(l.id);
    if (l.status === "under_review") {
      db.prepare("UPDATE listings SET status='active', confirmed_at=datetime('now'), status_changed_at=datetime('now') WHERE id=?").run(l.id);
      db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "Listing restored", `"${l.title}" was reviewed and is live again.`);
    }
    return send(res, 200, { ok: true });
  }
  if (action === "remove") {
    db.prepare("UPDATE listings SET status='removed', status_changed_at=datetime('now') WHERE id=?").run(l.id);
    db.prepare("UPDATE reports SET status='actioned' WHERE listing_id=? AND status='open'").run(l.id);
    db.prepare("UPDATE listing_flags SET resolved=1 WHERE listing_id=?").run(l.id);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "Listing removed", `"${l.title}" was removed after review because it broke our listing rules. Contact info@patahome.co.ke if you'd like to discuss.`);
    return send(res, 200, { ok: true });
  }
  send(res, 400, { error: "action must be clear or remove" });
});

/* -------- verification review queue -------- */
router.add("GET", "/api/admin/verifications", (req, res) => {
  if (!requireAdmin(req, res, "moderate")) return;
  const rows = db.prepare("SELECT * FROM users WHERE verify_status='pending' ORDER BY id").all();
  send(res, 200, rows.map(u => ({
    id: u.id, name: u.name, legalName: u.legal_name, phone: u.phone, email: u.email,
    idType: u.id_type || "National ID", idNumber: u.id_number, kraPin: u.kra_pin || "",
    dob: u.dob, county: u.county, town: u.town,
    docs: (() => { try { return JSON.parse(u.verify_docs || "[]"); } catch { return []; } })()
      .map(d => cldEnabled() ? photoUrl(d, "c_limit,w_1000,q_auto:good") : d),
    listings: db.prepare("SELECT COUNT(*) n FROM listings WHERE owner_id=? AND status!='removed'").get(u.id).n
  })));
});

router.add("POST", "/api/admin/verifications/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return; auditOnSuccess(req, res, a, (req.body && req.body.approve) ? "verify_approve" : "verify_reject", "user", p.id, req.body && req.body.reason);
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  const approve = !!(req.body && req.body.approve);
  if (approve) {
    db.prepare("UPDATE users SET verified=1, verify_status='verified' WHERE id=?").run(u.id);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(u.id, "verify", "You are verified ✓", "Your account passed verification — your listings now show the trusted badge.");
  } else {
    db.prepare("UPDATE users SET verified=0, verify_status='rejected' WHERE id=?").run(u.id);
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
      .run(u.id, "verify", "Verification not approved", (req.body && req.body.reason) ? String(req.body.reason).slice(0, 300) : "We couldn't verify your details. Check your ID information and try again, or contact support.");
  }
  send(res, 200, { ok: true });
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
  const a = requireAdmin(req, res, "view"); if (!a) return;
  const contacts = can(a, "super") || can(a, "support");
  const leads = {};
  for (const r of db.prepare("SELECT listing_id, COUNT(*) n FROM leads GROUP BY listing_id").all()) leads[r.listing_id] = r.n;
  const q = req.query, where = [], params = [];
  if (q.status === "all") {} else if (q.status) { where.push("l.status=?"); params.push(String(q.status)); } else where.push("l.status != 'removed'");
  if (q.owner) { where.push("l.owner_id=?"); params.push(+q.owner); }
  const rows = db.prepare(`SELECT l.*, a.name AS area_name, a.county, u.name AS owner_name, u.phone AS owner_phone
    FROM listings l JOIN areas a ON a.id=l.area_id JOIN users u ON u.id=l.owner_id
    ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY l.id DESC`).all(...params);
  send(res, 200, rows.map(r => ({
    id: r.id, category: r.category, title: r.title, description: r.description, area: r.area_name, areaId: r.area_id, county: r.county,
    price: r.price, bedrooms: r.bedrooms, status: r.status, featured: !!(r.featured_until && r.featured_until > new Date().toISOString()), featuredUntil: r.featured_until,
    adminBanner: r.admin_banner || "", ownerId: r.owner_id, ownerName: r.owner_name,
    ownerPhone: contacts ? realPhone(r.owner_phone) : (realPhone(r.owner_phone) ? maskPhone(r.owner_phone) : ""), leads: leads[r.id] || 0, createdAt: r.created_at
  })));
});

router.add("GET", "/api/admin/users", (req, res) => {
  const a = requireAdmin(req, res, "view"); if (!a) return;
  const contacts = can(a, "super") || can(a, "support");
  const rows = db.prepare(`SELECT u.id, u.name, u.phone, u.verified, u.role, u.admin_role, u.created_at, u.banned_until,
      (SELECT COUNT(*) FROM listings l WHERE l.owner_id=u.id AND l.status!='removed') AS listings
    FROM users u ORDER BY u.id DESC`).all();
  send(res, 200, rows.map(r => ({ id: r.id, name: r.name, phone: contacts ? realPhone(r.phone) : (realPhone(r.phone) ? maskPhone(r.phone) : ""),
    verified: r.verified, role: r.role, adminRole: r.role === "admin" ? (r.admin_role || "super") : null, created_at: r.created_at,
    banned: !!(r.banned_until && (r.banned_until === "forever" || r.banned_until > new Date().toISOString())), bannedUntil: r.banned_until, listings: r.listings })));
});

router.add("PATCH", "/api/admin/users/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return; auditOnSuccess(req, res, a, "set_verified", "user", p.id, req.body);
  const row = db.prepare("SELECT id FROM users WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "User not found" });
  if (req.body.verified !== undefined)
    db.prepare("UPDATE users SET verified=? WHERE id=?").run(req.body.verified ? 1 : 0, p.id);
  send(res, 200, { ok: true });
});

/* -------- admin: support tickets & live-chat inbox -------- */
router.add("GET", "/api/admin/support", (req, res) => {
  if (!requireAdmin(req, res, "support")) return;
  const rows = db.prepare(`
    SELECT t.id, t.subject, t.message, t.status, t.created_at,
           t.user_id, u.name AS user_name, u.phone AS user_phone, u.email AS user_email
    FROM support_tickets t LEFT JOIN users u ON u.id = t.user_id
    ORDER BY (t.status='open') DESC, t.id DESC`).all();
  send(res, 200, rows.map(r => ({
    id: r.id, subject: r.subject, message: r.message, status: r.status,
    createdAt: r.created_at,
    // Anonymous live-chat submissions store name+phone in the subject as "Live chat — Name (Phone)"
    source: r.user_id ? "user" : "live-chat",
    from: r.user_id ? { id: r.user_id, name: r.user_name, phone: realPhone(r.user_phone), email: r.user_email }
                    : parseChatSubject(r.subject)
  })));
});

// Parse the "Live chat — Name (Phone)" subject to surface name/phone in the UI.
function parseChatSubject(s) {
  const m = String(s || "").match(/^Live chat\s*[—-]\s*(.+?)\s*\((.+?)\)\s*$/);
  return m ? { id: null, name: m[1], phone: m[2], email: "" } : { id: null, name: "Anonymous", phone: "", email: "" };
}

router.add("PATCH", "/api/admin/support/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "support"); if (!a) return; auditOnSuccess(req, res, a, "ticket_" + String((req.body || {}).status || ""), "ticket", p.id, null);
  const row = db.prepare("SELECT id FROM support_tickets WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Ticket not found" });
  const status = req.body && req.body.status;
  if (status !== "open" && status !== "resolved")
    return send(res, 400, { error: "status must be 'open' or 'resolved'" });
  db.prepare("UPDATE support_tickets SET status=? WHERE id=?").run(status, p.id);
  send(res, 200, { ok: true });
});

/* ================= admin: people ================= */
router.add("GET", "/api/admin/me", (req, res) => {
  const a = requireAdmin(req, res); if (!a) return;
  send(res, 200, { id: a.id, name: a.name, role: a.adminRole, roleLabel: ADMIN_ROLES[a.adminRole], caps: ROLE_CAPS[a.adminRole] });
});

// One page about one person: profile, listings, reports, flags, leads, viewings, devices, history.
router.add("GET", "/api/admin/users/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "view"); if (!a) return;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  const contacts = can(a, "super") || can(a, "support");
  const listings = db.prepare(`SELECT l.id, l.title, l.category, l.status, l.price, l.created_at, l.featured_until, l.admin_banner, a.name area,
      (SELECT COUNT(*) FROM leads WHERE listing_id=l.id) leads, (SELECT COUNT(*) FROM inquiries WHERE listing_id=l.id) inquiries
    FROM listings l JOIN areas a ON a.id=l.area_id WHERE l.owner_id=? ORDER BY l.id DESC`).all(u.id);
  const ids = listings.map(l => l.id), inIds = ids.length ? `(${ids.join(",")})` : "(0)";
  send(res, 200, {
    user: {
      id: u.id, name: u.name, businessName: u.business_name || "", role: u.role, adminRole: u.role === "admin" ? (u.admin_role || "super") : null,
      phone: contacts ? realPhone(u.phone) : (realPhone(u.phone) ? maskPhone(u.phone) : ""), email: u.email ? (contacts ? u.email : maskEmail(u.email)) : "",
      whatsapp: contacts ? (u.whatsapp || "") : (u.whatsapp ? maskPhone(u.whatsapp) : ""),
      verified: !!u.verified, verifyStatus: u.verify_status || "none", phoneVerified: !!u.phone_verified, emailVerified: !!u.email_verified,
      county: u.county || "", town: u.town || "", createdAt: u.created_at,
      banned: isBanned(u), bannedUntil: u.banned_until, banReason: u.ban_reason || "", bannedAt: u.banned_at
    },
    listings: listings.map(l => ({ ...l, featured: !!(l.featured_until && l.featured_until > new Date().toISOString()) })),
    reports: db.prepare(`SELECT r.listing_id listingId, r.reason, r.details, r.status, r.created_at at FROM reports r WHERE r.listing_id IN ${inIds} ORDER BY r.id DESC LIMIT 50`).all()
      .map(r => ({ ...r, reason: REPORT_REASONS[r.reason] || r.reason })),
    flags: db.prepare(`SELECT listing_id listingId, kind, detail, resolved, created_at at FROM listing_flags WHERE listing_id IN ${inIds} ORDER BY id DESC LIMIT 50`).all(),
    inquiries: db.prepare(`SELECT i.id, i.listing_id listingId, i.from_name fromName, ${contacts ? "i.from_phone" : "''"} fromPhone, i.message, i.owner_reply reply, i.created_at at,
        (SELECT COUNT(*) FROM messages m WHERE m.inquiry_id=i.id) messages FROM inquiries i WHERE i.listing_id IN ${inIds} ORDER BY i.id DESC LIMIT 50`).all(),
    viewings: db.prepare(`SELECT id, listing_id listingId, name, slot_at slotAt, status, created_at at FROM viewings WHERE listing_id IN ${inIds} ORDER BY id DESC LIMIT 50`).all(),
    sessions: db.prepare("SELECT id, created_at, last_seen, ua, ip, readonly FROM sessions WHERE user_id=? ORDER BY last_seen DESC").all(u.id)
      .map(s => ({ id: s.id.slice(0, 6), started: new Date(s.created_at).toISOString(), lastSeen: new Date(s.last_seen).toISOString(), device: s.ua || "",
        ip: can(a, "super") ? s.ip : (s.ip ? s.ip.replace(/[\d]+$/, "x") : ""), viewAs: !!s.readonly })),
    history: db.prepare("SELECT at, admin_name admin, action, detail FROM admin_audit WHERE target_type='user' AND target_id=? ORDER BY id DESC LIMIT 50").all(String(u.id))
  });
});

router.add("POST", "/api/admin/users/:id/ban", (req, res, p) => {
  const a = requireAdmin(req, res, "users"); if (!a) return;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  if (u.role === "admin") return send(res, 400, { error: "Remove their admin role first" });
  const b = req.body || {}, reason = String(b.reason || "").trim().slice(0, 200);
  if (!reason) return send(res, 400, { error: "Give a reason — the user sees it" });
  const days = +b.days;
  const until = b.forever ? "forever" : days > 0 ? new Date(Date.now() + Math.min(days, 3650) * 86400e3).toISOString() : null;
  if (!until) return send(res, 400, { error: "Choose how long (days) or ban permanently" });
  if (until === "forever" && !can(a, "super")) return send(res, 403, { error: "Only the super admin can ban permanently" });
  const hidden = banUser(u.id, until, reason, !!b.blockIdentifiers, a, req);
  send(res, 200, { ok: true, listingsHidden: hidden, bannedUntil: until });
});
router.add("POST", "/api/admin/users/:id/unban", (req, res, p) => {
  const a = requireAdmin(req, res, "users"); if (!a) return;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  if (u.banned_until === "forever" && !can(a, "super")) return send(res, 403, { error: "Only the super admin can lift a permanent ban" });
  const shown = unbanUser(u.id, a, req, String((req.body || {}).note || "").slice(0, 200) || null);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(u.id, "system", "Your account is active again", "Welcome back — your listings are visible again.");
  send(res, 200, { ok: true, listingsShown: shown });
});
router.add("POST", "/api/admin/users/:id/signout", (req, res, p) => {
  const a = requireAdmin(req, res, "users"); if (!a) return;
  const u = db.prepare("SELECT id, role FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  if (u.role === "admin" && !can(a, "super")) return send(res, 403, { error: "Only the super admin can sign out another admin" });
  const n = revokeSessions(u.id).changes;
  audit(req, a, "force_signout", "user", u.id, `${n} session(s)`);
  send(res, 200, { ok: true, signedOut: n });
});
// Read-only look at the site as this user (30 min; every use is logged).
router.add("POST", "/api/admin/users/:id/view-as", (req, res, p) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  if (u.role === "admin") return send(res, 400, { error: "You can't view as another admin" });
  audit(req, a, "view_as", "user", u.id, "read-only, 30 min");
  send(res, 200, { token: createSession(u, req, a), name: u.name, expiresInMinutes: VIEW_AS_MS / 60e3 });
});
router.add("POST", "/api/admin/users/:id/role", (req, res, p) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const u = db.prepare("SELECT * FROM users WHERE id=?").get(p.id);
  if (!u) return send(res, 404, { error: "User not found" });
  if (u.id === a.id) return send(res, 400, { error: "You can't change your own role" });
  const role = String((req.body || {}).role || "");
  if (role !== "none" && !ADMIN_ROLES[role]) return send(res, 400, { error: "role must be none, support, moderator or super" });
  if (role !== "none" && isBanned(u)) return send(res, 400, { error: "Lift the ban first" });
  if (role !== "none" && !u.email && !realPhone(u.phone)) return send(res, 400, { error: "Admins need an email or phone for login codes" });
  if (role === "none") db.prepare("UPDATE users SET role='user', admin_role=NULL WHERE id=?").run(u.id);
  else db.prepare("UPDATE users SET role='admin', admin_role=? WHERE id=?").run(role, u.id);
  revokeSessions(u.id);
  audit(req, a, "set_role", "user", u.id, `${u.role === "admin" ? (u.admin_role || "super") : "none"} → ${role}`);
  if (role !== "none") adminAlert("New admin added", `${a.name} made ${u.name} (#${u.id}) a ${ADMIN_ROLES[role]}.`);
  send(res, 200, { ok: true });
});
router.add("GET", "/api/admin/team", (req, res) => {
  const a = requireAdmin(req, res, "view"); if (!a) return;
  send(res, 200, db.prepare("SELECT id, name, admin_role, email FROM users WHERE role='admin' ORDER BY id").all()
    .map(r => ({ id: r.id, name: r.name, role: r.admin_role || "super", roleLabel: ADMIN_ROLES[r.admin_role || "super"], email: can(a, "super") ? r.email || "" : "",
      lastLogin: (db.prepare("SELECT at FROM admin_audit WHERE admin_id=? AND action='login' ORDER BY id DESC LIMIT 1").get(r.id) || {}).at || null })));
});

/* ================= admin: listings ================= */
function adminListing(id) { return db.prepare("SELECT * FROM listings WHERE id=?").get(id); }
router.add("PATCH", "/api/admin/listings/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return;
  const l = adminListing(p.id);
  if (!l) return send(res, 404, { error: "Listing not found" });
  const b = req.body || {}, sets = [], params = [], changed = {};
  // Move to another category (e.g. land that was posted as a bedsitter)
  const newCat = b.category !== undefined && b.category !== l.category ? String(b.category) : null;
  if (newCat) {
    if (!["rent", "sale", "shortlet", "land", "commercial"].includes(newCat)) return send(res, 400, { error: "Unknown category" });
    const price = b.price !== undefined ? Math.round(+b.price) : l.price;
    const blank = { land_deal: null, size_value: null, size_unit: null, price_basis: null, lease_min: null };
    const clear = ["land_deal=NULL", "size_value=NULL", "size_unit=NULL", "size_acres=NULL", "price_basis=NULL", "price_per_acre=NULL", "lease_min=NULL",
      "comm_type=NULL", "area_sqft=NULL", "price_per_sqft=NULL", "income_month=NULL"];
    const oldF = parseJson(l.features, {});
    sets.push("category=?", ...clear); params.push(newCat);
    if (newCat === "land") {
      const f = landFields({ ...b, price }, blank);
      if (f.error) return send(res, 400, { error: f.error });
      sets.push("bedrooms=NULL", "land_deal=?", "size_value=?", "size_unit=?", "size_acres=?", "price_basis=?", "price_per_acre=?", "lease_min=?", "features=?");
      params.push(f.deal, f.sizeValue, f.sizeUnit, f.sizeAcres, f.basis, f.perAcre, f.leaseMin, JSON.stringify(cleanLandFeatures(oldF)));
    } else if (newCat === "commercial") {
      const f = commFields({ ...b, price }, blank);
      if (f.error) return send(res, 400, { error: f.error });
      sets.push("bedrooms=NULL", "land_deal=?", "comm_type=?", "size_value=?", "size_unit=?", "area_sqft=?", "price_basis=?", "price_per_sqft=?", "lease_min=?", "income_month=?", "features=?");
      params.push(f.deal, f.type, f.sizeValue, f.sizeUnit, f.areaSqft, f.basis, f.perSqft, f.leaseMin, f.income, JSON.stringify(cleanCommFeatures(oldF)));
    } else {
      const beds = b.bedrooms !== undefined ? (b.bedrooms === "" || b.bedrooms === null ? null : Math.max(0, Math.min(20, parseInt(b.bedrooms, 10) || 0)))
        : (["rent", "sale", "shortlet"].includes(l.category) ? l.bedrooms : null);
      sets.push("bedrooms=?", "features=?"); params.push(beds, JSON.stringify(cleanFeatures(oldF)));
    }
    // a let listing that becomes a sale (or the other way) can't keep a rented/sold status
    if (["rented", "sold"].includes(l.status)) sets.push("status='active'");
    changed.category = `${l.category} → ${newCat}`;
    delete b.bedrooms;
  }
  if (b.title !== undefined) { const t = String(b.title).trim().slice(0, 140); if (!t) return send(res, 400, { error: "Title can't be empty" }); sets.push("title=?"); params.push(t); changed.title = t; }
  if (b.description !== undefined) { sets.push("description=?"); params.push(String(b.description).slice(0, 5000)); changed.description = "edited"; }
  if (b.bedrooms !== undefined && ["rent", "sale", "shortlet"].includes(newCat || l.category)) { const v = b.bedrooms === "" || b.bedrooms === null ? null : Math.max(0, Math.min(20, parseInt(b.bedrooms, 10) || 0)); sets.push("bedrooms=?"); params.push(v); changed.bedrooms = v; }
  if (b.areaId !== undefined) {
    const area = db.prepare("SELECT * FROM areas WHERE id=?").get(b.areaId);
    if (!area) return send(res, 400, { error: "Unknown area" });
    sets.push("area_id=?"); params.push(area.id); changed.area = area.name;
    if (!l.exact_pin) { sets.push("lat=?", "lng=?"); params.push(area.lat + (Math.random() - 0.5) * 0.01, area.lng + (Math.random() - 0.5) * 0.01); }
  }
  if (b.price !== undefined) {
    const price = Math.round(+b.price); if (!(price > 0)) return send(res, 400, { error: "Enter a price" });
    sets.push("price=?"); params.push(price); changed.price = `${l.price} → ${price}`;
    if (newCat) {} else if (l.category === "land") { const f = landFields({ price }, l); if (!f.error) { sets.push("price_per_acre=?"); params.push(f.perAcre); } }
    if (l.category === "commercial") { const f = commFields({ price }, l); if (!f.error) { sets.push("price_per_sqft=?"); params.push(f.perSqft); } }
  }
  if (b.adminBanner !== undefined) { const t = String(b.adminBanner || "").trim().slice(0, 160); sets.push("admin_banner=?"); params.push(t || null); changed.banner = t || "(removed)"; }
  if (!sets.length) return send(res, 400, { error: "Nothing to change" });
  db.prepare(`UPDATE listings SET ${sets.join(",")} WHERE id=?`).run(...params, l.id);
  audit(req, a, "edit_listing", "listing", l.id, changed);
  if (b.notifyOwner !== false && (changed.title || changed.price || changed.description || changed.area || changed.category)) {
    const CAT_NAME = { rent: "Houses for rent", sale: "Houses for sale", shortlet: "Airbnb / short stays", land: "Land", commercial: "Commercial property" };
    db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "We updated your listing",
      `Our team corrected details on "${l.title}"${newCat ? ` and moved it to ${CAT_NAME[newCat]}` : ""}${b.note ? ": " + String(b.note).slice(0, 200) : "."}`);
  }
  send(res, 200, listingView(db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(l.id)));
});
function setListingStatus(l, status, a, req, why) {
  db.prepare("UPDATE listings SET status=?, status_changed_at=datetime('now')" + (status === "active" ? ", confirmed_at=datetime('now')" : "") + " WHERE id=?").run(status, l.id);
  if (status === "removed") { db.prepare("UPDATE reports SET status='actioned' WHERE listing_id=? AND status='open'").run(l.id); db.prepare("UPDATE listing_flags SET resolved=1 WHERE listing_id=?").run(l.id); }
  const msg = { removed: ["Listing removed", `"${l.title}" was removed by our team${why ? ": " + why : " because it broke our listing rules"}. Contact info@patahome.co.ke to discuss.`],
    under_review: ["Listing paused", `"${l.title}" is paused while our team checks it${why ? ": " + why : ""}.`],
    active: ["Listing live again", `"${l.title}" is visible again.`] }[status];
  if (msg) db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", msg[0], msg[1]);
}
function setFeatured(l, days) {
  const until = days > 0 ? new Date(Date.now() + days * 86400e3).toISOString() : null;
  db.prepare("UPDATE listings SET featured_until=? WHERE id=?").run(until, l.id);
  return until;
}
router.add("POST", "/api/admin/listings/:id/feature", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return;
  const l = adminListing(p.id); if (!l) return send(res, 404, { error: "Listing not found" });
  const days = Math.max(0, Math.min(365, Math.round(+((req.body || {}).days) || 0)));
  const until = setFeatured(l, days);
  audit(req, a, days ? "feature" : "unfeature", "listing", l.id, days ? `${days} days` : null);
  if (days) db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)").run(l.owner_id, "listing", "Your listing is featured ⭐", `"${l.title}" is featured at the top of search for ${days} day${days === 1 ? "" : "s"}.`);
  send(res, 200, { ok: true, featuredUntil: until });
});
router.add("POST", "/api/admin/listings/bulk", (req, res) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return;
  const b = req.body || {};
  const ids = [...new Set((Array.isArray(b.ids) ? b.ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 500);
  const action = String(b.action || ""), why = String(b.reason || "").trim().slice(0, 200);
  if (!ids.length) return send(res, 400, { error: "Select at least one listing" });
  if (!["remove", "pause", "restore", "feature", "unfeature"].includes(action)) return send(res, 400, { error: "Unknown action" });
  const days = Math.max(1, Math.min(365, Math.round(+b.days || 7)));
  let done = 0;
  for (const id of ids) {
    const l = adminListing(id); if (!l) continue;
    if (action === "remove" && l.status !== "removed") setListingStatus(l, "removed", a, req, why);
    else if (action === "pause" && l.status === "active") setListingStatus(l, "under_review", a, req, why);
    else if (action === "restore" && ["under_review", "removed", "expired"].includes(l.status)) setListingStatus(l, "active", a, req);
    else if (action === "feature") setFeatured(l, days);
    else if (action === "unfeature") setFeatured(l, 0);
    else continue;
    done++;
  }
  audit(req, a, "bulk_" + action, "listing", ids.join(",").slice(0, 900), { count: done, reason: why || undefined, days: action === "feature" ? days : undefined });
  send(res, 200, { ok: true, changed: done });
});

/* ---------- blocklist ---------- */
router.add("GET", "/api/admin/blocklist", (req, res) => {
  if (!requireAdmin(req, res, "moderate")) return;
  send(res, 200, db.prepare("SELECT b.id, b.term, b.created_at at, u.name addedBy FROM blocklist b LEFT JOIN users u ON u.id=b.created_by ORDER BY b.id DESC").all());
});
router.add("POST", "/api/admin/blocklist", (req, res) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return;
  const term = String((req.body || {}).term || "").trim().replace(/\s+/g, " ").slice(0, 80);
  if (term.length < 3) return send(res, 400, { error: "Enter at least 3 characters" });
  try { db.prepare("INSERT INTO blocklist (term, created_by) VALUES (?,?)").run(term, a.id); }
  catch (e) { return send(res, 409, { error: "That term is already on the list" }); }
  audit(req, a, "blocklist_add", "blocklist", null, term);
  // hold any live listing that already contains it
  const live = db.prepare("SELECT id FROM listings WHERE status='active'").all();
  let held = 0;
  for (const r of live) { const before = adminListing(r.id).status; checkBlocklist(r.id); if (adminListing(r.id).status !== before) held++; }
  send(res, 201, { ok: true, held });
});
router.add("DELETE", "/api/admin/blocklist/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "moderate"); if (!a) return;
  const row = db.prepare("SELECT * FROM blocklist WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Not found" });
  db.prepare("DELETE FROM blocklist WHERE id=?").run(row.id);
  audit(req, a, "blocklist_remove", "blocklist", row.id, row.term);
  send(res, 200, { ok: true });
});

/* ================= admin: site ================= */
router.add("GET", "/api/admin/settings", (req, res) => {
  if (!requireAdmin(req, res, "super")) return;
  send(res, 200, Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map(k => [k, setting(k)])));
});
router.add("PATCH", "/api/admin/settings", (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const b = req.body || {}, changed = {};
  for (const [k, rule] of Object.entries(SETTING_RULES)) {
    if (b[k] === undefined) continue;
    const v = String(rule(b[k]));
    if (v === "NaN") return send(res, 400, { error: `Invalid value for ${k}` });
    if (v === setting(k)) continue;
    changed[k] = { from: setting(k), to: v };
    db.prepare("INSERT INTO settings (key,value,updated_at,updated_by) VALUES (?,?,datetime('now'),?) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at, updated_by=excluded.updated_by").run(k, v, a.id);
  }
  applySettings();
  if (Object.keys(changed).length) audit(req, a, "settings", "settings", null, changed);
  send(res, 200, Object.fromEntries(Object.keys(SETTINGS_DEFAULTS).map(k => [k, setting(k)])));
});

/* ---------- areas ---------- */
router.add("GET", "/api/admin/areas", (req, res) => {
  if (!requireAdmin(req, res, "view")) return;
  send(res, 200, db.prepare(`SELECT a.*, (SELECT COUNT(*) FROM listings l WHERE l.area_id=a.id) listings,
    (SELECT COUNT(*) FROM listings l WHERE l.area_id=a.id AND l.status='active') active FROM areas a ORDER BY a.county, a.name`).all());
});
function areaInput(b, e) {
  const name = String(b.name ?? (e && e.name) ?? "").trim().replace(/\s+/g, " ").slice(0, 60);
  const county = String(b.county ?? (e && e.county) ?? "").trim().slice(0, 40);
  const lat = b.lat !== undefined ? +b.lat : e && e.lat, lng = b.lng !== undefined ? +b.lng : e && e.lng;
  if (name.length < 2 || !county) return { error: "Enter the area name and county" };
  if (!(lat > -5.2 && lat < 5.5 && lng > 33.5 && lng < 42.2)) return { error: "Those coordinates aren't in Kenya — check the pin (lat, lng)" };
  return { name, county, lat, lng };
}
router.add("POST", "/api/admin/areas", (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const v = areaInput(req.body || {}); if (v.error) return send(res, 400, v);
  try { const info = db.prepare("INSERT INTO areas (name,county,lat,lng) VALUES (?,?,?,?)").run(v.name, v.county, v.lat, v.lng);
    audit(req, a, "area_add", "area", info.lastInsertRowid, v); send(res, 201, { id: info.lastInsertRowid, ...v }); }
  catch (e) { send(res, 409, { error: "An area with that name already exists" }); }
});
router.add("PATCH", "/api/admin/areas/:id", (req, res, p) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const e = db.prepare("SELECT * FROM areas WHERE id=?").get(p.id); if (!e) return send(res, 404, { error: "Area not found" });
  const v = areaInput(req.body || {}, e); if (v.error) return send(res, 400, v);
  try { db.prepare("UPDATE areas SET name=?, county=?, lat=?, lng=? WHERE id=?").run(v.name, v.county, v.lat, v.lng, e.id); }
  catch (err) { return send(res, 409, { error: "An area with that name already exists" }); }
  audit(req, a, "area_edit", "area", e.id, { from: { name: e.name, county: e.county, lat: e.lat, lng: e.lng }, to: v });
  send(res, 200, { id: e.id, ...v });
});
router.add("POST", "/api/admin/areas/:id/merge", (req, res, p) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const from = db.prepare("SELECT * FROM areas WHERE id=?").get(p.id), into = db.prepare("SELECT * FROM areas WHERE id=?").get((req.body || {}).into);
  if (!from || !into) return send(res, 404, { error: "Area not found" });
  if (from.id === into.id) return send(res, 400, { error: "Pick a different area to merge into" });
  const moved = db.prepare("UPDATE listings SET area_id=? WHERE area_id=?").run(into.id, from.id).changes;
  db.prepare("DELETE FROM areas WHERE id=?").run(from.id);
  audit(req, a, "area_merge", "area", into.id, `${from.name} → ${into.name} (${moved} listings moved)`);
  send(res, 200, { ok: true, moved });
});

/* ---------- audit log ---------- */
router.add("GET", "/api/admin/audit", (req, res) => {
  if (!requireAdmin(req, res, "super")) return;
  const q = req.query, where = [], params = [];
  if (q.admin) { where.push("admin_id=?"); params.push(+q.admin); }
  if (q.action) { where.push("action=?"); params.push(String(q.action)); }
  if (q.target) { where.push("target_type=? AND target_id=?"); const [t, id] = String(q.target).split(":"); params.push(t, id); }
  const limit = Math.min(500, Math.max(20, +q.limit || 200)), before = +q.before || 0;
  if (before) { where.push("id<?"); params.push(before); }
  send(res, 200, db.prepare(`SELECT * FROM admin_audit ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY id DESC LIMIT ${limit}`).all(...params));
});

/* ================= admin: business ================= */
router.add("GET", "/api/admin/growth", (req, res) => {
  if (!requireAdmin(req, res, "view")) return;
  const weeks = 12, out = [];
  const count = (sql, a, b) => db.prepare(sql).get(a, b).n;
  for (let i = weeks - 1; i >= 0; i--) {
    const end = new Date(Date.now() - i * 7 * 86400e3), start = new Date(end - 7 * 86400e3);
    const s = start.toISOString().replace("T", " ").slice(0, 19), e = end.toISOString().replace("T", " ").slice(0, 19);
    out.push({
      week: start.toISOString().slice(0, 10),
      users: count("SELECT COUNT(*) n FROM users WHERE role='user' AND created_at>=? AND created_at<?", s, e),
      owners: count("SELECT COUNT(*) n FROM (SELECT owner_id, MIN(created_at) f FROM listings GROUP BY owner_id) WHERE f>=? AND f<?", s, e),
      listings: count("SELECT COUNT(*) n FROM listings WHERE created_at>=? AND created_at<?", s, e),
      leads: count("SELECT COUNT(*) n FROM leads WHERE created_at>=? AND created_at<?", s, e) + count("SELECT COUNT(*) n FROM inquiries WHERE created_at>=? AND created_at<?", s, e),
      viewings: count("SELECT COUNT(*) n FROM viewings WHERE created_at>=? AND created_at<?", s, e),
      revenue: db.prepare("SELECT COALESCE(SUM(amount),0) n FROM payments WHERE status='completed' AND created_at>=? AND created_at<?").get(s, e).n
    });
  }
  const counties = db.prepare(`SELECT a.county,
      SUM(CASE WHEN l.created_at >= datetime('now','-30 days') THEN 1 ELSE 0 END) now30,
      SUM(CASE WHEN l.created_at >= datetime('now','-60 days') AND l.created_at < datetime('now','-30 days') THEN 1 ELSE 0 END) prev30,
      SUM(CASE WHEN l.status='active' THEN 1 ELSE 0 END) active
    FROM listings l JOIN areas a ON a.id=l.area_id GROUP BY a.county ORDER BY now30 DESC, active DESC LIMIT 15`).all();
  const leads30 = db.prepare(`SELECT a.county, COUNT(*) n FROM leads le JOIN listings l ON l.id=le.listing_id JOIN areas a ON a.id=l.area_id
    WHERE le.created_at >= datetime('now','-30 days') GROUP BY a.county`).all();
  const lm = Object.fromEntries(leads30.map(r => [r.county, r.n]));
  const topOwners = db.prepare(`SELECT u.id, u.name, u.verified, COUNT(DISTINCT l.id) listings,
      (SELECT COUNT(*) FROM leads le JOIN listings x ON x.id=le.listing_id WHERE x.owner_id=u.id AND le.created_at >= datetime('now','-30 days')) leads30
    FROM users u JOIN listings l ON l.owner_id=u.id AND l.status='active' GROUP BY u.id ORDER BY leads30 DESC, listings DESC LIMIT 10`).all();
  send(res, 200, { weeks: out, counties: counties.map(c => ({ ...c, leads30: lm[c.county] || 0 })), topOwners });
});

// CSV exports (super admin only; every export is logged)
const csvCell = (v) => { const s = v == null ? "" : String(v); return /[",\n\r]/.test(s) || /^[=+\-@]/.test(s) ? `"${(/^[=+\-@]/.test(s) ? "'" : "") + s.replace(/"/g, '""')}"` : s; };
router.add("GET", "/api/admin/export", (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const kind = String(req.query.kind || "");
  const sets = {
    users: ["SELECT u.id, u.name, u.phone, u.email, u.county, u.town, u.verified, u.role, u.created_at, (SELECT COUNT(*) FROM listings l WHERE l.owner_id=u.id) listings FROM users u ORDER BY u.id",
      r => ({ ...r, phone: realPhone(r.phone) })],
    listings: [`SELECT l.id, l.category, l.title, l.price, l.status, a.name area, a.county, u.name owner, l.lister_role, l.created_at,
        (SELECT COUNT(*) FROM leads WHERE listing_id=l.id) leads FROM listings l JOIN areas a ON a.id=l.area_id JOIN users u ON u.id=l.owner_id ORDER BY l.id`, r => r],
    leads: [`SELECT i.id, i.created_at, i.listing_id, l.title, i.from_name, i.from_phone, i.message, CASE WHEN i.owner_reply IS NULL THEN 'no' ELSE 'yes' END replied
        FROM inquiries i JOIN listings l ON l.id=i.listing_id ORDER BY i.id`, r => r]
  };
  if (!sets[kind]) return send(res, 400, { error: "kind must be users, listings or leads" });
  const rows = db.prepare(sets[kind][0]).all().map(sets[kind][1]);
  const cols = rows.length ? Object.keys(rows[0]) : [];
  const csv = "﻿" + [cols.join(","), ...rows.map(r => cols.map(c => csvCell(r[c])).join(","))].join("\r\n");
  audit(req, a, "export", "export", kind, `${rows.length} rows`);
  res.writeHead(200, { "Content-Type": "text/csv; charset=utf-8", "Content-Disposition": `attachment; filename="patahome-${kind}-${new Date().toISOString().slice(0, 10)}.csv"`, "Cache-Control": "no-store" });
  res.end(csv);
});

// Message one user or a group: in-app notification, email and/or SMS.
function broadcastAudience(t) {
  if (t.type === "user") return db.prepare("SELECT * FROM users WHERE id=?").all(+t.id);
  const where = ["u.role='user'", "(u.banned_until IS NULL)"], params = [];
  if (t.type === "owners") where.push("EXISTS (SELECT 1 FROM listings l WHERE l.owner_id=u.id AND l.status='active')");
  if (t.county) { where.push("(u.county=? OR EXISTS (SELECT 1 FROM listings l JOIN areas a ON a.id=l.area_id WHERE l.owner_id=u.id AND a.county=?))"); params.push(t.county, t.county); }
  if (t.type !== "owners" && t.type !== "all") return [];
  return db.prepare(`SELECT u.* FROM users u WHERE ${where.join(" AND ")}`).all(...params);
}
router.add("POST", "/api/admin/broadcast", async (req, res) => {
  const a = requireAdmin(req, res, "super"); if (!a) return;
  const b = req.body || {}, t = b.audience || {};
  const title = String(b.title || "").trim().slice(0, 100), body = String(b.body || "").trim().slice(0, 1000);
  const ch = new Set(Array.isArray(b.channels) ? b.channels : ["notification"]);
  if (!title || !body) return send(res, 400, { error: "Write a title and a message" });
  const people = broadcastAudience(t);
  const reach = { total: people.length, notification: ch.has("notification") ? people.length : 0,
    email: ch.has("email") && mailConfigured() ? people.filter(u => u.email).length : 0,
    sms: ch.has("sms") && smsConfigured() ? people.filter(u => realPhone(u.phone)).length : 0 };
  if (b.dryRun) return send(res, 200, { dryRun: true, reach });
  if (!people.length) return send(res, 400, { error: "Nobody matches that audience" });
  if (reach.sms > 1000) return send(res, 400, { error: "SMS is limited to 1,000 people per message — narrow the audience" });
  const note = db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)");
  if (reach.notification) for (const u of people) note.run(u.id, "system", title, body);
  audit(req, a, "broadcast", t.type === "user" ? "user" : "audience", t.type === "user" ? t.id : JSON.stringify(t), { title, channels: [...ch], reach });
  send(res, 200, { ok: true, reach });
  // emails/SMS go out in the background, a few at a time
  (async () => {
    for (const u of people) {
      try {
        if (reach.email && u.email) await sendMail({ to: u.email, subject: title, text: `Hi ${String(u.name || "").split(" ")[0] || "there"},\n\n${body}\n\n— PataHome · patahome.co.ke` });
        if (reach.sms && realPhone(u.phone)) await sendSms({ to: u.phone, text: `PataHome: ${body}`.slice(0, 300) });
      } catch (e) { console.error("broadcast send failed:", e.message); }
    }
  })().catch(() => {});
});

applySettings();

router.add("GET", "/api/health", (req, res) => {
  send(res, 200, { ok: true, listings: db.prepare("SELECT COUNT(*) n FROM listings WHERE status='active'").get().n });
});

/* ============================================================
   SEO: server-rendered pages, sitemap.xml, robots.txt
   ============================================================ */
const BASE_URL = (process.env.BASE_URL || "http://localhost:3000").replace(/\/$/, "");
const CATS = {
  rentals:      { db: "rent",     label: "Houses & Rooms for Rent",   unit: "/month" },
  "for-sale":   { db: "sale",     label: "Houses for Sale",           unit: "" },
  "short-stays":{ db: "shortlet", label: "Airbnb Rentals in Kenya", unit: "/night" },
  "land-for-sale":  { db: "land", deal: "sale",  label: "Land for Sale",  unit: "" },
  "land-for-lease": { db: "land", deal: "lease", label: "Land for Lease", unit: "" },
  "commercial-for-sale": { db: "commercial", deal: "sale",  label: "Commercial Property for Sale", unit: "" },
  "commercial-to-let":   { db: "commercial", deal: "lease", label: "Commercial Property to Let",   unit: "" }
};
const DEAL_CATS = new Set(["land", "commercial"]); // listed only on pages for areas that have them
const CAT_SLUG = { rent: "rentals", sale: "for-sale", shortlet: "short-stays", land: "land-for-sale", commercial: "commercial-for-sale" };
const catSlugOf = (row) => row.category === "land" ? (row.land_deal === "lease" ? "land-for-lease" : "land-for-sale")
  : row.category === "commercial" ? (row.land_deal === "lease" ? "commercial-to-let" : "commercial-for-sale") : CAT_SLUG[row.category];
const commView = (row) => ({ deal: row.land_deal, priceBasis: row.price_basis, price: row.price, pricePerSqft: row.price_per_sqft, areaSqft: row.area_sqft, incomeMonth: row.income_month });
const commSize = (row) => [COMM.TYPES[row.comm_type] || "Commercial", row.size_value ? COMM.areaLabel(row.size_value, row.size_unit, row.area_sqft) : ""].filter(Boolean).join(" · ");
const priceText = (row) => {
  if (row.category === "commercial") { const p = COMM.priceLabel(commView(row)); return p.main + (p.extra ? ` (${p.extra})` : ""); }
  if (row.category !== "land") return fmtKes(row.price) + (row.category === "rent" ? "/month" : row.category === "shortlet" ? "/night" : "");
  const p = LAND.priceLabel({ landDeal: row.land_deal, priceBasis: row.price_basis, price: row.price, pricePerAcre: row.price_per_acre, sizeAcres: row.size_acres });
  return p.main + (p.extra ? ` (${p.extra})` : "");
};
const slugify = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const escapeHtml = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const fmtKes = (n) => "KES " + Number(n).toLocaleString("en-KE");

function areaBySlug(slug) {
  return db.prepare("SELECT * FROM areas").all().find((a) => slugify(a.name) === slug) || null;
}

function pageShell({ title, description, canonical, jsonLd, bodyHtml, image, imageAlt }) {
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
<meta property="og:image" content="${image || BASE_URL + "/og-image.png"}">
<meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
${imageAlt ? `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}">` : ""}
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0e8a68">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<link rel="manifest" href="/manifest.webmanifest">
<script>try{navigator.sendBeacon("/api/pv",new Blob([JSON.stringify({path:location.pathname,ref:document.referrer})],{type:"application/json"}))}catch(e){}</script>
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
  .grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(250px,1fr));gap:14px;margin:16px 0}
  .lcard{background:#fff;border:1px solid #e3e8e5;border-radius:14px;overflow:hidden;text-decoration:none;color:inherit;display:block;transition:transform .15s,box-shadow .15s}
  .lcard:hover{transform:translateY(-3px);box-shadow:0 10px 24px rgba(20,40,30,.1)}
  .lcard .ph{aspect-ratio:4/3;background:#e8f0ec center/cover no-repeat}
  .lcard .bd{padding:12px 14px}
  .lcard .t{font-weight:700;color:#1c2320;line-height:1.3}
  .chips{display:flex;flex-wrap:wrap;gap:8px;margin:10px 0 4px}
  .chips a{padding:6px 12px;border-radius:99px;background:#fff;border:1px solid #d3e8de;text-decoration:none;font-size:.85rem;font-weight:600}
  .chips a.on{background:#0e7c5a;color:#fff;border-color:#0e7c5a}
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
    Object.keys(CATS).filter(cs => !DEAL_CATS.has(CATS[cs].db)).map((cs) =>
      areas.map((a) => `<a href="/${cs}/${slugify(a.name)}">${escapeHtml(CATS[cs].label.split(" ")[0])} ${escapeHtml(a.name)}</a>`).join(" ")
    ).join("<br>") + `</div>`;
}

function sendHtml(res, code, html) {
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
  res.end(html);
}

/* ---- per-listing page: /listing/:id/:slug? ---- */
function listingPage(req, res, p) {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=? AND l.status='active'`).get(p.id);
  if (!row) return sendHtml(res, 404, pageShell({
    title: "Listing not found — PataHome", description: "This listing is no longer available.",
    canonical: `${BASE_URL}/`, bodyHtml: `<h1>Listing not found</h1><p>It may have been rented or sold. <a href="/">Browse current listings</a>.</p>` }));
  const catSlug = catSlugOf(row);
  const unit = row.category === "rent" ? "/month" : row.category === "shortlet" ? "/night" : "";
  const isLand = row.category === "land" || row.category === "commercial";
  const landSize = row.category === "land" ? LAND.sizeLabel(row.size_value, row.size_unit, row.size_acres) : row.category === "commercial" ? commSize(row) : "";
  const canonical = `${BASE_URL}/listing/${row.id}/${slugify(row.title)}`;
  const desc = `${row.title} in ${row.area_name}, ${row.county} County — ${isLand ? landSize + ", " + priceText(row) : fmtKes(row.price) + unit}. ${(row.lister_role || "owner") === "owner" ? "Contact the owner directly on PataHome — no agent, no viewing fees." : row.lister_role === "agent" ? `Listed by an agent${row.agent_fee ? ` (fee: ${row.agent_fee})` : ""} — every fee shown upfront on PataHome.` : "Listed by the caretaker — every fee shown upfront on PataHome."}`;
  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "Product",
    name: row.title,
    description: desc,
    offers: { "@type": "Offer", price: row.price, priceCurrency: "KES", availability: "https://schema.org/InStock", url: canonical },
    additionalType: "https://schema.org/RealEstateListing"
  };
  const photos = parsePhotos(row.photos);
  const image = photos.length && cldEnabled() ? photoUrl(photos[0], "c_fill,g_auto,w_1200,h_630,q_auto:good,f_jpg") : null;
  const shareTitle = isLand
    ? (row.category === "commercial"
      ? `${COMM.TYPES[row.comm_type] || "Commercial property"} ${row.land_deal === "lease" ? "to let" : "for sale"} · ${priceText(row)} · ${row.area_name}`
      : `${row.land_deal === "lease" ? "Land for lease" : "Land for sale"} · ${landSize.split(" · ")[0]} · ${priceText(row)} · ${row.area_name}`)
    : `${fmtKes(row.price)}${unit} · ${row.bedrooms != null ? (row.bedrooms === 0 ? "Bedsitter" : row.bedrooms + " bedroom") + " · " : ""}${row.area_name}`;
  const bodyHtml = `
    ${image ? `<img src="${image}" alt="${escapeHtml(row.title)}" style="width:100%;border-radius:14px;aspect-ratio:1200/630;object-fit:cover">` : ""}
    <h1>${escapeHtml(row.title)}</h1>
    ${row.admin_banner ? `<p style="background:#fdecea;border:1.5px solid #e7a9a2;border-radius:10px;padding:10px 12px;color:#8a2319;font-weight:700">⚠️ ${escapeHtml(row.admin_banner)}</p>` : ""}
    <div class="card">
      <div class="price">${escapeHtml(priceText(row))}</div>
      ${isLand ? `<div class="meta">📐 ${escapeHtml(landSize)}</div><p style="background:#fff8ec;border:1px solid #f3dfb8;border-radius:10px;padding:10px 12px;color:#6b4712;font-size:.9rem"><b>Before paying anything:</b> ${row.category === "commercial" && row.land_deal === "lease" ? "view the premises and confirm the landlord owns or manages it" : "do an official search on Ardhisasa and visit the property with the owner"}.</p>` : ""}
      <div class="meta">📍 ${escapeHtml(row.area_name)}, ${escapeHtml(row.county)} County
        ${row.bedrooms != null ? ` · 🛏 ${row.bedrooms === 0 ? "Bedsitter" : row.bedrooms + " bedroom(s)"}` : ""}
        · Listed by ${escapeHtml(row.owner_name)}${row.owner_verified ? " ✓ verified owner" : ""}</div>
      ${row.description ? `<p>${escapeHtml(row.description)}</p>` : ""}
      <a class="cta" href="/browse?open=${row.id}">See photos &amp; contact the ${row.lister_role === "agent" ? "agent" : "owner"}</a>
    </div>
    <p><a href="/${catSlug}/${slugify(row.area_name)}">More ${escapeHtml(CATS[catSlug].label.toLowerCase())} in ${escapeHtml(row.area_name)} →</a></p>
    ${areaLinksHtml()}`;
  sendHtml(res, 200, pageShell({ title: `${shareTitle} — ${row.title} | PataHome`, description: desc, canonical, jsonLd, bodyHtml, image, imageAlt: row.title }));
}
router.add("GET", "/listing/:id", listingPage);
router.add("GET", "/listing/:id/:slug", listingPage);

/* ---- category+area landing pages ----
   /rentals/ruaka, /for-sale/nyali, /short-stays/diani, and for rentals
   bedroom-type pages: /rentals/ruaka/bedsitters, /rentals/ruaka/2-bedroom … */
const BED_SLUGS = { bedsitters: 0, "1-bedroom": 1, "2-bedroom": 2, "3-bedroom": 3 };
const BED_LABEL = { bedsitters: "Bedsitters", "1-bedroom": "1 Bedroom", "2-bedroom": "2 Bedroom", "3-bedroom": "3+ Bedroom" };
function landingPage(req, res, p) {
  const cat = CATS[p.catSlug];
  const area = cat ? areaBySlug(p.areaSlug) : null;
  const bedSlug = p.beds || null;
  if (!cat || !area || (bedSlug && (cat.db === "sale" || DEAL_CATS.has(cat.db) || !(bedSlug in BED_SLUGS)))) return send(res, 404, { error: "Not found" });
  const beds = bedSlug ? BED_SLUGS[bedSlug] : null;
  const bedSql = beds === null ? "" : beds === 3 ? " AND l.bedrooms >= 3" : ` AND l.bedrooms = ${beds}`;
  const dealSql = cat.deal ? ` AND l.land_deal='${cat.deal}'` : "";
  const rows = db.prepare(`${LISTING_SQL} WHERE l.status='active' AND l.category=? AND l.area_id=?${bedSql}${dealSql} ORDER BY l.featured_until DESC, l.id DESC`).all(cat.db, area.id);
  const canonical = `${BASE_URL}/${p.catSlug}/${p.areaSlug}${bedSlug ? "/" + bedSlug : ""}`;
  const what = bedSlug ? `${BED_LABEL[bedSlug]} ${cat.db === "shortlet" ? "Airbnbs" : "houses for rent"}` : cat.label;
  const minPrice = rows.length ? Math.min(...rows.map((r) => r.price)) : null;
  const title = `${what} in ${area.name}, ${area.county}${minPrice ? ` from ${fmtKes(minPrice)}` : ""} | PataHome`;
  const desc = rows.length
    ? `${rows.length} ${what.toLowerCase()} in ${area.name}, ${area.county} County from ${fmtKes(minPrice)}${cat.unit}. Photos, prices and direct contact with verified owners — no viewing fees.`
    : `Find ${what.toLowerCase()} in ${area.name}, ${area.county} County on PataHome. Get an alert when new homes are listed.`;
  const jsonLd = { "@context": "https://schema.org", "@type": "ItemList", name: title,
    itemListElement: rows.map((r, i) => ({ "@type": "ListItem", position: i + 1, url: `${BASE_URL}/listing/${r.id}/${slugify(r.title)}` })) };
  const chip = (slug, label) => `<a class="${(bedSlug || "") === slug ? "on" : ""}" href="/${p.catSlug}/${p.areaSlug}${slug ? "/" + slug : ""}">${label}</a>`;
  const nearby = db.prepare("SELECT * FROM areas WHERE county=? AND id!=? LIMIT 12").all(area.county, area.id);
  const browseQ = `/browse?q=${encodeURIComponent(area.name)}&cat=${cat.db}${beds !== null ? "&beds=" + beds : ""}${cat.deal ? (cat.db === "land" ? "&landDeal=" : "&deal=") + cat.deal : ""}`;
  const bodyHtml = `
    <h1>${escapeHtml(what)} in ${escapeHtml(area.name)}, ${escapeHtml(area.county)} County</h1>
    <p class="meta">${rows.length} listing${rows.length === 1 ? "" : "s"}${minPrice ? ` · from ${fmtKes(minPrice)}${cat.unit}` : ""} · direct from owners · updated daily</p>
    ${cat.db !== "sale" && !DEAL_CATS.has(cat.db) ? `<div class="chips">${chip("", "All")}${Object.keys(BED_SLUGS).map(k => chip(k, BED_LABEL[k])).join("")}</div>` : ""}
    ${rows.length ? `<div class="grid">${rows.map((r) => {
      const ph = parsePhotos(r.photos)[0];
      const img = ph && cldEnabled() ? photoUrl(ph, "c_fill,w_500,h_375,q_auto:eco") : "";
      return `<a class="lcard" href="/listing/${r.id}/${slugify(r.title)}">
        <div class="ph" ${img ? `style="background-image:url('${img}')"` : ""}></div>
        <div class="bd"><div class="t">${escapeHtml(r.title)}</div>
        <div class="price">${escapeHtml(priceText(r))}</div>
        ${r.category === "land" ? `<div class="meta">📐 ${escapeHtml(LAND.sizeLabel(r.size_value, r.size_unit, r.size_acres))}</div>` : ""}
        ${r.category === "commercial" ? `<div class="meta">🏢 ${escapeHtml(commSize(r))}</div>` : ""}
        <div class="meta">📍 ${escapeHtml(r.area_name)}${r.bedrooms != null ? ` · 🛏 ${r.bedrooms === 0 ? "Bedsitter" : r.bedrooms + " BR"}` : ""}${(r.lister_role || "owner") === "owner" ? " · Direct owner" : " · Agent"}</div></div></a>`;
    }).join("")}</div>` : `<div class="card">No ${escapeHtml(what.toLowerCase())} listed here right now. <a href="${browseQ}">Search nearby areas</a> or set an alert on the browse page to hear about new ones first.</div>`}
    <a class="cta" href="${browseQ}">Search, filter &amp; see these on the map</a>
    ${nearby.length ? `<div class="links"><strong>Nearby in ${escapeHtml(area.county)}:</strong><br>${nearby.map(a => `<a href="/${p.catSlug}/${slugify(a.name)}${bedSlug ? "/" + bedSlug : ""}">${escapeHtml(a.name)}</a>`).join(" ")}</div>` : ""}
    ${areaLinksHtml()}`;
  sendHtml(res, 200, pageShell({ title, description: desc, canonical, jsonLd, bodyHtml }));
}
router.add("GET", "/:catSlug/:areaSlug", landingPage);
router.add("GET", "/:catSlug/:areaSlug/:beds", landingPage);

/* ---- browse index (crawl entry point) ---- */
/* /browse = the interactive listings app; /areas = crawlable area directory for SEO */
router.add("GET", "/browse", (req, res) => {
  res.writeHead(200, { "Content-Type": "text/html", "Cache-Control": "no-cache, must-revalidate" });
  res.end(fs.readFileSync(path.join(__dirname, "public", "browse.html")));
});

router.add("GET", "/areas", (req, res) => {
  sendHtml(res, 200, pageShell({
    title: "Browse Houses by Area | PataHome",
    description: "Browse rentals and houses for sale across Kenyan counties on PataHome — direct from verified owners.",
    canonical: `${BASE_URL}/areas`,
    bodyHtml: `<h1>Browse by area</h1>${areaLinksHtml()}`
  }));
});

/* ---- sitemap.xml + robots.txt ---- */

router.add("GET", "/sitemap.xml", (req, res) => {
  const areas = db.prepare("SELECT * FROM areas").all();
  const listings = db.prepare("SELECT id, title FROM listings WHERE status='active'").all();
  const urls = [`${BASE_URL}/`, `${BASE_URL}/browse`, `${BASE_URL}/areas`]
    .concat(Object.keys(CATS).filter(cs => !DEAL_CATS.has(CATS[cs].db)).flatMap((cs) => areas.map((a) => `${BASE_URL}/${cs}/${slugify(a.name)}`)))
    .concat(db.prepare("SELECT DISTINCT l.land_deal, a.name FROM listings l JOIN areas a ON a.id=l.area_id WHERE l.status='active' AND l.category='land'").all()
      .map(r => `${BASE_URL}/${r.land_deal === "lease" ? "land-for-lease" : "land-for-sale"}/${slugify(r.name)}`))
    .concat(db.prepare("SELECT DISTINCT l.land_deal, a.name FROM listings l JOIN areas a ON a.id=l.area_id WHERE l.status='active' AND l.category='commercial'").all()
      .map(r => `${BASE_URL}/${r.land_deal === "lease" ? "commercial-to-let" : "commercial-for-sale"}/${slugify(r.name)}`))
    .concat(db.prepare(`SELECT DISTINCT l.category, l.bedrooms, a.name FROM listings l JOIN areas a ON a.id=l.area_id
      WHERE l.status='active' AND l.category!='sale' AND l.bedrooms IS NOT NULL`).all()
      .map(r => `${BASE_URL}/${CAT_SLUG[r.category]}/${slugify(r.name)}/${Object.keys(BED_SLUGS).find(k => BED_SLUGS[k] === Math.min(r.bedrooms, 3))}`))
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
  // Read-only data endpoints stay crawlable so Googlebot can fully render the pages
  res.end(`User-agent: *
Allow: /
Allow: /api/areas
Allow: /api/listings
Allow: /api/config
Allow: /api/insights
Disallow: /dashboard
Disallow: /admin
Disallow: /api/

Sitemap: ${BASE_URL}/sitemap.xml
`);
});

/* ================= server ================= */
const MIME = { ".webmanifest": "application/manifest+json", ".json": "application/json", ".txt": "text/plain", ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  req.query = Object.fromEntries(url.searchParams);

  // Canonical redirects (only when behind a proxy that sets x-forwarded-proto,
  // so local development on http://localhost is unaffected):
  // www.example.com -> example.com, and http -> https
  const fwdProto = req.headers["x-forwarded-proto"];
  const host = req.headers.host || "";
  if (fwdProto && (host.startsWith("www.") || fwdProto === "http")) {
    res.writeHead(301, { Location: "https://" + host.replace(/^www\./, "") + req.url, "Cache-Control": "no-cache" });
    return res.end();
  }

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET,POST,PUT,PATCH,DELETE,OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type,Authorization",
      "Access-Control-Allow-Credentials": "true"
    });
    return res.end();
  }

  let body = "";
  req.on("data", (c) => { body += c; if (body.length > 1e6) req.destroy(); });
  req.on("end", () => {
    try { req.body = body ? JSON.parse(body) : {}; } catch { req.body = {}; }
    const m = router.match(req.method, url.pathname);
    const fail = (e) => {
      console.error(e);
      alertAdmin(`Error on ${req.method} ${url.pathname}`, (e && e.stack) || String(e));
      if (!res.headersSent) send(res, 500, { error: "Something went wrong" });
    };
    try {
      if (m) { const r = m.handler(req, res, m.params); if (r && typeof r.catch === "function") r.catch(fail); return; }
      // static files from ./public (put patahome.html there as index.html)
      if (req.method === "GET") {
        // old .html addresses redirect permanently to the clean ones (/dashboard.html → /dashboard)
        const htmlName = url.pathname.match(/^\/([a-z0-9-]+)\.html$/);
        if (htmlName && htmlName[1] !== "offline" && fs.existsSync(path.join(__dirname, "public", htmlName[1] + ".html"))) {
          res.writeHead(301, { Location: (htmlName[1] === "index" ? "/" : "/" + htmlName[1]) + url.search, "Cache-Control": "public, max-age=86400" });
          return res.end();
        }
        let file = path.join(__dirname, "public", url.pathname === "/" ? "index.html" : url.pathname);
        // clean URLs: /admin serves admin.html, /browse serves browse.html, …
        if (!path.extname(file) && fs.existsSync(file + ".html")) file += ".html";
        if (file.startsWith(path.join(__dirname, "public")) && fs.existsSync(file) && fs.statSync(file).isFile()) {
          const ext = path.extname(file);
          res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            // HTML must always revalidate so deploys show up immediately (browsers + Cloudflare edge)
            // HTML, the service worker and the app manifest must revalidate so updates reach installed apps
            "Cache-Control": ext === ".html" || ext === "" || ext === ".webmanifest" || path.basename(file) === "sw.js" ? "no-cache, must-revalidate" : "public, max-age=86400",
            ...(path.basename(file) === "sw.js" ? { "Service-Worker-Allowed": "/" } : {})
          });
          return res.end(fs.readFileSync(file));
        }
      }
      send(res, 404, { error: "Not found" });
    } catch (e) { fail(e); }
  });
});

if (require.main === module) {
  server.listen(PORT, () => console.log(`PataHome API running on http://localhost:${PORT}`));
}
module.exports = server;
