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

module.exports = db;
