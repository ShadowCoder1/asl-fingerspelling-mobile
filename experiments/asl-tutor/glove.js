/* glove.js: the letter as a GLOVE for the learner to put their hand into (Indranil's renders, 20 Oct 2026; JT: "I like
 * the idea of thinking that it's a glove that you have to put your hand into"; for Thursday's demo L X G, right hand).
 * Drawing only: it grades nothing, and the hold, the grader and the words are exactly as with the outline.
 *
 * WHERE IT GOES. In a fixed spot (Indranil and JT, 20 Oct: a glove that moves would be confusing; "if the size is
 * roughly like their hand, most ideal"), a little further right than the outline's (GLOVE_SPOT; Indranil: "being too
 * centered on the screen is uncomfortable on the elbows"), never turning, its size easing to the learner's palm (as
 * picture-ghost.js): the glove's wrist -> middle knuckle (assets/gloves/gloves.json) as long as theirs.
 *
 * WHAT IT SAYS. Translucent, so the learner's own hand and skeleton show inside it (Indranil: "like the skeleton is
 * within a glove"), and mint when the grader would accept the hand as it is now (the coach's `look`, the same grader as
 * the hold). Nothing else (Indranil, 20 Oct, after trying it: no gold lines, "the mismatch between skeleton and glove
 * provides enough corrective feedback"; no white line round the glove): the words under the letter say what to move.
 *
 * HOW IT MOVES (the owner, 20 Oct: "clean animations ... a cute bounce when the sign is completed ... make sure it
 * isn't distracting"). Nothing moves while the learner is trying. A new letter's glove pops in (POP, 0.3 s); when the
 * hold is accepted (celebrate) it swells for a moment (BOING) and wobbles like jelly, squashing and stretching along the
 * hand about its wrist and settling within JELLO.ms, while a mint ring and a few sparkles leave its edge and fade
 * (SPARKS). All of it is over inside the second the accepted letter stays up (flow.js END_DWELL_MS). */

import { anchorOf, transformOf, applyTransform, PALM_LENGTH, PALM_AT, SIZE_EASE } from "./picture-ghost.js";

export const GLOVE = Object.freeze({ body: 0.6, tintEase: 0.22 });
export const TINT = Object.freeze({ match: "#34d399" });
const MINT = "#a7f3d0";
/* The glove's palm on screen, as a fraction of the camera view (x from the left, y from the top), for a right hand;
 * mirrored for a left one. The outline's is x 0.66 (picture-ghost.js SPOT). */
export const GLOVE_SPOT = Object.freeze({ x: 0.74, y: 0.55 });
/* A phone held upright (mobile/, 22 Oct): the picture is taller than wide and its sides are close to the hand, so the
 * glove sits nearer the middle and a little lower, where a hand held up in front of the chest is; at 0.74 a hand near
 * the phone pushed the glove off the right edge. Landscape pictures keep GLOVE_SPOT. */
export const GLOVE_SPOT_PORTRAIT = Object.freeze({ x: 0.64, y: 0.6 });
/** The spot on the canvas (shown mirrored, so the screen's x is flipped), for a canvas W x H and a hand. */
export function gloveSpot(W, H, hand = "right") {
  const S = H > W ? GLOVE_SPOT_PORTRAIT : GLOVE_SPOT;
  const sx = hand === "left" ? 1 - S.x : S.x;
  return { x: (1 - sx) * W, y: S.y * H };
}
export const POP = Object.freeze({ ms: 320, from: 0.88 });
export const BOING = Object.freeze({ ms: 240, amp: 0.07 });
export const JELLO = Object.freeze({ ms: 800, amp: 0.15, periodMs: 270, decayMs: 210 });
/* sparkles start FROM (palm lengths from the palm, about the glove's edge) and travel REACH further */
export const SPARKS = Object.freeze({ n: 10, ms: 750, from: 0.8, reach: [0.45, 0.8], size: [0.05, 0.085], colors: ["#a7f3d0", "#ffffff", "#c4b5fd", "#6ee7b7"] });

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const easeOut = (u) => 1 - (1 - u) ** 3;

/** A new glove's scale, t ms after it appeared: from POP.from to 1, overshooting a little (ease-out-back). */
export function popScale(t) {
  const u = clamp01(t / POP.ms), c = 1.6;
  const back = 1 + (c + 1) * (u - 1) ** 3 + c * (u - 1) ** 2;
  return POP.from + (1 - POP.from) * back;
}

