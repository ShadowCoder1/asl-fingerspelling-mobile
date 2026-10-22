/* picture-ghost.js: the letter's PICTURE laid over the learner's own hand on the camera view (the owner, 19 Oct 2026,
 * after trying the hand drawn from tracked points: "too many joints ... can u not just use this", pointing at the
 * picture). The same clean line drawing as beside the camera, as white lines, sitting on the learner's palm at their
 * hand's size.
 *
 * WHERE IT GOES. In a FIXED SPOT (SPOT: right of centre on screen, where a right hand is held in the camera check;
 * mirrored for a left hand), pointing the way the letter does (G and H sideways, P and Q down), for the learner to put
 * their hand into (the owner, 19 Oct: "do we even need it to follow the hand? can't we keep it in a spot and have them
 * fit it" -- following the hand, the drawing's proportions never quite matched it). Only its SIZE follows the learner:
 * W->M (the picture's wrist and middle knuckle, marked by hand in tutor/ghost-pictures.json; MediaPipe finds no hand in
 * a line drawing) as long as their wrist -> middle knuckle (3-D palm size x PALM_LENGTH), changing slowly, so it fits a
 * learner near the camera or far from it without shivering. { follow: true } puts it on the hand instead (its palm on
 * the palm, the size from the hand on screen within SIZE_RANGE of the 3-D palm), still never turning.
 *
 * WHAT IT SAYS (the coach's `look`, coach.js): white lines; green lines when the grader would accept the hand as it
 * is now; amber lines when the hand is turned wrong; and for the finger (or thumb) the grader's blame would change, a
 * GOLDEN FINGER that starts on the learner's own finger and slides to where it should be, pauses there, and starts
 * again (the owner, 19 Oct: "animate into the right spot so ik how to move my finger"). Where it should be comes from
 * the letter's real hand (tutor/ghost-hands.json, the one closest to how fluent signers make it): that hand's palm is
 * fitted onto the learner's palm (wrist, thumb base and the four knuckles; a 2-D similarity), and its finger, carried
 * along, is the goal. The learner's own finger also glows faintly, and the goal is dotted, so start and end are clear.
 *
 * The canvas is inside the mirrored stage (js/core/experiment.js), in the camera's unmirrored coordinates, so the
 * picture is put on it flipped: on screen it then reads exactly as it does beside the camera. */

import { palmSize } from "../../tutor/hand-frame.js";
import { pictureMirrored } from "../../tutor/letters.js";
import { FINGER_POINTS } from "./ghost.js";

export const PALM_LENGTH = 1.07;   // wrist -> middle knuckle in palm sizes (median of the 26 ghost hands, 3-D)
export const PALM_AT = 0.75;       // the middle of a palm, as a fraction of the way from the wrist to the middle knuckle
export const SIZE_RANGE = [0.75, 1.15];   // follow mode: the picture's size, as a fraction of the size the 3-D palm says
/* The fixed spot for the picture's palm, as a fraction of the picture ON SCREEN (x from the left, y from the top), for
 * a right hand; and how fast its size follows the learner's hand (per frame). */
export const SPOT = Object.freeze({ x: 0.66, y: 0.55 });
/* ...and on a phone held upright (mobile/, 22 Oct; as glove.js GLOVE_SPOT_PORTRAIT): nearer the middle, a little lower. */
export const SPOT_PORTRAIT = Object.freeze({ x: 0.62, y: 0.6 });
export const SIZE_EASE = 0.06;
const RASTER = 500;                // tutor/ghost-pictures.json was marked at this width

const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const palmCenter = (P) => [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + P[i][0] / 5, a[1] + P[i][1] / 5], [0, 0]);

/** The learner's hand on the canvas, in pixels: wrist, middle knuckle and 3-D palm size. */
export function anchorOf(landmarks, W, H) {
  if (!landmarks || landmarks.length !== 21) return null;
  const P = landmarks.map((p) => [p.x * W, p.y * H, (p.z ?? 0) * W]);
  const s = palmSize(P);
  if (!(Number.isFinite(s) && s > 0)) return null;
  return { w: [P[0][0], P[0][1]], m: [P[9][0], P[9][1]], s };
}

