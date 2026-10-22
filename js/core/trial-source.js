/* trial-source.js: how the runner decides which trials to run, and how many
 * of them there will be.
 *
 * Most experiments (finger tapping, the feature probe) know every trial before
 * the first one starts: a plain array, or a function that builds one. A tutor
 * cannot do that -- which letter comes next depends on how the last one went
 * -- so it defines nextTrial(index, summariesSoFar) instead, and hands back
 * one trial at a time.
 *
 * This file is the seam between those two shapes and the runner's loop. Both
 * come out looking the same to js/core/experiment.js: { next(summaries),
 * total }, plus a little bookkeeping the session document wants (see `kind`
 * and `endedBecause` below). The runner never has to ask which kind of
 * experiment it is running.
 *
 * DOM-FREE ON PURPOSE. No `document`, `window`, or `location` at module scope
 * (or anywhere in it), so tests/trial-source.test.js can drive this under
 * plain `node --test`, with no browser at all -- the same reason
 * trial-loop.js is its own file. */

// A nextTrial that never stops itself would run forever without this: no
// maxTrials set, a bug in the adaptive logic, whatever the reason. 1000 is far
// more than any real session would ask for, so hitting it always means a bug
// worth knowing about, not a long study that happened to need more trials.
const SAFETY_CAP = 1000;

/**
 * @param {object} exp  an experiment definition (see experiments/_template.js)
 * @returns {{
 *   next: (summariesSoFar?: object[]) => Promise<object|null>,
 *   total: number|null,
 *   kind: "list"|"nextTrial",
 *   endedBecause: "maxTrials"|"safetyCap"|null,
 * }}
 *   `next` resolves to the next trial object, or null once there are no more.
 *   `total` is the trial count when it is known ahead of time, else null.
 *   `kind` and `endedBecause` are for the session document (js/core/
 *   experiment.js writes them as `trialSource` / `trialSourceEnded`; see
 *   docs/DATA_FORMAT.md). `endedBecause` is set only once `next` has returned
 *   null BECAUSE a cap was hit, never for an experiment that simply ran out of
 *   trials on its own.
 */
export function makeTrialSource(exp) {
  const hasTrials = exp.trials !== undefined;
  const hasNextTrial = exp.nextTrial !== undefined;

  // Exactly one of the two, always. Both leaves the runner no way to know
  // which one was meant; neither leaves it nothing to run. Either is a mistake
  // in the experiment file, not something worth guessing around, so it fails
  // here, at creation -- before the consent screen -- rather than quietly
  // picking one or hanging later.
  if (hasTrials === hasNextTrial) {
    throw new Error(
      hasTrials
        ? "An experiment must define exactly one of `trials` or `nextTrial`, not both."
        : "An experiment must define one of `trials` or `nextTrial` (see experiments/_template.js)."
    );
  }

  return hasTrials ? listSource(exp) : nextTrialSource(exp);
}

/* A fixed list, known in full before the first trial. `trials` may be a
 * function -- called here, exactly ONCE, the same way the runner has always
 * called it -- so an experiment that builds its list from the participant's
 * condition or a random seed still gets one stable list for the whole run. */
function listSource(exp) {
  const list = typeof exp.trials === "function" ? exp.trials() : exp.trials;
  // T7b: a `trials` function that returns a string iterates BY CHARACTER
  // below (each one handed to the runner as if it were a trial object) and
  // one that returns a plain object gives `total: undefined` -- either way a
  // participant would consent and then run zero real trials, with no error
  // anywhere. Caught here, at creation, before the consent screen, same as
  // the "exactly one of trials/nextTrial" check above.
  if (!Array.isArray(list)) {
    throw new Error(
      `\`trials\` must be an array${typeof exp.trials === "function" ? " (the function returned " + typeof list + ")" : ""}, got ${typeof list}.`
    );
  }
  let i = 0;

  return {
    kind: "list",
    total: list.length,
    endedBecause: null,
    async next() {
      return i < list.length ? list[i++] : null;
    },
  };
}

/* A trial decided one at a time. `total` is `maxTrials` when it is a real cap
 * (a positive integer) -- there is no way to show "trial 4 of ?" as a
 * fraction, so anything else falls back to `null` and the runner shows a
 * running count instead (see ui.setProgress). */
function nextTrialSource(exp) {
  const maxTrials = Number.isInteger(exp.maxTrials) && exp.maxTrials > 0 ? exp.maxTrials : null;
  const cap = maxTrials ?? SAFETY_CAP;
  let i = 0;
  let endedBecause = null;

  return {
    kind: "nextTrial",
    total: maxTrials,
    get endedBecause() { return endedBecause; },
    async next(summariesSoFar = []) {
      // Checked BEFORE calling nextTrial, so a runaway experiment (one whose
      // nextTrial never returns null on its own) is stopped by the cap itself
      // rather than by running out of memory first -- the whole reason the cap
      // exists.
      if (i >= cap) {
        endedBecause = maxTrials !== null ? "maxTrials" : "safetyCap";
        return null;
      }

      // A COPY, not the runner's own array: nextTrial gets to look at what has
      // happened so far, not to rewrite it. Handing over the real array would
      // let one experiment's `summariesSoFar.push(...)` corrupt the record
      // every other part of the runner (the session document, renderResults)
      // relies on.
      const index = i;
      const trial = await exp.nextTrial(index, summariesSoFar.slice());

      if (trial === null || trial === undefined) return null;
      // T7a: `typeof [] === "object"`, so an array would otherwise sail past
      // this check and be handed to the runner as a trial -- it is not one.
      if (typeof trial !== "object" || Array.isArray(trial)) {
        throw new Error(
          `nextTrial(${index}, …) must return a trial object, or null/undefined to end ` +
          `the session, but returned ${Array.isArray(trial) ? "an array" : typeof trial}: ${JSON.stringify(trial)}`
        );
      }

      i++;
      return trial;
    },
  };
}
