/* PataHome commercial-property helpers, shared by the server, browse page,
   homepage and dashboard. Floor area is stored in the owner's unit AND in
   square feet so buyers/tenants can filter and compare. */
(function (root) {
  var SQFT_PER_SQM = 10.7639104;
  var TYPES = {
    shop: "Shop / retail", office: "Office", warehouse: "Warehouse / godown", industrial: "Industrial / factory",
    hotel: "Hotel / restaurant", building: "Commercial building", rental_block: "Rental block (flats)",
    mixed: "Mixed-use building", plot: "Commercial plot", petrol: "Petrol station",
    institution: "School / institution", health: "Clinic / hospital"
  };
  var UNITS = {
    sqft: { sqft: 1, one: "sq ft", many: "sq ft" },
    sqm:  { sqft: SQFT_PER_SQM, one: "m²", many: "m²" },
    acre: { sqft: 43560, one: "acre", many: "acres" }
  };
  var BASIS = {
    sale:  { total: "total price" },
    lease: { month: "per month", sqft_month: "per sq ft per month", year: "per year" }
  };
  var SHORT = { total: "", month: "/month", sqft_month: "/sq ft/month", year: "/yr" };
  var DETAILS = {
    title: { ready: "Title deed ready", leasehold: "Leasehold", sectional: "Sectional title", mother: "Mother title", sharecert: "Share certificate" },
    frontage: { highway: "Highway frontage", main: "Main road", side: "Side street", inside: "Inside a mall / complex" },
    fit: { shell: "Bare shell", semi: "Semi-fitted", fitted: "Fully fitted", furnished: "Furnished" },
    power: { three: "Three-phase power", single: "Single-phase power", none: "No power yet" },
    tenancy: { vacant: "Vacant", tenanted: "Fully let (earning income)", part: "Partly let" }
  };
  var TICKS = { parking: "Parking", lift: "Lift", generator: "Backup generator", security: "24h security", cctv: "CCTV",
    borehole: "Borehole", loading: "Loading bay", fibre: "Fibre internet", washrooms: "Washrooms" };

  function num(n, d) { return Number(n).toLocaleString("en-KE", { maximumFractionDigits: d == null ? 0 : d }); }
  function money(n) {
    n = Math.round(n);
    if (n >= 1e6) return "KES " + num(n / 1e6, n % 1e6 ? 2 : 0).replace(/\.?0+$/, "") + "M";
    if (n >= 1e5) return "KES " + num(Math.round(n / 1e3)) + "K";
    return "KES " + num(n);
  }
  function sqft(value, unit) { var u = UNITS[unit]; return u ? value * u.sqft : null; }
  function areaLabel(value, unit, sq) {
    var u = UNITS[unit]; if (!u || !value) return "";
    var main = num(value, 2) + " " + (Number(value) === 1 ? u.one : u.many);
    if (unit === "sqft") return main;
    var s = sq != null ? sq : sqft(value, unit);
    return main + " · ≈ " + num(s) + " sq ft";
  }
  /* price as entered + one useful derived figure */
  function priceLabel(x) {
    var deal = x.deal || "sale", basis = x.priceBasis || (deal === "lease" ? "month" : "total");
    var main = (basis === "sqft_month" ? "KES " + num(x.price) : money(x.price)) + (SHORT[basis] ? " " + SHORT[basis] : "");
    var extra = "";
    if (deal === "sale") {
      if (x.incomeMonth && x.price) extra = "≈ " + num(x.incomeMonth * 12 / x.price * 100, 1) + "% yearly yield";
      else if (x.pricePerSqft) extra = "KES " + num(x.pricePerSqft) + " /sq ft";
    } else {
      if (basis === "sqft_month" && x.areaSqft) extra = "≈ " + money(x.price * x.areaSqft) + " /month";
      else if (x.pricePerSqft) extra = "≈ KES " + num(x.pricePerSqft) + " /sq ft/month";
    }
    return { main: main, extra: extra };
  }
  /* normalised price per sq ft (sale: KES per sq ft; lease: KES per sq ft per month) */
  function perSqft(deal, basis, price, sq) {
    if (!(sq > 0)) return null;
    if (deal === "sale") return price / sq;
    return { month: price / sq, sqft_month: price, year: price / 12 / sq }[basis] || null;
  }
  root.PH_COMM = { TYPES: TYPES, UNITS: UNITS, BASIS: BASIS, SHORT: SHORT, DETAILS: DETAILS, TICKS: TICKS,
    sqft: sqft, areaLabel: areaLabel, priceLabel: priceLabel, perSqft: perSqft, money: money };
})(typeof window !== "undefined" ? window : globalThis);
