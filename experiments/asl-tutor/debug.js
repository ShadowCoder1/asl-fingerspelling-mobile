/* debug.js: ?debug=1 -- what the grader sees, live, and a recording to keep.
 *
 * NOT FOR LEARNERS. The tutor's own page never shows a score (ui.js says why);
 * this panel shows all of them, because the person reading it is trying to
 * find out why a correct hand is not being accepted, and that cannot be done
 * from "Not quite". It is off unless the URL asks for it, and a session run
 * with it on says so in its log.
 *
 * TWO JOBS:
 *   1. THE PANEL. For the frame on screen: the three likeliest letters, the
 *      target's score against its accept/reject thresholds, its distance
 *      against the typicality gate, which hand the geometry thinks this is and
 *      how sure, how big the hand is, and what the hold-still ring is doing.
 *   2. THE RECORDING. Every frame of the session, in the same file format
 *      replay mode plays back (js/core/replay.js), plus which letter was being
 *      asked for on each frame. "Save recording" downloads it; it is also
 *      saved when the session ends. That file is a real hand in front of a
 *      real camera with the intended letter attached, which is the one thing
 *      the bootstrap model has never had (training/MODEL_REPORT.md). Landmarks
 *      only -- no picture ever leaves the camera -- but hand geometry is
 *      biometric, so the file is the learner's to share or not.
 */

import { inspectFrame } from "./engine.js";
import { createRecording } from "./debug-recording.js";

const PANEL_EVERY_MS = 150;
const f1 = (v) => (Number.isFinite(v) ? v.toFixed(1) : String(v));
const f3 = (v) => (Number.isFinite(v) ? v.toFixed(3) : String(v));

/* `canSave` is false in replay mode: the "recording" would be a copy of the
 * file being played, and ?autorun=1 clicks every button on the page -- the
 * smoke test was dropping one-frame files into the Downloads folder of whoever
 * ran it. */
export function createDebug(el, { getModel, canSave = true }) {
  const wrap = document.createElement("div");
  wrap.className = "tutor-debug";
  wrap.innerHTML = `
    <div class="tutor-debug-head">
      <strong>debug</strong>
      ${canSave ? '<button type="button" id="tutor-debug-save">Save recording</button>' : '<span class="subtle">replay: nothing to save</span>'}
      <span id="tutor-debug-count" class="subtle"></span>
    </div>
    <pre id="tutor-debug-pre" aria-hidden="true">waiting for the first frame…</pre>`;
  el.append(wrap);
  const pre = wrap.querySelector("#tutor-debug-pre");
  const count = wrap.querySelector("#tutor-debug-count");

  const rec = createRecording();
  let video = null;
  let t0 = null;
  let lastPanel = -Infinity;
  let saved = 0;

  const trialStart = (trial) => rec.trialStart(trial);

  function frame({ flat, handedness, handednessScore, trial, videoInfo, committerState, progress }) {
    const now = performance.now();
    if (t0 === null) t0 = now;
    video = { width: videoInfo.width, height: videoInfo.height };
    const kept = rec.addFrame({ flat, handedness, handednessScore, tWallMs: now - t0 });
    const times = rec.times();

    if (now - lastPanel < PANEL_EVERY_MS) return;
    lastPanel = now;
    count.textContent = kept ? `${rec.frameCount()} frames recorded` : `${rec.frameCount()} frames recorded — FULL, save it now`;
    const model = getModel();
    if (!model) return;
    const fps = times.length > 30 ? 30000 / (times[times.length - 1] - times[times.length - 31]) : NaN;
    const head = `asked for: ${trial.letter} (${trial.kind})    ${f1(fps)} fps    ${videoInfo.width}x${videoInfo.height}`;
    const ring = `ring: progress ${f3(progress)}  armed ${committerState.armed}  tooSmall ${committerState.tooSmall}  ` +
                 `lastReset ${committerState.lastResetReason ?? "-"}  holdOffUntil ${committerState.holdOffUntil ?? "-"}`;
    const info = inspectFrame(model, { flat, aspect: videoInfo.aspect, videoHeight: videoInfo.height }, trial.letter);
    if (info === null) {
      pre.textContent = `${head}\nNO HAND\n${ring}`;
      return;
    }
    const top = info.top.map((t) => `${t.name} ${f1(t.ll)}`).join("   ");
    pre.textContent = [
      head,
      `likeliest:   ${top}`,
      `would say:   ${info.outcome.toUpperCase()}${info.reason ? ` (${info.reason})` : ""}${info.rival ? `   rival ${info.rival}` : ""}   [tier ${info.tier}]`,
      `score:       ${f1(info.score)}   accept at >= ${f1(info.accept)}   reject below ${f1(info.reject)}`,
      `distance:    ${f1(info.d2)}   gate ${f1(info.gate)}   ${info.d2 > info.gate ? "OUTSIDE the gate -> reject" : "inside"}`,
      `hand:        ${info.sign > 0 ? "appears RIGHT" : "appears LEFT"} (margin ${f3(info.margin)})   MediaPipe says ${handedness ?? "-"} ${f3(handednessScore)}`,
      `size:        palm ${f1(info.palmSizePx)} px (${f3(info.palmFrac)} of height)   centered ${info.centered}`,
      ring,
    ].join("\n");
  }

  const attempt = (data) => rec.attempt(data);
  const doc = () => rec.doc({ video, userAgent: navigator.userAgent, savedAt: new Date().toISOString() });

  function save() {
    if (!canSave || rec.frameCount() === 0) return;
    const blob = new Blob([JSON.stringify(doc())], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `asl-tutor-debug-${new Date().toISOString().replace(/[:.]/g, "-")}${saved ? `-${saved}` : ""}.json`;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    saved++;
  }
  if (canSave) wrap.querySelector("#tutor-debug-save").onclick = save;

  return { trialStart, frame, attempt, save, frameCount: () => rec.frameCount() };
}
