// PataHome API — zero-dependency Node.js backend (requires Node 22.5+)
// Run: node seed.js && node server.js
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { URL } = require("node:url");
const db = require("./db");
const { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter, sendMail, mailConfigured, sendSms, smsConfigured } = require("./lib");

const PORT = process.env.PORT || 3000;
const router = makeRouter();

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
  ownerId: row.owner_id,
  ownerName: row.owner_name,
  ownerVerified: !!row.owner_verified,
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
const SESSION_IDLE_MS = Math.max(0.25, +process.env.SESSION_IDLE_HOURS || 4) * 3600e3;
const SESSION_MAX_MS = Math.max(1, +process.env.SESSION_MAX_DAYS || 14) * 86400e3;
const clientIp = (req) => String(req.headers["cf-connecting-ip"] || req.headers["x-forwarded-for"] || req.socket?.remoteAddress || "").split(",")[0].trim().slice(0, 64);
function createSession(u, req) {
  const sid = crypto.randomBytes(24).toString("base64url"), now = Date.now();
  db.prepare("INSERT INTO sessions (id,user_id,created_at,last_seen,expires_at,ua,ip) VALUES (?,?,?,?,?,?,?)")
    .run(sid, u.id, now, now, now + SESSION_MAX_MS, String(req?.headers?.["user-agent"] || "").slice(0, 200), req ? clientIp(req) : "");
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
  if (!h.startsWith("Bearer ")) return null;
  const p = verifyToken(h.slice(7));
  if (!p || !p.sid) { req._authFail = "expired"; return null; }
  const row = db.prepare("SELECT * FROM sessions WHERE id=? AND user_id=?").get(p.sid, p.id);
  const now = Date.now();
  if (!row) { req._authFail = "expired"; return null; }
  if (now - row.last_seen > SESSION_IDLE_MS) { db.prepare("DELETE FROM sessions WHERE id=?").run(row.id); req._authFail = "idle"; return null; }
  if (now > row.expires_at) { db.prepare("DELETE FROM sessions WHERE id=?").run(row.id); req._authFail = "expired"; return null; }
  if (now - row.last_seen > 60e3) db.prepare("UPDATE sessions SET last_seen=? WHERE id=?").run(now, row.id);
  return p;
}
const requireAuth = (req, res) => {
  const u = getUser(req);
  if (!u) {
    const idleH = Math.round(SESSION_IDLE_MS / 3600e3 * 10) / 10;
    const msg = req._authFail === "idle" ? `You were signed out after ${idleH} hour${idleH === 1 ? "" : "s"} of inactivity — please log in again`
      : req._authFail ? "Your session has ended — please log in again" : "Login required";
    send(res, 401, { error: msg, code: req._authFail ? "SESSION_EXPIRED" : "LOGIN_REQUIRED" });
    return null;
  }
  return u;
};
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
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
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+15 minutes'))")
    .run(userId, "email", email, code);
  await sendMail({
    to: email,
    subject: `${code} is your PataHome verification code`,
    text: `Karibu!\n\nYour PataHome verification code is: ${code}\n\nEnter it to confirm your email address. The code expires in 15 minutes.\n\nIf you didn't request this, you can ignore this email.\n\n— PataHome · patahome.co.ke`
  });
  return true;
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
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+15 minutes'))")
    .run(userId, "phone", phone, code);
  await sendSms({
    to: phone,
    text: `${code} is your PataHome verification code. It expires in 15 minutes. Do not share it with anyone.`
  });
  return true;
}
const age = (dob) => { const d = new Date(dob); return isNaN(d) ? null : Math.floor((Date.now() - d.getTime()) / 31557600000); };
const authResponse = (res, code, u, req) =>
  send(res, code, { token: createSession(u, req), user: publicUser(u) });

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
  authResponse(res, 200, user, req);
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
    if (user) {
      if (!user.google_id) db.prepare("UPDATE users SET google_id=?, avatar_url=COALESCE(avatar_url,?) WHERE id=?").run(p.sub, p.picture || null, user.id);
    } else {
      const info = db.prepare("INSERT INTO users (name,phone,email,password_hash,google_id,avatar_url,email_verified) VALUES (?,?,?,?,?,?,1)")
        .run(p.name || "PataHome User", "g." + p.sub, (p.email || "").toLowerCase(), "", p.sub, p.picture || null);
      user = db.prepare("SELECT * FROM users WHERE id=?").get(info.lastInsertRowid);
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
  db.prepare("INSERT INTO verify_codes (user_id,kind,target,code,expires_at) VALUES (?,?,?,?,datetime('now','+15 minutes'))")
    .run(u.id, "email", email, code);
  try {
    await sendMail({
      to: email,
      subject: `${code} is your PataHome verification code`,
      text: `Karibu!\n\nYour PataHome verification code is: ${code}\n\nEnter it to confirm your email address. The code expires in 15 minutes.\n\nIf you didn't request this, you can ignore this email.\n\n— PataHome · patahome.co.ke`
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
  for (const l of db.prepare("SELECT photos FROM listings WHERE owner_id=?").all(u.id))
    for (const id of parsePhotos(l.photos)) cldDestroy(id);
  db.prepare("DELETE FROM users WHERE id=?").run(u.id);
  send(res, 200, { ok: true });
});

/* ================= public config ================= */
router.add("GET", "/api/config", (req, res) => {
  send(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, cloudinary: cldEnabled(), phoneVerify: phoneVerifyEnabled(),
    sessionIdleMinutes: Math.round(SESSION_IDLE_MS / 60e3) });
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
const SEARCH_CAT_LABEL = { rent: "for rent", sale: "for sale", shortlet: "airbnb short stay" };
const SEARCH_STOP = new Set(["in","near","at","the","a","an","for","and","with","to","of","under","below","max","na","ya","kwa","karibu","house","houses","home","homes","nyumba","property","kenya"]);
const SEARCH_EXPAND = {
  keja:["for rent"],kejas:["for rent"],rent:["for rent"],rental:["for rent"],rentals:["for rent"],kukodi:["for rent"],
  sale:["for sale"],buy:["for sale"],buying:["for sale"],sell:["for sale"],selling:["for sale"],kununua:["for sale"],
  bedsitter:["bedsitter","studio"],bedsitters:["bedsitter","studio"],studio:["bedsitter","studio"],
  "1br":["1 bedroom"],one:["1 bedroom"],"2br":["2 bedroom"],two:["2 bedroom"],"3br":["3 bedroom"],three:["3 bedroom"],
  flat:["apartment"],apt:["apartment"],airbnb:["airbnb"],bnb:["airbnb"]
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
  const desc = (r.description || "").toLowerCase(), cat = SEARCH_CAT_LABEL[r.category] || "";
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
    newest: (a, b) => b.id - a.id
  }[sort] || ((a, b) => b.id - a.id);
  const now = new Date().toISOString();
  const feat = r => (r.featured_until && r.featured_until > now) ? 1 : 0;
  rows.sort((a, b) => (tokens.length ? (scores.get(b.id) - scores.get(a.id)) : 0) || (feat(b) - feat(a)) || base(a, b));

  const perPage = Math.min(Math.max(+q.perPage || 20, 1), 50), page = Math.max(+q.page || 1, 1);
  const slice = rows.slice((page - 1) * perPage, page * perPage);
  const out = { total: rows.length, page, perPage, hasMore: page * perPage < rows.length,
    listings: slice.map(r => listingView(r, hasLoc ? lat : null, hasLoc ? lng : null)) };
  if (page === 1) {
    out.pins = rows.map(r => ({ id: r.id, lat: r.lat, lng: r.lng, price: r.price, category: r.category, title: r.title, area: `${r.area_name}, ${r.county}` }));
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
  const { category, title, description, areaId, price, bedrooms } = req.body || {};
  if (!["rent", "sale", "shortlet"].includes(category)) return send(res, 400, { error: "Invalid category" });
  if (!title || !areaId || !price) return send(res, 400, { error: "title, areaId and price are required" });
  const area = db.prepare("SELECT * FROM areas WHERE id=?").get(areaId);
  if (!area) return send(res, 400, { error: "Unknown areaId — see GET /api/areas" });
  const lat = area.lat + (Math.random() - 0.5) * 0.01, lng = area.lng + (Math.random() - 0.5) * 0.01;
  const photos = req.body.photos;
  if (photos !== undefined) {
    if (!Array.isArray(photos) || photos.length > CLD.maxPhotos || !photos.every(validPhotoId))
      return send(res, 400, { error: `photos must be up to ${CLD.maxPhotos} uploaded photo ids` });
  }
  const info = db.prepare(`INSERT INTO listings (owner_id,category,title,description,area_id,price,bedrooms,lat,lng,photos)
    VALUES (?,?,?,?,?,?,?,?,?,?)`)
    .run(u.id, category, title.trim(), description || "", areaId, +price,
         bedrooms == null || bedrooms === "" ? null : +bedrooms, lat, lng,
         JSON.stringify(photos || []));
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(info.lastInsertRowid);
  notifyFollowers(u.id, "New listing from an owner you follow", `${row.title} is now live in ${row.area_name}.`).catch(e=>console.error("follower notification failed:",e.message));
  send(res, 201, listingView(row));
});

router.add("PATCH", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && u.role !== "admin") return send(res, 403, { error: "Not your listing" });
  const body = req.body || {};
  const allowed = ["title", "description", "price", "bedrooms"];
  const sets = [], params = [];
  for (const k of allowed) if (body[k] !== undefined) { sets.push(`${k}=?`); params.push(body[k]); }

  // A listing can be relisted, but it cannot be both rented and sold. Validate
  // the lifecycle on the server as well as in the owner UI so direct API calls
  // cannot make a listing disappear under an incompatible status.
  if (body.status !== undefined) {
    if (row.status === "removed")
      return send(res, 409, { error: "Removed listings cannot be relisted. Create a new listing instead." });
    const status = String(body.status);
    const rentable = row.category === "rent" || row.category === "shortlet";
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
  const updated = db.prepare(`${LISTING_SQL} WHERE l.id=?`).get(row.id);
  notifyFollowers(updated.owner_id, "A followed listing was updated", `${updated.title} has new details on PataHome.`).catch(e=>console.error("follower notification failed:",e.message));
  send(res, 200, listingView(updated));
});

router.add("DELETE", "/api/listings/:id", (req, res, p) => {
  const u = requireAuth(req, res); if (!u) return;
  const row = db.prepare("SELECT * FROM listings WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Listing not found" });
  if (row.owner_id !== u.id && u.role !== "admin") return send(res, 403, { error: "Not your listing" });
  // reclaim photo storage before soft-deleting
  for (const id of parsePhotos(row.photos)) cldDestroy(id);
  db.prepare("UPDATE listings SET status='removed', status_changed_at=datetime('now'), photos='[]' WHERE id=?").run(row.id);
  send(res, 200, { ok: true });
});

