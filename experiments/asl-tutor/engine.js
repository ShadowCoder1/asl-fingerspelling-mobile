/* engine.js: one learner's frames in, the tutor's effects out -- with no DOM.
 *
 * WHY THIS FILE EXISTS. Version 1 kept the per-frame pipeline in the browser
 * glue (experiments/asl-tutor.js): push the frame at the committer, grade a
 * commit, apply what the flow said. The flow's RULES were tested under Node
 * and the committer's STILLNESS was tested under Node, but the dozen lines that
 * joined them ran only in a browser, and that is exactly where the first
 * camera session broke (2026-09-20): every trial boundary re-armed the
 * committer under a hand that had not moved, so one held pose was graded
 * against letter after letter, and a finished trial was replaced by the next
 * letter before its feedback could be read. Nothing under `node --test` could
 * have seen either, because nothing under `node --test` ran a second trial.
 *
 * So the join lives here now: the committer, the flow, the hold-offs and the
 * end-of-trial dwell, driven by (tMs, landmarks) and nothing else. The glue
 * keeps what genuinely needs a browser -- the DOM, the model fetch, the
 * runner's addEvent/endTrial -- and tools/make-tutor-replay.mjs runs THIS
 * file to lay down its recording, so the smoke scenario is checked against
 * the same pipeline the page runs rather than against a description of it.
 *
 * TIME COMES IN, IT IS NEVER READ: tMs is the runner's per-trial clock, which
 * restarts near zero at every trial. */

import { toPoints } from "../../tutor/landmarks.js";
import { chirality, palmSize } from "../../tutor/hand-frame.js";
import { featuresFromFlat } from "../../tutor/features.js";
import { createCommitter, shapeDistance, DEFAULTS as COMMIT_DEFAULTS } from "../../tutor/commit.js";
import { verify, standardize, scoreAll } from "../../tutor/verifier.js";
import { createFlow } from "./flow.js";
import { createMixedVerify, SECOND_OPINION } from "../../tutor/mix.js";
import { MOTION_LETTERS, MOTION_HINTS, MOTION_DEFAULTS, motionVerdict, inShape } from "../../tutor/motion.js";

/* Which hand made a hold. The geometry (tutor/hand-frame.js chirality) is
 * trusted when it is clear; when it is not, MediaPipe's own label, by majority
 * over the recent frames. On this platform's unmirrored frames a physical
 * RIGHT hand reads as +1 and "Right" (research/live/REPORT.md section 1). */
export const HAND_MARGIN = 0.15;
const HAND_SIGN = { right: 1, left: -1 };