/** The swell as the hold is accepted, t ms after: up by BOING.amp and back to exactly 1. */
export function boing(t) {
  if (!(t >= 0) || t >= BOING.ms) return 1;
  return 1 + BOING.amp * Math.sin((Math.PI * t) / BOING.ms);
}

/** The jelly wobble, t ms after the hold was accepted: the scale along the hand and across it (one up while the other
 * goes down, so it keeps its volume), back to exactly 1 at JELLO.ms. */
export function jello(t) {
  if (!(t >= 0) || t >= JELLO.ms) return { along: 1, across: 1 };
  const w = JELLO.amp * Math.exp(-t / JELLO.decayMs) * Math.sin((2 * Math.PI * t) / JELLO.periodMs) * (1 - t / JELLO.ms);
  return { along: 1 - w, across: 1 + w };
}

/** The sparkles: where each one goes (angle, how far in palm lengths), its size and colour. The same every time. */
export function sparks(n = SPARKS.n) {
  return Array.from({ length: n }, (_, i) => {
    const r = Math.sin(i * 12.9898 + 78.233) * 43758.5453, j = r - Math.floor(r);
    return { angle: (2 * Math.PI * (i + 0.35 * j)) / n - Math.PI / 2, reach: SPARKS.reach[0] + (SPARKS.reach[1] - SPARKS.reach[0]) * j,
      size: SPARKS.size[0] + (SPARKS.size[1] - SPARKS.size[0]) * (((i * 7) % 3) / 2), color: SPARKS.colors[i % SPARKS.colors.length] };
  });
}

/** The glove's wrist and middle knuckle in its own pixels, on the canvas's side. The renders are a right hand as it
 * looks on the learner's mirrored screen and the canvas is shown mirrored, so for a right hand they go on it flipped;
 * a left hand gets the glove's mirror image on screen (Indranil: "just horizontally reverse"), unflipped on the canvas. */
export function glovePoints({ W, M }, hand, w, h) {
  const f = hand === "left" ? (q) => [q[0] * w, q[1] * h] : (q) => [(1 - q[0]) * w, q[1] * h];
  return { W: f(W), M: f(M) };
}
export const gloveFlipped = (hand) => hand !== "left";

/* The glove in one tint, on the canvas's side: "color" keeps the render's own shading and takes the tint's hue. */
function tinted(img, flip, color) {
  const c = document.createElement("canvas");
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext("2d");
  if (flip) { g.translate(c.width, 0); g.scale(-1, 1); }
  g.drawImage(img, 0, 0);
  g.setTransform(1, 0, 0, 1, 0, 0);
  if (color) {
    g.globalCompositeOperation = "color";
    g.fillStyle = color;
    g.fillRect(0, 0, c.width, c.height);
    g.globalCompositeOperation = "destination-in";
    if (flip) { g.translate(c.width, 0); g.scale(-1, 1); }
    g.drawImage(img, 0, 0);
    g.setTransform(1, 0, 0, 1, 0, 0);
  }
  return c;
}

/**
 * One per session, the outline's interface: `load(letters)`, `has(letter)`, `reset()` at each trial, `draw` every
 * frame after the canvas was cleared, and `celebrate(tMs)` when the hold is accepted.
 * @param {{gloves: object, hand?: "right"|"left"}} o   gloves: assets/gloves/gloves.json letters
 */