/* -------- photo uploads: browser uploads straight to Cloudinary (no server disk) -------- */
router.add("GET", "/api/uploads/sign", (req, res) => {
  const u = requireAuth(req, res); if (!u) return;
  if (!cldEnabled()) return send(res, 503, { error: "Photo uploads are not configured yet" });
  const folder = req.query.kind === "verify" ? "patahome/verify" : CLD.folder;
  const timestamp = Math.floor(Date.now() / 1000);
  const params = { folder, timestamp, transformation: CLD_TRANSFORM };
  send(res, 200, {
    cloudName: CLD.cloud, apiKey: CLD.key,
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
  const { name, phone, message } = req.body || {};
  if (!name || !phone || !message) return send(res, 400, { error: "name, phone and message are required" });
  if (String(message).length > 1000) return send(res, 400, { error: "Message too long (max 1000 chars)" });
  const info = db.prepare("INSERT INTO inquiries (listing_id,from_name,from_phone,message) VALUES (?,?,?,?)")
    .run(row.id, String(name).trim(), String(phone).trim(), String(message).trim());
  // an inquiry is also a lead
  const u = getUser(req);
  db.prepare("INSERT INTO leads (listing_id,user_id) VALUES (?,?)").run(row.id, u ? u.id : null);
  db.prepare("INSERT INTO notifications (user_id,kind,title,body) VALUES (?,?,?,?)")
    .run(row.owner_id, "inquiry", "New message", `${String(name).trim()} asked about "${row.title}".`);
  send(res, 201, { ok: true, inquiryId: info.lastInsertRowid });
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
    openTickets: one("SELECT COUNT(*) FROM support_tickets WHERE status='open'"),
    byCategory: Object.fromEntries(db.prepare("SELECT category, COUNT(*) n FROM listings WHERE status='active' GROUP BY category").all().map(r => [r.category, r.n]))
  });
});

