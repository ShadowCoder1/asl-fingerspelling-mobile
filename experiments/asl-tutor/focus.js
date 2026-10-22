/* focus.js: the room dimmed and blurred, the learner's hand left clear (JT, 19 Oct 2026: "i find it hard to see the
 * outline of the finger given the background is ME in my room ... maybe background can be blurred so people can focus
 * on hand and what they need to match in").
 *
 * HOW. A small canvas laid over the camera picture, under the outline: each frame it gets a shrunk copy of the camera
 * frame (stretched back up, that is a blur), darkened, with a soft-edged HOLE cut where the hand is -- through the hole
 * the real camera picture shows, sharp. The white outline then sits on a dark, featureless background wherever the hand
 * is not.
 *
 * WHY THIS WAY. Nothing here touches what the hand tracker reads: MediaPipe takes the <video> element's decoded frame
 * (HTML: "the frame at the current playback position"; WebGL texImage2D: "the uploaded frame of the video"), and this
 * only draws a copy of that frame onto another canvas. No CSS changes per frame (a moving CSS mask repaints on the main
 * thread, the thread the tracker runs on), no second <video>, and no canvas `filter` (Safari still has it switched off).
 * The canvas has the camera's aspect ratio and sits in the same mirrored box as the video and the outline (#stage
 * .mirror; js/core/experiment.js), so `object-fit: cover` crops all three the same way.
 *
 * When no hand has been seen for LOST_MS the dimming fades away, so the learner can see where they are. */

export const FOCUS = Object.freeze({
  scale: 4,       // the dimmer canvas is the camera frame / 4
  blur: 4,        // the blur: the frame shrunk a further 4 times (640 x 480 -> 40 x 30), then stretched back up
  dim: 0.55,      // how dark the room goes
  reach: 1.3,     // the hole's radius: this times half the hand's box diagonal
  pad: 0.35,      // ... plus this many palm sizes (the hole trails a moving hand by the tracker's latency)
  soft: 0.45,     // the inner, fully clear part of the hole, as a fraction of its radius
  ease: 0.5,      // how fast the hole follows the hand, per frame
  lostMs: 700,
});

/** Where the hole goes, in the camera frame's pixels (unmirrored: the overlay's own coordinates): the hand's box
 * centre, and a radius that covers the hand with room to spare. null without a hand. */
export function holeFor(landmarks, W, H, { reach = FOCUS.reach, pad = FOCUS.pad } = {}) {
  if (!landmarks || landmarks.length !== 21) return null;
  let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
  for (const p of landmarks) {
    const x = p.x * W, y = p.y * H;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return null;
    x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y);
  }
  const palm = Math.hypot((landmarks[9].x - landmarks[0].x) * W, (landmarks[9].y - landmarks[0].y) * H);
  return { x: (x0 + x1) / 2, y: (y0 + y1) / 2, r: reach * 0.5 * Math.hypot(x1 - x0, y1 - y0) + pad * palm };
}

/**
 * @param {HTMLElement} stage   #stage (the camera view)
 * @returns {{draw(video: HTMLVideoElement, landmarks: object[]|null, tMs: number): void, set(on: boolean): void,
 *   hide(): void, readonly on: boolean}}
 */
export function createFocus(stage, opts = {}) {
  const o = { ...FOCUS, ...opts };
  const mirror = stage.querySelector(".mirror");
  const canvas = document.createElement("canvas");
  canvas.id = "focus-dim";
  canvas.className = "focus-dim focus-off";
  canvas.setAttribute("aria-hidden", "true");
  mirror.insertBefore(canvas, mirror.querySelector("#overlay"));
  const g = canvas.getContext("2d");
  const tiny = document.createElement("canvas");
  const t = tiny.getContext("2d");
  let on = true, hole = null, seenAt = -Infinity, shown = false;
  const srcMirrored = () => document.documentElement.classList.contains("src-mirror");
  const show = (v) => { if (v !== shown) { shown = v; canvas.classList.toggle("focus-off", !v); } };

  return {
    get on() { return on; },
    set(v) { on = !!v; if (!on) show(false); },
    hide() { show(false); hole = null; },
    draw(video, landmarks, tMs) {
      if (!on || !video?.videoWidth) { show(false); return; }
      const W = video.videoWidth, H = video.videoHeight;
      const w = Math.max(1, Math.round(W / o.scale)), h = Math.max(1, Math.round(H / o.scale));
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
      const tw = Math.max(1, Math.round(w / o.blur)), th = Math.max(1, Math.round(h / o.blur));
      if (tiny.width !== tw || tiny.height !== th) { tiny.width = tw; tiny.height = th; }

      const want = holeFor(landmarks, W, H, o);
      if (want) {
        seenAt = tMs;
        hole = hole ? { x: hole.x + o.ease * (want.x - hole.x), y: hole.y + o.ease * (want.y - hole.y), r: hole.r + o.ease * (want.r - hole.r) } : want;
      }
      if (tMs - seenAt > o.lostMs) { show(false); hole = null; return; }

      t.imageSmoothingEnabled = true;
      t.imageSmoothingQuality = "high";
      t.drawImage(video, 0, 0, tw, th);
      g.globalCompositeOperation = "source-over";
      g.imageSmoothingEnabled = true;
      g.imageSmoothingQuality = "high";
      g.drawImage(tiny, 0, 0, w, h);
      g.fillStyle = `rgba(6, 10, 18, ${o.dim})`;
      g.fillRect(0, 0, w, h);
      if (hole) {
        // the canvas is in the camera's pixels shown mirrored with the video -- except with ?srcmirror=1, where the
        // video (and this canvas) are shown as they come and the landmarks were turned back to the true view
        const x = (srcMirrored() ? W - hole.x : hole.x) / o.scale, y = hole.y / o.scale, r = hole.r / o.scale;
        const grad = g.createRadialGradient(x, y, o.soft * r, x, y, r);
        grad.addColorStop(0, "rgba(0, 0, 0, 1)");
        grad.addColorStop(1, "rgba(0, 0, 0, 0)");
        g.globalCompositeOperation = "destination-out";
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, 2 * r, 2 * r);
        g.globalCompositeOperation = "source-over";
      }
      show(true);
    },
  };
}
