#!/usr/bin/env python3
"""Builds public/dark.css — the site's dark theme — from the light styles.

Every rule that sets a colour (background, text, border, fill…) in the pages'
<style> blocks and in refresh.css is re-emitted under `html.dark`, with light
surfaces turned into dark ones and dark text turned light (hue kept, so brand
greens/golds stay recognisable). Rules keep their original order and each
page's rules get the same extra specificity, so hover/active states still win
over their base rules exactly as in light mode.

Run after changing any page CSS:   python3 tools/build-dark-css.py
"""
import colorsys, os, re, sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "public")
PAGES = [  # (file, body class)
    
    ("messages.html", "page-messages"), ("viewing.html", "page-viewing"), ("privacy.html", "page-legal"),
    ("terms.html", "page-legal"), ("owner.html", "page-owner"), ("offline.html", "page-offline"),
]
COLOR_PROPS = re.compile(r"^(background(-color|-image)?|color|border(-top|-right|-bottom|-left)?(-color)?|outline(-color)?|fill|stroke|box-shadow|text-decoration-color|caret-color|accent-color|column-rule-color)$")

NAMED = {"white": "#ffffff", "black": "#000000", "#fff": "#ffffff", "#000": "#000000"}
COLOR_RX = re.compile(r"#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)|\bwhite\b|\bblack\b")

def parse_color(tok):
    t = NAMED.get(tok.lower(), tok)
    if t.startswith("#"):
        h = t[1:]
        if len(h) in (3, 4): h = "".join(c * 2 for c in h)
        r, g, b = int(h[0:2], 16), int(h[2:4], 16), int(h[4:6], 16)
        a = int(h[6:8], 16) / 255 if len(h) == 8 else 1.0
        return r, g, b, a
    m = re.match(r"rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)", t)
    if not m: return None
    a = m.group(4)
    a = 1.0 if a is None else (float(a[:-1]) / 100 if a.endswith("%") else float(a))
    return float(m.group(1)), float(m.group(2)), float(m.group(3)), a

def fmt(r, g, b, a):
    r, g, b = (max(0, min(255, round(x))) for x in (r, g, b))
    return f"#{r:02x}{g:02x}{b:02x}" if a >= 0.999 else f"rgba({r},{g},{b},{round(a, 3)})"

def hls(r, g, b): return colorsys.rgb_to_hls(r / 255, g / 255, b / 255)
def rgb(h, l, s): return tuple(x * 255 for x in colorsys.hls_to_rgb(h, l, s))

NEUTRAL_HUE = 158 / 360   # the site's green-tinted dark greys

def dark_surface(c):
    """light background → dark surface, keeping any tint"""
    r, g, b, a = c
    h, l, s = hls(r, g, b)
    if l < 0.72: return None                      # already mid/dark (brand buttons, photos…) — keep
    if s < 0.12: h, s = NEUTRAL_HUE, 0.26          # white/grey → green-grey like the rest of the theme
    else: s = min(s, 0.45)
    nl = 0.085 + (1 - l) * 0.45                    # white → 8.5%, #e9f6f1 → ~11%, #cfe → ~15%
    return fmt(*rgb(h, nl, s), a)

def light_text(c):
    """dark text → light text, keeping hue for brand-coloured text"""
    r, g, b, a = c
    h, l, s = hls(r, g, b)
    if l >= 0.6: return None
    if s < 0.15: return fmt(*rgb(NEUTRAL_HUE, 0.93 - l * 0.45, 0.14), a)   # ink/muted greys
    return fmt(*rgb(h, max(0.66, 0.9 - l * 0.4), min(s, 0.7)), a)           # brand colours

def light_line(c):
    r, g, b, a = c
    h, l, s = hls(r, g, b)
    if l < 0.72: return None
    if s < 0.12: h, s = NEUTRAL_HUE, 0.22
    return fmt(*rgb(h, 0.2 + (1 - l) * 0.25, min(s, 0.35)), a)

def map_colors(value, fn):
    changed = False
    def sub(m):
        nonlocal changed
        c = parse_color(m.group(0))
        if not c: return m.group(0)
        out = fn(c)
        if out is None: return m.group(0)
        changed = True
        return out
    return COLOR_RX.sub(sub, value), changed

def transform_decl(prop, value):
    p = prop.lower()
    if p.startswith("--"): return None
    if not COLOR_PROPS.match(p): return None
    if p.startswith("background"):
        if "url(" in value and not re.search(r"gradient", value): return value, False
        return map_colors(value, dark_surface)
    if p in ("color", "fill", "stroke", "caret-color", "text-decoration-color", "accent-color"):
        if p in ("fill", "stroke") and value.strip() in ("none", "currentColor"): return value, False
        return map_colors(value, light_text)
    if p.startswith("border") or p.startswith("outline") or p == "column-rule-color":
        return map_colors(value, light_line)
    if p == "box-shadow":
        # soft light halos → darker; keep drop shadows as they are
        return map_colors(value, lambda c: None if c[3] < 0.35 or hls(*c[:3])[1] < 0.72 else fmt(*rgb(NEUTRAL_HUE, 0.12, 0.2), c[3]))
    return value, False

# ---------------------------------------------------------------- tiny CSS parser
def strip_comments(css): return re.sub(r"/\*.*?\*/", "", css, flags=re.S)

