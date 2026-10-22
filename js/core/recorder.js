/* recorder.js: collects one row of numbers per video frame, and splits the
 * result into Firestore-sized pieces.
 *
 * WHY CHUNKING EXISTS
 * A Firestore document can hold at most 1 MiB. One frame of hand tracking is
 * about 1.2 KB (21 landmarks x 3 coordinates, twice: screen + world). A 30-
 * second trial at 30 fps is therefore about 1.1 MB, which is over the limit. So we cut
 * the frame list into chunks of RECORDING.chunkFrames and store each chunk as
 * its own document. analysis/fetch_data.py glues them back together, so you
 * never have to think about this again. */

import { RECORDING } from "../../config.js";
import { flattenRounded, DECIMALS } from "../../tutor/landmarks.js";

/* Coordinate precision has ONE home, tutor/landmarks.js's DECIMALS, because
 * the grader reads back the same rounded numbers this file saves. config.js
 * used to carry a `decimals` knob as well, documented as something a
 * researcher might turn; turning it would have meant a sign graded online at
 * one rounding and re-graded offline at another, with nothing on the screen or
 * in the data to say which answer to believe. The knob is gone, and this
 * guard is what stops it coming quietly back. */
export function assertPrecisionAgrees(recording) {
  const configured = recording?.decimals;
  if (configured !== undefined && configured !== DECIMALS) {
    throw new Error(
      `config.js sets RECORDING.decimals to ${configured}, but landmarks are rounded to ` +
      `${DECIMALS} decimals by DECIMALS in tutor/landmarks.js, which is also what the ` +
      "grader reads. Coordinate precision is not a config knob: remove RECORDING.decimals, " +
      "and change DECIMALS if the precision itself is wrong."
    );
  }
}

assertPrecisionAgrees(RECORDING);

export class Recorder {
  constructor(opts = {}) {
    this.chunkFrames = opts.chunkFrames ?? RECORDING.chunkFrames;
    // Landmark precision comes from tutor/landmarks.js, not from config.js:
    // see assertPrecisionAgrees above. opts.decimals stays so a test can round
    // differently on purpose.
    this.decimals    = opts.decimals    ?? DECIMALS;
    this.frames = [];
    this.events = [];
  }

  /** Throw away anything recorded so far. Call at the start of each trial. */
  reset() {
    this.frames = [];
    this.events = [];
  }

  /**
   * Store one frame.
   *
   * @param {number} tMs      milliseconds since this trial started
   * @param {object|null} lm  landmark array for ONE hand/person (image coords),
   *                          or null if nothing was detected this frame
   * @param {object|null} wl  the matching world landmarks (metres), or null
   * @param {object} derived  any extra numbers your experiment computed, e.g.
   *                          { aperture: 0.41 }. Kept alongside the raw data.
   * @param {object|null} extra  optional per-frame facts the runner knows and
   *                          your experiment does not: { h, hs, vt }. Leave it
   *                          out and the stored frame is exactly what earlier
   *                          versions of this file wrote, byte for byte.
   */
  addFrame(tMs, lm, wl, derived = {}, extra = null) {
    const frame = {
      t: round(tMs, 1),
      lm: lm ? flattenRounded(lm, this.decimals) : null,
      wl: wl ? flattenRounded(wl, this.decimals) : null,
      d: roundValues(derived, 5),
    };

    if (extra) {
      // h: which hand MediaPipe said this was, AS REPORTED ("L" or "R"), and
      // hs: how confident it was. We do NOT correct the label here. Measured
      // on this platform's unmirrored camera image (research/live/REPORT.md
      // section 1), a physical RIGHT hand comes back labelled "Right". Code
      // that needs to know which hand it is really looking at works it out
      // from the geometry instead (tutor/hand-frame.js), because that label
      // can flip at frame edges regardless of mirroring; MediaPipe's label is
      // kept only as a cross-check, and it is only useful as a cross-check if
      // it is stored raw.
      frame.h = extra.h ?? null;
      frame.hs = round(extra.hs, 3);
      // vt: the video element's own media time, in seconds. `t` is wall-clock
      // time since the trial started; `vt` is the timestamp of the picture the
      // landmarks actually came from. They drift apart when the browser is
      // busy, and only `vt` tells you two frames were really the same picture.
      frame.vt = round(extra.vt, 3);
    }

    this.frames.push(frame);
  }

  /**
   * Note that something happened at a point in time, a tap, a button press,
   * a target appearing. Events are stored in the small session document, so
   * they are cheap to query later.
   */
  addEvent(tMs, type, data = {}) {
    this.events.push({ t: round(tMs, 1), type, ...roundValues(data, 5) });
  }

  /** How many frames actually contained a detected hand/person. */
  detectionRate() {
    if (!this.frames.length) return 0;
    const hits = this.frames.filter((f) => f.lm !== null).length;
    return hits / this.frames.length;
  }

  /** Split the recorded frames into Firestore-sized arrays. */
  toChunks() {
    const out = [];
    for (let i = 0; i < this.frames.length; i += this.chunkFrames) {
      out.push(this.frames.slice(i, i + this.chunkFrames));
    }
    return out;
  }
}

/* ---- helpers ---------------------------------------------------------- */

function round(v, decimals) {
  if (typeof v !== "number" || !Number.isFinite(v)) return null;
  const p = 10 ** decimals;
  return Math.round(v * p) / p;
}

function roundValues(obj, decimals) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = typeof v === "number" ? round(v, decimals) : v;
  }
  return out;
}
