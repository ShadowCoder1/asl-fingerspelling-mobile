/* =============================================================================
 *  asl-probe.js, watch the seven articulatory blocks of your own hand.
 * =============================================================================
 *
 *  WHAT IT IS FOR
 *  This is not a task and it grades nothing. It is the window into the feature
 *  pipeline: hold your hand up and the table shows what tutor/features.js is
 *  currently measuring, block by block. Curl your index finger and the index
 *  row moves. Turn your hand sideways and the orientation row moves. Switch
 *  hands and the chirality sign flips while the block values stay put, which
 *  is the whole point of canonicalizing a hand before measuring it.
 *
 *  It is also the experiment the headless smoke test drives
 *  (tools/e2e-smoke.sh), because one trial of it touches most of the pipeline:
 *  rounding, the median window, chirality, the palm frame, all 46 features,
 *  and the runner's endTrial(). What makes that worth anything is that the
 *  smoke test reads back the two numbers onTrialEnd returns below --
 *  gradedFrames and sign -- so featurization that quietly stopped happening
 *  fails it. The frame counts on their own would not: the runner produces
 *  those whether or not this file measures a thing.
 *
 *  It does NOT cover the positioning gate. A replay skips that screen
 *  entirely, so js/core/experiment.js's positioningLoop has never been run by
 *  the smoke test, nor has the camera, MediaPipe or Firebase.
 *
 *  THE SEVEN BLOCKS (tutor/features.js) are thumb, index, middle, ring, pinky,
 *  spread and orientation. A block is the group of features that one
 *  articulator controls, and it is the unit a tutor gives feedback in: "your
 *  ring finger is too straight", not "feature 23 is 18 degrees out".
 *
 *  ONE FRAME IS NOT ENOUGH. Landmarks wobble by a pixel or two from frame to
 *  frame, so every number here comes from the MEDIAN of a 7-frame window
 *  (about a quarter of a second) rather than the newest frame. Dropouts are
 *  pushed into that window as nulls and skipped, never filled in: a hand that
 *  vanished for four frames has to show as a gap, not as a hand that held
 *  still.
 * ===========================================================================*/

import { flattenRounded, medianFlat, toPoints, DECIMALS } from "../tutor/landmarks.js";
import { chirality, palmSize } from "../tutor/hand-frame.js";
import { featuresFromFlat, FEATURE_NAMES, BLOCKS } from "../tutor/features.js";

/* How many frames the median runs over. Odd, so the median is always a value
 * that was really measured. Seven frames is ~230 ms at 30 fps: long enough to
 * kill the wobble, short enough that the table still feels live. */
const WINDOW_FRAMES = 7;

/* Below this, the left/right decision is a coin flip and the whole canonical
 * frame with it. `margin` is a length in image units, so it is divided by the
 * hand's own palm size first (tutor/hand-frame.js palmSize -- the same
 * quantity the size-normalized features divide by), making the threshold
 * independent of how big the hand is in the picture. For reference, measured
 * on synthetic hands: a perfectly flat hand gives 0.26, a relaxed open hand
 * 1.8, a fist 2.7. (Those three were first measured against the
 * wrist-to-middle-knuckle distance, as 0.24 / 1.7 / 2.5; that span is a fixed
 * 1.0832x the palm size for every pose of the synthetic hand, since both are
 * built from the same rigid palm, so the numbers carry over exactly.) */
const AMBIGUOUS_MARGIN = 0.5;

// Built by mount(), used by onFrame(). One experiment runs at a time, and the
// runner mounts before the first trial, so a module-level handle is enough.
let view = null;