/** The picture's marked points, on the canvas's side. They were marked on the picture as it is shown beside the
 * camera; the canvas is shown mirrored, so the picture is ALWAYS laid on it as the mirror image of that (canvasFlipped
 * just says how to get there from the SVG file), and so are its points. (Flipping them only when the SVG was flipped
 * pinned every viewer-drawn letter's picture to the wrong place: the owner's L sat a hand's width off, 19 Oct.) */
export function picturePoints(points, letter, hand, width = RASTER) {
  const p = points[letter];
  if (!p) return null;
  // marked for a right-handed learner; for a left-handed one the picture beside the camera is itself mirrored
  const shown = hand === "left" ? (q) => [width - q[0], q[1]] : (q) => [q[0], q[1]];
  const f = (q) => { const r = shown(q); return [width - r[0], r[1]]; };
  return { W: f(p.W), M: f(p.M) };
}
/* How the SVG file goes on the canvas: the mirror image of how it is shown beside the camera (pictureMirrored). */
export const canvasFlipped = (letter, hand) => !pictureMirrored(letter, hand);

/**
 * Where the picture should be, for its W and M and the learner's hand: its palm point (PALM_AT of the way from W to
 * M) at (x, y), at its own angle (th = 0, always), scaled by k.
 */
export function pictureTarget({ W, M }, hand) {
  const len = Math.hypot(M[0] - W[0], M[1] - W[1]);
  const ux = hand.m[0] - hand.w[0], uy = hand.m[1] - hand.w[1], ulen = Math.hypot(ux, uy);
  const k3 = (hand.s * PALM_LENGTH) / len;
  const k = ulen > 0 ? Math.max(SIZE_RANGE[0] * k3, Math.min(SIZE_RANGE[1] * k3, ulen / len)) : k3;
  return { x: hand.w[0] + PALM_AT * ux, y: hand.w[1] + PALM_AT * uy, th: 0, k };
}

/** The fixed spot on the canvas (shown mirrored, so the screen's x is flipped), for a canvas W x H and a hand. */
export function spotOf(W, H, hand = "right") {
  const S = H > W ? SPOT_PORTRAIT : SPOT;
  const sx = hand === "left" ? 1 - S.x : S.x;
  return { x: (1 - sx) * W, y: S.y * H };
}

/** The canvas transform (a b c d e f, for setTransform) putting the picture's palm point at (x, y), turned and scaled. */
export function transformOf({ W, M }, { x, y, th, k }) {
  const cx = W[0] + PALM_AT * (M[0] - W[0]), cy = W[1] + PALM_AT * (M[1] - W[1]);
  const a = k * Math.cos(th), b = k * Math.sin(th);
  return { a, b, c: -b, d: a, e: x - (a * cx - b * cy), f: y - (b * cx + a * cy) };
}
export const applyTransform = (t, [x, y]) => [t.a * x + t.c * y + t.e, t.b * x + t.d * y + t.f];

/* A picture as white-on-clear line art, on the canvas's side, RASTER wide: alpha from how dark each pixel is. */
async function lineArt(url, flip) {
  const img = new Image();
  img.decoding = "async";
  img.src = url;
  await img.decode();
  const w = RASTER, h = Math.round((RASTER * img.naturalHeight) / img.naturalWidth);
  const c = document.createElement("canvas");
  c.width = w; c.height = h;
  const g = c.getContext("2d", { willReadFrequently: true });
  g.fillStyle = "#fff";
  g.fillRect(0, 0, w, h);
  if (flip) { g.translate(w, 0); g.scale(-1, 1); }
  g.drawImage(img, 0, 0, w, h);
  const d = g.getImageData(0, 0, w, h);
  for (let i = 0; i < d.data.length; i += 4) {
    const lum = (d.data[i] * 0.299 + d.data[i + 1] * 0.587 + d.data[i + 2] * 0.114) / 255;
    d.data[i] = d.data[i + 1] = d.data[i + 2] = 255;
    d.data[i + 3] = Math.round(255 * Math.max(0, Math.min(1, (1 - lum) * 1.25)));
  }
  g.setTransform(1, 0, 0, 1, 0, 0);
  g.putImageData(d, 0, 0);
  return c;
}

