/* =============================================================================
 *  asl-tutor.js, a playable slice of the fingerspelling tutor.
 * =============================================================================
 *
 *  WHAT IT IS. The page shows a letter. You make the handshape and hold still.
 *  A ring fills while you hold, and when it closes the tutor grades that one
 *  pose: right, wrong-and-here-is-one-thing-to-fix, or "I could not see that
 *  well enough to say". A drop-out schedule decides what comes next.
 *
 *  IT IS A RESEARCH PROTOTYPE AND THE SCREEN SAYS SO. The grader is a bootstrap
 *  model fitted on posed photographs from six public datasets
 *  (tutor/model.json provenance, training/MODEL_REPORT.md). Not one hand in
 *  front of this camera contributed to it, the thresholds were fitted on the
 *  same held-out scores they are reported against, and it will be wrong about
 *  some people. The attempt log below is what makes that measurable from the
 *  first session rather than a thing to be discovered later.
 *
 *  WHERE THE PIECES LIVE. This file is glue only -- URL options, the model
 *  fetch, the per-frame pipeline and the calls into the runner. The rules are
 *  in experiments/asl-tutor/flow.js (pure, tested under Node) and the DOM is in
 *  experiments/asl-tutor/ui.js. Nothing decides anything in two places.
 *
 *  THE PER-FRAME PIPELINE, in order:
 *    landmarks -> flattenRounded (the grader reads the same rounded numbers the
 *    recorder saves) -> committer.push (has the hand stopped moving?) -> on a
 *    commit: toPoints, chirality, featuresFromFlat, then verify against the
 *    target letter with this frame's tracking quality.
 *
 *  LEFT-HANDED SIGNERS. Fine, and nothing to set. Chirality is read from the
 *  geometry and the hand is mirrored into a canonical right hand before any
 *  feature is measured (tutor/hand-frame.js), so one model serves both hands.
 *
 *  URL OPTIONS (docs/TUTOR.md has the long version):
 *    ?letters=LBY     teach exactly these, in this order
 *    ?seed=12345      the schedule's seed; otherwise derived from the
 *                     participant id, and saved with the session either way
 *    ?maxTrials=40    cap the session
 *    ?hints=lenient   give the top-gain block's hint even when the model
 *                     cannot show that fixing it alone would be enough
 *    ?debug=1         NOT for learners: a live panel of the grader's numbers
 *                     and a downloadable recording of the session's landmarks
 *                     (experiments/asl-tutor/debug.js)
 * ===========================================================================*/

import { flattenRounded, DECIMALS } from "../tutor/landmarks.js";
import { loadModel } from "../tutor/verifier.js";
import { STATIC_LETTERS, pictureUrl } from "../tutor/letters.js";
import { createDropoutSchedule } from "../tutor/schedule-dropout.js";
import { TUTOR_VERSION } from "./asl-tutor/flow.js";
import { createEngine, TUTOR_COMMIT_OPTS } from "./asl-tutor/engine.js";
import { createDebug } from "./asl-tutor/debug.js";
import { mountTutor, renderTutorResults } from "./asl-tutor/ui.js";
import { drawLandmarks } from "../js/core/experiment.js";

const MODEL_PATH = "tutor/model.json";


