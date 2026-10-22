/* =============================================================================
 *  _template.js, copy this file to start a new experiment.
 * =============================================================================
 *
 *  HOW TO USE IT
 *    1. cp experiments/_template.js experiments/my-experiment.js
 *    2. Change `id` to "my-experiment" (it must match the filename).
 *    3. Set ACTIVE_EXPERIMENT: "my-experiment" in config.js,
 *       or just open index.html?exp=my-experiment while you are testing.
 *
 *  THE FIVE HOOKS, in the order they happen:
 *
 *    onTrialStart(trial)   once per trial, before the countdown.
 *                          Return the starting `state` for this trial.
 *    onFrame({...})        once per camera frame. Do your measuring here.
 *                          Return numbers to be saved with that frame.
 *    draw(ctx, {...})      once per camera frame, after onFrame. Paint the
 *                          overlay the participant sees.
 *    onTrialEnd({...})     once per trial, when the trial stops. Return
 *                          summary numbers for this trial.
 *
 *  All of them are optional. An experiment with only `trials` still runs, it
 *  just records raw landmarks and nothing else, which is sometimes exactly
 *  what you want.
 *
 *  TWO MORE HOOKS, for tasks that need their own screen furniture:
 *
 *    mount(el, ctx)        once, before the first trial, with an empty <div>
 *                          inside the trial screen. Build any HTML your task
 *                          needs (a table of live numbers, a target to copy)
 *                          and keep the element to update later from onFrame.
 *                          ctx is { participant, condition, video }.
 *    renderResults(trials) at the very end. Return an HTML string to show on
 *                          the final screen instead of the default table.
 *    e2eSummary(trials)    OPTIONAL, and only for the unattended smoke run
 *                          (?autorun=1). Return a small flat object of your
 *                          own whole-session numbers; it is merged into the
 *                          page's machine-readable report under "experiment"
 *                          (tools/e2e-smoke.sh reads it). Use it for a check
 *                          that spans trials -- the per-trial report carries
 *                          scalars only. Never uploaded, never shown to a
 *                          participant, never called without ?autorun=1.
 *
 *  SHORT TRIALS THAT END THEMSELVES
 *  Some tasks are not "keep going for fifteen seconds", they are "do this one
 *  thing, and we are done the moment you do it". Four optional trial fields
 *  and one optional argument to onFrame cover that; see the fields marked
 *  OPTIONAL below and docs/CUSTOMIZE.md.
 * ===========================================================================*/

import { HAND, POSE, distance3d } from "../js/core/tracker.js";
import { drawLandmarks } from "../js/core/experiment.js";