def parse_blocks(css):
    """yield ('rule', selector, body) | ('at', prelude, inner_css) in order"""
    i, n = 0, len(css)
    while i < n:
        j = css.find("{", i)
        if j < 0: break
        prelude = css[i:j].strip()
        depth, k = 1, j + 1
        while k < n and depth:
            if css[k] == "{": depth += 1
            elif css[k] == "}": depth -= 1
            k += 1
        body = css[j + 1:k - 1]
        # a stray ';' statement before the prelude (e.g. @import …;) — drop it
        if ";" in prelude and not prelude.startswith("@"): prelude = prelude.split(";")[-1].strip()
        if prelude.startswith("@"): yield ("at", prelude, body)
        else: yield ("rule", prelude, body)
        i = k

def split_decls(body):
    out, buf, depth = [], "", 0
    for ch in body:
        if ch == "(": depth += 1
        elif ch == ")": depth -= 1
        if ch == ";" and depth == 0: out.append(buf); buf = ""
        else: buf += ch
    if buf.strip(): out.append(buf)
    res = []
    for d in out:
        if ":" not in d: continue
        p, v = d.split(":", 1)
        res.append((p.strip(), v.strip()))
    return res

def split_selectors(sel):
    out, buf, depth = [], "", 0
    for ch in sel:
        if ch in "([": depth += 1
        elif ch in ")]": depth -= 1
        if ch == "," and depth == 0: out.append(buf.strip()); buf = ""
        else: buf += ch
    if buf.strip(): out.append(buf.strip())
    return out

PAGE_RX = re.compile(r"^\.page-[\w-]+")
def prefix_selector(sel, body_prefix):
    """html.dark + a body prefix with fixed specificity, merged with body-level classes in the selector"""
    s = sel.strip()
    if s.startswith(":root") or s.startswith("@"): return None
    if s.startswith("html"):
        rest = s[4:]
        if rest.startswith(" body") or rest.startswith(">body"): s = rest.lstrip(" >");
        else: return "html.dark" + rest
    rest = None
    m = re.match(r"^body((?:[.:#\[][^\s>+~]*)*)(.*)$", s)
    if m:
        quals, rest = m.group(1), m.group(2)
        quals = quals.replace(".dark", "")
    else:
        quals, rest = "", " " + s
    # a leading .page-x right after body belongs to body
    r2 = rest.lstrip()
    pm = PAGE_RX.match(r2) if rest.startswith(" ") else None
    if pm and not quals:
        quals += pm.group(0); rest = r2[len(pm.group(0)):]
    elif rest and not rest.startswith((" ", ">", "+", "~")) and not m:
        rest = " " + rest
    return f"{body_prefix}{quals}{rest}"

KEEP_TEXT = []  # selectors that sit on a kept (mid/saturated) background — their text stays as designed
def convert(css, body_prefix):
    out = []
    for kind, prelude, body in parse_blocks(strip_comments(css)):
        if kind == "at":
            name = prelude.split()[0].lower()
            if name in ("@media", "@supports", "@container", "@layer"):
                inner = convert(body, body_prefix)
                if inner.strip(): out.append(f"{prelude}{{\n{inner}}}\n")
            continue  # keyframes, font-face, page…
        decls = []
        already_dark = "dark" in prelude
        sel_list = split_selectors(prelude)
        # does this rule paint a background we keep (brand green, gold…)? then keep its text colour too
        kept_bg = False
        for p, v in split_decls(body):
            if p.lower() in ("background", "background-color"):
                cols = [parse_color(m) for m in COLOR_RX.findall(v)]
                cols = [c for c in cols if c and c[3] > 0.5]
                if cols and all(hls(*c[:3])[1] < 0.72 for c in cols) and not all(hls(*c[:3])[1] < 0.2 for c in cols):
                    kept_bg = True
        if kept_bg: KEEP_TEXT.extend(sel_list)
        on_kept = kept_bg or any(any(x.startswith(k + " ") for k in KEEP_TEXT) for x in sel_list)
        for p, v in split_decls(body):
            if p.startswith("--"): continue
            if not COLOR_PROPS.match(p.lower()): continue
            imp = "!important" in v
            val = v.replace("!important", "").strip()
            if already_dark: nv = val
            elif on_kept and p.lower() in ("color", "fill", "stroke"): nv = val
            else:
                t = transform_decl(p, val)
                if t is None: continue
                nv = t[0]
            decls.append(f"{p}:{nv}{'!important' if imp else ''}")
        if not decls: continue
        sels = [x for x in (prefix_selector(s, body_prefix) for s in split_selectors(prelude)) if x]
        if not sels: continue
        out.append(f"{','.join(sels)}{{{';'.join(decls)}}}\n")
    return "".join(out)

def page_css(path):
    html = open(path, encoding="utf-8").read()
    return "\n".join(re.findall(r"<style[^>]*>(.*?)</style>", html, flags=re.S))

def main():
    parts = ["/* AUTO-GENERATED by tools/build-dark-css.py — do not edit by hand; edit dark-extra rules at the bottom of the script */\n"]
    for f, cls in PAGES:
        p = os.path.join(ROOT, f)
        if not os.path.exists(p): continue
        css = page_css(p)
        if css.strip(): parts.append(f"/* ---- {f} ---- */\n" + convert(css, f"html.dark body.{cls}"))
    parts.append("/* ---- refresh.css ---- */\n" + convert(open(os.path.join(ROOT, "refresh.css"), encoding="utf-8").read(), "html.dark body.dark"))
    parts.append(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "dark-extra.css"), encoding="utf-8").read())
    open(os.path.join(ROOT, "dark.css"), "w", encoding="utf-8").write("".join(parts))
    print("dark.css:", sum(len(x) for x in parts), "bytes")

if __name__ == "__main__":
    main()