export default {
  id: "asl-probe",
  title: "Hand feature probe",

  tracker: "hand",
  trackerOptions: { numHands: 1 },

  instructions: `
    <p>Hold one hand up in front of the camera, palm toward it, and move it
       around while you watch the table.</p>
    <ul>
      <li>Curl one finger at a time: only that finger's row should move.</li>
      <li>Turn your hand sideways: the orientation row moves, the finger rows
          should not.</li>
      <li>Swap hands: the hand line flips, the block values stay put.</li>
    </ul>
    <p>Nothing is being graded. This is a look at what the tutor measures.</p>`,

  /* One trial, no countdown: there is nothing to get ready for. 20 seconds is
   * long enough to try a few shapes; a replay ends it as soon as the recording
   * runs out (see onFrame). */
  trials: [
    { id: "probe", durationSec: 20, countdownSec: 0, skipRest: true,
      prompt: "Move your hand and watch the seven blocks." },
  ],

  /* The tracker is handed to onTrialStart so an experiment can ask it things.
   * Replay mode's tracker (js/core/replay.js) sets `exhausted` when the
   * recording runs out; a real MediaPipe tracker never does, and then this
   * trial simply runs its 20 seconds. */
  onTrialStart(trial, { tracker }) {
    return { tracker, window: [], graded: 0, sign: null };
  },

  onFrame({ landmarks, handedness, handednessScore, state, video, endTrial }) {
    // A dropout goes into the window as null rather than being left out, so
    // seven entries always mean the last seven frames.
    state.window.push(landmarks ? flattenRounded(landmarks, DECIMALS) : null);
    if (state.window.length > WINDOW_FRAMES) state.window.shift();

    const flat = medianFlat(state.window);
    let derived = {};

    if (flat === null) {
      view?.noHand();
    } else {
      // The real aspect ratio, not a guess: MediaPipe measures x across the
      // width and y down the height, so a wrong ratio bends every angle below.
      const points = toPoints(flat, video.aspect);
      const { sign, margin } = chirality(points);
      const values = featuresFromFlat(flat, video.aspect, sign);
      view?.update(values, { sign, margin, points, handedness, handednessScore });
      state.graded++;
      state.sign = sign;
      derived = { sign, margin };
    }

    // Replay only: stop as soon as the recording is used up instead of waiting
    // out the 20 seconds on an empty file. "duration" and "" are reserved by
    // the runner, so this reason has to be its own word.
    if (state.tracker?.exhausted) endTrial("replay-finished");

    return derived;
  },

  onTrialEnd({ state }) {
    return { gradedFrames: state.graded, sign: state.sign };
  },

  /* The table lives in #exp-mount, which sits OUTSIDE the mirrored video: text
   * drawn on the canvas itself would come out back to front. There is no
   * draw() here on purpose, so the overlay stays the platform's plain
   * landmark skeleton. */
  mount(el) {
    el.innerHTML = `
      <p id="probe-hand" class="subtle">Looking for your hand…</p>
      <p id="probe-warning" class="bad" hidden></p>
      <table class="results">
        <tr><th>block</th><th>what it is doing</th></tr>
        ${BLOCKS.map((b) => `<tr><th>${b}</th><td id="probe-${b}">—</td></tr>`).join("")}
      </table>
      <p class="subtle">Angles in degrees; distances in palm widths (the mean of
         the five spans across the palm, tutor/hand-frame.js palmSize, which is
         what the features themselves divide by). Median of the last
         ${WINDOW_FRAMES} frames.</p>`;

    const cells = {};
    for (const block of BLOCKS) cells[block] = el.querySelector(`#probe-${block}`);
    const handLine = el.querySelector("#probe-hand");
    const warning = el.querySelector("#probe-warning");

    view = {
      noHand() {
        handLine.textContent = "No hand in the last few frames.";
        warning.hidden = true;
        warning.textContent = "";
        // Blanked rather than frozen at their last values: a table that keeps
        // showing numbers for a hand that is not there is a lie.
        for (const block of BLOCKS) cells[block].textContent = "—";
      },

      update(values, { sign, margin, points, handedness, handednessScore }) {
        const f = {};
        for (let i = 0; i < FEATURE_NAMES.length; i++) f[FEATURE_NAMES[i]] = values[i];

        // sign +1 means the camera is looking at a hand shaped like a right
        // hand. MediaPipe's own label is shown beside it as an independent
        // cross-check: measured on this platform's unmirrored image
        // (research/live/REPORT.md section 1), it says "Right" for that same
        // physical right hand. It is the NEWEST frame's label, where
        // everything else here is the median of the window, so during a
        // dropout it can read "none" next to perfectly good numbers.
        const physical = sign === 1 ? "right" : "left";
        const label = handedness ? `${handedness}${handednessScore == null ? "" : ` ${handednessScore.toFixed(2)}`}` : "none";
        // || 1 for a degenerate hand, where palmSize is 0: a margin reported
        // as Infinity would read as "certainly a right hand" on exactly the
        // frames where there is nothing to be certain about.
        const scaled = margin / (palmSize(points) || 1);
        handLine.textContent =
          `Geometry says a ${physical} hand (sign ${sign > 0 ? "+1" : "-1"}, ` +
          `margin ${scaled.toFixed(2)} palm widths). ` +
          `MediaPipe's label for this frame: ${label}.`;

        const ambiguous = Math.abs(scaled) < AMBIGUOUS_MARGIN;
        warning.hidden = !ambiguous;
        // Cleared rather than left standing, so the message can never be a
        // leftover from some earlier frame.
        warning.textContent = ambiguous
          ? "Flat hand: left/right is ambiguous, so these numbers may be mirrored. " +
            "Curl your fingers slightly toward the camera."
          : "";

        cells.thumb.textContent =
          `tip radial ${num(f.thumbtip_radial)}, distal ${num(f.thumbtip_distal)}, ` +
          `palmar ${num(f.thumbtip_palmar)} · to index tip ${num(f.d_thumbtip_index_tip)}`;

        for (const finger of ["index", "middle", "ring", "pinky"]) {
          const mcp = f[`flex_${finger}_mcp`], pip = f[`flex_${finger}_pip`], dip = f[`flex_${finger}_dip`];
          cells[finger].textContent =
            `flexion ${deg((mcp + pip + dip) / 3)} mean (mcp ${deg(mcp)}, pip ${deg(pip)}, dip ${deg(dip)})`;
        }

        cells.spread.textContent =
          `index-middle ${deg(f.abd_index_middle)}, middle-ring ${deg(f.abd_middle_ring)}, ` +
          `ring-pinky ${deg(f.abd_ring_pinky)} · crossing ${num(f.cross_im_radial)}`;

        cells.orientation.textContent =
          `palm normal (${num(f.palmnormal_x)}, ${num(f.palmnormal_y)}, ${num(f.palmnormal_z)}) · ` +
          `hand direction (${num(f.handdir_x)}, ${num(f.handdir_y)}, ${num(f.handdir_z)})`;
      },
    };
  },

  renderResults(trials) {
    const rows = trials.map((t) => `<tr>
      <th>${t.id}</th>
      <td>${t.frameCount} frames</td>
      <td>${Math.round((t.detectionRate ?? 0) * 100)}% with a hand</td>
      <td>${t.gradedFrames ?? 0} measured</td>
      <td>ended: ${t.endReason}</td>
    </tr>`);
    return `<table class="results">
      <tr><th>trial</th><th>recorded</th><th>tracking</th><th>features</th><th>why it stopped</th></tr>
      ${rows.join("")}
    </table>`;
  },
};

/* ---- formatting -------------------------------------------------------- */

// NaN is a real answer here (a degenerate hand makes every size-normalized
// feature NaN, see tutor/features.js), so it is shown rather than hidden.
const deg = (v) => (Number.isFinite(v) ? `${v.toFixed(0)}°` : "n/a");
const num = (v) => (Number.isFinite(v) ? v.toFixed(2) : "n/a");
