/* ghost.js: the ghost hand -- the letter's hand drawn as a translucent hand on the camera view, sitting on the
 * learner's own wrist and scaled to their hand, showing what their hand should look like TO THE CAMERA (the picture
 * beside it often shows the other side, e.g. G, H, P). Built for the demo (experiments/asl-demo.js, Indranil and JT,
 * 19 Oct 2026: "a translucent hand silhouette ... that shows what their hand should look like to the camera"); first
 * prototyped for study 2's ?feedback=ghost.
 *
 * The ghost is one REAL hand per letter (tutor/ghost-hands.json: of the public training hands the grader accepts as
 * that letter, the one closest to how six fluent signers make it; tools/ghost-hands), never an average. It sits on the
 * middle of the learner's palm at their hand's size and turns with a small tilt of their hand (MAX_TURN_DEG), but
 * otherwise keeps its own orientation, so a hand turned the wrong way shows up as not fitting.
 *
 * HOW IT IS DRAWN (renderGhost). Like the letter's picture: one clean outline round the whole hand, the inside faint
 * so the learner's own hand shows through, and no line at any joint -- each finger is one shape. The fingers show
 * only faintly where they cross each other or the palm (painted back to front by the template's depth, MediaPipe z,
 * smaller = nearer), so a fist still reads as fingers folded over a palm.
 *
 * WHAT IT SAYS (the `look`, from experiments/asl-tutor/coach.js): neutral (a white outline); "match" (the grader
 * would accept the hand as it is now: the outline turns green); "fix" with blocks (the one or two articulators the
 * grader's blame names, tutor/blame.js, laid over the hand in pulsing amber: a finger, the thumb, the four fingers for
 * their spread, or for the whole hand's orientation an amber outline).
 *
 * The canvas is inside the mirrored stage (js/core/experiment.js), so it is drawn in the camera's own, unmirrored
 * coordinates, exactly like the learner's landmarks; the templates are right hands in those coordinates, and a
 * left-handed learner gets them mirrored. */

import { palmSize } from "../../tutor/hand-frame.js";

export const FINGER_POINTS = Object.freeze({
  thumb: [1, 2, 3, 4], index: [5, 6, 7, 8], middle: [9, 10, 11, 12], ring: [13, 14, 15, 16], pinky: [17, 18, 19, 20],
});
const FINGERS = Object.keys(FINGER_POINTS);
// bone widths at the base, middle and tip joint, in palm sizes (an adult hand: a finger is about a fifth of a palm wide)
const WIDTH = { thumb: [0.32, 0.27, 0.235, 0.205], index: [0.25, 0.225, 0.2, 0.182], middle: [0.26, 0.235, 0.21, 0.19],
  ring: [0.245, 0.218, 0.197, 0.18], pinky: [0.215, 0.195, 0.178, 0.165] };
const PALM = [0, 1, 5, 9, 13, 17];
const PALM_ROUND = 0.12;      // the palm's corners are rounded by this much (palm sizes)

/* How visible the ghost is in study 2's design (teaching trials only, fading over the rounds); the demo always uses 1. */
export function ghostStrength(kind, pass, teachRounds) {
  if (kind !== "teach") return 0;
  if (!(teachRounds > 1)) return 1;
  return Math.max(0, Math.min(1, 1 - pass / (teachRounds - 1)));
}

/* How far the ghost turns WITH the learner's hand, in the picture's plane. Up to this, a hand held a little tilted
 * still gets the ghost lying on it (the grader takes small tilts); beyond it the ghost stays at its own angle plus
 * this much, so a hand turned the wrong way (G and H lie sideways, P and Q point down) shows as not fitting. */
export const MAX_TURN_DEG = 30;

const palmCenter = (P) => [0, 5, 9, 13, 17].reduce((a, i) => [a[0] + P[i][0] / 5, a[1] + P[i][1] / 5], [0, 0]);
const palmAngle = (P) => Math.atan2(P[9][1] - P[0][1], P[9][0] - P[0][0]);
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

