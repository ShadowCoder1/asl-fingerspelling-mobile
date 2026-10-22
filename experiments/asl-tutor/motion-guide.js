/* motion-guide.js: J and Z, the two letters that MOVE (JT, 19 Oct 2026: "the image outline while useful for the static
 * postures, might be hard to scale to dynamic"). For them the camera view also shows the PATH: a dotted gold line from
 * the learner's own fingertip (the pinky for J, the index for Z) the way the stroke goes, a light running along it, and
 * the fingertip's own trail as it moves, so what was drawn sits next to what to draw (the path ahead of the hand of
 * OctoPocus, Bau & Mackay 2008, and LightGuide, Sodhi et al. 2012; YouMove's ribbons, Anderson et al. 2013; Sigrist et
 * al. 2013 on showing a movement after it).
 *
 * WHICH WAY. As the signer sees it -- which is the mirrored camera view: J goes down, then hooks toward the middle of
 * the body; Z goes across, back down diagonally, and across again, reading as a Z to the signer (Handspeak's common
 * error is a mirrored Z). A left hand mirrors both. HOW BIG. In palm lengths (wrist -> middle knuckle), comfortably past
 * what tutor/motion.js needs (J: down 0.45, across 0.25; Z: 0.6 wide, 0.35 down, two turns).
 *
 * The path starts at the fingertip and follows the hand while it is still; once the fingertip is on the move, the path
 * stays where it was, so the stroke can be drawn along it. */

/* The strokes, as the signer sees them: x to the signer's right, y down, from the fingertip, in palm lengths. */
const J_DOWN = 0.55, J_HOOK_R = 0.26;
export const STROKES = Object.freeze({
  J: Object.freeze([[0, 0], [0, J_DOWN / 2], [0, J_DOWN], ...Array.from({ length: 10 }, (_, i) => {
    const a = (Math.PI * (i + 1)) / 10;   // half a turn, hooking toward the body's middle and back up
    return [-J_HOOK_R + J_HOOK_R * Math.cos(a), J_DOWN + J_HOOK_R * Math.sin(a)];
  })]),
  Z: Object.freeze([[0, 0], [0.8, 0], [0, 0.65], [0.8, 0.65]]),
});
export const TIP = Object.freeze({ J: 20, Z: 8 });
export const TRAIL_MS = 1600;
export const MOVING = 0.22;       // the fingertip has moved this many palm lengths in MOVING_MS: the path stays put
export const MOVING_MS = 250;
export const RUN_MS = 1700;       // one run of the light along the path

/** The stroke on the canvas: canvas pixels from an anchor (the fingertip, canvas px) and a palm length (px). The canvas
 * is shown mirrored (js/core/experiment.js; with ?srcmirror=1 too), so the signer's right is the canvas's left. */
export function strokeOnCanvas(letter, anchor, palmPx, hand = "right") {
  const s = STROKES[letter];
  if (!s || !anchor || !(palmPx > 0)) return null;
  const side = hand === "left" ? 1 : -1;   // signer's right -> canvas x
  return s.map(([x, y]) => [anchor[0] + side * x * palmPx, anchor[1] + y * palmPx]);
}

/** A point a fraction f (0..1) of the way along a polyline, by length. */
export function along(pts, f) {
  if (!(f < 1)) return pts[pts.length - 1].slice();
  if (!(f > 0)) return pts[0].slice();
  const seg = [];
  let total = 0;
  for (let i = 1; i < pts.length; i++) { const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]); seg.push(d); total += d; }
  let target = Math.max(0, Math.min(1, f)) * total;
  for (let i = 0; i < seg.length; i++) {
    if (target <= seg[i] || i === seg.length - 1) {
      const u = seg[i] > 0 ? Math.min(1, target / seg[i]) : 0;
      return [pts[i][0] + u * (pts[i + 1][0] - pts[i][0]), pts[i][1] + u * (pts[i + 1][1] - pts[i][1])];
    }
    target -= seg[i];
  }
  return pts[pts.length - 1];
}

