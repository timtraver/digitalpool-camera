// Local overlay renderer: draws a DigitalPool Overlay Builder canvas straight to
// a Skia surface, with no browser involved.
//
// It is a deliberate reimplementation of digitalpool-antd's
// src/screens/overlay-builder/renderers/{OverlayCanvasRenderer,ElementRenderer}.js,
// which lay the overlay out as absolutely-positioned flex boxes in the DOM. Every
// rule those two files express in CSS is reproduced here in canvas operations —
// the CSS each block mirrors is named in its comment, because the only thing
// keeping the two renderers in agreement is that correspondence.
// tools/overlay-conformance measures the drift.
//
// Supported element types are listed in SUPPORTED; callers use unsupportedTypes()
// to decide whether a given overlay can be drawn locally at all.
const fs = require("fs");
const path = require("path");

let _skia = null;
function skia() {
  if (!_skia) _skia = require("@napi-rs/canvas");
  return _skia;
}

// ── Fonts ────────────────────────────────────────────────────────────────────
// `fontFamily: 'inherit'` in a saved overlay means "the web app's body font",
// which is digitalpool-antd/src/index.css:86 — UniformCondensed first, then the
// platform UI stack. The device has none of those system faces, so the bundled
// UniformCondensed is what it resolves to in practice.
const INHERIT_FAMILY = "UniformCondensed";

let _fontsRegistered = false;
function registerFonts(dir) {
  if (_fontsRegistered) return;
  const { GlobalFonts } = skia();
  if (!fs.existsSync(dir)) throw new Error(`overlayRenderer: font dir not found: ${dir}`);
  for (const f of fs.readdirSync(dir)) {
    if (!/\.(ttf|otf|woff2?|ttc)$/i.test(f)) continue;
    GlobalFonts.registerFromPath(path.join(dir, f));
  }
  _fontsRegistered = true;
}

// ── Element support ──────────────────────────────────────────────────────────
const SUPPORTED = new Set([
  "player_name", "player_score", "player_points", "player_skill_level", "player_race_to",
  "race_to", "match_status", "match_clock", "table_label",
  "tournament_name", "tournament_location", "tournament_game_type",
  "static_text", "static_image", "shape",
  "player_avatar", "tournament_logo", "tournament_game_type_image",
  "player_flag", "image_carousel",
]);

function unsupportedTypes(canvas) {
  const out = new Set();
  for (const el of (canvas && canvas.elements) || []) {
    if (el.visible === false) continue;
    if (!SUPPORTED.has(el.type)) out.add(el.type);
  }
  return [...out];
}

// ── Data binding ─────────────────────────────────────────────────────────────
// Mirrors ElementRenderer's switch. Returns the string an element renders, or
// null when the element is not textual.
function textFor(element, binding) {
  const player = element.player === 2 ? "challenger2" : "challenger1";
  const m = (binding && binding.match) || {};
  const t = (binding && binding.tournament) || {};
  const tbl = (binding && binding.table) || {};
  switch (element.type) {
    case "player_name":        return m[`${player}_name`] || "";
    case "player_score":       return m[`${player}_score`] != null ? String(m[`${player}_score`]) : "0";
    case "player_points": {
      const pts = m[`${player}_points`];
      return pts != null && pts !== "" ? String(pts) : "";
    }
    case "player_skill_level": {
      const sl = m[`${player}_skill_level`];
      return sl != null ? String(sl) : "";
    }
    case "player_race_to":     return m[`${player}_race_to`] ? `Race to ${m[`${player}_race_to`]}` : "";
    case "race_to": {
      const r = m.race_to || t.winners_race_to;
      return r ? `Race to ${r}` : "";
    }
    case "match_status":       return m.identifier || "";
    case "match_clock":        return matchClockText(m.start_time, m.end_time);
    case "table_label":        return tbl.label || "";
    case "tournament_name":    return t.name || "";
    case "tournament_location":return t.location || "";
    case "tournament_game_type": return t.game_type || "";
    case "static_text":        return element.text || "";
    default:                   return null;
  }
}

// ElementRenderer's MatchClock: elapsed time as H:MMm, frozen at end_time.
function matchClockText(startTime, endTime, now = Date.now()) {
  if (!startTime) return "0:00m";
  const end = endTime ? new Date(endTime).getTime() : now;
  const minutesTotal = Math.max(0, Math.floor((end - new Date(startTime).getTime()) / 60000));
  return `${Math.floor(minutesTotal / 60)}:${String(minutesTotal % 60).padStart(2, "0")}m`;
}