export default {
  /* Must match the filename (without .js). */
  id: "_template",
  title: "My New Experiment",

  /* "hand" (21 landmarks) or "pose" (33 landmarks, whole body). */
  tracker: "hand",
  trackerOptions: { numHands: 1 },

  /* Shown once before the trials start. Plain HTML. */
  instructions: `
    <p>Explain the task here.</p>
    <ul><li>Keep instructions short and concrete.</li></ul>`,

  /* One object per trial. Any extra fields you add (like `hand` or
   * `targetSize` below) are handed to your hooks and saved with the data.
   *
   * OPTIONAL per-trial settings, for short trials. Leave them out and a trial
   * behaves exactly as it always has: a 3 second countdown, the full duration,
   * a "Saving…" screen, and a rest screen before the next one.
   *
   *   countdownSec: 0        no "3, 2, 1, GO" before this trial. (Default 3.
   *                          Three seconds before each of forty short trials
   *                          is most of the session.)
   *   skipRest: true         no rest screen after this trial.
   *   backgroundUpload: true don't make the participant watch the upload. The
   *                          upload starts and the next trial begins straight
   *                          away; everything still in flight is waited for at
   *                          the end. A failed upload is retried once and then
   *                          recorded in the session's `uploadErrors`, so it
   *                          is never lost without a trace.
   *   durationSec            still the CAP, even when a trial ends itself.
   */
  trials: [
    { id: "trial1", durationSec: 15, prompt: "Do the thing." },
    { id: "trial2", durationSec: 15, prompt: "Do the thing again." },
  ],

  /* ALTERNATIVE TO `trials`: choose each one as you go, for a task that cannot
   * know what comes next until it has seen how the last trial went (a tutor
   * deciding which letter to ask for). Define ONE of `trials` or `nextTrial`,
   * never both -- see js/core/trial-source.js and "Choosing each trial as you
   * go" in docs/CUSTOMIZE.md.
   *
   *   maxTrials: 20,   // caps the session (also what "trial N of ?" shows).
   *                     // Leave it out and a hard safety cap of 1000 applies,
   *                     // so a bug that never returns null cannot run forever.
   *   nextTrial(index, summariesSoFar) {
   *     // summariesSoFar is a COPY of trialSummaries so far -- read it, do
   *     // not rely on mutating it. Return the next trial object (sync or
   *     // async), or null/undefined once there is nothing left to ask for.
   *     if (index >= 20) return null;
   *     return { id: `t${index}`, letter: pickNextLetter(summariesSoFar) };
   *   },
   */

  onTrialStart(trial) {
    // Anything you need to keep track of during the trial goes here.
    return { count: 0 };
  },

  onFrame({ landmarks, worldLandmarks, handedness, handednessScore, tMs, trial,
            state, addEvent, endTrial, video }) {
    // `landmarks`, on-screen positions, x and y between 0 and 1. Use for drawing.
    // `worldLandmarks`, real-world positions in metres. Use for measuring.
    // Both are null on frames where nothing was detected, always check.
    //
    // `handedness` is "Left"/"Right" AS MEDIAPIPE REPORTS IT, and it reports
    // the mirror image: a physical RIGHT hand comes back as "Left", because the
    // model is shown the unmirrored camera picture. It is passed on uncorrected
    // on purpose. `handednessScore` (0 to 1, or null) is how sure it is.
    //
    // `video` is { width, height, aspect }: the camera's REAL frame size, which
    // is not always the one requested in config.js. Any angle you compute from
    // `landmarks` needs it, because x is measured across the width and y down
    // the height, so assuming a square frame quietly distorts every angle.
    //
    // `endTrial(reason)` stops this trial after the current frame and records
    // `reason` on the trial summary. Use it when the trial has achieved what
    // it was for, e.g. endTrial("accepted") once the participant holds the
    // right shape. `durationSec` is still the cap; not calling it changes
    // nothing. Only the first call counts. "duration" and "" are the runner's
    // own words ("duration" means the timer ran out), so passing either records
    // "ended" and logs a complaint rather than ending the session.
    if (!worldLandmarks) return {};

    const someDistance = distance3d(
      worldLandmarks[HAND.THUMB_TIP],
      worldLandmarks[HAND.INDEX_TIP]
    );

    // Call addEvent() when something noteworthy happens. Events are stored in
    // the small session document, so they are cheap to look at later.
    // addEvent("my_event", { value: someDistance });

    // Whatever you return is saved alongside the raw landmarks for this frame.
    return { someDistance };
  },

  draw(ctx, { landmarks, derived, state, trial, canvas, tMs }) {
    // ctx is a normal 2D canvas context, already cleared for you.
    drawLandmarks(ctx, canvas, landmarks);
  },

  onTrialEnd({ frames, events, trial, state, endReason }) {
    // Return per-trial summary numbers. These end up in the session document
    // and in the metrics table, so put anything you want to eyeball here.
    //
    // `endReason` is "duration" when the trial ran its full length, or whatever
    // was passed to endTrial(). It is saved on the trial either way, so you do
    // not have to return it.
    return { count: state.count };
  },

  /* OPTIONAL. Called once, before the first trial, with an empty <div> inside
   * the trial screen (it is hidden unless you define this). Build whatever
   * your task needs and keep a reference to update it from onFrame.
   *
   *   mount(el, { participant, condition, video }) {
   *     el.innerHTML = `<p id="target">…</p>`;
   *   },
   *
   * OPTIONAL. Called once at the end with the array of trial summaries. Return
   * an HTML string to replace the default results table on the final screen.
   *
   *   renderResults(trials) {
   *     return `<p>You got ${trials.filter((t) => t.correct).length} right.</p>`;
   *   },
   */
};