/* The order letters are introduced in. Print-like shapes first (L, V, W, Y and
 * I all look like the letter they stand for, which is a handhold a beginner
 * can use), then the rest of tier 1. M and N are last and outside the default
 * cap of twelve: they are the two tier-1 letters most easily confused with
 * each other and with S, and a first session is not the place for them. Only
 * tier-1 letters appear at all -- tier 2 gets no verdict from this model
 * (tutor/model.json tiers), so teaching one here would mean a trial the tutor
 * can never answer.
 *
 * A and G joined tier 1 on 2026-09-21, when the FSboard signers joined the
 * model's training rows, and they go LAST, outside the default twelve: A is
 * one thumb away from S and E, and the only two real-video Gs we have labels
 * for are both rejected (research/fsboard-2026-09-21/README.md). Ask for them
 * with ?letters= until a recorded session says they are ready for a first one.
 *
 * NOTHING IN THE LANGUAGE TIES THIS LIST TO THE MODEL. It is copied by hand,
 * and the tier set has already moved twice across this plan (13 -> 16 -> 14 -> 16
 * letters). tests/tutor-letters-vs-model.test.js reads tutor/model.json with
 * `fs` and asserts this set matches the model's tier-1 letters exactly; and
 * assertLettersGradable below is the runtime half of the same guard -- it
 * refuses to teach a letter the LOADED model disagrees about, rather than
 * trusting this list once the model file is actually in hand. */
export const INTRO_ORDER = Object.freeze(["L", "V", "W", "Y", "I", "B", "D", "F", "K", "E", "S", "X", "M", "N", "A", "G"]);

/* The runtime half of the INTRO_ORDER/model.json guard above. A drifted
 * INTRO_ORDER would otherwise fail quietly: the verifier abstains `tier2` on
 * every hold of that letter (tutor/verifier.js), which flow.js's onAbstain
 * logs as an anomaly but still shows the learner "I couldn't see your hand
 * clearly" -- wrong reason, buried in the log, three abstains later the
 * trial just ends `sensor`. Checked against the model that actually loaded,
 * not against INTRO_ORDER a second time, so a mismatch is a fatal naming the
 * letter rather than a letter silently taught and never answered. */
export function assertLettersGradable(letters, model) {
  const wrongTier = letters.filter((l) => model.tiers[l] !== 1);
  if (wrongTier.length === 0) return;
  throw new Error(
    `${wrongTier.join(", ")} ${wrongTier.length === 1 ? "is" : "are"} tier 2 in the loaded model ` +
    `(tutor/model.json) -- this tutor cannot grade ${wrongTier.length === 1 ? "it" : "them"}.`
  );
}

export const DEFAULT_LETTER_COUNT = 12;
export const DEFAULT_MAX_TRIALS = 80;

/* Every trial is the same shape: no countdown (three seconds of "3, 2, 1" in
 * front of eighty short trials is most of the session), no rest screen, and
 * the upload runs in the background so the next letter comes straight up.
 * Forty seconds is a cap, not a target -- a trial normally ends on its own. */
const TRIAL_DURATION_SEC = 40;

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);

/* A URL option that is wrong is a typo by whoever made the link, and guessing
 * what they meant produces a session that looks fine and taught the wrong
 * thing. So each one is collected here and thrown as a fatal at mount, where
 * the runner can put it on the screen (and, in an unattended run, into
 * data-e2e) instead of the tutor quietly running a different study. */
const complaints = [];

export function parseLetters(raw) {
  if (raw === null || raw === undefined) {
    return INTRO_ORDER.slice(0, DEFAULT_LETTER_COUNT);
  }
  // `?letters=` with nothing after it is a link somebody built wrong -- a
  // template that did not fill in, most likely. Falling back to the default
  // twelve would run a different session than the one they asked for and look
  // exactly like success.
  if (raw === "") {
    throw new Error(
      "?letters= is empty. Either leave it out, to teach the default " +
      `${INTRO_ORDER.slice(0, DEFAULT_LETTER_COUNT).join("")}, or name the letters to teach, for example ?letters=LBY.`
    );
  }
  const letters = raw.toUpperCase().split("");
  const unknown = letters.filter((l) => !STATIC_LETTERS.includes(l));
  if (unknown.length) {
    throw new Error(
      `?letters=${raw} contains ${unknown.join(", ")}, which ${unknown.length === 1 ? "is not a letter" : "are not letters"} ` +
      `this tutor can teach. J and Z are movements, not handshapes, and this slice only does still hands. ` +
      `Try letters from ${STATIC_LETTERS.join("")}.`
    );
  }
  if (new Set(letters).size !== letters.length) {
    throw new Error(`?letters=${raw} repeats a letter; the schedule needs each letter once.`);
  }
  /* A tier-2 letter is REFUSED rather than taught intro-only. The brief allows
   * either; this is the simpler one, and the honest one for a slice: an
   * intro-only letter would be a trial the learner takes seriously and the
   * tutor never answers, which is a worse experience than not being offered
   * it. The letter is still shown in the mastery map as untaught. */
  const tier2 = letters.filter((l) => !INTRO_ORDER.includes(l));
  if (tier2.length) {
    throw new Error(
      `?letters=${raw} asks for ${tier2.join(", ")}, which this model does not grade ` +
      `(tier 2 -- see training/MODEL_REPORT.md). This slice only teaches letters it can answer: ${INTRO_ORDER.join("")}.`
    );
  }
  return letters;
}

