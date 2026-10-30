/* Header menu: the "menu + account" pill button and the floating menu card.
   Shared by the homepage and /browse. The pages call phMenuAccount(me) once
   they know who is signed in, so the pill shows that person's initials. */
(function () {
  var btn = document.getElementById("hamBtn"), pop = document.getElementById("navPop");
  if (!btn || !pop) return;
  var dim = document.createElement("div");
  dim.className = "nav-dim";
  document.body.appendChild(dim);

  function setOpen(open) {
    pop.classList.toggle("show", open);
    dim.classList.toggle("show", open);
    btn.setAttribute("aria-expanded", open ? "true" : "false");
    btn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    if (open) { var first = pop.querySelector("a,button"); if (first) first.focus({ preventScroll: true }); }
  }
  window.toggleNav = function (e) { if (e) e.stopPropagation(); setOpen(!pop.classList.contains("show")); };
  window.phCloseNav = function () { if (pop.classList.contains("show")) { setOpen(false); btn.focus({ preventScroll: true }); } };

  btn.addEventListener("click", window.toggleNav);
  dim.addEventListener("click", window.phCloseNav);
  document.addEventListener("click", function (e) { if (!e.target.closest("#navPop,#hamBtn")) setOpen(false); });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape") window.phCloseNav(); });

  var signedIn = false;
  try { signedIn = !!localStorage.getItem("pb_token"); } catch (e) {}
  if (!signedIn) { var a = document.getElementById("npAcct"); if (a) a.textContent = "Sign in"; }

  window.phMenuAccount = function (me) {
    var av = btn.querySelector(".mp-av");
    if (!av || !me) return;
    if (me.avatarUrl) { av.textContent = ""; var img = document.createElement("img"); img.src = me.avatarUrl; img.alt = ""; av.appendChild(img); }
    else av.textContent = (me.name || "U").trim().split(/\s+/).map(function (w) { return w[0]; }).slice(0, 2).join("").toUpperCase();
    av.classList.add("in");
    var a = document.getElementById("npAcct"); if (a) a.textContent = "My account";
  };
})();