/* The hold-still ring, as this tutor runs it. The module's own defaults are
 * what its statistical tests characterize; these are what real hands needed.
 *
 *   holdMs 900, settleMs 300   600 ms was too quick to feel like a decision --
 *       a hand pausing on its way somewhere was graded. The ring appears once
 *       the learner has actually stopped, and they then have a visible 0.6 s
 *       to change their mind.
 *   stillPerFinger, stillTol 0.10 (and, until 2026-09-21, placeTol 0.3)   on real tracked video the
 *       plain maximum at 0.06 broke 12% of the frames inside a genuinely held
 *       letter and let 11 of 60 holds close a 600 ms ring. What moved was the
 *       hand as a whole, plus single hopping landmarks -- not the fingers. So
 *       SHAPE (palm centre removed; per finger, its second largest landmark)
 *       is judged tightly and PLACE loosely. In the comparison script, at the
 *       same 600 ms hold, that closed 42 of 60; through THIS committer with
 *       THESE options, on a real clip at half speed (learner-like holds), it
 *       closes 20 of 22 against 6 for the plain rule, and the grader accepts
 *       what they commit (tutor/commit.js DEFAULTS;
 *       research/live/eval-still-policies.mjs; tests/real-holds.test.js). A
 *       finger still curling cannot commit (guaranteed once its tip travels
 *       about 0.26 palm widths a second at 30 fps, 0.35 at 12 fps -- slower
 *       than that and the 230 ms the grader reads is not blurred by it
 *       anyway); a hand merely gliding sideways
 *       can, and is graded exactly as if it were still, because the features
 *       do not know where the hand is (tests/tutor-engine.test.js has both).
 *   stillAlign, placeTol 1.0   the owner, after the first recorded session:
 *       "if I move my hand, don't hold it still, it doesn't detect the letter".
 *       It did not: with their own recording swayed half a palm side to side
 *       the ring closed on 5 of 57 letters, rocked 12 degrees at the wrist on
 *       10, both on none -- three degrees of rock moves a fingertip the whole
 *       shape tolerance, and place was held to 0.3 palm widths (2-3 cm). The
 *       ANSWER is a shape kept for a second, not a hand kept in one spot, so
 *       shape is now compared with the turn taken out as well as without
 *       (tutor/commit.js stillAlign) and the hand may wander a palm width
 *       from where the hold began. Same recording, same motions: 57 of 57,
 *       with the verdicts it got held still; as recorded, no letter is graded
 *       earlier and wrong, and several close 0.5-1 s sooner
 *       (research/recordings-2026-09-21/). What still cannot commit: a finger
 *       moving (unchanged), and a hand going somewhere -- more than a palm
 *       width in the 1.2 s, which is an arm being raised, not an answer.
 *   heldOverPlace Infinity   the price of the line above. A pose carried over
 *       a trial boundary used to re-arm by SHAPE or by PLACE (0.6 palm widths):
 *       harmless while a hand that was moving could not commit anyway. Now it
 *       can, so a learner still holding up the last letter and swaying would
 *       re-arm by place and have the old letter graded against the new one --
 *       the burst of the first camera session, back for anyone who does not
 *       keep still. Across a boundary only a change of SHAPE (or the hand
 *       going away) re-arms. The status line already asks for exactly that
 *       ("Relax your hand, then make this letter").
 *   rearmAfterMs 3500   a correction too small to register as movement is
 *       still graded if it is held for 3.5 s after the verdict. Safe only
 *       because of SAME_POSE_TOL below: a hand that has NOT changed is never
 *       charged a second attempt, however the ring came to close on it again.
 *
 * WHAT THE REAL-VIDEO NUMBERS ARE AND ARE NOT. They come from a comparison
 * script at a 600 ms hold on fluent signers who hold a letter 0.7-1.7 s; at
 * this tutor's 900 ms almost none of those holds is long enough to close
 * under ANY rule (9 of 60; the plain rule 0). The tolerance was not read off
 * a knee in that data -- there is none, and no negative examples to make one.
 * It was set from the other side: what motion must still break a hold.
 *
 * Logged with the session. */
export const TUTOR_COMMIT_OPTS = Object.freeze({
  ...COMMIT_DEFAULTS, holdMs: 900, settleMs: 300, stillPerFinger: true, stillTol: 0.10, stillAlign: true, placeTol: 1.0, heldOverPlace: Infinity, rearmAfterMs: 3500,
});

/* The study's expert mode (JT, 2026-10-07, for Karen's lab: lengthen both
 * times). The ring shows after 0.5 s still and the sign is graded at 1.5 s,
 * not 0.3 and 0.9, so a hand only pausing on its way is not graded. Everything
 * else is the tutor's. On the real held letters of
 * tests/fixtures/real-holds-ghana.json played at a third of real speed (holds
 * of about 3.3 s, slow moves between them), the tutor's ring committed 5 times
 * outside any held letter and this one none, and it still closed 20 of 22
 * holds (tests/real-holds.test.js). */
export const EXPERT_COMMIT_OPTS = Object.freeze({ ...TUTOR_COMMIT_OPTS, holdMs: 1500, settleMs: 500 });

/* Two committed poses closer than this, as shapes (palm widths, tutor/commit.js
 * shapeDistance), are the same answer given twice. 0.15 is the committer's own
 * idea of "the hand has not changed" (rearmTol); a real correction -- a thumb
 * tucked, a finger straightened -- moves two landmarks of a finger by several
 * times that. experiments/asl-tutor/flow.js says what happens to a repeat. */
export const SAME_POSE_TOL = 0.15;
/* How many still holds in a J or Z's starting shape are taken as the pause
 * before the drawing (see frame()) before one is graded as the answer. */
export const START_PAUSES_ALLOWED = 2;

/* Is the whole hand in the picture? Every landmark at least 2% in from every
 * edge. MediaPipe extrapolates the landmarks of a hand that is partly out of
 * frame, and the features of half a hand are finite, plausible and wrong --
 * that is what this guards. It used to demand the middle 80% of the picture,
 * which is a different and much stricter thing: on real video EVERY "I
 * couldn't see your hand" abstain came from it (research/live/REPORT.md B1,
 * 8% of the frames of correct, fully visible hands), because a hand held up
 * beside the face, or a wrist coming up from the bottom edge, is where hands
 * are. Still called `centered` in the quality record and the logs. */