export function createGloveGhost({ gloves, hand = "right" }) {
  const art = {};   // letter -> { neutral, match, pp, len }
  let cur = null, tint = 0, shownAt = null, celebratedAt = null;
  return {
    async load(letters) {
      await Promise.all([...new Set(letters)].filter((L) => gloves[L]).map(async (L) => {
        const img = new Image();
        img.decoding = "async";
        img.src = gloves[L].src;
        await img.decode();
        const flip = gloveFlipped(hand);
        const neutral = tinted(img, flip, null), match = tinted(img, flip, TINT.match);
        const pp = glovePoints(gloves[L], hand, img.naturalWidth, img.naturalHeight);
        art[L] = { neutral, match, pp, len: Math.hypot(pp.M[0] - pp.W[0], pp.M[1] - pp.W[1]) };
      }));
    },
    has: (L) => !!art[L],
    reset() { cur = null; tint = 0; shownAt = null; celebratedAt = null; },
    celebrate(tMs) { celebratedAt = tMs; },
    /* `strength` (0..1): how much of the guidance to show (the demo's ?fade=1); the glove is drawn that much fainter,
     * and not at all at 0. */
    draw(ctx, canvas, landmarks, letter, look = null, tMs = 0, strength = 1) {
      const a = art[letter];
      if (!a || !(strength > 0)) return;
      const W = canvas.width, H = canvas.height;
      const green = look?.state === "match" || look?.state === "accepted";
      const hand0 = anchorOf(landmarks, W, H);
      // in its spot; only the size eases toward the learner's hand
      const spot = gloveSpot(W, H, hand);
      const kWant = ((hand0?.s ?? (cur ? null : H * 0.2)) * PALM_LENGTH) / a.len;
      cur = { x: spot.x, y: spot.y, th: 0, k: cur ? (hand0 ? cur.k + SIZE_EASE * (kWant - cur.k) : cur.k) : kWant };
      tint += GLOVE.tintEase * ((green ? 1 : 0) - tint);
      shownAt ??= tMs;

      // where it is, then the pop as it appears (about the palm) and the wobble once accepted (about the wrist,
      // squashing along the hand)
      const t = transformOf(a.pp, cur);
      const palm = applyTransform(t, [a.pp.W[0] + PALM_AT * (a.pp.M[0] - a.pp.W[0]), a.pp.W[1] + PALM_AT * (a.pp.M[1] - a.pp.W[1])]);
      const wrist = applyTransform(t, a.pp.W), knuckle = applyTransform(t, a.pp.M);
      const pop = popScale(tMs - shownAt) * (celebratedAt == null ? 1 : boing(tMs - celebratedAt));
      const wob = celebratedAt == null ? { along: 1, across: 1 } : jello(tMs - celebratedAt);
      const phi = Math.atan2(knuckle[1] - wrist[1], knuckle[0] - wrist[0]);
      const fadeIn = clamp01((tMs - shownAt) / 200);
      // accepted: a mint ring and a few sparkles leave the glove's edge and fade, BEHIND it (they come from it)
      const since = celebratedAt == null ? Infinity : tMs - celebratedAt;
      if (since >= 0 && since < SPARKS.ms) {
        const u = since / SPARKS.ms, e = easeOut(u), R = a.len * cur.k;
        ctx.save();
        ctx.globalAlpha = 0.6 * (1 - u) * strength;
        ctx.strokeStyle = MINT;
        ctx.lineWidth = Math.max(1, 0.09 * R * (1 - u));
        ctx.beginPath(); ctx.arc(palm[0], palm[1], R * (0.9 + 0.75 * e), 0, 2 * Math.PI); ctx.stroke();
        for (const p of sparks()) {
          const d = R * (SPARKS.from + p.reach * e), x = palm[0] + d * Math.cos(p.angle), y = palm[1] + d * Math.sin(p.angle);
          const r = R * p.size * (1 - 0.6 * u);
          ctx.globalAlpha = 0.9 * (1 - u) ** 1.5 * strength;
          ctx.fillStyle = p.color;
          ctx.beginPath();   // a four-point twinkle
          for (let k = 0; k < 8; k++) {
            const ang = (k * Math.PI) / 4 + u, rr = k % 2 ? 0.38 * r : r;
            ctx.lineTo(x + rr * Math.cos(ang), y + rr * Math.sin(ang));
          }
          ctx.closePath(); ctx.fill();
        }
        ctx.restore();
      }
      ctx.save();
      ctx.translate(palm[0], palm[1]); ctx.scale(pop, pop); ctx.translate(-palm[0], -palm[1]);
      ctx.translate(wrist[0], wrist[1]); ctx.rotate(phi); ctx.scale(wob.along, wob.across); ctx.rotate(-phi); ctx.translate(-wrist[0], -wrist[1]);
      ctx.transform(t.a, t.b, t.c, t.d, t.e, t.f);
      ctx.imageSmoothingQuality = "high";
      // lavender, or mint as the hand comes right
      const g = clamp01(tint);
      for (const [img, w] of [[a.neutral, 1 - g], [a.match, g]]) {
        if (w < 0.01) continue;
        ctx.globalAlpha = GLOVE.body * w * strength * fadeIn;
        ctx.drawImage(img, 0, 0);
      }
      ctx.restore();
    },
  };
}
