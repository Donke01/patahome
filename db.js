// db.js: SQLite via Node's built-in node:sqlite (Node 22.5+). Zero dependencies.
const { DatabaseSync } = require("node:sqlite");
const path = require("node:path");

const db = new DatabaseSync(process.env.DB_PATH || path.join(__dirname, "patahome.db"));
try { db.exec("PRAGMA journal_mode = WAL"); } catch { /* WAL unsupported on some filesystems, default journal is fine */ }
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

// Expand listings.category to allow 'shortlet' (Airbnb-style furnished nightly rentals).
// SQLite doesn't support ALTER on CHECK constraints, so if the old CHECK is present we
// rebuild the table in a transaction. Idempotent, skipped once the new CHECK is in place.
try {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").get();
  if (info && info.sql && info.sql.includes("'vehicle'") && !info.sql.includes("'shortlet'")) {
    db.exec("BEGIN");
    db.exec(`CREATE TABLE listings_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      category TEXT NOT NULL CHECK (category IN ('rent','sale','shortlet','land','vehicle')),
      title TEXT NOT NULL,
      description TEXT DEFAULT '',
      area_id INTEGER NOT NULL REFERENCES areas(id),
      price INTEGER NOT NULL CHECK (price > 0),
      bedrooms INTEGER,
      lat REAL NOT NULL,
      lng REAL NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      featured_until TEXT,
      photos TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`);
    db.exec(`INSERT INTO listings_new (id,owner_id,category,title,description,area_id,price,bedrooms,lat,lng,status,featured_until,photos,created_at)
             SELECT id,owner_id,category,title,description,area_id,price,bedrooms,lat,lng,status,featured_until,photos,created_at FROM listings`);
    db.exec("DROP TABLE listings");
    db.exec("ALTER TABLE listings_new RENAME TO listings");
    db.exec("CREATE INDEX IF NOT EXISTS idx_listings_cat ON listings(category, status)");
    db.exec("CREATE INDEX IF NOT EXISTS idx_listings_geo ON listings(lat, lng)");
    db.exec("COMMIT");
    console.log("✓ Migrated listings table: 'shortlet' category enabled.");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  console.error("shortlet migration failed:", e.message);
}

// Keeps a small, useful lifecycle audit for listings which are no longer live.
// This is deliberately nullable so existing listings retain their original history.
try { db.exec("ALTER TABLE listings ADD COLUMN status_changed_at TEXT"); } catch (e) { /* column exists */ }

// richer user profiles for the account system
for (const col of [
  "business_name TEXT", "business_type TEXT", "bio TEXT",
  "language TEXT DEFAULT 'en'", "avatar_url TEXT", "google_id TEXT",
  "verify_status TEXT DEFAULT 'none'",  // none | pending | verified | rejected
  "dob TEXT", "country TEXT DEFAULT 'Kenya'", "county TEXT", "town TEXT",
  "id_number TEXT", "verify_docs TEXT", "legal_name TEXT",
  "email_verified INTEGER DEFAULT 0",
  "phone_verified INTEGER DEFAULT 0",
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
  follower_email TEXT,
  follower_user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  verified INTEGER NOT NULL DEFAULT 0,
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
CREATE INDEX IF NOT EXISTS idx_followers_phone ON followers(follower_phone);
CREATE TABLE IF NOT EXISTS follower_codes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  challenge TEXT NOT NULL UNIQUE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  follower_name TEXT NOT NULL,
  follower_phone TEXT NOT NULL,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_codes_user ON verify_codes(user_id, kind);
`);
try { db.exec("ALTER TABLE followers ADD COLUMN follower_email TEXT"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE followers ADD COLUMN follower_user_id INTEGER"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE followers ADD COLUMN verified INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }

/* Who posted a listing: the owner themself, an agent, or a caretaker/manager
   acting for the owner. Agent listings must disclose their fee to tenants. */
try { db.exec("ALTER TABLE listings ADD COLUMN lister_role TEXT NOT NULL DEFAULT 'owner'"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN agent_fee TEXT NOT NULL DEFAULT ''"); } catch (e) { /* exists */ }

/* Listing freshness: listings expire LISTING_TTL_DAYS after the owner last
   confirmed they're still available (or edited them). */
try { db.exec("ALTER TABLE listings ADD COLUMN confirmed_at TEXT"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN reminded_at TEXT"); } catch (e) { /* exists */ }

/* Trust & safety: tenant reports, automatic scam/duplicate flags, and the
   Cloudinary content hash (etag) of every listing photo for reuse detection. */
db.exec(`
CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  reason TEXT NOT NULL,
  details TEXT NOT NULL DEFAULT '',
  contact TEXT NOT NULL DEFAULT '',
  ip TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'open',          -- open | dismissed | actioned
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_reports_listing ON reports(listing_id, status);
CREATE TABLE IF NOT EXISTS listing_flags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,                            -- photo_reuse | price_outlier | many_counties | shared_contact
  detail TEXT NOT NULL DEFAULT '',
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_flags_listing ON listing_flags(listing_id, resolved);
CREATE TABLE IF NOT EXISTS photo_hashes (
  public_id TEXT PRIMARY KEY,
  listing_id INTEGER NOT NULL,
  owner_id INTEGER NOT NULL,
  etag TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_photo_etag ON photo_hashes(etag);
`);

/* ---- Listing extras: structured details, video, nearby places ---- */
try { db.exec("ALTER TABLE listings ADD COLUMN features TEXT NOT NULL DEFAULT '{}'"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN video TEXT NOT NULL DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE listings ADD COLUMN nearby TEXT"); } catch (e) { /* exists: JSON, NULL = not fetched yet */ }

db.exec(`
/* Viewing requests from tenants */
CREATE TABLE IF NOT EXISTS viewings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT NOT NULL DEFAULT '',
  slot_at TEXT NOT NULL,                 -- ISO datetime (EAT shown to users)
  note TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'requested', -- requested | confirmed | declined | cancelled
  token TEXT NOT NULL,                   -- lets the tenant view/cancel without an account
  reminded INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_viewings_listing ON viewings(listing_id, status);

/* Message threads (each inquiry becomes a thread) */
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inquiry_id INTEGER NOT NULL REFERENCES inquiries(id) ON DELETE CASCADE,
  sender TEXT NOT NULL,                  -- tenant | owner
  body TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_messages_inquiry ON messages(inquiry_id);

/* Saved searches / new-listing alerts */
CREATE TABLE IF NOT EXISTS saved_searches (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  criteria TEXT NOT NULL,                -- JSON {cat,q,price,beds,direct}
  label TEXT NOT NULL DEFAULT '',
  token TEXT NOT NULL UNIQUE,
  confirmed INTEGER NOT NULL DEFAULT 0,
  sent_today INTEGER NOT NULL DEFAULT 0,
  sent_day TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

/* Per-listing daily counters for owner analytics */
CREATE TABLE IF NOT EXISTS listing_stats (
  listing_id INTEGER NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  views INTEGER NOT NULL DEFAULT 0,
  saves INTEGER NOT NULL DEFAULT 0,
  shares INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (listing_id, day)
);
`);
try { db.exec("ALTER TABLE inquiries ADD COLUMN thread_token TEXT"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE inquiries ADD COLUMN from_email TEXT NOT NULL DEFAULT ''"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE inquiries ADD COLUMN owner_unread INTEGER NOT NULL DEFAULT 1"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE inquiries ADD COLUMN tenant_unread INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE inquiries ADD COLUMN updated_at TEXT"); } catch (e) { /* exists */ }

/* ---- Referrals, backups log, cookieless traffic stats ---- */
try { db.exec("ALTER TABLE users ADD COLUMN referral_code TEXT"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN referred_by INTEGER"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN referral_rewarded INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }
try { db.exec("ALTER TABLE users ADD COLUMN featured_credits INTEGER NOT NULL DEFAULT 0"); } catch (e) { /* exists */ }
db.exec(`
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_refcode ON users(referral_code);
CREATE TABLE IF NOT EXISTS backups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  file TEXT NOT NULL DEFAULT '',
  bytes INTEGER NOT NULL DEFAULT 0,
  remote TEXT NOT NULL DEFAULT '',
  ok INTEGER NOT NULL DEFAULT 0,
  error TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS pv_daily (day TEXT NOT NULL, path TEXT NOT NULL, views INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, path));
CREATE TABLE IF NOT EXISTS pv_ref (day TEXT NOT NULL, host TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, host));
CREATE TABLE IF NOT EXISTS pv_city (day TEXT NOT NULL, city TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, city));
CREATE TABLE IF NOT EXISTS pv_uniques (day TEXT NOT NULL, h TEXT NOT NULL, PRIMARY KEY (day, h));
CREATE TABLE IF NOT EXISTS search_log (day TEXT NOT NULL, q TEXT NOT NULL, results INTEGER NOT NULL DEFAULT 0, n INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (day, q));
`);

/* ---- Land listings: deal type, size (owner's unit + acres), pricing basis,
   exact pin, and private title documents for the "Documents checked" badge ---- */
for (const col of [
  "land_deal TEXT", "size_value REAL", "size_unit TEXT", "size_acres REAL", "price_basis TEXT",
  "price_per_acre REAL", "lease_min TEXT", "exact_pin INTEGER NOT NULL DEFAULT 0",
  "title_ref TEXT", "land_docs TEXT NOT NULL DEFAULT '[]'", "docs_status TEXT NOT NULL DEFAULT 'none'", "docs_note TEXT"
]) { try { db.exec("ALTER TABLE listings ADD COLUMN " + col); } catch (e) { /* exists */ } }
try { db.exec("CREATE INDEX IF NOT EXISTS idx_listings_land ON listings(category, land_deal, size_acres)"); } catch (e) { /* ignore */ }

/* ---- Commercial property (shops, offices, warehouses, buildings…) for sale or lease.
   Reuses land_deal (sale|lease), size_value/size_unit, price_basis, lease_min,
   exact_pin and the private title documents; adds its own type/area/income columns. */
for (const col of ["comm_type TEXT", "area_sqft REAL", "price_per_sqft REAL", "income_month INTEGER"]) {
  try { db.exec("ALTER TABLE listings ADD COLUMN " + col); } catch (e) { /* exists */ }
}
// Allow category 'commercial'. SQLite can't ALTER a CHECK constraint, so rebuild the
// table from its own schema (every column and index kept). Foreign keys are switched
// off for the swap so child rows (inquiries, viewings…) are not cascade-deleted.
try {
  const info = db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='listings'").get();
  if (info && info.sql && !info.sql.includes("'commercial'")) {
    const newSql = info.sql
      .replace(/CHECK\s*\(\s*category IN \(([^)]*)\)\s*\)/, (m, list) => `CHECK (category IN (${list},'commercial'))`)
      .replace(/^CREATE TABLE\s+("?)listings\1/, "CREATE TABLE listings_new");
    if (!newSql.includes("'commercial'") || !newSql.startsWith("CREATE TABLE listings_new")) throw new Error("unexpected listings schema");
    const cols = db.prepare("PRAGMA table_info(listings)").all().map(c => `"${c.name}"`).join(",");
    const idx = db.prepare("SELECT sql FROM sqlite_master WHERE type='index' AND tbl_name='listings' AND sql IS NOT NULL").all().map(r => r.sql);
    db.exec("PRAGMA foreign_keys = OFF");
    db.exec("BEGIN");
    db.exec(newSql);
    db.exec(`INSERT INTO listings_new (${cols}) SELECT ${cols} FROM listings`);
    db.exec("DROP TABLE listings");
    db.exec("ALTER TABLE listings_new RENAME TO listings");
    for (const s of idx) db.exec(s);
    db.exec("COMMIT");
    db.exec("PRAGMA foreign_keys = ON");
    console.log("✓ Migrated listings table: 'commercial' category enabled.");
  }
} catch (e) {
  try { db.exec("ROLLBACK"); } catch {}
  try { db.exec("PRAGMA foreign_keys = ON"); } catch {}
  console.error("commercial migration failed:", e.message);
}
try { db.exec("CREATE INDEX IF NOT EXISTS idx_listings_comm ON listings(category, comm_type, area_sqft)"); } catch (e) { /* ignore */ }

/* Login sessions, one row per signed-in device. Tokens carry the session id,
   so a session can be expired for inactivity, capped in length, or revoked
   (logout, "sign out everywhere", password/phone/email change). */
db.exec(`
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL,
  last_seen INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  ua TEXT,
  ip TEXT
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
`);

/* ---- Admin powers: team roles, bans, read-only "view as", listing banners,
   append-only audit log, word blocklist and editable site settings ---- */
for (const [table, col] of [
  ["users", "admin_role TEXT"],            // super | moderator | support (only when role='admin')
  ["users", "banned_until TEXT"],          // ISO time, or 'forever'
  ["users", "ban_reason TEXT"], ["users", "banned_at TEXT"], ["users", "banned_by INTEGER"],
  ["listings", "admin_banner TEXT"],       // e.g. "Under investigation, do not pay"
  ["sessions", "readonly INTEGER NOT NULL DEFAULT 0"], ["sessions", "viewer_id INTEGER"]
]) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) { /* exists */ } }
for (const [table, col] of [
  ["users", "managed INTEGER NOT NULL DEFAULT 0"],        // account PataHome created for an owner who can't list themselves
  ["listings", "assisted INTEGER NOT NULL DEFAULT 0"], ["listings", "assisted_by INTEGER"],
  ["listings", "contact_name TEXT"], ["listings", "contact_phone TEXT"], ["listings", "contact_whatsapp TEXT"],
  ["listings", "relay_sms INTEGER NOT NULL DEFAULT 0"], ["listings", "relay_copy INTEGER NOT NULL DEFAULT 0"],
  ["listings", "consent_how TEXT"], ["listings", "consent_note TEXT"], ["listings", "consent_at TEXT"]
]) { try { db.exec(`ALTER TABLE ${table} ADD COLUMN ${col}`); } catch (e) { /* exists */ } }
db.exec("UPDATE users SET admin_role='super' WHERE role='admin' AND admin_role IS NULL");
db.exec(`
CREATE TABLE IF NOT EXISTS admin_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  at TEXT NOT NULL DEFAULT (datetime('now')),
  admin_id INTEGER, admin_name TEXT,
  action TEXT NOT NULL, target_type TEXT, target_id TEXT, detail TEXT,
  ip TEXT, ua TEXT
);
CREATE INDEX IF NOT EXISTS idx_audit_at ON admin_audit(at);
CREATE INDEX IF NOT EXISTS idx_audit_target ON admin_audit(target_type, target_id);
CREATE TRIGGER IF NOT EXISTS audit_no_update BEFORE UPDATE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TRIGGER IF NOT EXISTS audit_no_delete BEFORE DELETE ON admin_audit BEGIN SELECT RAISE(ABORT, 'audit log is append-only'); END;
CREATE TABLE IF NOT EXISTS banned_identifiers (
  kind TEXT NOT NULL, value TEXT NOT NULL, user_id INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (kind, value)
);
CREATE TABLE IF NOT EXISTS blocklist (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  term TEXT NOT NULL UNIQUE, created_by INTEGER, created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY, value TEXT, updated_at TEXT NOT NULL DEFAULT (datetime('now')), updated_by INTEGER
);
`);
// One-off: photos per listing went up to 60. Lift any older saved limit once; after that the admin setting rules.
if (!db.prepare("SELECT 1 FROM settings WHERE key='mig_photos_60'").get()) {
  db.exec("UPDATE settings SET value='60' WHERE key='max_photos' AND CAST(value AS INTEGER) < 60");
  db.exec("INSERT OR IGNORE INTO settings (key,value) VALUES ('mig_photos_60','1')");
}

module.exports = db;
