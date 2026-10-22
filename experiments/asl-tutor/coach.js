/* coach.js: what the ghost hand says, live, on every frame (experiments/asl-tutor/ghost.js draws it).
 *
 * The ring still decides: a hand is graded when it is held still (tutor/commit.js), exactly as without the ghost.
 * The coach only LOOKS, frame by frame, with the same grader and the same blame the hold will get -- so what the
 * ghost shows while the learner is still moving is what the hold would be told:
 *
 *   match   the grader would accept this hand as it is right now (tutor/mix.js's P and O/E rules; the OpenFS second
 *           opinion reads a whole hold, so it only ever adds an acceptance at the hold)
 *   fix     it would not, and the grader's blame (tutor/blame.js chooseCorrection: the one or two articulators whose
 *           correction alone would make the grader accept) names what to change: a finger, the thumb, the spread
 *           between the fingers, or the orientation
 *   neutral nothing to say: no hand, a hand the camera cannot read well, a hand so far off that no one or two
 *           corrections would do (the picture is the help then), or a movement letter (J, Z)
 *
 * It judges the median of the last few frames, as the hold is graded, and a look is shown only once it has held for
 * SETTLE_MS ("match" a little sooner), so the ghost does not flicker while the hand is on its way into a shape.
 * Looking changes nothing the tutor does. */

import { toPoints } from "../../tutor/landmarks.js";
import { chirality, palmSize } from "../../tutor/hand-frame.js";
import { featuresFromFlat } from "../../tutor/features.js";
import { verify, standardize } from "../../tutor/verifier.js";
import { chooseCorrection } from "../../tutor/blame.js";
import { createMixedVerify, middleFingerDown, tipToKnuckle, NOT_E, thumbSideways, B_THUMB } from "../../tutor/mix.js";
import { blockLevels, partsToShow, MAX_SHOWN } from "../../tutor/feedback.js";
import { MOTION_LETTERS } from "../../tutor/motion.js";
import { isCentered } from "./engine.js";

export const SETTLE_MS = 220;
export const MATCH_SETTLE_MS = 120;
const HAND_SIGN = { right: 1, left: -1 };
const FINGERS4 = ["index", "middle", "ring", "pinky"];

/** What the grader and its blame say about one frame, for the ghost. Pure.
 * looksLike: also the letter the hand looks like when it is not the target (tutor/feedback.js looksLike, the same gate
 * the words after a hold use); levels: also every block's level for the per-finger meters (tutor/feedback.js
 * blockLevels), the blocks named held under the top. Neither changes the state. */
export function judgeFrame(model, { flat, aspect, videoHeight }, letter, hand = "right", { bThumb = false, looksLike = false, levels = false } = {}) {
  if (MOTION_LETTERS.includes(letter) || !(letter in model.index)) return { state: "neutral", blocks: [], why: "movement" };
  if (!flat || flat.some((v) => !Number.isFinite(v))) return { state: "neutral", blocks: [], why: "no-hand" };
  const points = toPoints(flat, aspect);
  const sign = HAND_SIGN[hand] ?? 1;
  const x = featuresFromFlat(flat, aspect, sign);
  const quality = {
    handPresentFrac: 1, palmSizePx: palmSize(points) * videoHeight, centered: isCentered(flat), chiralityMargin: chirality(points).margin,
  };
  const mixed = createMixedVerify({ verify, getOpenFS: () => null, getCommit: () => ({ flat, aspect, sign }), bThumb, looksLike });
  const v = mixed(model, x, letter, quality, { ignoreTier: true });
  const named = looksLike ? { looksLike: v.looksLike?.letter ?? null } : {};
  if (v.outcome === "accept") return levels ? { state: "match", blocks: [], levels: blockLevels(model, null, letter, { accepted: true }) } : { state: "match", blocks: [] };
  const z = v.reason === "tracking" || v.reason === "not-gradable" ? null : standardize(model, x);
  if (z === null || !z.every(Number.isFinite)) return { state: "neutral", blocks: [], why: v.reason === "tracking" ? "tracking" : "not-gradable" };
  const c = chooseCorrection(model, z, letter);
  // the meters reuse the gains blame has just computed for the correction: blame runs once a frame, meters on or off
  const withLevels = (r) => (levels ? { ...r, levels: blockLevels(model, z, letter, { named: r.blocks, gains: c.gains }) } : r);
  if (c.nothingToSay) {
    // the plain grader accepts it, one of mix.js's rules does not: say which way the rule points
    if (letter === "P" && !middleFingerDown(flat, aspect)) return withLevels({ state: "fix", blocks: ["orientation"], ...named });
    if (letter === "E" && tipToKnuckle(flat, aspect) >= NOT_E.minTipToKnuckle) return withLevels({ state: "fix", blocks: FINGERS4, ...named });
    if (bThumb && letter === "B" && thumbSideways(flat, aspect, sign) > B_THUMB.maxSideways) return withLevels({ state: "fix", blocks: ["thumb"], ...named });
    return withLevels({ state: "neutral", blocks: [], why: "rule", ...named });
  }
  if (c.blocks.length) return withLevels({ state: "fix", blocks: c.blocks.slice(), ...named });
  return withLevels({ state: "neutral", blocks: [], why: "whole-shape", ...named });
}

