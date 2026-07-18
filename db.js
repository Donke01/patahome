// db.js — SQLite via Node's built-in node:sqlite (Node 22.5+). Zero dependencies.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "patahome.db"));
try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* WAL unsupported on some filesystems — default journal is fine */ }
db.exec("PRAGMA foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  phone TEXT NOT NULL UNIQUE,
  email TEXT UNIQUE,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',          -- user | admin
  verified INTEGER NOT NULL DEFAULT 0,        -- owner ID/ownership verification
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS areas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  county TEXT NOT NULL,
  lat REAL NOT NULL,
  lng REAL NOT NULL
);

CREATE TABLE IF NOT EXISTS listings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category TEXT NOT NULL CHECK (category IN ('rent','sale','land','vehicle')),
  title TEXT NOT NULL,
  description TEXT DEFAULT '',
  area_id INTEGER NOT NULL REFERENCES areas(id),
  price INTEGER NOT NULL CHECK (price > 0),
  bedrooms INTEGER,                            -- NULL for land/vehicles
  lat REAL NOT NULL,
  lng REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',       -- active | rented | sold | removed
  featured_until TEXT,                         -- ISO date; featured = monetization
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_cat ON listings(category, status);
CREATE INDEX IF NOT EXISTS idx_listings_geo ON listings(lat, lng);

CREATE TABLE IF NOT EXISTS favorites (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (user_id, listing_id)
);

-- A "lead" = a tenant/buyer requesting the owner's contact. Core marketplace metric.
CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),        -- NULL if anonymous
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Inquiries = feedback/questions from tenants & buyers to the owner
CREATE TABLE IF NOT EXISTS inquiries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  from_name TEXT NOT NULL,
  from_phone TEXT NOT NULL,
  message TEXT NOT NULL,
  owner_reply TEXT,
  replied_at TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_inquiries_listing ON inquiries(listing_id);

-- Payments for featured listings (M-Pesa integration point; mocked for now)
CREATE TABLE IF NOT EXISTS payments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id),
  listing_id INTEGER REFERENCES listings(id),
  amount INTEGER NOT NULL,
  purpose TEXT NOT NULL,                       -- feature_7d | feature_30d | verification
  provider TEXT NOT NULL DEFAULT 'mpesa-mock',
  provider_ref TEXT,
  status TEXT NOT NULL DEFAULT 'pending',      -- pending | completed | failed
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
`);

/* -------- migrations (idempotent) -------- */
// photos: JSON array of Cloudinary public_ids (max 5 per listing)
try { db.exec("ALTER TABLE listings ADD COLUMN photos TEXT"); } catch (e) { /* column exists */ }
// richer user profiles for the account system
for (const col of [
  "business_name TEXT", "business_type TEXT", "bio TEXT",
  "language TEXT DEFAULT 'en'", "avatar_url TEXT", "google_id TEXT",
  "verify_status TEXT DEFAULT 'none'",  // none | pending | verified | rejected
  "dob TEXT", "country TEXT DEFAULT 'Kenya'", "county TEXT", "town TEXT",
  "id_number TEXT", "verify_docs TEXT", "legal_name TEXT",
  "email_verified INTEGER DEFAULT 0",
  "gender TEXT", "contact_pref TEXT", "whatsapp TEXT", "languages TEXT",
  "business_role TEXT", "business_since TEXT", "website TEXT", "business_address TEXT",
  "id_type TEXT", "kra_pin TEXT"
]) {
  try { db.exec(`ALTER TABLE users ADD COLUMN ${col}`); } catch (e) { /* exists */ }
}

// followers: a renter/buyer follows an owner to get notified of new listings
db.exec(`
CREATE TABLE IF NOT EXISTS followers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follower_name TEXT NOT NULL,
  follower_phone TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(owner_id, follower_phone)
);
CREATE TABLE IF NOT EXISTS notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- lead | inquiry | follower | system | verify
  title TEXT NOT NULL,
  body TEXT DEFAULT '',
  read INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS support_tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  message TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',         -- open | resolved
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS verify_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                          -- email | phone
  target TEXT NOT NULL,                        -- the new email/phone being verified
  code TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read);
CREATE INDEX IF NOT EXISTS idx_followers_owner ON followers(owner_id);
CREATE INDEX IF NOT EXISTS idx_codes_user ON verify_codes(user_id, kind);
`);

module.exports = db;
