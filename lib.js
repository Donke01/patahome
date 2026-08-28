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

/* ---------- minimal SMTP client (STARTTLS) — zero dependencies ----------
   Configured via env: SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASS, MAIL_FROM
   For iCloud custom domains: SMTP_HOST=smtp.mail.me.com, SMTP_USER=<Apple ID>,
   SMTP_PASS=<app-specific password>, MAIL_FROM=info@yourdomain */
const net = require("node:net");
const tls = require("node:tls");

const mailConfigured = () =>
  !!(process.env.MAIL_FROM && (process.env.RESEND_API_KEY ||
     (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS)));

/* Preferred path: Resend HTTPS API (works on hosts that block SMTP ports) */
async function sendMail({ to, subject, text }) {
  if (process.env.RESEND_API_KEY) {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + process.env.RESEND_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ from: `PataHome <${process.env.MAIL_FROM}>`, to: [to], subject, text }),
      signal: AbortSignal.timeout(15000)
    });
    if (!r.ok) {
      const d = await r.json().catch(() => ({}));
      throw new Error(d.message || ("Resend error " + r.status));
    }
    return true;
  }
  return smtpSend({ to, subject, text });
}

/* ---------- SMS via Infobip HTTPS API ----------
   Configured via env:
     INFOBIP_API_KEY   — from the Infobip dashboard (API keys)
     INFOBIP_BASE_URL  — your personal base URL, e.g. xxxxx.api.infobip.com
     SMS_SENDER        — alphanumeric sender ID (default "PataHome")
   Uses HTTPS so it works on hosts that block SMTP/SMPP ports. */
const smsConfigured = () =>
  !!(process.env.INFOBIP_API_KEY && process.env.INFOBIP_BASE_URL);

/* Normalise a Kenyan number to E.164 without the plus: 0712345678 -> 254712345678 */
function normalizePhone(phone) {
  let p = String(phone || "").replace(/[^0-9+]/g, "");
  if (p.startsWith("+")) p = p.slice(1);
  if (p.startsWith("0")) p = "254" + p.slice(1);
  else if (/^[17]\d{8}$/.test(p)) p = "254" + p;   // bare 7xxxxxxxx / 1xxxxxxxx
  return p;
}

async function sendSms({ to, text }) {
  if (!smsConfigured()) throw new Error("SMS not configured");
  const base = String(process.env.INFOBIP_BASE_URL).replace(/^https?:\/\//, "").replace(/\/$/, "");
  const r = await fetch(`https://${base}/sms/2/text/advanced`, {
    method: "POST",
    headers: {
      Authorization: "App " + process.env.INFOBIP_API_KEY,
      "Content-Type": "application/json",
      Accept: "application/json"
    },
    body: JSON.stringify({
      messages: [{
        destinations: [{ to: normalizePhone(to) }],
        from: process.env.SMS_SENDER || "PataHome",
        text
      }]
    }),
    signal: AbortSignal.timeout(15000)
  });
  const d = await r.json().catch(() => ({}));
  const masked = normalizePhone(to).replace(/^(\d{6})\d+(\d{3})$/, "$1***$2");
  if (!r.ok) {
    const msg = d?.requestError?.serviceException?.text || d?.message || `Infobip error ${r.status}`;
    console.error(`[sms] HTTP ${r.status} to ${masked}: ${msg}`);
    throw new Error(msg);
  }
  // Infobip returns 200 even when an individual message is rejected — check the status group.
  const m = d?.messages?.[0];
  const group = m?.status?.groupName;
  const messageId = m?.messageId || "?";
  if (group && !["PENDING", "DELIVERED"].includes(group)) {
    console.error(`[sms] rejected to ${masked} id=${messageId} group=${group}: ${m?.status?.description || ""}`);
    throw new Error(m.status.description || `SMS rejected (${group})`);
  }
  // PENDING means Infobip accepted it — NOT that the carrier delivered it.
  // Log the id so it can be traced in the Infobip portal's delivery reports.
  console.log(`[sms] accepted to ${masked} id=${messageId} group=${group || "?"} status=${m?.status?.name || "?"}`);
  return { messageId, group };
}

function smtpSend({ to, subject, text }) {
  return new Promise((resolve, reject) => {
    if (!mailConfigured()) return reject(new Error("mail not configured"));
    const host = process.env.SMTP_HOST, port = +(process.env.SMTP_PORT || 587);
    const user = process.env.SMTP_USER, pass = process.env.SMTP_PASS, from = process.env.MAIL_FROM;
    const implicitTls = port === 465;   // 465 = TLS from the first byte; 587 = STARTTLS upgrade
    let sock = implicitTls ? tls.connect(port, host, { servername: host }) : net.connect(port, host);
    let buf = "", stage = 0;
    const fail = (m) => { try { sock.destroy(); } catch {} ; reject(new Error(m)); };
    const timer = setTimeout(() => fail("SMTP timeout — server unreachable (host/port blocked?)"), 20000);
    const write = (line) => sock.write(line + "\r\n");
    const starttlsSteps = [
      { expect: /^250/, send: () => write("STARTTLS") },
      { expect: /^220/, send: () => {   // upgrade to TLS, then re-EHLO
          sock.removeAllListeners("data");
          sock = tls.connect({ socket: sock, servername: host }, () => write(`EHLO patahome.co.ke`));
          attach();
        } }
    ];
    const steps = [
      { expect: /^220/, send: () => write(`EHLO patahome.co.ke`) },
      ...(implicitTls ? [] : starttlsSteps),
      { expect: /^250/, send: () => write("AUTH LOGIN") },
      { expect: /^334/, send: () => write(Buffer.from(user).toString("base64")) },
      { expect: /^334/, send: () => write(Buffer.from(pass).toString("base64")) },
      { expect: /^235/, send: () => write(`MAIL FROM:<${from}>`) },
      { expect: /^250/, send: () => write(`RCPT TO:<${to}>`) },
      { expect: /^250/, send: () => write("DATA") },
      { expect: /^354/, send: () => {
          const msg = [
            `From: PataHome <${from}>`, `To: <${to}>`, `Subject: ${subject}`,
            `Date: ${new Date().toUTCString()}`,
            `Message-ID: <${Date.now()}.${Math.random().toString(36).slice(2)}@patahome.co.ke>`,
            "MIME-Version: 1.0", "Content-Type: text/plain; charset=utf-8", "",
            text, "."
          ].join("\r\n");
          sock.write(msg + "\r\n");
        } },
      { expect: /^250/, send: () => { write("QUIT"); clearTimeout(timer); resolve(true); } }
    ];
    function onData(chunk) {
      buf += chunk.toString();
      if (!/\r?\n$/.test(buf)) return;
      const line = buf.trim().split(/\r?\n/).pop(); buf = "";
      const step = steps[stage];
      if (!step) return;
      if (!step.expect.test(line)) { clearTimeout(timer); return fail(`SMTP error at step ${stage}: ${line.slice(0, 120)}`); }
      stage++;
      step.send();
    }
    function attach() { sock.on("data", onData); sock.on("error", (e) => { clearTimeout(timer); fail("SMTP connection error: " + e.message); }); }
    attach();
  });
}

module.exports = { hashPassword, verifyPassword, signToken, verifyToken, km, makeRouter, sendMail, mailConfigured, sendSms, smsConfigured, normalizePhone };