// ── Flags ────────────────────────────────────────────────────────────────────
// Port of digitalpool-antd src/utils/getCountryShortCode.js: a binding carries a
// country NAME ("United States"), sometimes an ISO-3 code, and the flag CDN wants
// ISO-2.
let _codes = null;
function countryShortCode(name) {
  if (!name) return null;
  if (!_codes) _codes = require("./overlayCountryCodes.js");
  const needle = String(name).toLowerCase().trim();
  for (const [key, value] of Object.entries(_codes.isoCountries)) {
    if (key === needle || value.toLowerCase() === needle) return value.toLowerCase();
  }
  for (const [key, value] of Object.entries(_codes.isoCountries3)) {
    if (key === needle || value.toLowerCase() === needle) {
      const iso2 = _codes.isoCountries[key];
      if (iso2) return iso2.toLowerCase();
    }
  }
  return null;
}

// CircleFlag.js hard-codes six flags that the CDN does not serve correctly (or at
// all) and ships them as local assets; everything else comes from the same CDN
// the web app uses. `assetDir` holds our copies of those six.
const FLAG_CDN = "https://hatscripts.github.io/circle-flags/flags/";
const FLAG_SPECIAL = {
  tw: "tw-ioc.svg", taiwan: "tw-ioc.svg", tpe: "tw-ioc.svg", "chinese taipei": "tw-ioc.svg",
  scotland: "scotland.svg", scb: "scotland.svg",
  macao: "macao.png", mac: "macao.png",
  "hong kong": "hkg.png", hkg: "hkg.png",
  "individual neutral athletes": "ain.png", ain: "ain.png",
};

function flagSourceFor(country, assets) {
  if (!country) return null;
  const key = String(country).toLowerCase().trim();
  if (FLAG_SPECIAL[key]) {
    const dir = (assets && assets.flagDir) || path.join(__dirname, "assets", "flags");
    return path.join(dir, FLAG_SPECIAL[key]);
  }
  if (key === "great britain" || key === "gb") return `${FLAG_CDN}gb.svg`;
  // The CDN falls back to "xx" (a blank globe) for anything it does not know,
  // which is what react-circle-flags does too.
  return `${FLAG_CDN}${countryShortCode(country) || "xx"}.svg`;
}

// ── Game-type images ─────────────────────────────────────────────────────────
// Port of digitalpool-antd src/utils/getGameType.js. The web app imports these
// as bundled assets; we keep our own copies beside the flags. No theme is passed
// through an overlay, so the light-theme default applies.
const GAME_TYPE_PATTERNS = [
  [/(eight_ball|eight ball|8ball|8 ball|8-ball|heyball)/, "eight-ball.png"],
  [/(nine_ball|nine ball|9ball|9 ball|9-ball)/, "nine-ball.png"],
  [/(one_pocket|one pocket)/, "one-pocket.png"],
  [/(ten_ball|ten ball|10ball|10 ball|10-ball)/, "ten-ball.png"],
  [/(snooker)/, "snooker-ball.png"],
];

function gameTypeImagePath(gameType, assets) {
  if (!gameType) return null;
  const dir = (assets && assets.gameTypeDir) || path.join(__dirname, "assets", "game-types");
  const lower = String(gameType).toLowerCase();
  for (const [pattern, file] of GAME_TYPE_PATTERNS) {
    if (lower.match(pattern)) return path.join(dir, file);
  }
  return path.join(dir, "default.png");
}

// Which binding field (if any) supplies an element's image.
function imageUrlFor(element, binding, assets) {
  const player = element.player === 2 ? "challenger2" : "challenger1";
  const m = (binding && binding.match) || {};
  const t = (binding && binding.tournament) || {};
  switch (element.type) {
    case "player_flag":     return flagSourceFor(m[`${player}_country`], assets);
    case "static_image":    return element.imageUrl || null;
    case "player_avatar":   return m[`${player}_avatarImg`] || null;
    case "tournament_logo": return t.logo || null;
    case "tournament_game_type_image":
      return gameTypeImagePath(t.game_type, assets);
    default: return null;
  }
}

// ── Image carousel ───────────────────────────────────────────────────────────
// Port of renderers/ImageCarousel.js. The web component advances on a setInterval
// started when it mounts; nothing here mounts, so the index is derived from the
// wall clock instead. That means the device's phase is its own — which is fine,
// because on a device this renderer IS the only one, and a deterministic clock
// makes the behaviour reproducible and testable.
const CAROUSEL_FADE_MS = 600; // transition: opacity 0.6s ease-in-out

function carouselImages(element) {
  return (element.images || []).filter(Boolean);
}

function carouselIntervalMs(element) {
  return Math.max(1, element.interval || 5) * 1000;
}

