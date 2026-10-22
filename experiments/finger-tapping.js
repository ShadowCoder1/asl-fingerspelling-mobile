/* =============================================================================
 *  finger-tapping.js, tap your index finger against your thumb, fast.
 * =============================================================================
 *
 *  This is a complete, working experiment. Read it top to bottom: it is the
 *  fastest way to understand how experiments are built here. To make your own,
 *  copy experiments/_template.js instead of editing this file.
 *
 *  WHAT IT MEASURES
 *  The distance between the thumb tip and the index fingertip ("aperture").
 *  When you tap, that distance oscillates. Counting the oscillations gives you
 *  tapping rate; their spacing gives you rhythm; their size gives you
 *  amplitude, and whether amplitude shrinks over time (the "sequence effect"
 *  that clinicians look for in Parkinson's disease).
 *
 *  A NOTE ON WHERE THE REAL ANALYSIS HAPPENS
 *  The tap detection below runs live so the participant sees a counter go up.
 *  It is deliberately simple. The numbers you put in a paper should come from
 *  analysis/metrics.py, which re-derives every tap from the raw landmarks with
 *  parameters you can change afterwards. Detecting twice is not a mistake, *  it means you are never stuck with a threshold you chose before seeing data.
 * ===========================================================================*/

import { HAND, distance3d } from "../js/core/tracker.js";
import { drawLandmarks } from "../js/core/experiment.js";