/* The most trials this tutor will run in one sitting. Forty seconds each, so
 * the cap is already well over three hours of somebody's afternoon: a number
 * above it is a typo (an extra zero) far more often than a request. */
export const MAX_TRIALS_CAP = 500;

export function parseMaxTrials(raw) {
  if (raw === null || raw === undefined || raw === "") {
    return { value: DEFAULT_MAX_TRIALS, complaint: null };
  }
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) {
    return { value: DEFAULT_MAX_TRIALS, complaint: `?maxTrials=${raw} is not a positive whole number.` };
  }
  if (n > MAX_TRIALS_CAP) {
    return {
      value: DEFAULT_MAX_TRIALS,
      complaint: `?maxTrials=${raw} is more than this tutor will run in one sitting (at most ${MAX_TRIALS_CAP}).`,
    };
  }
  return { value: n, complaint: null };
}

export function parseHintPolicy(raw) {
  if (raw === null || raw === "") return "strict";
  if (raw === "strict" || raw === "lenient") return raw;
  complaints.push(`?hints=${raw} is not a hint policy; it has to be "strict" or "lenient".`);
  return "strict";
}

/* A seed from the participant id, when the URL did not give one. FNV-1a over
 * the id's UTF-16 code units, which is deterministic, has no dependencies, and
 * spreads short ids (P01, P02) across the whole range instead of into
 * neighboring seeds. The number that comes out is saved with the session, so a
 * run can always be rebuilt from the record rather than from this rule. */