// CSS ease-in-out is cubic-bezier(0.42, 0, 0.58, 1); solved by bisection on x,
// which is plenty precise for an opacity ramp and avoids pulling in a solver.
function easeInOut(t) {
  if (t <= 0) return 0;
  if (t >= 1) return 1;
  const bez = (a, b, u) => 3 * a * (1 - u) * (1 - u) * u + 3 * b * (1 - u) * u * u + u * u * u;
  let lo = 0, hi = 1, u = t;
  for (let i = 0; i < 20; i++) {
    u = (lo + hi) / 2;
    if (bez(0.42, 0.58, u) < t) lo = u; else hi = u;
  }
  return bez(0, 1, u);
}

/**
 * Which image(s) a carousel shows at `now`, and how far through a crossfade it
 * is. Returns { index, prevIndex, progress } where progress 1 means settled.
 */
function carouselState(element, now) {
  const list = carouselImages(element);
  if (list.length <= 1) return { index: 0, prevIndex: 0, progress: 1 };
  const intervalMs = carouselIntervalMs(element);
  const slot = Math.floor(now / intervalMs);
  const index = ((slot % list.length) + list.length) % list.length;
  const prevIndex = ((index - 1) % list.length + list.length) % list.length;
  const sinceSwitch = now - slot * intervalMs;
  const fading = element.effect === "fade" && sinceSwitch < CAROUSEL_FADE_MS;
  return { index, prevIndex, progress: fading ? easeInOut(sinceSwitch / CAROUSEL_FADE_MS) : 1 };
}

/**
 * When this canvas next needs redrawing for animation reasons alone, as an
 * absolute timestamp, or null if nothing on it animates. The producer uses this
 * to wake exactly when a carousel changes instead of polling the clock.
 */
function nextAnimationAt(canvasDef, now) {
  let soonest = null;
  for (const el of (canvasDef && canvasDef.elements) || []) {
    if (el.visible === false || el.type !== "image_carousel") continue;
    if (carouselImages(el).length <= 1) continue;
    const intervalMs = carouselIntervalMs(el);
    const sinceSwitch = now % intervalMs;
    // Either the next slot boundary, or the next step of an in-flight fade.
    const next = el.effect === "fade" && sinceSwitch < CAROUSEL_FADE_MS
      ? now + Math.min(CAROUSEL_FADE_MS / 6, intervalMs - sinceSwitch)
      : now + (intervalMs - sinceSwitch);
    if (soonest === null || next < soonest) soonest = next;
  }
  return soonest;
}

// ── CSS value parsing ────────────────────────────────────────────────────────
function parseBorder(border) {
  // "none" | "<width>px <style> <color>"
  if (!border || border === "none") return null;
  const m = String(border).match(/^\s*([\d.]+)px\s+(\w+)\s+(.+?)\s*$/);
  if (!m) return null;
  const width = parseFloat(m[1]);
  if (!width || m[2] === "none") return null;
  return { width, color: m[3] };
}

// CSS text-shadow / box-shadow: "<x> <y> <blur> [<spread>] <color>", possibly
// several comma-separated. Canvas applies one shadow per draw, so each entry is
// a separate pass.
function parseShadows(value) {
  if (!value || value === "none") return [];
  const parts = [];
  let depth = 0, cur = "";
  for (const ch of String(value)) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { parts.push(cur); cur = ""; continue; }
    cur += ch;
  }
  if (cur.trim()) parts.push(cur);
  const out = [];
  for (const part of parts) {
    const lengths = [];
    let color = null;
    // A zero length is written without a unit ("0 4px 16px ..."), so bare
    // numbers have to be accepted as lengths too — matching only /\d+px/ here
    // silently shifted every offset one place left.
    const tokens = part.trim().match(/rgba?\([^)]*\)|hsla?\([^)]*\)|#[0-9a-f]{3,8}|-?[\d.]+(?:px)?\b|[a-z]+/gi) || [];
    for (const tok of tokens) {
      if (/^-?[\d.]+(px)?$/i.test(tok)) lengths.push(parseFloat(tok));
      else if (color === null && tok.toLowerCase() !== "inset") color = tok;
    }
    if (lengths.length >= 2) {
      out.push({
        x: lengths[0], y: lengths[1], blur: lengths[2] || 0, spread: lengths[3] || 0,
        color: color || "#000",
      });
    }
  }
  return out;
}