const same = (a, b) => a.state === b.state && a.blocks.join() === b.blocks.join();

/* The hold is graded on the median of its last WINDOW tracked frames (tutor/commit.js), so the coach judges the same
 * thing: the median of the hand's last WINDOW frames (no older than WINDOW_MS). Judging single frames, the ghost was
 * green at the end of 8.9% of the real holds that were then rejected (tools/ghost-hands/coach_eval.mjs). */
export const WINDOW = 7;
export const WINDOW_MS = 400;
export function medianFlat(rows) {
  const out = new Array(rows[0].length);
  const v = new Array(rows.length);
  for (let j = 0; j < out.length; j++) {
    for (let i = 0; i < rows.length; i++) v[i] = rows[i][j];
    v.sort((a, b) => a - b);
    const m = v.length >> 1;
    out[j] = v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
  }
  return out;
}

/* The letter the hand looks like is shown only once the same answer (a letter, or none) has held this long: a hand on
 * its way into a shape passes through others (an A on its way to an E is an S for a moment), and naming each would be
 * noise. It is settled on its own, so the part to change appears exactly as soon as it did before. */
export const LOOKS_SETTLE_MS = 450;

/** One per session: judges the median of the last few frames and smooths the result over time. `accepted()` turns
 * the ghost green until the next trial. With { looksLike: true } a settled look that is not a match carries
 * `looksLike` (the letter, or null). With { levels }, true or a function saying whether to (the meters are on),
 * `levels` is every block's meter level for the latest frame (not smoothed in time: the meters move with the hand;
 * their colours follow the settled look). */
export function createCoach(model, { hand = "right", settleMs = SETTLE_MS, matchSettleMs = MATCH_SETTLE_MS, window = WINDOW, windowMs = WINDOW_MS, bThumb = false, looksLike = false, levels = false, looksSettleMs = LOOKS_SETTLE_MS } = {}) {
  let shown = { state: "neutral", blocks: [] };
  let candidate = null, since = 0, done = false, recent = [], latest = null;
  let looksCand = null, looksSince = 0, looksShown = null;
  const wantLevels = typeof levels === "function" ? levels : () => levels;
  /* The settled letter goes only on a look that judged a hand (a part to change, or a whole shape, or a rule): never on
   * "no hand" or "can't see it well", where it would name a hand that is not there. */
  const judged = (look) => look.state === "fix" || look.why === "whole-shape" || look.why === "rule";
  const dress = ({ levels: _, ...look }) => (!looksLike || !judged(look) ? look : { ...look, looksLike: looksShown });
  /* The parts shown follow the SETTLED letter (tutor/feedback.js partsToShow: the pair sentence's parts when the words
   * after the hold will use it), so the golden finger and the words always come from the same letter, and a letter
   * flickering at the naming gate cannot move the golden finger. */
  const withParts = (now, letter) => {
    if (!looksLike || !looksShown || !judged(now)) return now;
    const parts = partsToShow(letter, looksShown, now.blocks);
    return parts.length ? { ...now, state: "fix", blocks: parts.slice(0, MAX_SHOWN) } : now;
  };
  return {
    reset() { shown = { state: "neutral", blocks: [] }; candidate = null; done = false; recent = []; latest = null; looksCand = null; looksShown = null; },
    accepted() { done = true; shown = { state: "accepted", blocks: [] }; },
    get look() { return shown; },
    get levels() { return done ? "accepted" : latest; },
    update(frame, letter, tMs) {
      if (done) return shown;
      const ok = frame.flat && frame.flat.every(Number.isFinite);
      if (ok) {
        recent.push({ tMs, flat: frame.flat });
        while (recent.length > window || (recent.length && recent[0].tMs < tMs - windowMs)) recent.shift();
      } else {
        recent = [];
      }
      const flat = recent.length ? (recent.length === 1 ? recent[0].flat : medianFlat(recent.map((r) => r.flat))) : null;
      const judgedNow = judgeFrame(model, { ...frame, flat }, letter, hand, { bThumb, looksLike, levels: wantLevels() });
      latest = judgedNow.levels ?? null;
      if (looksLike) {
        const L = judgedNow.looksLike ?? null;
        if (L !== looksCand) { looksCand = L; looksSince = tMs; }
        if (tMs - looksSince >= looksSettleMs && looksShown !== looksCand) {
          looksShown = looksCand;
          if (judged(shown)) shown = dress(withParts(shown.blame ? { ...shown, blocks: shown.blame } : shown, letter));
        }
      }
      const now = withParts({ ...judgedNow, blame: judgedNow.blocks }, letter);
      if (same(now, shown)) { candidate = null; return shown; }
      if (!candidate || !same(now, candidate)) { candidate = now; since = tMs; }
      if (tMs - since >= (now.state === "match" ? matchSettleMs : settleMs)) { shown = dress(now); candidate = null; }
      return shown;
    },
  };
}