/* -------- verification review queue -------- */
router.add("GET", "/api/admin/verifications", (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
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

/* -------- admin: support tickets & live-chat inbox -------- */
router.add("GET", "/api/admin/support", (req, res) => {
  if (!requireAdmin(req, res)) return;
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
  if (!requireAdmin(req, res)) return;
  const row = db.prepare("SELECT id FROM support_tickets WHERE id=?").get(p.id);
  if (!row) return send(res, 404, { error: "Ticket not found" });
  const status = req.body && req.body.status;
  if (status !== "open" && status !== "resolved")
    return send(res, 400, { error: "status must be 'open' or 'resolved'" });
  db.prepare("UPDATE support_tickets SET status=? WHERE id=?").run(status, p.id);
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
  rentals:      { db: "rent",     label: "Houses & Rooms for Rent",   unit: "/month" },
  "for-sale":   { db: "sale",     label: "Houses for Sale",           unit: "" },
  "short-stays":{ db: "shortlet", label: "Airbnb Rentals in Kenya", unit: "/night" }
};
const CAT_SLUG = { rent: "rentals", sale: "for-sale", shortlet: "short-stays" };
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
<meta property="og:image" content="${BASE_URL}/og-image.png">
<meta name="twitter:card" content="summary_large_image">
<meta name="theme-color" content="#0e8a68">
<link rel="icon" href="/favicon.ico" sizes="48x48">
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
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
  res.writeHead(code, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache, must-revalidate" });
  res.end(html);
}

/* ---- per-listing page: /listing/:id/:slug? ---- */
function listingPage(req, res, p) {
  const row = db.prepare(`${LISTING_SQL} WHERE l.id=? AND l.status='active'`).get(p.id);
  if (!row) return sendHtml(res, 404, pageShell({
    title: "Listing not found — PataHome", description: "This listing is no longer available.",
    canonical: `${BASE_URL}/`, bodyHtml: `<h1>Listing not found</h1><p>It may have been rented or sold. <a href="/">Browse current listings</a>.</p>` }));
  const catSlug = CAT_SLUG[row.category];
  const unit = row.category === "rent" ? "/month" : row.category === "shortlet" ? "/night" : "";
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

/* ---- category+area landing pages: /rentals/ruaka etc ---- */
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
  // Read-only data endpoints stay crawlable so Googlebot can fully render the pages
  res.end(`User-agent: *
Allow: /
Allow: /api/areas
Allow: /api/listings
Allow: /api/config
Allow: /api/insights
Disallow: /dashboard.html
Disallow: /admin.html
Disallow: /api/

Sitemap: ${BASE_URL}/sitemap.xml
`);
});

/* ================= server ================= */
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

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
          const ext = path.extname(file);
          res.writeHead(200, {
            "Content-Type": MIME[ext] || "application/octet-stream",
            // HTML must always revalidate so deploys show up immediately (browsers + Cloudflare edge)
            "Cache-Control": ext === ".html" || ext === "" ? "no-cache, must-revalidate" : "public, max-age=86400"
          });
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