/* Where the learner's hand is, in canvas pixels: the middle of the palm, the hand's 3-D palm size (so a hand turned
 * edge-on does not shrink the ghost) and the palm's direction in the picture (wrist -> middle knuckle). */
export function handAnchor(landmarks, W, H) {
  if (!landmarks || landmarks.length !== 21) return null;
  const P = landmarks.map((p) => [p.x * W, p.y * H, (p.z ?? 0) * W]);
  const s = palmSize(P);
  if (!(Number.isFinite(s) && s > 0)) return null;
  const [x, y] = palmCenter(P);
  return { x, y, s, ang: palmAngle(P) };
}

/* The template's 21 points on the canvas, for an anchor and a hand: [x, y, depth], depth in pixels (smaller =
 * nearer). The template's palm centre goes on the anchor's, at the anchor's size, turned toward the anchor's
 * direction by at most MAX_TURN_DEG (not at all for an anchor with no direction). */
export function placeGhost(pts, anchor, hand = "right") {
  const m = hand === "left" ? -1 : 1;
  const T = pts.map((p) => [m * p[0], p[1], p[2] ?? 0]);
  const c = palmCenter(T);
  const lim = (MAX_TURN_DEG * Math.PI) / 180;
  const th = Number.isFinite(anchor.ang) ? Math.max(-lim, Math.min(lim, wrapPi(anchor.ang - palmAngle(T)))) : 0;
  const co = Math.cos(th), si = Math.sin(th);
  return T.map((p) => {
    const dx = p[0] - c[0], dy = p[1] - c[1];
    return [anchor.x + anchor.s * (co * dx - si * dy), anchor.y + anchor.s * (si * dx + co * dy), p[2] * anchor.s];
  });
}

/* With no hand in view yet: the ghost stands a little below the middle of the picture, about the size a hand at arm's
 * length is, as an invitation. */
export const defaultAnchor = (W, H) => ({ x: W * 0.5, y: H * 0.62, s: H * 0.2 });

/* The hand as shapes: the palm, and each finger WHOLE -- its three bones as one shape, so there is no line at any joint
 * (an outline per bone made the ghost a diagram to decode; 19 Oct, the owner: "just the clean image"). Painted
 * farthest first. A finger goes in front of the palm only when it is clearly nearer the camera (a fist's folded
 * fingers, the thumb across a B); otherwise it goes behind and the palm covers its base. */
export function handParts(Q, s) {
  const palmDepth = PALM.reduce((a, i) => a + Q[i][2], 0) / PALM.length;
  const parts = [{ kind: "palm", block: "palm", depth: palmDepth, pad: PALM_ROUND * s, pts: PALM.map((i) => Q[i]) }];
  FINGERS.forEach((f, n) => {
    const ix = FINGER_POINTS[f];
    const bones = [0, 1, 2].map((k) => ({ a: Q[ix[k]], b: Q[ix[k + 1]], r1: (WIDTH[f][k] * s) / 2, r2: (WIDTH[f][k + 1] * s) / 2 }));
    const depth = (Q[ix[1]][2] + Q[ix[2]][2] + Q[ix[3]][2]) / 3;
    parts.push({ kind: "finger", block: f, depth: depth < palmDepth - 0.12 * s ? depth : palmDepth + 1e-6 * (1 + n), pad: 0, bones });
  });
  return parts.map((p, i) => ({ p, i })).sort((u, v) => (v.p.depth - u.p.depth) || (u.i - v.i)).map((u) => u.p);
}