export function seedFromParticipant(id) {
  let h = 0x811c9dc5;
  const s = String(id ?? "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/* SHA-256 of the model text, so a session can say exactly which model graded
 * it. Cheap (one hash of 600 KB at startup) and the browser does it for us; a
 * context without crypto.subtle gets null rather than a fabricated hash. */
async function sha256(text) {
  try {
    const bytes = new TextEncoder().encode(text);
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return null;
  }
}

const parsedMaxTrials = parseMaxTrials(params.get("maxTrials"));
if (parsedMaxTrials.complaint) complaints.push(parsedMaxTrials.complaint);
const maxTrials = parsedMaxTrials.value;
const hintPolicy = parseHintPolicy(params.get("hints"));
const debugOn = params.get("debug") === "1";

/* Built by mount() and nextTrial(); one tutor runs at a time. */
let view = null;
let debug = null;        // only with ?debug=1
let session = null;      // { letters, seed, model, modelSha, schedule, committer, sessionLogged }
let mountError = null;

export default {
  id: "asl-tutor",
  title: "Fingerspelling tutor",

  tracker: "hand",
  trackerOptions: { numHands: 1 },

  maxTrials,

  instructions: `
    <p>You will be shown a letter. Make that handshape with one hand and
       <strong>hold it still</strong> — a ring fills while you hold, and when it
       closes the tutor looks at your hand.</p>
    <ul>
      <li>Either hand is fine. Left-handed signing is handled automatically.</li>
      <li>Keep your hand near the middle of the picture and close enough to fill
          a good part of it.</li>
      <li>If the tutor says the sign is wrong, it will tell you one thing to
          change. Try again.</li>
    </ul>
    <p><strong>Research prototype.</strong> The grading is approximate and comes
       from a model built on public photographs, not from anyone using this
       page. It can be wrong about a correct hand. This teaches fingerspelling
       handshapes, not ASL — to learn ASL, learn from Deaf teachers.</p>`,

  /* ---- what the learner sees ------------------------------------------- */

  mount(el, { participant }) {
    let letters;
    try {
      letters = parseLetters(params.get("letters"));
    } catch (err) {
      // Kept rather than thrown from here: mount runs before the first trial,
      // and throwing inside it leaves the stage half-built. nextTrial is the
      // first awaited call after this, and the runner turns a rejection there
      // into the fatal screen.
      mountError = err;
      letters = INTRO_ORDER.slice(0, 1);
    }

    const urlSeed = params.get("seed");
    let seed;
    if (urlSeed !== null && urlSeed !== "") {
      const n = Number(urlSeed);
      if (!Number.isInteger(n)) {
        complaints.push(`?seed=${urlSeed} is not a whole number.`);
        seed = seedFromParticipant(participant?.participantId);
      } else {
        seed = n >>> 0;
      }
    } else {
      seed = seedFromParticipant(participant?.participantId);
    }

    session = {
      letters, seed,
      seedSource: urlSeed ? "url" : "participantId",
      model: null, modelSha: null, schedule: null,
      engine: null,            // built once the model is in (loadEverything)
      sessionLogged: false,
      sessionAttached: false,
      replayExhausted: false,
    };

    view = mountTutor(el, { letters, hintPolicy });
    if (debugOn) debug = createDebug(el, { getModel: () => session.model, canSave: !params.has("replay") });
  },

  /* ---- which letter comes next ----------------------------------------- */

  async nextTrial(index) {
    if (mountError) throw mountError;
    if (complaints.length) throw new Error(complaints.join(" "));
    if (session === null) throw new Error("asl-tutor: nextTrial ran before mount");

    if (index === 0) await loadEverything();

    // A replay that has run dry has nothing left to show anybody: the current
    // trial already ended with "replay-finished", and asking the schedule for
    // one more letter would start a trial that records a single empty frame.
    if (session.replayExhausted) return null;

    const picked = session.schedule.next();
    if (picked === null) return null;

    view.mastery(masteryStates(session.schedule.snapshot(), session.letters));

    return {
      id: `t${String(index + 1).padStart(2, "0")}_${picked.letter}_${picked.kind}`,
      letter: picked.letter,
      kind: picked.kind,
      durationSec: TRIAL_DURATION_SEC,
      countdownSec: 0,
      skipRest: true,
      backgroundUpload: true,
    };
  },

  onTrialStart(trial, { tracker }) {
    // The engine owns the committer, the flow and the pacing between them
    // (experiments/asl-tutor/engine.js); a new trial is one call.
    session.engine.startTrial(trial);
    debug?.trialStart(trial);
    return { tracker, addEvent: null, overlay: trial.kind === "intro" };
  },

  /* ---- one frame -------------------------------------------------------- */

  onFrame({ landmarks, handedness, handednessScore, tMs, trial, state, video, addEvent, endTrial }) {
    // Kept so onTrialEnd can still write an event: the runner hands addEvent to
    // onFrame only, and the trial-end row belongs with the rest of the trial's
    // log rather than in a second place. It carries the last frame's tMs, which
    // is within a frame of when the trial really ended.
    state.addEvent = addEvent;

    if (!session.sessionLogged) {
      session.sessionLogged = true;
      addEvent("tutor-session", sessionRecord());
    }

    const flat = landmarks ? flattenRounded(landmarks, DECIMALS) : null;
    const out = session.engine.frame({ tMs, flat, aspect: video.aspect, videoHeight: video.height });
    view.progress(out.progress);
    view.paused(out.paused);
    applyEffects(out.effects, { trial, addEvent, endTrial });
    debug?.frame({
      flat, handedness, handednessScore, trial, videoInfo: video,
      committerState: session.engine.committerState, progress: out.progress,
    });

    let derived = { progress: round3(out.progress) };
    if (out.committed) derived = { ...derived, committed: true, sign: out.sign };

    /* Replay only: the recording has run out, so stop rather than sitting out
     * the forty-second cap on an empty file. "duration" and "" are reserved by
     * the runner, so this reason is its own word (see experiments/asl-probe.js).
     * A trial already decided and sitting out its dwell ends as what it WAS;
     * only one still in play is cut short by the recording. */
    if (state.tracker?.exhausted) {
      session.replayExhausted = true;
      if (session.engine.hasPending()) applyEffects(session.engine.flushAll(), { trial, addEvent, endTrial });
      else if (!session.engine.flowState?.ended) endTrial("replay-finished");
    }

    return derived;
  },

  /* The landmark skeleton is ON while the learner is copying a picture and OFF
   * while they are being tested: during a test it pulls the eye to the overlay
   * and away from their own hand, and it is the one piece of the screen that
   * could be read as feedback when it is not. */
  draw(ctx, { landmarks, trial, canvas }) {
    if (trial.kind === "intro") drawLandmarks(ctx, canvas, landmarks);
    // else: the runner already cleared the canvas, so there is nothing to do.
  },

  onTrialEnd({ state, endReason }) {
    // onFrame is the only place state.addEvent gets set (the runner hands
    // addEvent to onFrame, not to onTrialEnd) -- see the comment on it above.
    // A trial with zero frames (the camera never delivered one before
    // duration/sensor ended it) never runs onFrame, so state.addEvent is
    // still whatever onTrialStart set it to (null) and every `log()` effect
    // below silently no-ops. The trial-end ROW itself is never lost -- it
    // rides on this function's return value regardless of addEvent -- but
    // the attempt/status rows inside `effects` would vanish with no sign
    // anything went missing, so this is loud about it instead.
    if (state.addEvent == null) {
      console.warn("asl-tutor: onTrialEnd ran with no addEvent captured (a zero-frame trial) -- this trial's log events were dropped");
    }
    const effects = session.engine.finishTrial(endReason);
    for (const e of effects) {
      if (e.kind === "log") state.addEvent?.(e.event, e.data);
      if (e.kind === "schedule-report") {
        // Forwarded as the flow built it: an ungraded trial carries no
        // booleans, because there was nothing to be right or wrong about.
        session.schedule.report(e.ungraded === true
          ? { letter: e.letter, ungraded: true }
          : { letter: e.letter, firstAttemptCorrect: e.firstAttemptCorrect, assisted: e.assisted });
      }
    }
    const snap = session.schedule.snapshot();
    view.mastery(masteryStates(snap, session.letters));

    // The session-level record rides on the FIRST trial's summary, which the
    // runner already saves into the session document. It is written at the end
    // of trial one rather than at mount because the model hash is only known
    // once the model has been fetched. It is a ONE-TRIAL snapshot, not a
    // final one -- every per-letter counter is still 0 -- so it is never the
    // place to read the session's final per-letter state; buildTrialSummary
    // below is.
    const sessionExtras = session.sessionAttached ? null : firstTrialExtras();
    session.sessionAttached = true;
    return buildTrialSummary(session.engine.summary(), snap.letters, sessionExtras);
  },

  renderResults(summaries) {
    debug?.save();
    return renderTutorResults(summaries);
  },

  /* What the unattended run reports (js/core/experiment.js merges this into
   * #e2e-result under "experiment"). Counting from the trials' own event log
   * rather than from the runner's frame counts is the point: an onFrame that
   * stopped verifying anything would leave every runner number unchanged. */
  e2eSummary(trialSummaries) {
    // I1: the LAST trial's scheduleLetters is where the session's final
    // per-letter state lives (see buildTrialSummary and docs/TUTOR.md) --
    // summed here into two totals so a smoke test can assert on it without
    // reaching into a specific trial index, which would break the moment the
    // schedule reorders letters. `ungradedTotal` and `testsTotal` are sums
    // ACROSS LETTERS of the schedule's own counters, not the endReason
    // buckets below: a letter can be ungraded once and pass a test later in
    // the same session, and this counts both.
    const lastScheduleLetters = trialSummaries.length
      ? trialSummaries[trialSummaries.length - 1]?.scheduleLetters ?? {}
      : {};
    let ungradedTotal = 0, testsTotal = 0;
    for (const s of Object.values(lastScheduleLetters)) {
      ungradedTotal += s.ungraded ?? 0;
      testsTotal += s.tests ?? 0;
    }

    const out = {
      tutorVersion: TUTOR_VERSION, hintPolicy, seed: session?.seed ?? null,
      letters: (session?.letters ?? []).join(""),
      trials: trialSummaries.length,
      introDone: 0, accept: 0, corrected: 0, failed: 0, sensor: 0, duration: 0, replayFinished: 0,
      ungraded: 0, ungradedTotal, testsTotal,
      attempts: 0, rejects: 0, accepts: 0, abstains: 0,
      hintsShown: 0, picturesShown: 0, triaged: 0,
      correctedFromReject: 0, anomalies: 0, nothingToSay: 0,
      // ?debug=1 only: how many frames the debug recorder holds. null without
      // it, so a smoke scenario can tell "off" from "on and recorded nothing".
      debugFrames: debug ? debug.frameCount() : null,
    };
    const bucket = {
      "intro-done": "introDone", accept: "accept", corrected: "corrected",
      failed: "failed", sensor: "sensor", duration: "duration", "replay-finished": "replayFinished",
    };

    for (const t of trialSummaries) {
      // finalOutcome first: a trial decided at 38.9 s is still sitting out its
      // dwell when the runner's 40 s cap ends it, so the runner says
      // "duration" about a trial the tutor had already called. What the tutor
      // decided is the outcome; the runner's word only fills in when the tutor
      // decided nothing.
      const key = bucket[t.finalOutcome ?? t.endReason];
      if (key) out[key]++;
      if (t.ungraded === true) out.ungraded++;
      // js/core/recorder.js SPREADS an event's data onto the row rather than
      // nesting it, so a logged field is a field of the event itself.
      const events = t.events ?? [];
      const attempts = events.filter((e) => e.type === "attempt");
      const feedback = events.filter((e) => e.type === "feedback");
      const anomalies = events.filter((e) => e.type === "anomaly");

      out.attempts += attempts.length;
      out.accepts += attempts.filter((a) => a.outcome === "accept").length;
      out.rejects += attempts.filter((a) => a.outcome === "reject").length;
      out.abstains += attempts.filter((a) => a.outcome === "abstain").length;
      out.triaged += attempts.filter((a) => typeof a.triage === "string").length;
      out.hintsShown += feedback.filter((f) => f.hintId).length;
      out.picturesShown += feedback.filter((f) => f.showPicture).length;
      out.anomalies += anomalies.length;
      out.nothingToSay += anomalies.filter((a) => /nothingToSay/.test(a.what ?? "")).length;

      if (t.endReason === "corrected") {
        const first = attempts.find((a) => a.consumed);
        const said = feedback.some((f) => f.hintId || f.showPicture);
        if (first && first.outcome === "reject" && typeof first.triage === "string" && said) {
          out.correctedFromReject++;
        }
      }
    }
    return out;
  },
};

/* -------------------------------------------------------------------------
 * Startup: the model, then the schedule.
 * ---------------------------------------------------------------------- */

async function loadEverything() {
  let text;
  try {
    const res = await fetch(MODEL_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(
      `Could not load the grading model from ${MODEL_PATH} (${err?.message || err}). ` +
      "The tutor cannot grade anything without it. Check that you are serving the whole repository folder."
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`${MODEL_PATH} is not valid JSON: ${err?.message || err}`);
  }

  try {
    session.model = loadModel(parsed);
  } catch (err) {
    throw new Error(`${MODEL_PATH} did not load as a model: ${err?.message || err}`);
  }
  assertLettersGradable(session.letters, session.model);

  session.engine = createEngine({ model: session.model, letters: session.letters, hintPolicy });
  session.modelSha = await sha256(text);
  session.schedule = createDropoutSchedule({
    letters: session.letters, seed: session.seed, maxTrials,
  });
}

function sessionRecord() {
  return {
    tutorVersion: TUTOR_VERSION,
    hintPolicy,
    letters: session.letters.join(""),
    seed: session.seed,
    seedSource: session.seedSource,
    modelGitCommit: session.model.provenance?.gitCommit ?? null,
    modelSha256: session.modelSha,
    committer: { ...TUTOR_COMMIT_OPTS },
    debug: debugOn,
    maxTrials,
  };
}

function firstTrialExtras() {
  return {
    session: {
      ...sessionRecord(),
      schedule: session.schedule.snapshot(),
    },
  };
}

/* What onTrialEnd hands back to the runner, every trial: the flow's own
 * summary plus the schedule's per-letter table AS OF THIS TRIAL'S END --
 * `order` left out, since it is redundant with the trial rows themselves --
 * and, only when `sessionExtras` is given (trial 0), the static session
 * block. Pure and exported so tests/tutor-flow.test.js can drive it without
 * a schedule, a flow or a DOM: the LAST trial's `scheduleLetters` is where a
 * session's final per-letter state actually lives (docs/TUTOR.md), and this
 * is the one function that has to get that right on every call, not just the
 * first. */
export function buildTrialSummary(summary, scheduleLetters, sessionExtras) {
  const withSchedule = { ...summary, scheduleLetters };
  return sessionExtras ? { ...withSchedule, ...sessionExtras } : withSchedule;
}

/* -------------------------------------------------------------------------
 * Effects -> the screen, the log and the runner.
 * ---------------------------------------------------------------------- */

function applyEffects(effects, { trial, addEvent, endTrial }) {
  for (const e of effects) {
    switch (e.kind) {

      case "cue":
        view.cue(e);
        break;
      case "feedback":
        view.feedback(e, trial.letter);
        addEvent("feedback", {
          trialId: trial.id, letter: trial.letter, tone: e.tone,
          hintId: e.hintId ?? null, showPicture: !!e.showPicture,
        });
        break;
      case "status":
        view.status(e.text);
        break;
      case "reward":
        view.reward(e.points);
        break;
      case "complete":
        view.complete();
        break;
      case "log":
        addEvent(e.event, e.data);
        if (e.event === "attempt") debug?.attempt(e.data);
        break;
      case "end-trial":
        endTrial(e.reason);
        break;
      case "schedule-report":
        // Only finishTrial produces these, and onTrialEnd handles them there,
        // where the runner's endReason is known.
        break;
      default:
        console.warn(`asl-tutor: unknown effect ${e.kind}`);
    }
  }
}

/* -------------------------------------------------------------------------
 * Small helpers.
 * ---------------------------------------------------------------------- */

/* The schedule's own bookkeeping, read as the four states the map shows.
 * `lagIndex > 0` means the letter has been got right unaided at least once,
 * which is the first thing worth showing a learner. */
function masteryStates(snapshot, letters) {
  const out = {};
  for (const letter of letters) {
    const s = snapshot.letters[letter];
    out[letter] = !s || !s.introduced ? "untaught"
      : s.retired ? "retired"
      : s.lagIndex > 0 ? "passed"
      : "introduced";
  }
  return out;
}

const round3 = (v) => Math.round(v * 1000) / 1000;

// Re-exported so docs and tests can name the same picture rule the UI uses.
export { pictureUrl };