// @napi-rs/canvas applies a shadow colour's alpha TWICE: a shadow asked for at
// rgba(0,0,0,0.5) lands at an effective 0.25, and the relationship is exactly
// quadratic (measured across 0.2-1.0). Chrome applies it once, so an overlay's
// shadows come out roughly half strength against the reference renderer unless
// the alpha is pre-compensated with its square root.
// Only the alpha channel is touched; everything else passes through untouched.
function compensateShadowAlpha(color) {
  if (!color) return color;
  const c = String(color).trim();
  const rgba = c.match(/^rgba?\(([^)]+)\)$/i);
  if (rgba) {
    const parts = rgba[1].split(",").map((x) => x.trim());
    if (parts.length === 4) {
      const a = parseFloat(parts[3]);
      if (Number.isFinite(a) && a > 0 && a < 1) return `rgba(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Math.sqrt(a)})`;
    }
    return c;
  }
  const hsla = c.match(/^hsla?\(([^)]+)\)$/i);
  if (hsla) {
    const parts = hsla[1].split(",").map((x) => x.trim());
    if (parts.length === 4) {
      const a = parseFloat(parts[3]);
      if (Number.isFinite(a) && a > 0 && a < 1) return `hsla(${parts[0]}, ${parts[1]}, ${parts[2]}, ${Math.sqrt(a)})`;
    }
    return c;
  }
  // #RRGGBBAA / #RGBA
  if (/^#([0-9a-f]{8}|[0-9a-f]{4})$/i.test(c)) {
    const long = c.length === 9;
    const hex = long ? c.slice(7, 9) : c[4] + c[4];
    const a = parseInt(hex, 16) / 255;
    if (a > 0 && a < 1) {
      const comp = Math.round(Math.sqrt(a) * 255).toString(16).padStart(2, "0");
      return (long ? c.slice(0, 7) : `#${c[1]}${c[1]}${c[2]}${c[2]}${c[3]}${c[3]}`) + comp;
    }
  }
  return c;
}

function applyTextTransform(text, transform) {
  switch (transform) {
    case "uppercase":  return text.toUpperCase();
    case "lowercase":  return text.toLowerCase();
    // CSS capitalize uppercases the first letter of every word, leaving the rest.
    case "capitalize": return text.replace(/(^|\s)(\S)/g, (_, pre, ch) => pre + ch.toUpperCase());
    default:           return text;
  }
}

function fontString(style) {
  const family = !style.fontFamily || style.fontFamily === "inherit"
    ? INHERIT_FAMILY
    : style.fontFamily;
  const weight = style.fontWeight || 400;
  const size = style.fontSize || 32;
  return `${weight} ${size}px "${family}"`;
}

// CSS linear-gradient(<angle>deg, …): 0deg points to the top and angles grow
// clockwise, whereas canvas gradients are two points in box coordinates. Project
// the angle onto the box and return the start/end points of the gradient line.
function gradientPoints(angleDeg, w, h) {
  const rad = ((angleDeg % 360) + 360) % 360 * (Math.PI / 180);
  const dx = Math.sin(rad);
  const dy = -Math.cos(rad);
  // Length of the gradient line for a box, per the CSS spec.
  const len = Math.abs(w * dx) + Math.abs(h * dy);
  const cx = w / 2, cy = h / 2;
  return [cx - (dx * len) / 2, cy - (dy * len) / 2, cx + (dx * len) / 2, cy + (dy * len) / 2];
}

function colorWithAlpha(color, alpha) {
  // Port of ElementRenderer.colorWithAlpha.
  if (color == null || alpha == null || alpha >= 1) return color;
  const a = Math.max(0, Math.min(1, alpha));
  const c = String(color).trim();
  if (c.startsWith("#")) {
    let hex = c.slice(1);
    if (hex.length === 3) hex = hex.split("").map((ch) => ch + ch).join("");
    if (hex.length !== 6) return color;
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16));
    if ([r, g, b].some(Number.isNaN)) return color;
    return `rgba(${r}, ${g}, ${b}, ${a})`;
  }
  const rgb = c.match(/^rgba?\(\s*([0-9]+)\s*,\s*([0-9]+)\s*,\s*([0-9]+)/i);
  if (rgb) return `rgba(${rgb[1]}, ${rgb[2]}, ${rgb[3]}, ${a})`;
  return color;
}