/* A tapered capsule (the convex hull of two circles), added to the current path. */
function capsule(ctx, { a, r1, b, r2 }) {
  const dx = b[0] - a[0], dy = b[1] - a[1], L = Math.hypot(dx, dy);
  if (L <= Math.abs(r1 - r2) + 1e-9) {
    const [c, r] = r1 >= r2 ? [a, r1] : [b, r2];
    ctx.moveTo(c[0] + r, c[1]);
    ctx.arc(c[0], c[1], r, 0, 2 * Math.PI);
    return;
  }
  const th = Math.atan2(dy, dx), al = Math.acos((r1 - r2) / L);
  ctx.moveTo(a[0] + r1 * Math.cos(th + al), a[1] + r1 * Math.sin(th + al));
  ctx.arc(a[0], a[1], r1, th + al, th - al + 2 * Math.PI);
  ctx.arc(b[0], b[1], r2, th - al, th + al);
  ctx.closePath();
}
function partPath(ctx, part) {
  ctx.beginPath();
  if (part.kind === "palm") {
    part.pts.forEach((q, k) => (k ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
    ctx.closePath();
  } else {
    for (const b of part.bones) capsule(ctx, b);
  }
}
/* The part's shape, filled (the palm's corners rounded by stroking it `pad` wide in the same colour). */
function fillPart(ctx, part, color) {
  partPath(ctx, part);
  ctx.fillStyle = color;
  if (part.pad > 0) { ctx.strokeStyle = color; ctx.lineWidth = 2 * part.pad; ctx.stroke(); }
  ctx.fill();
}
/* The part's shape grown by w all round (fill the part over it afterwards and only a w-wide line is left). */
function growPart(ctx, part, color, w) {
  partPath(ctx, part);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2 * (part.pad + w);
  ctx.stroke();
}

/* Which colour each block gets for a look, and whether the whole outline is amber (the hand is turned wrong). */
export function blockColors(look) {
  const out = { palm: "neutral", thumb: "neutral", index: "neutral", middle: "neutral", ring: "neutral", pinky: "neutral" };
  if (look?.state === "match" || look?.state === "accepted") {
    for (const k of Object.keys(out)) out[k] = "match";
    return { colors: out, outlineAll: false };
  }
  let outlineAll = false;
  if (look?.state === "fix") {
    for (const b of look.blocks ?? []) {
      if (b in out) out[b] = "fix";
      else if (b === "spread") for (const f of ["index", "middle", "ring", "pinky"]) out[f] = "fix";
      else if (b === "orientation") outlineAll = true;
    }
  }
  return { colors: out, outlineAll };
}

/* How it looks: one clean outline round the whole hand, a faint inside (the learner's own hand shows through it), no
 * lines at the joints; the fingers show only faintly where they cross each other. The part to change is laid over it
 * in amber, pulsing; a hand the grader would take turns the outline green. */
export const LOOK = Object.freeze({
  outline: 0.045,          // the outline's width, palm sizes
  bodyAlpha: 0.2,          // the inside
  bodyLine: 0.016,         // the faint line where one finger crosses another, palm sizes
  outlineAlpha: 0.95,
  fixAlpha: [0.45, 0.75],  // the part to change, between these as it pulses
});
const PAINT = {
  neutral: { outline: "#ffffff", body: "#ffffff", bodyLine: "#0f172a" },
  match: { outline: "#22c55e", body: "#86efac", bodyLine: "#14532d" },
  fix: { fill: "hsl(38 96% 62%)", line: "hsl(28 92% 42%)", outline: "hsl(38 96% 55%)" },
};

/* Paint the ghost into three layers (canvases of the camera's size) and lay them on ctx. With no layers (a test
 * under Node) the inside and the outline are painted straight onto ctx. */
export function renderGhost(ctx, Q, s, look, tMs = 0, layers = null) {
  const { colors, outlineAll } = blockColors(look);
  const green = look?.state === "match" || look?.state === "accepted";
  const pal = green ? PAINT.match : PAINT.neutral;
  const parts = handParts(Q, s);
  const pulse = 0.5 + 0.5 * Math.sin(tMs / 160);   // about 1 Hz
  const round = (g) => { g.lineJoin = "round"; g.lineCap = "round"; };
  const W = ctx.canvas?.width, H = ctx.canvas?.height;

  // 1. the inside: every part back to front, a thin line round each so crossed fingers can be told apart
  const body = layers?.body.getContext("2d") ?? ctx;
  if (layers) body.clearRect(0, 0, W, H);
  body.save(); round(body);
  if (!layers) body.globalAlpha = LOOK.bodyAlpha;
  for (const part of parts) { growPart(body, part, pal.bodyLine, LOOK.bodyLine * s); fillPart(body, part, pal.body); }
  body.restore();

  // 2. the outline: the whole hand grown, minus the hand itself
  const ring = layers?.ring.getContext("2d") ?? ctx;
  const outlineColor = outlineAll && !green ? PAINT.fix.outline : pal.outline;
  ring.save(); round(ring);
  if (layers) {
    ring.clearRect(0, 0, W, H);
    for (const part of parts) growPart(ring, part, outlineColor, LOOK.outline * s * (outlineAll && !green ? 1.3 + 0.5 * pulse : 1));
    ring.globalCompositeOperation = "destination-out";
    for (const part of parts) fillPart(ring, part, "#000");
  } else {
    ring.globalAlpha = LOOK.outlineAlpha;
    for (const part of parts) growPart(ring, part, outlineColor, LOOK.outline * s);
  }
  ring.restore();

  // 3. the part(s) to change
  const fixParts = parts.filter((p) => colors[p.block] === "fix");
  if (layers) {
    const hi = layers.hi.getContext("2d");
    hi.clearRect(0, 0, W, H);
    hi.save(); round(hi);
    for (const part of fixParts) { growPart(hi, part, PAINT.fix.line, 0.035 * s); fillPart(hi, part, PAINT.fix.fill); }
    hi.restore();
    ctx.save();
    ctx.globalAlpha = green ? LOOK.bodyAlpha * 1.5 : LOOK.bodyAlpha;
    ctx.drawImage(layers.body, 0, 0);
    if (fixParts.length) {
      ctx.globalAlpha = LOOK.fixAlpha[0] + (LOOK.fixAlpha[1] - LOOK.fixAlpha[0]) * pulse;
      ctx.drawImage(layers.hi, 0, 0);
    }
    // the outline last, with a soft dark edge so a white line still reads on a white wall
    ctx.globalAlpha = LOOK.outlineAlpha;
    ctx.shadowColor = green ? "rgba(21,128,61,0.8)" : "rgba(15,23,42,0.55)";
    ctx.shadowBlur = Math.max(3, 0.06 * s);
    ctx.drawImage(layers.ring, 0, 0);
    ctx.restore();
  } else {
    ctx.save(); round(ctx);
    for (const part of fixParts) fillPart(ctx, part, PAINT.fix.fill);
    ctx.restore();
  }
}

/* Three canvases of the given size, for renderGhost. */
export function makeLayers(W, H) {
  const mk = () => { const c = document.createElement("canvas"); c.width = W; c.height = H; return c; };
  return { body: mk(), ring: mk(), hi: mk() };
}

/* One per session. `draw` is called every frame, after the canvas was cleared. The anchor is smoothed a little so
 * the ghost does not shiver with the tracker. `look` is the coach's (coach.js); `tMs` drives the amber pulse. */
export function createGhost(templates, { smoothing = 0.35 } = {}) {
  let a = null;
  let layers = null;
  return {
    reset() { a = null; },
    get anchor() { return a; },
    draw(ctx, canvas, landmarks, letter, hand, strength, look = null, tMs = 0) {
      const t = templates[letter];
      if (!t || !(strength > 0)) return;
      const W = canvas.width, H = canvas.height;
      const now = handAnchor(landmarks, W, H);
      if (now) {
        a = a ? { x: a.x + smoothing * (now.x - a.x), y: a.y + smoothing * (now.y - a.y), s: a.s + smoothing * (now.s - a.s),
          ang: a.ang + smoothing * wrapPi(now.ang - a.ang) } : now;
      }
      const at = a ?? defaultAnchor(W, H);
      const Q = placeGhost(t.pts, at, hand);
      if (typeof document === "undefined") {
        ctx.save();
        ctx.globalAlpha = strength;
        renderGhost(ctx, Q, at.s, look, tMs, null);
        ctx.restore();
        return;
      }
      if (!layers || layers.body.width !== W || layers.body.height !== H) layers = makeLayers(W, H);
      ctx.save();
      ctx.globalAlpha = strength;
      renderGhost(ctx, Q, at.s, look, tMs, layers);
      ctx.restore();
    },
  };
}
