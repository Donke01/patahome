// seed.js — safe to run on every boot.
//   • Areas + admin account are always ensured (idempotent) — the app needs areas to work.
//   • Demo owners/listings/inquiries are only created when SEED_DEMO=1 (never in production).
// Run: node seed.js           (production-safe: areas + admin only)
//      SEED_DEMO=1 node seed.js   (also loads demo listings for local testing)
const db = require("./db");
const { hashPassword } = require("./lib");

const AREAS = [
  ["Kilimani, Nairobi","Nairobi",-1.2906,36.7870],
  ["Westlands, Nairobi","Nairobi",-1.2635,36.8029],
  ["Kasarani, Nairobi","Nairobi",-1.2200,36.8968],
  ["South B, Nairobi","Nairobi",-1.3081,36.8410],
  ["Ruaka","Kiambu",-1.2050,36.7772],
  ["Ruiru","Kiambu",-1.1500,36.9600],
  ["Thika Town","Kiambu",-1.0396,37.0900],
  ["Syokimau","Machakos",-1.3560,36.9260],
  ["Nyali","Mombasa",-4.0210,39.7090],
  ["Kisumu CBD","Kisumu",-0.0917,34.7680],
  ["Nakuru Town","Nakuru",-0.3031,36.0800],
  ["Eldoret Town","Uasin Gishu",0.5143,35.2698],
  ["Kitale Town CBD","Trans Nzoia",1.0157,35.0062],
  ["Milimani, Kitale","Trans Nzoia",1.0210,35.0150],
  ["Kiminini","Trans Nzoia",0.8940,34.9290],
  ["Endebess","Trans Nzoia",1.0713,34.8353],
  ["Kwanza","Trans Nzoia",1.1440,34.9990],
  ["Bikeke","Trans Nzoia",0.9700,35.0600]
];

/* ---------- Always ensure areas exist (idempotent — name is UNIQUE) ---------- */
const insArea = db.prepare("INSERT OR IGNORE INTO areas (name,county,lat,lng) VALUES (?,?,?,?)");
let areasAdded = 0;
for (const [name, county, lat, lng] of AREAS) {
  if (insArea.run(name, county, lat, lng).changes) areasAdded++;
}

/* ---------- Always ensure the admin account exists ---------- */
const adminPhone = process.env.ADMIN_PHONE || "0700000001";
const adminPass = process.env.ADMIN_PASSWORD || "admin1234";
const adminExists = db.prepare("SELECT id FROM users WHERE role='admin' LIMIT 1").get();
if (!adminExists) {
  db.prepare("INSERT INTO users (name,phone,password_hash,role,verified) VALUES (?,?,?,'admin',1)")
    .run("Site Admin", adminPhone, hashPassword(adminPass));
  console.log(`Admin account created for phone ${adminPhone}.`);
  if (!process.env.ADMIN_PASSWORD) console.log("⚠️  Using default admin password 'admin1234' — set ADMIN_PASSWORD to change it.");
}

console.log(`Areas ensured (${areasAdded} added, ${AREAS.length} total).`);

/* ---------- Demo data: only when explicitly requested ---------- */
const wantDemo = /^(1|true|yes)$/i.test(process.env.SEED_DEMO || "");
if (!wantDemo) {
  console.log("Production mode: skipping demo listings (set SEED_DEMO=1 to load them locally).");
  process.exit(0);
}

const existingListings = db.prepare("SELECT COUNT(*) n FROM listings").get().n;
if (existingListings > 0) {
  console.log(`DB already has ${existingListings} listings — skipping demo seed.`);
  process.exit(0);
}

const OWNERS = [
  ["Grace Wanjiru","0712445210"],["Brian Otieno","0723118904"],
  ["Amina Yusuf","0733902341"],["Peter Kamau","0701556782"],
  ["Faith Chebet","0745220913"],["David Mwangi","0728664105"],
  ["Lucy Njeri","0710337458"],["Hassan Ali","0754881236"]
];