// ── Geometry helpers ─────────────────────────────────────────────────────────
// border-radius is a full CSS value, not a number: the builder writes per-corner
// shorthands like "0 0 140px 140px" and "50%" as well as plain pixel numbers.
// Returns four [rx, ry] pairs in TL, TR, BR, BL order, with the CSS overlap
// clamp applied so adjacent radii can never exceed an edge.
function parseRadii(value, w, h) {
  const corners = [[0, 0], [0, 0], [0, 0], [0, 0]];
  if (value == null || value === "" || value === 0) return corners;

  const one = (tok, axis) => {
    const t = String(tok).trim();
    if (t.endsWith("%")) return (parseFloat(t) / 100) * (axis === "x" ? w : h);
    return parseFloat(t) || 0;
  };

  if (typeof value === "number") {
    for (const c of corners) { c[0] = value; c[1] = value; }
  } else {
    // "A / B" splits horizontal and vertical radii; each side takes 1-4 values
    // expanded the CSS way (TL, TR, BR, BL).
    const [hPart, vPart] = String(value).split("/");
    const expand = (str) => {
      const t = str.trim().split(/\s+/).filter(Boolean);
      if (!t.length) return ["0", "0", "0", "0"];
      if (t.length === 1) return [t[0], t[0], t[0], t[0]];
      if (t.length === 2) return [t[0], t[1], t[0], t[1]];
      if (t.length === 3) return [t[0], t[1], t[2], t[1]];
      return t.slice(0, 4);
    };
    const hs = expand(hPart);
    const vs = vPart ? expand(vPart) : hs;
    for (let i = 0; i < 4; i++) {
      corners[i][0] = one(hs[i], "x");
      corners[i][1] = one(vs[i], "y");
    }
  }

  // CSS clamp: shrink all radii by one factor if any edge is over-subscribed.
  const [tl, tr, br, bl] = corners;
  const f = Math.min(
    w / (tl[0] + tr[0]) || Infinity,
    w / (bl[0] + br[0]) || Infinity,
    h / (tl[1] + bl[1]) || Infinity,
    h / (tr[1] + br[1]) || Infinity,
    1
  );
  if (f < 1) for (const c of corners) { c[0] *= f; c[1] *= f; }
  return corners;
}

// Rounded rectangle with independent, possibly elliptical, corners. `inset`
// shrinks each radius, which is what a border needs: its inner edge curves more
// tightly than the outer one.
function roundRectPath(ctx, x, y, w, h, radiusValue, inset = 0) {
  // No extra per-corner cap here: parseRadii already applied the CSS overlap
  // clamp, which allows a single corner to reach the FULL width or height when
  // the corner it shares an edge with is 0 — e.g. "0 0 140px 140px" on a 1520x84
  // banner resolves to 84px bottom corners, not 42px.
  const r = parseRadii(radiusValue, w + inset * 2, h + inset * 2).map(([rx, ry]) => [
    Math.max(0, rx - inset),
    Math.max(0, ry - inset),
  ]);
  const [tl, tr, br, bl] = r;
  ctx.beginPath();
  if (r.every(([rx, ry]) => rx <= 0 && ry <= 0)) { ctx.rect(x, y, w, h); return; }
  ctx.moveTo(x + tl[0], y);
  ctx.lineTo(x + w - tr[0], y);
  if (tr[0] || tr[1]) ctx.ellipse(x + w - tr[0], y + tr[1], tr[0], tr[1], 0, -Math.PI / 2, 0);
  ctx.lineTo(x + w, y + h - br[1]);
  if (br[0] || br[1]) ctx.ellipse(x + w - br[0], y + h - br[1], br[0], br[1], 0, 0, Math.PI / 2);
  ctx.lineTo(x + bl[0], y + h);
  if (bl[0] || bl[1]) ctx.ellipse(x + bl[0], y + h - bl[1], bl[0], bl[1], 0, Math.PI / 2, Math.PI);
  ctx.lineTo(x, y + tl[1]);
  if (tl[0] || tl[1]) ctx.ellipse(x + tl[0], y + tl[1], tl[0], tl[1], 0, Math.PI, Math.PI * 1.5);
  ctx.closePath();
}

function ellipsePath(ctx, x, y, w, h) {
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2);
  ctx.closePath();
}

// object-fit: where the image lands inside its box.
function objectFitRect(fit, boxW, boxH, imgW, imgH) {
  if (!imgW || !imgH) return { x: 0, y: 0, w: boxW, h: boxH };
  if (fit === "fill") return { x: 0, y: 0, w: boxW, h: boxH };
  const scale = fit === "cover"
    ? Math.max(boxW / imgW, boxH / imgH)
    : Math.min(boxW / imgW, boxH / imgH); // contain (the default here)
  const w = imgW * scale, h = imgH * scale;
  return { x: (boxW - w) / 2, y: (boxH - h) / 2, w, h };
}

// ── Text layout ──────────────────────────────────────────────────────────────
// CSS line-breaking as the DOM does it for these boxes: break on whitespace,
// never inside a word. A single word wider than the box overflows (the flex
// item's automatic minimum size), it does not get split.
function wrapLines(ctx, text, maxWidth) {
  const paragraphs = String(text).split("\n");
  const lines = [];
  for (const para of paragraphs) {
    const words = para.split(/\s+/).filter(Boolean);
    if (!words.length) { lines.push(""); continue; }
    let line = words[0];
    for (let i = 1; i < words.length; i++) {
      const candidate = `${line} ${words[i]}`;
      if (ctx.measureText(candidate).width <= maxWidth) line = candidate;
      else { lines.push(line); line = words[i]; }
    }
    lines.push(line);
  }
  return lines;
}