export const EDGE_MARGIN = 0.02;
/* THE WRIST IS LET OFF, a little. The first recorded session (2026-09-21, a
 * laptop camera at 640x480) abstained "I couldn't see your hand clearly" six
 * times, five of them on a correct letter, and in all six the ONLY landmark
 * near an edge was the wrist, at the bottom one (y 0.98-1.03): at a desk a
 * forearm comes up from under the picture, so that is simply where wrists are
 * -- 7% of that session's frames. It costs the grade nothing: over the 163
 * held frames with the wrist at 0.98-1.05, the right letter was accepted in
 * every one, against 0.97-1.00 further in. So the wrist may overhang an edge
 * by this much; every finger and knuckle still has to be inside the margin. */
export const WRIST_OVERHANG = 0.05;
export function isCentered(flat) {
  for (let i = 0; i < flat.length; i += 3) {
    const x = flat[i], y = flat[i + 1];
    // A hole must fail by NAME: null compares as 0, which is inside a margin that is negative.
    if (typeof x !== "number" || typeof y !== "number") return false;
    const m = i === 0 ? -WRIST_OVERHANG : EDGE_MARGIN;
    if (!(x >= m && x <= 1 - m && y >= m && y <= 1 - m)) return false;
  }
  return true;
}

/* What the grader would say about ONE frame, right now, with every number it
 * used. Read-only: it touches neither the committer nor the flow, so looking
 * cannot change what the tutor does. It exists for ?debug=1
 * (experiments/asl-tutor/debug.js) -- the learner-facing page never shows a
 * score (ui.js says why), but somebody working out why a correct hand is not
 * accepted needs exactly these numbers, live, next to their own hand. */
export function inspectFrame(model, { flat, aspect, videoHeight }, target) {
  if (flat === null || flat.some((v) => !Number.isFinite(v))) return null;
  const points = toPoints(flat, aspect);
  const { sign, margin } = chirality(points);
  const x = featuresFromFlat(flat, aspect, sign);
  const quality = {
    handPresentFrac: 1,
    palmSizePx: palmSize(points) * videoHeight,
    centered: isCentered(flat),
    chiralityMargin: margin,
  };
  const v = verify(model, x, target, quality, { ignoreTier: true });
  const th = model.thresholds[target] ?? {};
  let top = [];
  const z = standardize(model, x);
  if (z.every(Number.isFinite)) {
    const { ll } = scoreAll(model, z);
    top = Object.entries(ll).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, l]) => ({ name, ll: l }));
  }
  return {
    sign, margin, palmSizePx: quality.palmSizePx, palmFrac: palmSize(points), centered: quality.centered,
    outcome: v.outcome, reason: v.reason, rival: v.rival ?? null,
    score: v.score, accept: th.accept ?? null, reject: th.reject ?? null,
    d2: v.d2, gate: v.gate, tier: v.tier, top,
  };
}

/**
 * @param {object} o
 * @param {object} o.model       a loaded model (tutor/verifier.js loadModel)
 * @param {string[]} o.letters
 * @param {"strict"|"lenient"} o.hintPolicy
 * @param {object} [o.commitOpts]
 * @param {object} [o.deps]      passed to createFlow (tests stub the verifier)
 */
