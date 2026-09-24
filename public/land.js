/* PataHome land helpers — shared by the browse page, homepage and dashboard.
   The server keeps an identical copy of UNITS/BASIS in server.js; keep them in sync.
   Sizes are stored in the owner's unit AND as acres (so buyers can filter and
   compare). "Points": 10 points = 1 acre, as used in parts of Kenya. */
(function (root) {
  var SQFT_PER_ACRE = 43560;
  var UNITS = {
    acre:        { acres: 1,                       one: "acre",              many: "acres" },
    point:       { acres: 0.1,                     one: "point",             many: "points" },
    ha:          { acres: 2.4710538,               one: "hectare",           many: "hectares" },
    plot_50x100: { acres: 5000 / SQFT_PER_ACRE,    one: "plot (50×100)",     many: "plots (50×100)" },
    plot_40x80:  { acres: 3200 / SQFT_PER_ACRE,    one: "plot (40×80)",      many: "plots (40×80)" },
    plot_100x100:{ acres: 10000 / SQFT_PER_ACRE,   one: "plot (100×100)",    many: "plots (100×100)" },
    quarter:     { acres: 0.25,                    one: "quarter acre",      many: "quarter acres" },
    half:        { acres: 0.5,                     one: "half acre",         many: "half acres" },
    sqm:         { acres: 1 / 4046.8564224,        one: "m²",                many: "m²" },
    sqft:        { acres: 1 / SQFT_PER_ACRE,       one: "sq ft",             many: "sq ft" }
  };
  var BASIS = {
    sale:  { total: "total price", per_acre: "per acre", per_plot: "per plot" },
    lease: { acre_year: "per acre per year", acre_season: "per acre per season", month: "per month (whole land)", year: "per year (whole land)" }
  };
  var SHORT = { total: "", per_acre: "/acre", per_plot: "/plot", acre_year: "/acre/yr", acre_season: "/acre/season", month: "/month", year: "/yr" };

  function num(n, d) { return Number(n).toLocaleString("en-KE", { maximumFractionDigits: d == null ? 2 : d }); }
  function money(n) {
    n = Math.round(n);
    if (n >= 1e6) return "KES " + num(n / 1e6, n % 1e6 ? 2 : 0).replace(/\.?0+$/, "") + "M";
    if (n >= 1e5) return "KES " + num(Math.round(n / 1e3), 0) + "K";
    return "KES " + num(n, 0);
  }
  function acres(value, unit) { var u = UNITS[unit]; return u ? value * u.acres : null; }
  function sizeLabel(value, unit, acresVal) {
    var u = UNITS[unit]; if (!u || !value) return "";
    var main = num(value, 3) + " " + (Number(value) === 1 ? u.one : u.many);
    var a = acresVal != null ? acresVal : acres(value, unit);
    if (unit === "acre" || a == null) return main;
    return main + " · ≈ " + (a >= 10 ? num(a, 1) : num(a, a < 0.1 ? 3 : 2)) + " acre" + (Math.abs(a - 1) < 1e-9 ? "" : "s");
  }
  /* price as entered + the useful derived figure */
  function priceLabel(x) {
    var deal = x.landDeal || "sale", basis = x.priceBasis || (deal === "lease" ? "acre_year" : "total");
    var main = money(x.price) + (SHORT[basis] ? " " + SHORT[basis] : "");
    var extra = "";
    if (deal === "sale" && x.pricePerAcre && basis !== "per_acre") extra = money(x.pricePerAcre) + " /acre";
    if (deal === "sale" && basis === "per_acre" && x.sizeAcres) extra = money(x.price * x.sizeAcres) + " total";
    if (deal === "lease" && x.pricePerAcre && basis !== "acre_year") extra = "≈ " + money(x.pricePerAcre) + " /acre/yr";
    return { main: main, extra: extra };
  }
  var DETAILS = {
    title: { ready: "Title deed ready", mother: "Mother title (subdivision pending)", allotment: "Allotment letter", leasehold: "Leasehold", sharecert: "Share certificate" },
    use: { agricultural: "Agricultural", residential: "Residential", commercial: "Commercial", mixed: "Mixed use", industrial: "Industrial" },
    road: { tarmac: "Tarmac road", murram: "Murram road", none: "No road access" },
    water: { piped: "Piped water", borehole: "Borehole", river: "River / stream", none: "No water yet" },
    power: { onsite: "Electricity on site", nearby: "Electricity nearby", none: "No electricity" },
    terrain: { flat: "Flat", gentle: "Gently sloping", steep: "Steep", valley: "Valley / wetland" },
    suits: { crops: "Crops", grazing: "Grazing", horticulture: "Horticulture", storage: "Storage / yard", building: "Building" }
  };
  root.PH_LAND = { UNITS: UNITS, BASIS: BASIS, SHORT: SHORT, DETAILS: DETAILS, acres: acres, sizeLabel: sizeLabel, priceLabel: priceLabel, money: money };
})(typeof window !== "undefined" ? window : globalThis);
