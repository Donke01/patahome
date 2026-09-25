/* PataHome English ⇄ Kiswahili.
   How it works: English stays in the HTML. When Kiswahili is chosen, every
   piece of text (and placeholder) that exactly matches a phrase below is
   swapped — including cards and popups the page builds later (a
   MutationObserver catches those). Switching back to English reloads.
   To translate something new, add "English text": "Kiswahili" below. */
(function () {
  var SW = {
    // header, menu, bottom bar
    "Browse Listings": "Tazama Nyumba", "List Your Property": "Tangaza Nyumba Yako",
    "Home": "Nyumbani", "Browse": "Tafuta", "Post": "Tangaza", "Account": "Akaunti",
    "Browse all listings": "Tazama nyumba zote", "My messages & viewings": "Jumbe na ziara zangu",
    "Houses for rent": "Nyumba za kupanga", "Homes for sale": "Nyumba zinazouzwa",
    // hero + search
    "Kenya's home of direct owner deals": "Mahali pa mikataba moja kwa moja na wamiliki",
    "Across all 47 counties": "Katika kaunti zote 47",
    "Search": "Tafuta", "Search listings…": "Tafuta nyumba…",
    "Fewer middlemen.": "Madalali wachache.", "More": "Na", "From": "Kutoka", "to Kisumu,": "hadi Kisumu,",
    "and every town between.": "na kila mji katikati.", "Browse bedsitters →": "Tazama bedsita →",
    // category tiles
    "Bedsitters": "Bedsita", "1 Bedroom": "Chumba 1", "2 Bedroom+": "Vyumba 2+",
    "For Sale": "Zinauzwa", "For Rent": "Za Kupanga",
    "Short stays": "Kukaa muda mfupi", "Studios & singles": "Studio na singo", "Starter homes": "Nyumba za kuanzia",
    "Family homes": "Nyumba za familia", "Buy a home": "Nunua nyumba",
    // homepage sections
    "Explore Kenya": "Gundua Kenya", "Fresh on the market": "Mpya sokoni", "Latest listings": "Nyumba mpya",
    "Browse all →": "Tazama zote →", "No listings yet": "Bado hakuna nyumba", "Here": "Hapa",
    "The PataHome promise": "Ahadi ya PataHome", "Real owners first.": "Wamiliki halisi kwanza.",
    "Every fee disclosed.": "Kila ada wazi.", "Homes near you.": "Nyumba karibu nawe.",
    "ID-verified owners": "Wamiliki waliothibitishwa", "No hidden fees": "Hakuna ada zilizofichwa",
    "Nearest homes first": "Nyumba za karibu kwanza", "Find a home →": "Tafuta nyumba →", "List yours free": "Tangaza bure",
    "Direct owner": "Mmiliki moja kwa moja", "✓ Verified owner": "✓ Mmiliki aliyethibitishwa", "Agent listing": "Tangazo la wakala",
    // footer
    "Houses for rent & sale across Kenya.": "Nyumba za kupanga na kuuza kote Kenya.",
    "Owners first — every fee shown upfront.": "Wamiliki kwanza — kila ada inaonyeshwa wazi.",
    "List your property free": "Tangaza nyumba yako bure", "Explore": "Gundua", "Owners": "Wamiliki",
    "Contact": "Mawasiliano", "Follow": "Tufuate", "Rent": "Kupanga", "Buy": "Kununua", "Near me": "Karibu nami",
    "My messages": "Jumbe zangu", "List a property": "Tangaza nyumba", "Dashboard": "Dashibodi",
    "Call us": "Tupigie", "Email us": "Tutumie barua pepe", "Privacy": "Faragha", "Terms": "Masharti",
    "Built for renters, buyers & owners": "Kwa wapangaji, wanunuzi na wamiliki",
    // browse page
    "Browse listings": "Tafuta nyumba", "Search, filter and map every verified listing.": "Tafuta, chuja na uone kwenye ramani kila tangazo lililothibitishwa.",
    "Use my location": "Tumia mahali nilipo", "…or pick an area": "…au chagua eneo", "...or pick an area": "...au chagua eneo",
    "All Listings": "Zote", "Any price": "Bei yoyote", "Any bedrooms": "Vyumba vyovyote",
    "Bedsitter / Studio": "Bedsita / Studio", "1 bedroom": "Chumba 1", "2 bedrooms": "Vyumba 2", "3+ bedrooms": "Vyumba 3+",
    "Nearest first": "Za karibu kwanza", "Price: low → high": "Bei: chini → juu", "Price: high → low": "Bei: juu → chini", "Newest": "Mpya zaidi",
    "Direct from owners only": "Wamiliki pekee", "Alert me": "Nijulishe", "Market insights": "Takwimu za soko",
    "Contact Owner": "Wasiliana na Mmiliki", "Contact Agent": "Wasiliana na Wakala", "Contact Caretaker": "Wasiliana na Msimamizi",
    "Details": "Maelezo", "About": "Kuhusu", "Nearby": "Karibu", "Verified owner": "Mmiliki aliyethibitishwa",
    "Direct owner listing": "Tangazo la mmiliki", "Caretaker listing": "Tangazo la msimamizi",
    "Book a free viewing": "Panga kutazama bure", "Book a viewing": "Panga kutazama", "Report": "Ripoti", "+ Follow": "+ Fuata",
    "Never pay before viewing.": "Usilipe kabla ya kuona nyumba.", "PataHome never asks for money.": "PataHome haiombi pesa kamwe.",
    "Report a scam": "Ripoti utapeli", "✓ No agent fees": "✓ Hakuna ada ya wakala", "✓ No viewing fees": "✓ Hakuna ada ya kutazama",
    "Listed by owner": "Imetangazwa na mmiliki", "Agent": "Wakala", "Caretaker / manager": "Msimamizi",
    "Home details": "Maelezo ya nyumba", "Deposit": "Amana", "Water": "Maji", "Electricity": "Umeme", "Floor": "Ghorofa",
    "Service charge": "Ada ya huduma", "Video tour": "Video ya nyumba", "Full screen": "Skrini nzima",
    "Matatu stage": "Stage ya matatu", "Supermarket": "Supamaketi", "Hospital / clinic": "Hospitali / kliniki", "School": "Shule",
    "Show more homes": "Onyesha nyumba zaidi",
    // popups & forms
    "Request viewing": "Omba kutazama", "Cancel": "Ghairi", "Send report": "Tuma ripoti", "Report this listing": "Ripoti tangazo hili",
    "Send Message": "Tuma ujumbe", "Or send a message": "Au tuma ujumbe", "Call": "Piga simu",
    "Get new matches first": "Pata nyumba mpya kwanza", "Create alert": "Unda arifa", "Day": "Siku", "Time": "Saa",
    "Your name": "Jina lako", "Phone": "Simu", "Email": "Barua pepe", "Send": "Tuma", "Today": "Leo", "Tomorrow": "Kesho",
    // install banner
    "Get the PataHome app": "Pata programu ya PataHome", "Faster on your phone — free, no Play Store needed.": "Haraka kwenye simu yako — bure, bila Play Store.",
    "Install": "Sakinisha",
    // messages / viewing pages
    // land
    "Land": "Ardhi", "Buy or lease": "Nunua au kodisha", "Land for sale": "Ardhi inauzwa", "Land for lease": "Ardhi ya kukodisha",
    "Land for sale & lease": "Ardhi ya kuuza na kukodisha", "Sale or lease": "Kuuza au kukodisha", "For sale": "Inauzwa", "For lease": "Ya kukodisha",
    "Any size": "Ukubwa wowote", "Any use": "Matumizi yoyote", "Title deed ready": "Hati miliki iko tayari",
    "Agricultural": "Kilimo", "Residential": "Makazi", "Commercial": "Biashara", "Mixed use": "Matumizi mchanganyiko",
    "Largest first": "Kubwa zaidi kwanza", "Price per acre: low → high": "Bei kwa ekari: chini → juu",
    "Book a free site visit": "Panga kutembelea shamba bure", "Documents checked": "Hati zimekaguliwa",
    "Land details": "Maelezo ya ardhi", "Title": "Hati", "Land use": "Matumizi ya ardhi", "Road": "Barabara", "Terrain": "Hali ya ardhi",
    "Fenced": "Imezungushiwa ua", "Beacons in place": "Mawe ya mipaka yapo", "Surveyed": "Imepimwa", "Can be subdivided": "Inaweza kugawanywa",
    "Before paying anything:": "Kabla ya kulipa chochote:",
    "Commercial": "Biashara", "Shops & offices": "Maduka na ofisi", "Commercial property": "Majengo ya biashara",
    "Sale or to let": "Kuuza au kupangisha", "To let": "Ya kupangisha", "Any type": "Aina yoyote", "Any floor area": "Ukubwa wowote",
    "Price per sq ft: low → high": "Bei kwa futi mraba: chini → juu", "Frontage": "Upande wa barabara", "Fit-out": "Umaliziaji",
    "Occupancy": "Wapangaji", "Floors": "Ghorofa", "Parking slots": "Nafasi za maegesho",
    "Before paying a deposit:": "Kabla ya kulipa amana:",
    "My messages & viewings ": "Jumbe na ziara zangu", "Viewings": "Ziara", "Conversations": "Mazungumzo", "View listing →": "Tazama tangazo →"
  };
  var HEADS_SW = [
    { pre: "Pata ", w: "nyumba", post: " <br>moja kwa moja kwa mmiliki." },
    { pre: "Pata ", w: "bedsita", post: " <br>moja kwa moja kwa mmiliki." },
    { pre: "Pata ", w: "chumba kimoja", post: " <br>moja kwa moja kwa mmiliki." },
    { pre: "", w: "Pata keja leo", post: " <br>ukiwa nyumbani." },
    { pre: "Pata ", w: "nyumba ya familia", post: " <br>moja kwa moja kwa mmiliki." }
  ];
  var SUBS_SW = [
    "Nyumba za kupanga na kuuza kote Kenya, zikipangwa kwa ukaribu nawe. Hakuna ada ya kutazama. Karibu nyumbani.",
    "Wamiliki wamethibitishwa na kila tangazo ni la moja kwa moja. Ongea kwa WhatsApp, panga kutazama, hamia.",
    "Kuanzia bedsita za chuo hadi nyumba za familia — ona zilizo karibu nawe kwanza, kwenye ramani au orodha."
  ];
  var HINTS_SW = ["bedsita Kasarani…", "chumba 1 karibu na chuo…", "vyumba 2 Ruiru…", "nyumba ya vyumba 3…", "nyumba ya familia Nakuru…"];

  var lang = "en";
  try { lang = localStorage.getItem("ph_lang") === "sw" ? "sw" : "en"; } catch (e) {}

  function swapText(node) {
    var raw = node.nodeValue, t = raw.trim();
    if (!t || !SW[t]) return;
    node.nodeValue = raw.replace(t, SW[t]);
  }
  function apply(root) {
    if (lang !== "sw" || !root) return;
    var w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode: function (n) { var p = n.parentNode && n.parentNode.nodeName; return p === "SCRIPT" || p === "STYLE" ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT; }
    });
    var n; while ((n = w.nextNode())) swapText(n);
    var els = root.querySelectorAll ? root.querySelectorAll("[placeholder],[aria-label],[title]") : [];
    for (var i = 0; i < els.length; i++) {
      ["placeholder", "aria-label", "title"].forEach(function (a) { var v = els[i].getAttribute(a); if (v && SW[v.trim()]) els[i].setAttribute(a, SW[v.trim()]); });
    }
  }
  function swapArray(name, repl) {
    try { var arr = window.eval(name); if (Array.isArray(arr)) { arr.splice.apply(arr, [0, arr.length].concat(repl)); } } catch (e) {}
  }
  window.PH_I18N = { lang: lang, apply: apply, t: function (s) { return lang === "sw" && SW[s] ? SW[s] : s; } };

  function toggleButton() {
    var host = document.querySelector("header .header-actions") || document.querySelector("header");
    if (!host || document.getElementById("langBtn")) return;
    var b = document.createElement("button");
    b.id = "langBtn"; b.type = "button"; b.className = "lang-btn";
    b.setAttribute("aria-label", lang === "sw" ? "Switch to English" : "Badilisha kuwa Kiswahili");
    b.innerHTML = '<span class="' + (lang === "en" ? "on" : "") + '">EN</span><span class="' + (lang === "sw" ? "on" : "") + '">SW</span>';
    b.onclick = function () { try { localStorage.setItem("ph_lang", lang === "sw" ? "en" : "sw"); } catch (e) {} location.reload(); };
    var css = document.createElement("style");
    css.textContent = ".lang-btn{display:inline-flex;align-items:center;gap:2px;padding:3px;border-radius:99px;border:1.5px solid var(--line,#e1e8e4);background:#fff;cursor:pointer;font:700 .7rem Inter,system-ui,sans-serif;flex-shrink:0}" +
      ".lang-btn span{padding:4px 7px;border-radius:99px;color:#5f6b66}.lang-btn span.on{background:#073d2e;color:#fff}";
    document.head.appendChild(css);
    host.insertBefore(b, host.firstChild);
  }

  function start() {
    toggleButton();
    if (lang !== "sw") return;
    document.documentElement.lang = "sw";
    swapArray("HEADS", HEADS_SW); swapArray("HERO_SUBS", SUBS_SW); swapArray("HINTS", HINTS_SW);
    apply(document.body);
    new MutationObserver(function (muts) {
      muts.forEach(function (m) {
        m.addedNodes.forEach(function (n) { if (n.nodeType === 1) apply(n); else if (n.nodeType === 3) swapText(n); });
        if (m.type === "characterData") swapText(m.target);
      });
    }).observe(document.body, { childList: true, subtree: true, characterData: true });
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();