/* The picture SCHEMATIZED (Indranil, 19 Oct: "more of a schematized outline (no details like knuckles)", so that a
 * right hand's skeleton sits inside it): a bold line round the OUTSIDE of the hand only -- the drawing filled in, cut
 * at the wrist (no forearm), and its edge traced -- with the drawing's inside lines kept but faint (DETAIL_ALPHA), so a
 * thumb across the palm still shows without the knuckles and nails competing with the outline. Pure, on alpha arrays;
 * returns { outline, detail } (0-255 each). If the outline cannot be closed (the fill leaks out), the whole drawing
 * comes back as the outline. */
export const OUTLINE_PX = 7;        // the outline's width at RASTER
export const DETAIL_ALPHA = 0.32;
export function schematizeAlpha(alpha, w, h, { W, M }) {
  const n = w * h;
  const ux = W[0] - M[0], uy = W[1] - M[1], ul = Math.hypot(ux, uy) || 1;
  const along = (x, y) => ((x - W[0]) * ux + (y - W[1]) * uy) / ul;     // > 0: past the wrist
  const across = (x, y) => ((x - W[0]) * -uy + (y - W[1]) * ux) / ul;
  const cut = 0.06 * ul;
  const line = new Uint8Array(n);
  let vmin = Infinity, vmax = -Infinity;
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const a = along(x, y);
    if (alpha[i] > 110 && a <= cut) {
      line[i] = 1;
      if (a > cut - 0.08 * ul) { const v = across(x, y); vmin = Math.min(vmin, v); vmax = Math.max(vmax, v); }
    }
  }
  // close the hand across the wrist, between its outermost lines there
  for (let y = 0, i = 0; y < h; y++) for (let x = 0; x < w; x++, i++) {
    const a = along(x, y), v = across(x, y);
    if (a > cut - 2 && a <= cut + 1 && v >= vmin && v <= vmax) line[i] = 1;
  }
  // small gaps in the drawing closed (lines grown by 3 px), then everything reachable from the border is outside
  const thick = dilate(line, w, h, 3);
  const outside = new Uint8Array(n), stack = [];
  const push = (i) => { if (!thick[i] && !outside[i]) { outside[i] = 1; stack.push(i); } };
  for (let x = 0; x < w; x++) { push(x); push((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { push(y * w); push(y * w + w - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % w;
    if (x > 0) push(i - 1);
    if (x < w - 1) push(i + 1);
    if (i >= w) push(i - w);
    if (i < n - w) push(i + w);
  }
  let filled = 0;
  for (let i = 0; i < n; i++) if (!outside[i]) filled++;
  const outline = new Uint8ClampedArray(n), detail = new Uint8ClampedArray(n);
  if (filled < 0.04 * n) {               // the fill leaked: give the drawing back as it is (minus the forearm)
    for (let i = 0; i < n; i++) outline[i] = line[i] ? alpha[i] : 0;
    return { outline, detail };
  }
  // the outline: the filled hand's own edge, OUTLINE_PX wide, on its inside
  const near = dilate(outside, w, h, OUTLINE_PX);
  for (let i = 0; i < n; i++) {
    if (!outside[i] && near[i]) outline[i] = 255;
    else if (line[i]) detail[i] = Math.round(alpha[i] * DETAIL_ALPHA);
  }
  return { outline, detail };
}

/* A binary image grown by r pixels (a square: a sliding maximum along rows, then columns). */
export function dilate(src, w, h, r) {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let count = 0;
    for (let x = -r; x < w + r; x++) {
      if (x + r < w && x + r >= 0) count += src[y * w + x + r];
      if (x - r - 1 >= 0 && x - r - 1 < w) count -= src[y * w + x - r - 1];
      if (x >= 0 && x < w) tmp[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let count = 0;
    for (let y = -r; y < h + r; y++) {
      if (y + r < h && y + r >= 0) count += tmp[(y + r) * w + x];
      if (y - r - 1 >= 0 && y - r - 1 < h) count -= tmp[(y - r - 1) * w + x];
      if (y >= 0 && y < h) out[y * w + x] = count > 0 ? 1 : 0;
    }
  }
  return out;
}

function schematize(mask, pts) {
  const g = mask.getContext("2d", { willReadFrequently: true });
  const d = g.getImageData(0, 0, mask.width, mask.height);
  const a = new Uint8ClampedArray(mask.width * mask.height);
  for (let i = 0; i < a.length; i++) a[i] = d.data[4 * i + 3];
  const { outline, detail } = schematizeAlpha(a, mask.width, mask.height, pts);
  for (let i = 0; i < a.length; i++) d.data[4 * i + 3] = Math.max(outline[i], detail[i]);
  g.putImageData(d, 0, 0);
  return mask;
}

/* The line art in one colour with a soft dark edge BAKED IN (so white lines read on a white wall), made once per
 * letter and colour: drawing a blur on every frame cost frames, and the tracker and the hold-still ring with them. */
function baked(mask, color, edge) {
  const t = document.createElement("canvas");
  t.width = mask.width; t.height = mask.height;
  const tg = t.getContext("2d");
  tg.drawImage(mask, 0, 0);
  tg.globalCompositeOperation = "source-in";
  tg.fillStyle = color;
  tg.fillRect(0, 0, t.width, t.height);
  const pad = 8;
  const c = document.createElement("canvas");
  c.width = mask.width + 2 * pad; c.height = mask.height + 2 * pad;
  const g = c.getContext("2d");
  g.shadowColor = edge;
  g.shadowBlur = 6;
  g.drawImage(t, pad, pad);
  g.shadowBlur = 0;
  g.drawImage(t, pad, pad);
  c.pad = pad;
  return c;
}

/** One letter's line art as the page draws it (for tools/ghost-hands/outlines.html): baked, white, on the canvas's side. */
export async function letterArt(url, letter, points, hand = "right", style = "outline") {
  let mask = await lineArt(url, canvasFlipped(letter, hand));
  if (style === "outline") mask = schematize(mask, picturePoints(points, letter, hand));
  return baked(mask, "#ffffff", "rgba(15, 23, 42, 0.85)");
}

export const LINE = Object.freeze({ neutral: "#ffffff", match: "#22c55e", turn: "#f59e0b" });
const EDGE = Object.freeze({ neutral: "rgba(15, 23, 42, 0.85)", match: "rgba(20, 83, 45, 0.9)", turn: "rgba(15, 23, 42, 0.85)" });
export const LINE_ALPHA = 0.92;
const GOLD = { fill: "rgba(251, 191, 36, 0.9)", line: "rgba(146, 64, 14, 0.95)", glow: "rgba(245, 158, 11, 0.35)" };
const PALM_FIT = [0, 1, 5, 9, 13, 17];

/** The 2-D similarity (complex z, then + t) that best puts points S onto points D (least squares, no reflection). */
export function fitSimilarity(S, D) {
  const n = S.length;
  const sc = S.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  const dc = D.reduce((a, p) => [a[0] + p[0] / n, a[1] + p[1] / n], [0, 0]);
  let re = 0, im = 0, ss = 0;
  for (let i = 0; i < n; i++) {
    const sx = S[i][0] - sc[0], sy = S[i][1] - sc[1], dx = D[i][0] - dc[0], dy = D[i][1] - dc[1];
    re += sx * dx + sy * dy; im += sx * dy - sy * dx; ss += sx * sx + sy * sy;
  }
  const zr = re / ss, zi = im / ss;
  return (p) => [dc[0] + zr * (p[0] - sc[0]) - zi * (p[1] - sc[1]), dc[1] + zi * (p[0] - sc[0]) + zr * (p[1] - sc[1])];
}

/** Where each finger of the letter's real hand would be on the learner's hand: { finger: [[x, y] x 4] } on the canvas. */
export function goalFingers(template, P, hand = "right") {
  const m = hand === "left" ? -1 : 1;
  const T = template.map((p) => [m * p[0], p[1]]);
  const f = fitSimilarity(PALM_FIT.map((i) => T[i]), PALM_FIT.map((i) => P[i]));
  const out = {};
  for (const [name, ix] of Object.entries(FINGER_POINTS)) out[name] = ix.map((i) => f(T[i]));
  return out;
}

/* The golden finger's journey, as a fraction 0..1 of the way from the learner's finger to the goal, for a time:
 * rest on the finger, glide (eased), rest at the goal, fade, again. */
export const MOVE_MS = 1800;
export function journey(tMs) {
  const u = ((tMs % MOVE_MS) + MOVE_MS) % MOVE_MS / MOVE_MS;
  if (u < 0.15) return { f: 0, alpha: 0.9 };
  if (u < 0.6) { const v = (u - 0.15) / 0.45; return { f: v < 0.5 ? 2 * v * v : 1 - 2 * (1 - v) * (1 - v), alpha: 0.9 }; }
  if (u < 0.85) return { f: 1, alpha: 0.9 };
  return { f: 1, alpha: 0.9 * (1 - (u - 0.85) / 0.15) };
}

function fingerPath(ctx, pts) {
  ctx.beginPath();
  pts.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
}

/** The finger to change (the coach's `look`), drawn before the picture: a faint glow on the learner's own finger and
 * the goal dotted. Returns what drawGoldFinger needs (null: nothing to change, or no template to say where to).
 * Shared with the glove (glove.js). `s` is the learner's 3-D palm size on the canvas. */
export function fingerHints(ctx, { landmarks, W, H, letter, look, templates, hand, s, strength }) {
  const blocks = look?.state === "fix" ? look.blocks ?? [] : [];
  if (!landmarks || !blocks.length) return null;
  const fingers = blocks.flatMap((b) => (b === "spread" ? ["index", "middle", "ring", "pinky"] : FINGER_POINTS[b] ? [b] : []));
  const P = landmarks.map((p) => [p.x * W, p.y * H]);
  const goal = templates?.[letter] ? goalFingers(templates[letter].pts, P, hand) : null;
  const lw = 0.2 * s;
  ctx.save();
  ctx.globalAlpha = strength;
  ctx.lineCap = ctx.lineJoin = "round";
  for (const f of fingers) {
    const mine = FINGER_POINTS[f].map((i) => P[i]);
    fingerPath(ctx, mine);
    ctx.strokeStyle = GOLD.glow; ctx.lineWidth = 1.5 * lw; ctx.stroke();
    if (goal) {
      fingerPath(ctx, goal[f]);
      ctx.setLineDash([0.12 * s, 0.12 * s]);
      ctx.strokeStyle = GOLD.fill; ctx.lineWidth = 0.06 * s; ctx.stroke();
      ctx.setLineDash([]);
    }
  }
  ctx.restore();
  return goal ? { fingers, P, goal, lw } : null;
}

/** The golden finger gliding from the learner's finger to the goal (fingerHints' result), on top of the picture. */
export function drawGoldFinger(ctx, gold, tMs, s, strength) {
  const { f: k, alpha } = journey(tMs);
  ctx.save();
  ctx.lineCap = ctx.lineJoin = "round";
  ctx.globalAlpha = alpha * strength;
  for (const f of gold.fingers) {
    const from = FINGER_POINTS[f].map((i) => gold.P[i]);
    const now = from.map((q, j) => [q[0] + k * (gold.goal[f][j][0] - q[0]), q[1] + k * (gold.goal[f][j][1] - q[1])]);
    fingerPath(ctx, now);
    ctx.strokeStyle = GOLD.line; ctx.lineWidth = gold.lw + 0.07 * s; ctx.stroke();
    ctx.strokeStyle = GOLD.fill; ctx.lineWidth = gold.lw; ctx.stroke();
    // the fingertip, a little brighter, so the eye follows it
    const tip = now[now.length - 1];
    ctx.beginPath(); ctx.arc(tip[0], tip[1], 0.55 * gold.lw, 0, 2 * Math.PI);
    ctx.fillStyle = "rgba(254, 243, 199, 0.95)"; ctx.fill();
  }
  ctx.restore();
}

/**
 * One per session. `load(letters, pictureUrl)` prepares the pictures; `draw` is called every frame after the canvas
 * was cleared.
 * @param {{points: object, templates?: object, hand?: "right"|"left", smoothing?: number}} o
 *   templates: tutor/ghost-hands.json letters, for where the golden finger goes (none: the finger only glows)
 *   follow: put the picture on the hand instead of in its spot
 *   style: "outline" (the picture schematized: schematizeAlpha) or "picture" (the whole drawing)
 */
export function createPictureGhost({ points, templates = null, hand = "right", smoothing = 0.45, follow = false, style = "outline" }) {
  const art = {};     // letter -> { neutral, match, turn } canvases
  let cur = null;     // where the picture is now: { x, y, th, k }
  return {
    async load(letters, pictureUrl) {
      await Promise.all([...new Set(letters)].filter((L) => points[L] && pictureUrl(L)).map(async (L) => {
        let mask = await lineArt(pictureUrl(L), canvasFlipped(L, hand));
        if (style === "outline") mask = schematize(mask, picturePoints(points, L, hand));
        art[L] = { neutral: baked(mask, LINE.neutral, EDGE.neutral), match: baked(mask, LINE.match, EDGE.match), turn: baked(mask, LINE.turn, EDGE.turn) };
      }));
    },
    has: (L) => !!art[L],
    reset() { cur = null; },
    /* `strength` (0..1): how much of the guidance to show (the demo's ?fade=1 fades it as a letter is learned); the
     * outline and the golden finger are drawn that much fainter, and not at all at 0. */
    draw(ctx, canvas, landmarks, letter, look = null, tMs = 0, strength = 1) {
      if (!(strength > 0)) return;
      const pics = art[letter], pp = picturePoints(points, letter, hand);
      if (!pics || !pp) return;
      const W = canvas.width, H = canvas.height;
      const green = look?.state === "match" || look?.state === "accepted";
      const blocks = look?.state === "fix" ? look.blocks ?? [] : [];
      const turned = blocks.includes("orientation");
      const hand0 = anchorOf(landmarks, W, H);
      const len = Math.hypot(pp.M[0] - pp.W[0], pp.M[1] - pp.W[1]);
      if (follow) {
        if (hand0) {
          const want = pictureTarget(pp, hand0);
          cur = cur ? { x: cur.x + smoothing * (want.x - cur.x), y: cur.y + smoothing * (want.y - cur.y),
            k: cur.k + smoothing * (want.k - cur.k), th: 0 } : want;
        }
      } else {
        // in its spot; only the size eases toward the learner's hand
        const spot = spotOf(W, H, hand);
        const kWant = ((hand0?.s ?? (cur ? null : H * 0.2)) * PALM_LENGTH) / len;
        const k = cur ? (hand0 ? cur.k + SIZE_EASE * (kWant - cur.k) : cur.k) : kWant;
        cur = { x: spot.x, y: spot.y, th: 0, k };
      }
      const at = { s: hand0?.s ?? H * 0.2 };
      if (!cur) cur = pictureTarget(pp, { w: [W * 0.5, H * 0.75], m: [W * 0.5, H * 0.5], s: H * 0.2 });
      const pulse = 0.5 + 0.5 * Math.sin(tMs / 160);

      // the finger to change: a faint glow on the learner's own finger, the goal dotted, and the golden finger gliding
      // from one to the other (drawn after the picture, below, so it is on top)
      const gold = fingerHints(ctx, { landmarks, W, H, letter, look, templates, hand, s: at.s, strength });

      // the picture
      const t = transformOf(pp, cur);
      const img = green ? pics.match : turned ? pics.turn : pics.neutral;
      ctx.save();
      ctx.setTransform(t.a, t.b, t.c, t.d, t.e, t.f);
      ctx.globalAlpha = (turned && !green ? 0.6 + 0.4 * pulse : LINE_ALPHA) * strength;
      ctx.drawImage(img, -img.pad, -img.pad);
      ctx.restore();

      if (gold) drawGoldFinger(ctx, gold, tMs, at.s, strength);
    },
  };
}