export function createEngine({ model, letters, hintPolicy = "strict", commitOpts = TUTOR_COMMIT_OPTS, deps = {}, gradeAll = false, hand = null, motionParams = MOTION_DEFAULTS, holdOffMs = undefined, mix = null }) {
  const committer = createCommitter(commitOpts);
  /* mix ({ getOpenFS }): grade with tutor/mix.js. It needs the trial's tracked frames (OpenFS reads the whole
   * clip) and the hold being graded, so the engine keeps both. */
  let clip = [];         // { tMs, flat } of every tracked frame this trial, oldest first
  let commitCtx = null;  // set only while flow.onCommit runs
  if (mix) deps = { ...deps, verify: createMixedVerify({ verify, getOpenFS: mix.getOpenFS, getCommit: () => commitCtx, bThumb: !!mix.bThumb, looksLike: !!mix.looksLike }) };
  let recent = [];       // { tMs, flat, label } for the motion letters and the hand vote
  let flow = null;
  let lastGraded = null;   // the points of the last pose graded in THIS trial
  let queued = [];     // effects waiting for the trial's first frame
  let pending = [];    // { dueT, effect }: effects the flow asked to have LATER
  let startPauses = 0; // still holds in a J/Z starting shape let pass this trial

  /* Sort one batch of the flow's effects into: do now (returned to the glue),
   * do later (kept here), and the two the engine carries out itself. */
  function route(effects, tMs, out) {
    for (const e of effects) {
      if (e.afterMs > 0) {
        pending.push({ dueT: tMs + e.afterMs, effect: { ...e, afterMs: 0 } });
        if (e.kind === "end-trial") {
          // Nothing left to nag about once the trial is decided, and nothing
          // left to grade: without the hold-off the ring filled a whole lap
          // during every dwell and then graded nothing.
          out.push({ kind: "status", text: "" });
          committer.holdOff(tMs + e.afterMs);
        }
      } else if (e.kind === "hold-off") {
        committer.holdOff(tMs + e.ms);
      } else {
        out.push(e);
      }
    }
  }

  function flush(tMs, out) {
    for (let i = 0; i < pending.length;) {
      if (tMs >= pending[i].dueT) out.push(pending.splice(i, 1)[0].effect);
      else i++;
    }
  }

  return {
    /* A new trial. nextTrial(), NOT reset(), on the committer: a pose still
     * held up from the last letter must not be graded against this one
     * (tutor/commit.js nextTrial has the story). */
    startTrial(trial) {
      committer.nextTrial();
      flow = createFlow({ model, letters, hintPolicy, deps, gradeAll, handName: hand, ...(holdOffMs ? { holdOffMs } : {}) });
      recent = [];
      clip = [];
      pending = [];
      lastGraded = null;
      startPauses = 0;
      queued = flow.startTrial(trial);
    },

    /**
     * One frame.
     * @param {object} f
     * @param {number} f.tMs
     * @param {(number|null)[]|null} f.flat   flattenRounded landmarks, or null
     * @param {number} f.aspect               video width / height
     * @param {number} f.videoHeight          pixels
     * @returns {{progress:number, effects:object[], committed:boolean, sign:number|null}}
     */
    frame({ tMs, flat, aspect, videoHeight, handedness = null }) {
      if (flow === null) throw new Error("engine.frame: no trial has been started");
      const effects = [];
      recent.push({ tMs, flat, label: handedness });
      if (mix && flat !== null && flat.every(Number.isFinite)) {
        clip.push({ tMs, flat });
        if (clip.length > 2 * SECOND_OPINION.maxFrames) clip = clip.slice(-SECOND_OPINION.maxFrames);
      }
      while (recent.length && recent[0].tMs < tMs - motionParams.WINDOW_MS - 2000) recent.shift();
      if (queued.length) { route(queued, tMs, effects); queued = []; }

      const pushed = committer.push(tMs, flat, aspect);
      const progress = pushed.progress;
      let committed = pushed.committed;
      /* J and Z are movements (JT, 2026-09-24: "if the algorithm detects it,
       * you don't need the hold"). So on a J or Z trial the recent movement is
       * checked on every frame, and the moment it is recognised that IS the
       * answer: no hold. Only a recognised movement ends a trial this way; a
       * wrong one still needs a hold to be graded (and to get its hint). Not
       * while the ring is held shut (reading time, a decided trial's dwell). */
      if (!committed && flat && MOTION_LETTERS.includes(flow.state?.letter) && !flow.state?.ended) {
        const shut = committer.state.holdOffUntil !== null && tMs < committer.state.holdOffUntil;
        if (!shut) {
          const win = recent.filter((r) => r.flat && r.tMs >= tMs - motionParams.WINDOW_MS);
          const early = motionVerdict(flow.state.letter, win, aspect, motionParams);
          if (early.ok) committed = { flat, tStart: win[0]?.tMs ?? tMs, tCommit: tMs, handPresentFrac: 1, early: true };
        }
      }
      const cs = committer.state;
      route(flow.onStatus({ tMs, tooSmall: cs.tooSmall, lastResetReason: cs.lastResetReason }), tMs, effects);

      /* ...and on a J or Z trial a "hold" whose fingertip is still travelling
       * is not an answer: the hold rule lets a slowly moving hand count as
       * still, which on a J fired half-way down the stroke and graded half a
       * letter. Unless the movement is already recognised, it is ignored and
       * the drawing goes on. */
      if (committed && !committed.early && MOTION_LETTERS.includes(flow.state?.letter)) {
        const tip = flow.state.letter === "J" ? 20 : 8;
        const seg = recent.filter((r) => r.flat && r.tMs >= committed.tStart && r.tMs <= committed.tCommit);
        if (seg.length > 1) {
          const P = (f, i) => [f[3 * i] * aspect, f[3 * i + 1]];
          const palm = Math.hypot(...P(seg[0].flat, 0).map((v, k) => v - P(seg[0].flat, 9)[k])) || 1;
          const t0 = P(seg[0].flat, tip);
          const travel = Math.max(...seg.map((r) => Math.hypot(...P(r.flat, tip).map((v, k) => v - t0[k])))) / palm;
          const recognised = motionVerdict(flow.state.letter, recent.filter((r) => r.tMs >= committed.tStart - motionParams.WINDOW_MS && r.tMs <= committed.tCommit), aspect, motionParams).ok;
          if (travel > 0.3 && !recognised) committed = null;
        }
      }

      /* ...and a J or Z hand held still in the letter's own starting shape (an
       * I for J, a pointing index for Z) is the pause before the drawing, not
       * an answer. In the Prolific pilot (2026-09-28) people very often formed
       * the I, checked it against the picture, and only then drew the J; the
       * pause was graded as the answer and marked wrong. It is let through
       * only once it has been held so long that it plainly IS the answer
       * (START_PAUSES_ALLOWED re-holds, about eight seconds). On a teaching
       * trial the pause gets the drawing hint; on a test it gets nothing. */
      if (committed && !committed.early && MOTION_LETTERS.includes(flow.state?.letter) && startPauses < START_PAUSES_ALLOWED
          && inShape(flow.state.letter, committed.flat, aspect, motionParams)
          && !motionVerdict(flow.state.letter, recent.filter((r) => r.tMs >= committed.tStart - motionParams.WINDOW_MS && r.tMs <= committed.tCommit), aspect, motionParams).ok) {
        startPauses++;
        committed = null;
        if (flow.state.kind === "teach" || flow.state.kind === "intro") effects.push({ kind: "status", text: MOTION_HINTS[flow.state.letter].motion });
      }

      let sign = null;
      if (committed) {
        const points = toPoints(committed.flat, aspect);
        const c = chirality(points);
        sign = c.sign;
        let wrongHand = false;
        if (hand !== null) {
          const want = HAND_SIGN[hand];
          let madeWith = Math.abs(c.margin) >= HAND_MARGIN ? c.sign : null;
          if (madeWith === null) {
            const votes = recent.filter((r) => r.tMs >= committed.tStart && r.label).map((r) => (/^r/i.test(r.label) ? 1 : -1));
            if (votes.length) madeWith = votes.reduce((a, b) => a + b, 0) >= 0 ? 1 : -1;
          }
          wrongHand = madeWith !== null && madeWith !== want;
          // The asked-for hand is KNOWN, so a right hand whose geometry was
          // misread (sideways letters) is still graded as a right hand.
          if (!wrongHand) sign = want;
        }
        const x = featuresFromFlat(committed.flat, aspect, sign);
        const quality = {
          handPresentFrac: committed.handPresentFrac,
          // palmSize is measured on points whose x has been put on the y
          // scale, so it is already a fraction of the picture's HEIGHT; times
          // the real pixel height it is the palm's size on screen.
          palmSizePx: palmSize(points) * videoHeight,
          centered: isCentered(committed.flat),
          chiralityMargin: c.margin,
        };
        const samePose = lastGraded !== null && shapeDistance(lastGraded, points) <= SAME_POSE_TOL;
        if (!samePose) lastGraded = points;
        const letter = flow.state?.letter;
        const motion = MOTION_LETTERS.includes(letter)
          ? motionVerdict(letter, recent.filter((r) => r.tMs >= committed.tStart - motionParams.WINDOW_MS && r.tMs <= committed.tCommit), aspect, motionParams)
          : null;
        commitCtx = mix ? { flat: committed.flat, aspect, sign, tStart: committed.tStart, tCommit: committed.tCommit, clip } : null;
        try {
          route(flow.onCommit({ committed, x, quality, sign, samePose, motion, wrongHand }), tMs, effects);
        } finally {
          commitCtx = null;
        }
      }

      flush(tMs, effects);
      // `paused`: the ring is being held shut (reading time, or a decided
      // trial's dwell). The page dims it, so a still hand in front of a dead
      // ring reads as "wait" rather than "broken".
      const until = committer.state.holdOffUntil;
      return { progress, effects, committed: committed !== null, sign, paused: until !== null && tMs < until };
    },

    /* Everything still waiting, now. For a replay that has run out of frames:
     * a trial already decided and sitting out its dwell ends as what it WAS. */
    flushAll() {
      const out = [];
      flush(Infinity, out);
      return out;
    },

    hasPending: () => pending.length > 0,
    finishTrial: (endReason) => flow.finishTrial(endReason),
    summary: () => flow.summary(),
    get flowState() { return flow === null ? null : flow.state; },
    get committerState() { return committer.state; },
  };
}