export function createMotionGuide({ hand = "right" } = {}) {
  let anchor = null, trail = [];
  return {
    reset() { anchor = null; trail = []; },
    /** Every frame of a J or Z trial, after the outline (canvas px; landmarks normalized; tMs any steady clock). */
    draw(ctx, canvas, landmarks, letter, tMs, strength = 1) {
      if (!STROKES[letter] || !(strength > 0)) return;
      const W = canvas.width, H = canvas.height;
      if (landmarks?.length === 21) {
        const tip = [landmarks[TIP[letter]].x * W, landmarks[TIP[letter]].y * H];
        const palm = Math.hypot((landmarks[9].x - landmarks[0].x) * W, (landmarks[9].y - landmarks[0].y) * H);
        trail.push({ t: tMs, p: tip, palm });
      }
      while (trail.length && trail[0].t < tMs - TRAIL_MS) trail.shift();
      if (!trail.length) { anchor = null; return; }
      const now = trail[trail.length - 1];
      const recent = trail.filter((q) => q.t >= tMs - MOVING_MS);
      const moved = Math.max(...recent.map((q) => Math.hypot(q.p[0] - now.p[0], q.p[1] - now.p[1]))) / (now.palm || 1);
      if (!anchor || moved < MOVING) anchor = { p: anchor && moved < MOVING ? [anchor.p[0] + 0.35 * (now.p[0] - anchor.p[0]), anchor.p[1] + 0.35 * (now.p[1] - anchor.p[1])] : now.p, palm: now.palm };
      const path = strokeOnCanvas(letter, anchor.p, anchor.palm, hand);
      if (!path) return;
      const lw = Math.max(2, 0.06 * anchor.palm);
      ctx.save();
      ctx.globalAlpha = strength;
      ctx.lineCap = ctx.lineJoin = "round";
      // the path: dark edge, then dotted gold, and an arrowhead at its end
      ctx.beginPath();
      path.forEach((q, i) => (i ? ctx.lineTo(q[0], q[1]) : ctx.moveTo(q[0], q[1])));
      ctx.strokeStyle = "rgba(15, 23, 42, 0.55)"; ctx.lineWidth = lw + 3; ctx.stroke();
      ctx.setLineDash([1.6 * lw, 1.4 * lw]);
      ctx.strokeStyle = "rgba(251, 191, 36, 0.95)"; ctx.lineWidth = lw; ctx.stroke();
      ctx.setLineDash([]);
      const [a, b] = [path[path.length - 2], path[path.length - 1]];
      const ang = Math.atan2(b[1] - a[1], b[0] - a[0]), hl = 3.2 * lw;
      ctx.beginPath();
      ctx.moveTo(b[0], b[1]);
      ctx.lineTo(b[0] - hl * Math.cos(ang - 0.45), b[1] - hl * Math.sin(ang - 0.45));
      ctx.lineTo(b[0] - hl * Math.cos(ang + 0.45), b[1] - hl * Math.sin(ang + 0.45));
      ctx.closePath();
      ctx.fillStyle = "rgba(251, 191, 36, 0.95)"; ctx.fill();
      // the light running along it
      const f = ((tMs % RUN_MS) + RUN_MS) % RUN_MS / RUN_MS;
      const c = along(path, Math.min(1, f / 0.8));
      ctx.globalAlpha = strength * (f < 0.85 ? 1 : 1 - (f - 0.85) / 0.15);
      ctx.beginPath(); ctx.arc(c[0], c[1], 1.6 * lw, 0, 2 * Math.PI);
      ctx.fillStyle = "rgba(254, 243, 199, 0.95)"; ctx.fill();
      ctx.globalAlpha = strength;
      // the fingertip's own trail, fading with age
      for (let i = 1; i < trail.length; i++) {
        const age = (tMs - trail[i].t) / TRAIL_MS;
        ctx.beginPath(); ctx.moveTo(trail[i - 1].p[0], trail[i - 1].p[1]); ctx.lineTo(trail[i].p[0], trail[i].p[1]);
        ctx.strokeStyle = `rgba(56, 189, 248, ${(0.9 * (1 - age)).toFixed(3)})`; ctx.lineWidth = lw * 1.1; ctx.stroke();
      }
      ctx.restore();
    },
  };
}