// [category, title, areaName, price, bedrooms]
const LISTINGS = [
  ["rent","Modern 2BR apartment, balcony & borehole","Kilimani, Nairobi",65000,2],
  ["rent","Bedsitter near Safari Park, wifi ready","Kasarani, Nairobi",12000,0],
  ["rent","1BR with parking, secure court","South B, Nairobi",28000,1],
  ["rent","Executive 3BR + DSQ, gym & pool","Westlands, Nairobi",145000,3],
  ["rent","Spacious 2BR, near Two Rivers","Ruaka",38000,2],
  ["rent","1BR new build, tiled, tokens","Ruiru",16000,1],
  ["rent","2BR sea-breeze apartment","Nyali",45000,2],
  ["rent","Bedsitter, 5 min to CBD","Kisumu CBD",9500,0],
  ["rent","2BR near Section 58","Nakuru Town",22000,2],
  ["rent","Modern 2BR, tiled, own compound gate","Milimani, Kitale",18000,2],
  ["rent","Bedsitter near Mega Centre, water incl.","Kitale Town CBD",4500,0],
  ["rent","Executive 3BR maisonette + DSQ","Milimani, Kitale",35000,3],
  ["rent","Spacious 2BR near Kiminini market","Kiminini",9500,2],
  ["rent","1BR near Eldoret CBD, secure","Eldoret Town",13000,1],
  ["sale","4BR maisonette in gated community","Syokimau",14500000,4],
  ["sale","3BR bungalow, own compound","Thika Town",8900000,3],
  ["sale","2BR apartment, ready title","Kilimani, Nairobi",9800000,2],
  ["sale","3BR townhouse near Sarit","Westlands, Nairobi",23000000,3],
  ["sale","4BR maisonette on 1/4 acre","Milimani, Kitale",12500000,4],
  ["sale","2BR starter home, ready title","Bikeke",2900000,2],
  ["sale","3BR farmhouse on 1 acre","Endebess",7500000,3],
];

const insUser = db.prepare("INSERT OR IGNORE INTO users (name,phone,password_hash,verified) VALUES (?,?,?,1)");
const insListing = db.prepare(`INSERT INTO listings
  (owner_id,category,title,area_id,price,bedrooms,lat,lng) VALUES (?,?,?,?,?,?,?,?)`);
const getAreaByName = db.prepare("SELECT * FROM areas WHERE name=?");
const getUserByPhone = db.prepare("SELECT id FROM users WHERE phone=?");

const hash = hashPassword("demo1234"); // all demo owners share this password
const ownerIds = OWNERS.map(([name, phone]) => {
  insUser.run(name, phone, hash);
  return getUserByPhone.get(phone).id;
});

LISTINGS.forEach((x, i) => {
  const [cat, title, areaName, price, beds] = x;
  const area = getAreaByName.get(areaName);
  const lat = area.lat + Math.sin(i * 7) * 0.006;
  const lng = area.lng + Math.cos(i * 5) * 0.006;
  insListing.run(ownerIds[i % ownerIds.length], cat, title, area.id, price, beds, lat, lng);
});

const INQUIRIES = [
  [1,"Kevin Ochieng","0722334455","Hi, is the 2BR still available? Can I come view it this Saturday morning?"],
  [1,"Wambui Kariuki","0733221144","What's included in the rent — water and garbage? Any deposit terms?"],
  [4,"Mutua Musyoka","0744556677","Interested in the 3BR. Is the DSQ separate metered? Kindly share more photos."],
  [10,"Zawadi Atieno","0755667788","Naomba kujua kama hii nyumba iko karibu na stage? Asante."],
  [15,"Kiptoo Rono","0766778899","What's your last price for the maisonette? I'm a serious cash buyer."],
  [16,"Neema Wafula","0777889900","Is the title ready for transfer? Can my lawyer do due diligence this week?"]
];
const insInq = db.prepare("INSERT INTO inquiries (listing_id,from_name,from_phone,message) VALUES (?,?,?,?)");
const insLead = db.prepare("INSERT INTO leads (listing_id) VALUES (?)");
for (const [lid, name, phone, msg] of INQUIRIES) { insInq.run(lid, name, phone, msg); insLead.run(lid); }

console.log(`Demo data seeded: ${OWNERS.length} owners, ${LISTINGS.length} listings, ${INQUIRIES.length} inquiries.`);
console.log("Demo owner login: phone 0712445210, password demo1234");
