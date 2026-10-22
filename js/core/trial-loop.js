/* trial-loop.js: the timing skeleton of one trial, with no DOM in it so it can
 * be tested.
 *
 * A trial normally runs for its full duration: the loop waits for the next
 * camera frame, hands it to `step`, and stops when the clock runs out. Some
 * tasks want to stop sooner than that. A tutor asks for one handshape and the
 * moment the sign is accepted there is nothing left to record, so the
 * experiment calls endTrial("accepted") from inside its onFrame and the loop
 * finishes after that frame. `durationMs` is still the cap: an experiment that
 * never calls endTrial behaves exactly as it did before this file existed.
 *
 * WHY THIS IS ITS OWN FILE
 * Everything else about a trial needs a browser (a <video>, a canvas, MediaPipe).
 * The *timing* does not, and timing is the part that is easy to get subtly
 * wrong. Keeping it here, free of any DOM reference, means tests/trial-loop.test.js
 * can drive it with a fake clock under `node --test` and check the awkward
 * cases (end on the very first frame, a step that throws) in milliseconds.
 * Do not import anything browser-specific into this file. */

/* What a trial that simply ran out of time reports. It belongs to the runner:
 * an experiment that passes it (or an empty string) to endTrial gets "ended"
 * recorded instead, so "duration" in the data always means the timer. */
const RESERVED_REASON = "duration";
const FALLBACK_REASON = "ended";

/**
 * Run one trial's frame loop.
 *
 * @param {object}   o
 * @param {number}   o.durationMs    hard cap on the trial, in milliseconds
 * @param {() => number} o.now       a clock, normally () => performance.now()
 * @param {() => Promise<void>} o.nextFrame  resolves when it is worth looking again
 *                                  (normally the next animation frame)
 * @param {() => boolean} o.hasNewFrame  has the camera produced a new picture
 *                                  since the last step? The caller owns the
 *                                  bookkeeping for this: it records "the frame
 *                                  I just handled" inside its own `step`.
 * @param {(tMs: number, endTrial: (reason?: string) => void) => void} o.step
 *                                  called once per new frame, with the time
 *                                  since the trial started.
 * @param {(message: string) => void} [o.warn]  where to complain about a
 *                                  reserved reason. Injected so tests can read
 *                                  it instead of printing it.
 * @returns {Promise<{endReason: string}>}  "duration" if the clock ran out,
 *                                  otherwise whatever was passed to endTrial.
 */
export async function runTrialLoop({
  durationMs, now, nextFrame, hasNewFrame, step, warn = console.error,
}) {
  const t0 = now();
  let endReason = null;

  const endTrial = (reason = FALLBACK_REASON) => {
    // First caller wins: once a trial has ended, a later endTrial() is a no-op
    // whatever it passes. Checking this FIRST matters: a stray second call
    // must not be able to disturb a reason that was already set properly.
    if (endReason !== null) return;

    const text = String(reason);

    // "duration" is what a trial that ran its full length reports, and "" reads
    // as no reason at all. Either would blur the one distinction endReason
    // exists to make, so neither is accepted from an experiment.
    //
    // WHY THIS DOES NOT THROW. A reason is often computed (endTrial(state.label))
    // and a rare branch can make it empty. Throwing would escape through the
    // frame loop to the error screen: no session document, every trial already
    // uploaded orphaned, a participant lost at trial 30 over a naming mistake.
    // Recording "ended" keeps the session, and the complaint on the console
    // names the offending value so the experiment still gets fixed.
    if (text === "" || text === RESERVED_REASON) {
      warn(
        `endTrial(${JSON.stringify(reason)}): "" and "${RESERVED_REASON}" are reserved ` +
        `for the runner ("${RESERVED_REASON}" means the trial ran its full length), so ` +
        `"${FALLBACK_REASON}" was recorded instead. Pass something specific, for example ` +
        `endTrial("accepted").`
      );
      endReason = FALLBACK_REASON;
      return;
    }

    endReason = text;
  };

  while (endReason === null && now() - t0 < durationMs) {
    if (hasNewFrame()) step(now() - t0, endTrial);
    // Nothing is awaited once the trial has ended, so the last frame is the
    // frame that ended it, not the one after it. Note there is no try/catch
    // here on purpose: if `step` throws, the whole trial fails loudly rather
    // than quietly recording a trial's worth of nothing.
    if (endReason === null) await nextFrame();
  }
  return { endReason: endReason ?? RESERVED_REASON };
}