export default {
  id: "finger-tapping",
  title: "Finger Tapping",

  /* Which MediaPipe model to run, and how to configure it. */
  tracker: "hand",
  trackerOptions: { numHands: 1 },

  /* Shown once, before the first trial. Plain HTML. */
  instructions: `
    <p>You will tap your <strong>index finger against your thumb</strong>,
    like a pinching movement, over and over.</p>
    <ul>
      <li>Open your fingers <strong>as wide as you can</strong> between taps.</li>
      <li>Tap <strong>as fast as you can</strong>, and keep going for the whole
          15 seconds.</li>
      <li>Keep your hand in view of the camera the whole time.</li>
    </ul>
    <p>You will do this twice: once with each hand.</p>`,

  /* One entry per trial. Add, remove, or reorder these freely. */
  trials: [
    { id: "right", hand: "right", durationSec: 15,
      prompt: "Tap with your <strong>RIGHT</strong> hand, as fast and as wide as you can." },
    { id: "left", hand: "left", durationSec: 15,
      prompt: "Now tap with your <strong>LEFT</strong> hand, as fast and as wide as you can." },
  ],

  /* --------------------------------------------------------------------
   * Called once at the start of each trial. Whatever you return becomes
   * `state`, which every later hook can read and write.
   * ------------------------------------------------------------------ */
  onTrialStart(trial) {
    return {
      taps: 0,
      isOpen: true,          // are the fingers currently apart?
      lastTapMs: -Infinity,
      minR: Infinity,        // smallest aperture seen so far this trial
      maxR: -Infinity,       // largest
      peakSinceTap: 0,       // widest opening since the last tap
    };
  },

  /* --------------------------------------------------------------------
   * Called once per video frame. Return an object and those numbers get
   * stored next to the raw landmarks for that frame.
   * ------------------------------------------------------------------ */
  onFrame({ worldLandmarks, tMs, state, addEvent }) {
    if (!worldLandmarks) return {};   // hand not visible this frame

    // World landmarks are in metres with the origin at the center of the hand,
    // so this distance does not change when the participant leans towards the
    // camera. That is why we use them instead of the on-screen coordinates.
    const apertureM = distance3d(
      worldLandmarks[HAND.THUMB_TIP],
      worldLandmarks[HAND.INDEX_TIP]
    );

    // Dividing by the participant's own hand size makes the signal comparable
    // between people with different sized hands.
    const handSpanM = distance3d(
      worldLandmarks[HAND.WRIST],
      worldLandmarks[HAND.MIDDLE_MCP]
    );
    const r = handSpanM > 0 ? apertureM / handSpanM : 0;

    /* ---- live tap detection (see the note at the top of this file) ---- */
    state.minR = Math.min(state.minR, r);
    state.maxR = Math.max(state.maxR, r);
    state.peakSinceTap = Math.max(state.peakSinceTap, r);

    const range = state.maxR - state.minR;

    // Only start counting once we have seen the participant open AND close at
    // least once, so we know what their personal range actually is.
    if (range > MIN_RANGE) {
      const closeAt = state.minR + range * CLOSE_FRACTION;
      const openAt  = state.minR + range * OPEN_FRACTION;

      // Two different thresholds (a "Schmitt trigger"). A single threshold
      // would count several taps every time the signal wobbled across it.
      if (state.isOpen && r < closeAt && tMs - state.lastTapMs > REFRACTORY_MS) {
        state.isOpen = false;
        state.taps += 1;
        state.lastTapMs = tMs;
        addEvent("tap", { aperture: r, peakBefore: state.peakSinceTap });
        state.peakSinceTap = 0;
      } else if (!state.isOpen && r > openAt) {
        state.isOpen = true;
      }
    }

    // Anything returned here is saved with the frame.
    return { aperture: r, apertureM, handSpanM };
  },

  /* --------------------------------------------------------------------
   * Called once per frame, after onFrame. Paint whatever you want.
   * ------------------------------------------------------------------ */
  draw(ctx, { landmarks, derived, state, canvas, setReadout }) {
    drawLandmarks(ctx, canvas, landmarks, state.isOpen ? "#4ade80" : "#f87171");

    if (landmarks) {
      // A line between the two fingertips being measured.
      const a = landmarks[HAND.THUMB_TIP], b = landmarks[HAND.INDEX_TIP];
      ctx.strokeStyle = state.isOpen ? "#4ade80" : "#f87171";
      ctx.lineWidth = 6;
      ctx.beginPath();
      ctx.moveTo(a.x * canvas.width, a.y * canvas.height);
      ctx.lineTo(b.x * canvas.width, b.y * canvas.height);
      ctx.stroke();
    }

    // The running tap count. This goes into an HTML element rather than onto
    // the canvas, because the canvas is mirrored and text would come out
    // backwards.
    setReadout(`<span class="big">${state.taps}</span><span class="unit">taps</span>`);
  },

  /* --------------------------------------------------------------------
   * Called when the trial's timer runs out. Whatever you return is stored
   * in the small session document, ready to read without downloading the
   * raw frames.
   * ------------------------------------------------------------------ */
  onTrialEnd({ events, trial }) {
    const taps = events.filter((e) => e.type === "tap");
    const times = taps.map((e) => e.t);
    const itis = times.slice(1).map((t, i) => t - times[i]);   // inter-tap intervals, ms

    return {
      tapCount: taps.length,
      tapRateHz: taps.length / trial.durationSec,
      meanItiMs: mean(itis),
      sdItiMs: sd(itis),
      cvIti: mean(itis) ? sd(itis) / mean(itis) : null,   // rhythm variability
      meanPeakAperture: mean(taps.map((e) => e.peakBefore)),
      note: "Preliminary, from live detection. analysis/metrics.py is authoritative.",
    };
  },
};

/* ---- tuning knobs for the live detector -------------------------------- *
 * These only affect the on-screen counter. Change the equivalents in
 * analysis/metrics.py to change your actual results.                       */
const MIN_RANGE      = 0.25;  // how much the signal must span before we count
const CLOSE_FRACTION = 0.35;  // a tap is registered below this much of the range
const OPEN_FRACTION  = 0.55;  // fingers count as re-opened above this much
const REFRACTORY_MS  = 100;   // ignore taps closer together than this

const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : null);
const sd = (a) => {
  if (a.length < 2) return null;
  const m = mean(a);
  return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1));
};