function drawText(ctx, text, box, style) {
  const content = applyTextTransform(text, style.textTransform);
  if (!content) return;

  ctx.font = fontString(style);
  if (style.letterSpacing) ctx.letterSpacing = `${style.letterSpacing}px`;
  else ctx.letterSpacing = "0px";

  const lineHeight = (style.lineHeight || 1.2) * (style.fontSize || 32);
  const lines = wrapLines(ctx, content, box.w);

  // align-items: center on the flex container — the whole text block is centred
  // vertically in the content box, overflowing symmetrically when it is taller.
  const blockHeight = lines.length * lineHeight;
  let y = box.y + (box.h - blockHeight) / 2;

  const shadows = parseShadows(style.textShadow);
  ctx.fillStyle = style.color || "#ffffff";
  ctx.textBaseline = "alphabetic";

  const metrics = ctx.measureText("Mg");
  const ascent = metrics.fontBoundingBoxAscent ?? (style.fontSize || 32) * 0.8;
  const descent = metrics.fontBoundingBoxDescent ?? (style.fontSize || 32) * 0.2;
  // CSS half-leading: the font's content area is centred in the line box.
  const baselineOffset = (lineHeight - (ascent + descent)) / 2 + ascent;

  for (const line of lines) {
    const lineWidth = ctx.measureText(line).width;
    let x = box.x;
    if (style.textAlign === "center") x = box.x + (box.w - lineWidth) / 2;
    else if (style.textAlign === "right") x = box.x + box.w - lineWidth;

    for (const sh of shadows) {
      ctx.save();
      ctx.shadowColor = compensateShadowAlpha(sh.color);
      ctx.shadowBlur = sh.blur;
      ctx.shadowOffsetX = sh.x;
      ctx.shadowOffsetY = sh.y;
      ctx.fillText(line, x, y + baselineOffset);
      ctx.restore();
    }
    ctx.fillText(line, x, y + baselineOffset);
    y += lineHeight;
  }
  ctx.letterSpacing = "0px";
}

// Draws an element's box-shadow. `trace` paints the element's silhouette into
// whatever context it is given, in element-local coordinates.
//
// Done on a scratch surface because CSS clips the shadow to OUTSIDE the box:
// filling the silhouette with the shadow enabled and then erasing the silhouette
// leaves exactly the outer glow, which matters whenever the element itself is
// translucent (a shadow left underneath would darken it).
function drawBoxShadows(ctx, shadows, trace, w, h) {
  const { createCanvas } = skia();
  for (const sh of shadows) {
    const pad = Math.ceil(sh.blur * 2 + Math.abs(sh.x) + Math.abs(sh.y) + Math.abs(sh.spread) + 4);
    const tmp = createCanvas(Math.ceil(w) + pad * 2, Math.ceil(h) + pad * 2);
    const t = tmp.getContext("2d");
    t.translate(pad, pad);
    t.shadowColor = compensateShadowAlpha(sh.color);
    // CSS blur-radius and canvas shadowBlur both denote 2x the Gaussian sigma,
    // so they map 1:1.
    t.shadowBlur = sh.blur;
    t.shadowOffsetX = sh.x;
    t.shadowOffsetY = sh.y;
    t.fillStyle = "#000";
    trace(t);
    t.fill();
    t.shadowColor = "transparent";
    t.globalCompositeOperation = "destination-out";
    trace(t);
    t.fill();
    ctx.drawImage(tmp, -pad, -pad);
  }
}

// ── Element drawing ──────────────────────────────────────────────────────────
function drawShape(ctx, element, w, h, style) {
  const fill = element.fill || { type: "solid", color: "#1890ff" };
  const fillAlpha = fill.opacity != null ? fill.opacity : 1;
  const isCircle = element.shapeType === "circle";
  const radius = style.borderRadius || 0;

  const trace = () => (isCircle ? ellipsePath(ctx, 0, 0, w, h) : roundRectPath(ctx, 0, 0, w, h, radius));

  if (fill.type === "gradient") {
    const [x0, y0, x1, y1] = gradientPoints(fill.angle != null ? fill.angle : 90, w, h);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const stop of fill.stops || []) {
      grad.addColorStop(Math.max(0, Math.min(1, (stop.position || 0) / 100)), colorWithAlpha(stop.color, fillAlpha));
    }
    ctx.fillStyle = grad;
  } else {
    ctx.fillStyle = colorWithAlpha(fill.color || "#1890ff", fillAlpha) || "#1890ff";
  }
  trace();
  ctx.fill();

  // A CSS border sits inside the border box, so stroke on the inset centre line.
  const stroke = element.stroke && element.stroke.width > 0
    ? { width: element.stroke.width, color: colorWithAlpha(element.stroke.color || "#000000", element.stroke.opacity != null ? element.stroke.opacity : 1) }
    : parseBorder(style.border);
  if (stroke) {
    const i = stroke.width / 2;
    if (isCircle) ellipsePath(ctx, i, i, w - stroke.width, h - stroke.width);
    else roundRectPath(ctx, i, i, w - stroke.width, h - stroke.width, radius, i);
    ctx.lineWidth = stroke.width;
    ctx.strokeStyle = stroke.color;
    ctx.stroke();
  }
}

function drawElement(ctx, element, binding, images, assets, now) {
  const style = element.style || {};
  const w = element.w, h = element.h;

  ctx.save();
  // OverlayCanvasRenderer wraps each element in an absolutely positioned div with
  // `transform: rotate(Ndeg)` (origin 50% 50%) and `opacity`.
  ctx.translate(element.x + w / 2, element.y + h / 2);
  if (element.rotation) ctx.rotate((element.rotation * Math.PI) / 180);
  ctx.translate(-w / 2, -h / 2);
  ctx.globalAlpha = element.opacity != null ? element.opacity : 1;

  // box-shadow is painted before the clip: overflow:hidden clips an element's
  // content, never its shadow.
  const boxShadows = parseShadows(style.boxShadow);
  if (boxShadows.length) {
    const isCircle = element.type === "shape" && element.shapeType === "circle";
    const radius = style.borderRadius;
    drawBoxShadows(
      ctx,
      boxShadows,
      (c) => (isCircle ? ellipsePath(c, 0, 0, w, h) : roundRectPath(c, 0, 0, w, h, radius)),
      w,
      h
    );
  }

  // overflow: hidden on the element box.
  ctx.save();
  roundRectPath(ctx, 0, 0, w, h, style.borderRadius);
  ctx.clip();

  if (element.type === "shape") {
    drawShape(ctx, element, w, h, style);
    ctx.restore();
    ctx.restore();
    return;
  }

  // backgroundColor + borderRadius, then the border, both on the full box.
  if (style.backgroundColor && style.backgroundColor !== "transparent") {
    ctx.fillStyle = style.backgroundColor;
    roundRectPath(ctx, 0, 0, w, h, style.borderRadius);
    ctx.fill();
  }
  const border = parseBorder(style.border);
  if (border) {
    const i = border.width / 2;
    roundRectPath(ctx, i, i, w - border.width, h - border.width, style.borderRadius, i);
    ctx.lineWidth = border.width;
    ctx.strokeStyle = border.color;
    ctx.stroke();
  }

  if (element.type === "image_carousel") {
    // ImageCarousel fills the element box (its container is width/height 100%
    // with overflow hidden) and keeps the element's border-radius.
    const list = carouselImages(element);
    if (!list.length) {
      // Same empty state the component renders, so a misconfigured element looks
      // the same on the device as it does in the builder.
      ctx.fillStyle = "rgba(0,0,0,0.4)";
      roundRectPath(ctx, 0, 0, w, h, style.borderRadius);
      ctx.fill();
      drawText(ctx, "Image Carousel (add images)", { x: 0, y: 0, w, h }, {
        ...style, color: "#ffffff", fontSize: 14, textAlign: "center", textTransform: "none", textShadow: "none",
      });
      ctx.restore();
      ctx.restore();
      return;
    }
    const fit = element.objectFit || "cover";
    const { index, prevIndex, progress } = carouselState(element, now);
    const paint = (url, alpha) => {
      const img = images && images.get(url);
      if (!img || alpha <= 0) return;
      const prev = ctx.globalAlpha;
      ctx.globalAlpha = prev * alpha;
      const r = objectFitRect(fit, w, h, img.width, img.height);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
      ctx.globalAlpha = prev;
    };
    // Mid-fade the outgoing image is still painted underneath the incoming one,
    // which is what the stacked absolutely-positioned <img>s do.
    if (progress < 1 && list.length > 1) paint(list[prevIndex], 1 - progress);
    paint(list[index], progress);
    ctx.restore();
    ctx.restore();
    return;
  }

  if (element.type === "player_flag") {
    // CircleFlag renders a span of min(w,h), border-radius 50%, 1px dark border,
    // holding an img of the SAME size — which therefore overflows the border-box
    // content area by 1px on each side and is clipped by the circle.
    const url = imageUrlFor(element, binding, assets);
    const img = url && images && images.get(url);
    if (img) {
      const size = Math.min(w, h);
      let sx = 0;
      if (style.textAlign === "center") sx = (w - size) / 2;
      else if (style.textAlign === "right") sx = w - size;
      const sy = (h - size) / 2;
      ctx.save();
      ellipsePath(ctx, sx + 1, sy + 1, size - 2, size - 2);
      ctx.clip();
      ctx.drawImage(img, sx, sy, size, size);
      ctx.restore();
      ellipsePath(ctx, sx + 0.5, sy + 0.5, size - 1, size - 1);
      ctx.lineWidth = 1;
      ctx.strokeStyle = "rgba(0,0,0,0.2)";
      ctx.stroke();
    }
    ctx.restore();
    ctx.restore();
    return;
  }

  const url = imageUrlFor(element, binding, assets);
  if (url !== null) {
    // Image elements render with `padding: 0` in ElementRenderer, so the picture
    // fills the border box.
    const img = images && images.get(url);
    if (img) {
      // ElementRenderer hardcodes the fit for two of these rather than reading
      // element.objectFit: an avatar is always cropped to fill its box, and a
      // tournament logo is always fitted whole. Only static_image and the game
      // type image honour the element's own setting.
      const fit =
        element.type === "player_avatar" ? "cover" :
        element.type === "tournament_logo" ? "contain" :
        element.objectFit || "contain";
      const r = objectFitRect(fit, w, h, img.width, img.height);
      ctx.drawImage(img, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
    ctx.restore();
    return;
  }

  const text = textFor(element, binding);
  if (text) {
    const pad = style.padding || 0;
    const bw = border ? border.width : 0;
    const inset = pad + bw;
    drawText(ctx, text, { x: inset, y: inset, w: Math.max(0, w - inset * 2), h: Math.max(0, h - inset * 2) }, style);
  }

  ctx.restore();
  ctx.restore();
}

// ── Public API ───────────────────────────────────────────────────────────────
/**
 * Decode an image for renderCanvas().
 *
 * Callers must go through this rather than their own copy of @napi-rs/canvas:
 * the binding is a native module, and an Image produced by a *different* copy is
 * rejected by drawImage with "Value is not one of these types". Note also that
 * `new Image(); img.src = buf` reports a width and height but draws nothing —
 * loadImage is the only form that works.
 */
function loadImage(source) {
  return skia().loadImage(source);
}

/**
 * Collect every image URL an overlay needs, so callers can prefetch and cache
 * them before drawing (drawing itself is synchronous).
 */
function imageUrls(canvasDef, binding, assets) {
  const urls = new Set();
  for (const el of (canvasDef && canvasDef.elements) || []) {
    if (el.visible === false) continue;
    if (el.type === "image_carousel") {
      for (const u of carouselImages(el)) urls.add(u);
      continue;
    }
    const u = imageUrlFor(el, binding, assets);
    if (u) urls.add(u);
  }
  return [...urls];
}

/**
 * Draw an overlay canvas. `images` is a Map of url → decoded Image for anything
 * imageUrls() reported. Returns the Skia canvas.
 */
function renderCanvas(canvasDef, binding, { images = new Map(), assets = null, now = Date.now() } = {}) {
  const { createCanvas } = skia();
  const width = (canvasDef && canvasDef.width) || 1920;
  const height = (canvasDef && canvasDef.height) || 1080;
  const surface = createCanvas(width, height);
  const ctx = surface.getContext("2d");

  const bg = (canvasDef && canvasDef.background) || { type: "transparent" };
  if (bg.type === "solid" && bg.color) {
    ctx.fillStyle = bg.color;
    ctx.fillRect(0, 0, width, height);
  } else if (bg.type === "gradient") {
    const [x0, y0, x1, y1] = gradientPoints(bg.angle != null ? bg.angle : 90, width, height);
    const grad = ctx.createLinearGradient(x0, y0, x1, y1);
    for (const s of bg.stops || []) grad.addColorStop(Math.max(0, Math.min(1, (s.position || 0) / 100)), s.color);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, width, height);
  }

  const elements = [...((canvasDef && canvasDef.elements) || [])]
    .filter((el) => el.visible !== false)
    .sort((a, b) => (a.zIndex || 0) - (b.zIndex || 0));
  for (const el of elements) {
    if (!SUPPORTED.has(el.type)) continue;
    drawElement(ctx, el, binding, images, assets, now);
  }
  return surface;
}

module.exports = {
  registerFonts,
  renderCanvas,
  loadImage,
  imageUrls,
  unsupportedTypes,
  nextAnimationAt,
  SUPPORTED,
  INHERIT_FAMILY,
  // exported for tests
  _internals: { imageUrlFor, carouselState, carouselImages, easeInOut, wrapLines, parseRadii, compensateShadowAlpha, countryShortCode, flagSourceFor, gameTypeImagePath, parseShadows, parseBorder, gradientPoints, matchClockText, applyTextTransform, objectFitRect },
};
