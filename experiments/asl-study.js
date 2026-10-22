/* asl-study.js: JT's fixed three-part study (2026-09-21), as one task.
 *
 *   1. BASELINE   every letter once, letter only, no picture: the first hold
 *                 is recorded and the trial ends. The learner is told only
 *                 that it was recorded -- the ring and its (orange) burst
 *                 say the hold was taken, never right/wrong.       5 x 1 = 5
 *   2. TEACHING   every letter ten times, letter WITH its picture. A right
 *                 hold ends the trial (green burst, "Good job"); a wrong one
 *                 gets the hint.                                  5 x 10 = 50
 *   3. POST-TEST  as the baseline.                                5 x 1 = 5
 *
 * All 26 letters by default (JT 2026-09-25, the first data collection);
 * ?letters=BDFIV is the five-letter demo shown to Karen (DEMO_LETTERS).
 *
 * Every part is made of shuffled passes through the alphabet (a pass = each
 * letter once), seeded from the participant id, so no letter is seen twice
 * before every letter has been seen once. The questionnaire before is
 * questions.js (DEMOGRAPHIC_QUESTIONS); the one after is POST_QUESTIONS.
 *
 * The per-frame machinery is the tutor's (experiments/asl-tutor/engine.js and
 * flow.js: the hold-still ring, the grader, the hints, the pacing); what this
 * file owns is WHICH trial comes next and the study's stripped-down screen
 * (ui.js layout "study": the camera, the letter with its ring, the picture).
 *
 * URL: ?exp=asl-study   [&letters=…] [&reps=2,10,2] [&seed=n] [&debug=1]
 * `reps` shortens a run for trying it out; the numbers are logged. */

import { flattenRounded, DECIMALS } from "../tutor/landmarks.js";
import { loadModel } from "../tutor/verifier.js";
import { loadOpenFS } from "../tutor/openfs.js";
import { LETTERS, pictureUrl } from "../tutor/letters.js";
import { createPrng } from "../tutor/prng.js";
import { TUTOR_VERSION } from "./asl-tutor/flow.js";
import { createEngine, TUTOR_COMMIT_OPTS, EXPERT_COMMIT_OPTS } from "./asl-tutor/engine.js";
import { createDebug } from "./asl-tutor/debug.js";
import { mountTutor } from "./asl-tutor/ui.js";
import { drawLandmarks } from "../js/core/experiment.js";
import { createHandPicker, handSide } from "../tutor/pick-hand.js";
import { seedFromParticipant, parseHintPolicy } from "./asl-tutor.js";
import { runSignQuiz } from "./sign-quiz.js";
import { EXPERT_DEMOGRAPHIC_QUESTIONS, EXPERT_POST_QUESTIONS, EXPERT_POST_QUESTIONS_REQUIRED,
  EXPERT_PRETASK_QUESTIONS, EXPERT_PRETASK_QUESTIONS_REQUIRED } from "../questions.js";

const MODEL_PATH = "tutor/model.json";
// 2.1 (2026-10-04): expert mode's own instructions page and "Fingerspell this
// letter" (EXPERT_TEXT); the study itself is unchanged.
// 2.2 (2026-10-07): expert mode holds longer before a sign is graded
// (EXPERT_COMMIT_OPTS: ring shown at 0.5 s, graded at 1.5 s); the study is unchanged.
// 2.3 (2026-10-16, JT): the new grader (tutor/mix.js: the P rule, the O/E rule and OpenFS's second opinion on
// I M N X) on every link; ?grader=old grades with the previous one. Sessions record `grader`.
// 2.4 (2026-10-18, JT): the Prolific expert link starts with an ASL check (experiments/sign-quiz.js): how they
// describe their ASL, then ten everyday signs on video; only "fluent" + 8 of 10 go on. Sessions record `screening`.
// 2.5 (2026-10-18, JT): expert mode asks its own questions (questions.js EXPERT_DEMOGRAPHIC_QUESTIONS: the ASL
// question first, two answers; years of ASL on a 0-100 slider). On the Prolific expert link anyone not fluent stops
// right after that page, and three signs answered after more than 30 s end the check.
// 2.6 (2026-10-18, JT + Indranil): expert mode ends with one practice cycle (every letter once, with its picture and
// the feedback learners get), after its four test rounds, then Indranil's optional usability questions
// (questions.js EXPERT_POST_QUESTIONS).
// 2.7 (2026-10-18): on a Prolific link those questions are required (questions.js EXPERT_POST_QUESTIONS_REQUIRED), so
// nobody reaches the completion code without answering them.
// 2.8 (2026-10-18, Indranil): how they learned to fingerspell and its obstacles are asked BEFORE the task (after the
// ASL check; sessions record `preTaskQuestionnaire`), and the screen before the practice asks them to think of
// themselves, and anyone they know, first learning fingerspelling.
export const STUDY_VERSION = "asl-study/2.8";
// JT, 2026-09-22: one pass for each test, ten for teaching.
export const DEFAULT_REPS = Object.freeze({ pre: 1, teach: 10, post: 1 });
/* Fluent signers (JT, 2026-09-29): straight to the test, each letter four times (JT: 4 rounds, 104 trials),
 * no pictures and no teaching -- a baseline of how the grader does on people who
 * know the signs. ?mode=expert; an explicit ?reps= still wins, for trying it out. */
export const EXPERT_REPS = Object.freeze({ pre: 0, teach: 1, post: 4 });
/* ...and then one practice cycle (JT + Indranil, 2026-10-18: "tag on 1 training cycle through all the letters", so
 * experts experience the training part and can answer the usability questions). The tests stay kind "post", as in
 * every earlier expert session; the practice comes after them. */
export const EXPERT_PHASES = Object.freeze(["post", "teach"]);
/* What expert mode says (2026-10-04). Four Prolific "experts" saw only "Make
 * this letter" (the instructions page is off for everyone, config.js), and one
 * drew every letter in the air. So expert mode shows its own instructions page,
 * and every trial asks for fingerspelling by name. */
export const EXPERT_TEXT = Object.freeze({
  label: "Fingerspell this letter",
  helper: "Make the handshape, then hold it still.",
});
/* JT, 2026-09-23: five letters, for a short demo. The five the grader is surest
 * of on data it never saw (research/allletters-2026-09-22, per_letter.py:
 * correct hands accepted 0.93-0.99, look-alikes 0.00-0.03), none a movement,
 * none a look-alike of another, and each one a letter the owner's pilot went
 * from wrong to right on. The whole alphabet is ?letters=ABCDEFGHIJKLMNOPQRSTUVWXYZ. */
export const DEMO_LETTERS = Object.freeze(["B", "D", "F", "I", "V"]);

/* Which hand to sign with, from the questionnaire's dominantHand. Everyone is
 * asked to use ONE hand; "Left" means the left, anything else the right (the
 * pictures are drawn for a right hand, tutor/letters.js). */
export function studyHand(demographics) {
  // Model-mix test build: no questionnaire, so ?hand=left says which hand (right otherwise).
  const fromUrl = typeof location === "undefined" ? null : new URLSearchParams(location.search).get("hand");
  if (fromUrl === "left" || fromUrl === "right") return fromUrl;
  return /^left/i.test(demographics?.dominantHand ?? "") ? "left" : "right";
}
export const PHASES = Object.freeze(["pre", "teach", "post"]);

/* A quiz trial that never gets a hold ends here, recorded as no answer; a
 * teaching trial gets the tutor's usual forty seconds. */
const QUIZ_DURATION_SEC = 20;
const TEACH_DURATION_SEC = 40;

/* A short looping film of a few trials, shown before a part starts (JT,
 * 2026-09-23). Made by tools/demo-video/, from real recorded hands. Browsers
 * only autoplay a muted video, so its music is behind a button. */
export const demoVideo = (src, label) => `
  <figure class="study-demo">
    <video src="${src}" autoplay loop muted playsinline preload="auto" aria-label="${label}"></video>
    <button type="button" class="study-demo-sound"
      onclick="const v=this.previousElementSibling; v.muted=!v.muted; this.textContent=v.muted?'Sound on':'Sound off'">Sound on</button>
  </figure>`;
export const TEST_DEMO = "assets/demo/test-demo.mp4";
export const TEACH_DEMO = "assets/demo/teach-demo.mp4";

/* The break screens between parts. As short as JT asked for; the film shows
 * the rest. The runner shows them on its rest screen (js/core/experiment.js). */
export const BREAKS = Object.freeze({
  teach: {
    restHeading: "Now we will teach you the signs",
    // No film here (JT, 2026-09-24): it would give some signs a head start.
    restHtml: `<p>Copy the picture, then hold your hand still until the circle fills.</p>`,
    restButton: "Start",
  },
  post: {
    restHeading: "Now show us the signs again",
    restHtml: `<p>Like the first part: no pictures, so sign each letter from memory.</p>`,
    restButton: "Start",
  },
});

/* Expert mode's break before its practice cycle (2026-10-18). */
export const EXPERT_BREAKS = Object.freeze({
  teach: {
    restHeading: "Last part: the practice mode",
    // Indranil's words (2026-10-18), to set them watching the teaching
    restHtml: `<p><strong>You are about to see a prototype for teaching fingerspelling to novices.</strong> While interacting
      with the platform, try to think of yourself when you were first learning fingerspelling, and of anyone else in your
      life who has tried to learn fingerspelling.</p>
      <p>You will see each letter once more, with its picture, the way a learner practises. The platform tells you whether
      it recognized your handshape and, if not, what to change. Please fingerspell each letter as you normally would.
      Afterwards there are a few questions about it.</p>`,
    restButton: "Start",
  },
});

/* The whole session, as a list, in order. Pure: same inputs, same list.
 * @param {string[]} letters
 * @param {{pre:number, teach:number, post:number}} reps
 * @param {number} seed */
/* Signing with the other hand (Prolific, 2026-09-28): one person said she writes
 * with her right hand, signed with her left, and was told "Use your right hand."
 * 831 times over two hours; nothing stopped her. Now this many holds IN A ROW
 * with the other hand end the trial and bring back the camera check, which
 * does not let anyone past until it sees the asked-for hand. */
export const WRONG_HAND_LIMIT = 3;
export function nextWrongStreak(streak, attempt) {
  return attempt.wrongHand ? streak + 1 : 0;
}
/* The camera check's objection to this hand, or null: the asked-for hand, or
 * one the tracker cannot tell, may pass. */
export function handProblem(landmarks, label, aspect, want) {
  const side = handSide(landmarks, label, aspect);
  return side && side !== want ? `That is your ${side} hand. Please hold up your ${want} hand.` : null;
}

export function buildPlan(letters, reps, seed, phases = PHASES) {
  const prng = createPrng(seed);
  const plan = [];
  for (const phase of phases) {
    for (let pass = 0; pass < reps[phase]; pass++) {
      for (const letter of prng.shuffle(letters)) plan.push({ letter, kind: phase, pass });
    }
  }
  return plan;
}

export function parseReps(raw) {
  if (raw === null) return { ...DEFAULT_REPS };
  const parts = raw.split(",").map((v) => Number(v));
  if (parts.length !== 3 || parts.some((n) => !Number.isInteger(n) || n < 0) || parts.every((n) => n === 0)) {
    throw new Error(`?reps=${raw} should be three whole numbers, baseline,teaching,post-test -- for example reps=2,10,2.`);
  }
  return { pre: parts[0], teach: parts[1], post: parts[2] };
}

export function parseStudyLetters(raw) {
  if (raw === null) return LETTERS.slice();
  const letters = raw.toUpperCase().split("");
  const bad = letters.filter((l) => !LETTERS.includes(l));
  if (bad.length || !letters.length) throw new Error(`?letters=${raw} contains ${bad.join(", ") || "nothing"}, which are not letters. Use A-Z.`);
  if (new Set(letters).size !== letters.length) throw new Error(`?letters=${raw} repeats a letter; each should appear once.`);
  return letters;
}

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const EXPERT = params.get("mode") === "expert";
/* The ASL check (JT, 2026-10-18) runs on the expert link for people Prolific sent; Karen's lab link (no Prolific id)
 * goes straight on. ?quiz=1 turns it on for any link (to try it), ?quiz=0 off. */
export function expertPostQuestions(expert, fromProlific) {
  if (!expert) return null;
  return fromProlific ? EXPERT_POST_QUESTIONS_REQUIRED : EXPERT_POST_QUESTIONS;
}
export function expertPreTaskQuestions(expert, fromProlific) {
  if (!expert) return null;
  return fromProlific ? EXPERT_PRETASK_QUESTIONS_REQUIRED : EXPERT_PRETASK_QUESTIONS;
}
export function quizApplies(expert, participant, quizParam) {
  if (quizParam === "0") return false;
  if (quizParam === "1") return true;
  return expert && participant?.source === "prolific";
}
/* The hold-still ring: expert mode's is longer (JT, 2026-10-07), the novice study keeps the tutor's. */
export const commitOptsFor = (expert) => (expert ? EXPERT_COMMIT_OPTS : TUTOR_COMMIT_OPTS);
const COMMIT_OPTS = commitOptsFor(EXPERT);
const repsFromUrl = () => (params.get("reps") !== null ? parseReps(params.get("reps")) : EXPERT ? { ...EXPERT_REPS } : { ...DEFAULT_REPS });
const hintPolicy = parseHintPolicy(params.get("hints"));
const debugOn = params.get("debug") === "1";
/* The grader (2026-10-16, JT: on every link): tutor/mix.js, the P rule, the O/E rule and OpenFS's second opinion on
 * I M N X (research/combine-2026-10-16). ?grader=old grades with the previous grader alone. The test site (its
 * index.html carries <meta name="grader-compare">, or ?compare=1) also shows each test sign's verdict next to the
 * old grader's; participants never see that. */
const GRADER = params.get("grader") === "old" ? "old" : "new";
const COMPARE = params.get("compare") === "1"
  || (typeof document !== "undefined" && document.querySelector('meta[name="grader-compare"]') !== null);
const QUIZ_DWELL_MS = 2600;
/* OpenFS's weights (16 MB) start downloading when the study mounts, behind the camera check and instructions; the
 * first trial waits for them at most this long, then grades without the second opinion until they arrive. */
const OPENFS_WAIT_MS = 10000;
let openfsPromise = null;
let openfsReady = null;
function startOpenFS() {
  if (GRADER !== "new" || openfsPromise) return openfsPromise;
  const t0 = performance.now();
  openfsPromise = loadOpenFS().then((o) => {
    openfsReady = o;
    if (session) session.openfsLoadMs = Math.round(performance.now() - t0);
    return o;
  }).catch((err) => {
    // Grade anyway, without the second opinion, and say so where a tester will look.
    if (session) session.openfsError = String(err?.message || err);
    console.warn(`asl-study: OpenFS not loaded, grading without its second opinion (${err?.message || err})`);
    return null;
  });
  return openfsPromise;
}

const shortWhy = (o) => (o.outcome === "accept" ? "" : o.reason === "tracking" ? "hand not fully in view"
  : o.reason === "borderline" ? "too close to call" : o.rival && !o.rival.startsWith("_") ? `read as ${o.rival}` : "not a clear letter");

/** One line under the letter after each test sign: the verdict, and where the new grader differs from the old. */
export function quizText(v, letter) {
  const ok = v.outcome === "accept";
  if (!v.mix) return ok ? "✓ Recognized" : `✗ Not recognized (${shortWhy(v)})`;
  const old = v.mix.old, oldOk = old.outcome === "accept";
  const how = v.mix.by === "second-opinion" ? ` (OpenFS read ${letter}, ${Math.round(100 * v.mix.openfs.pTarget)}%)`
    : v.mix.by === "p-rule" ? (ok ? " (fingers point up, so not P)" : " (P has to point down)")
    : v.mix.by === "o-e-rule" ? (ok ? " (fingers curved round like an O, so not E)" : " (E folds the fingertips down to the knuckles)") : "";
  if (ok && oldOk) return "✓ Recognized";
  if (ok) return `✓ Recognized by the new grader${how}. Old grader: ✗ ${shortWhy(old)}`;
  if (oldOk) return `✗ Not recognized${how}. Old grader: ✓`;
  return `✗ Not recognized (${shortWhy(v)})${v.mix.openfs ? `. OpenFS read ${v.mix.openfs.top}` : ""}`;
}

/* The runner reads maxTrials before mount, for "Trial 3 of N": N is the plan's
 * length, known from the URL alone. A bad URL falls back to the default; mount
 * then reports the real complaint. */
function plannedTrials() {
  try {
    const r = repsFromUrl();
    return parseStudyLetters(params.get("letters")).length * (r.pre + r.teach + r.post);
  } catch {
    return LETTERS.length * (DEFAULT_REPS.pre + DEFAULT_REPS.teach + DEFAULT_REPS.post);
  }
}

let view = null;
let debug = null;
let session = null;
let mountError = null;
let picker = null;

export default {
  id: "asl-study",
  title: "Learning the fingerspelling alphabet",

  tracker: "hand",
  // Two, so that the other hand coming into view cannot take the tracker away
  // from the one being used: pickHand below keeps the asked-for hand, and the
  // other is never graded, drawn or saved (tutor/pick-hand.js).
  trackerOptions: { numHands: 2 },

  pickHand(res, { aspect, demographics }) {
    const want = studyHand(demographics);
    if (picker?.want !== want) picker = Object.assign(createHandPicker(want), { want });
    return picker(res, aspect);
  },

  maxTrials: plannedTrials(),

  // Before the camera (js/core/experiment.js, step 2b): the ASL check, when it applies, resolving with its record.
  async screening({ participant, demographics, root, show }) {
    if (!quizApplies(EXPERT, participant, params.get("quiz"))) return null;
    return runSignQuiz({ seed: seedFromParticipant(participant?.participantId), fluency: demographics?.aslFluency, root, show });
  },

  // Expert mode's own questions (JT, 2026-10-18): the ASL question first, years on a slider. The novice study keeps
  // questions.js DEMOGRAPHIC_QUESTIONS.
  demographicQuestions: EXPERT ? EXPERT_DEMOGRAPHIC_QUESTIONS : null,
  // ...and its own questions at the end (Indranil, 2026-10-18): required on a Prolific link (the completion code comes
  // after them), optional otherwise.
  postQuestions: expertPostQuestions(EXPERT, params.has("PROLIFIC_PID")),
  // ...and two before the task (Indranil, 2026-10-18), same rule.
  preTaskQuestions: expertPreTaskQuestions(EXPERT, params.has("PROLIFIC_PID")),

  // Expert mode always shows its instructions page (EXPERT_TEXT); otherwise
  // config.js SCREENS.instructions decides, as before.
  showInstructions: EXPERT ? true : null,

  // The camera check lets nobody past with the other hand, at the start or
  // when WRONG_HAND_LIMIT holds in a row were made with it.
  handProblem(res, k, { aspect, demographics }) {
    return handProblem(res.landmarks[k], res.handedness?.[k], aspect, studyHand(demographics));
  },
  needsHandCheck: () => !!session?.handCheck,
  handCheckDone() { if (session) { session.handCheck = false; session.wrongStreak = 0; session.handChecks = (session.handChecks ?? 0) + 1; } },
  handCheckText: ({ demographics } = {}) => {
    const hand = studyHand(demographics), other = hand === "right" ? "left" : "right";
    return {
      heading: `Please use your ${hand} hand`,
      text: `We keep seeing your ${other} hand. You told us you write with your ${hand} hand, so this study only counts your ${hand} hand, for every letter. Hold up your ${hand} hand. When we can see it, the button below will turn on.`,
    };
  },

  // The camera check says which hand to use: the instructions page is off
  // (config.js SCREENS.instructions), so this is where people learn it.
  positionText: ({ demographics } = {}) =>
    `Hold up your ${studyHand(demographics)} hand in front of the camera. Use only this hand for every letter. When we can see it clearly, the button below will turn on.`,

  // JT, 2026-09-23: this and a film of a few trials, nothing more.
  instructions: ({ demographics } = {}) => EXPERT ? `
    <p><strong>Fingerspell each letter with one hand, using the ASL alphabet handshapes.</strong> Do not draw the letter in the air.</p>
    <p>Make the handshape, then hold it still until the circle fills. Every letter comes up four times, in a random order. You will not be told whether each one was right.</p>
    <p>At the end you will go through the alphabet once in the practice mode that learners use, with pictures and feedback.</p>
    <p><strong>Please use your ${studyHand(demographics)} hand.</strong></p>
    ${demoVideo(TEST_DEMO, "A short film of someone fingerspelling three letters")}` : `
    <p>We will first see which signs you already know.</p>
    <p><strong>Please use your ${studyHand(demographics)} hand.</strong></p>
    ${demoVideo(TEST_DEMO, "A short film of someone signing three letters")}
    <p class="subtle">Make the sign, then hold your hand still until the circle fills.</p>`,

  mount(el, { participant, demographics }) {
    let letters = LETTERS.slice(), reps = { ...DEFAULT_REPS };
    try {
      letters = parseStudyLetters(params.get("letters"));
      reps = repsFromUrl();
    } catch (err) {
      mountError = err;   // thrown from nextTrial, where the runner shows it
    }
    const urlSeed = params.get("seed");
    const seed = urlSeed !== null && urlSeed !== "" && Number.isInteger(Number(urlSeed))
      ? Number(urlSeed) >>> 0 : seedFromParticipant(participant?.participantId);

    const plan = buildPlan(letters, reps, seed, EXPERT ? EXPERT_PHASES : PHASES);
    session = {
      letters, reps, seed, seedSource: urlSeed ? "url" : "participantId", plan, hand: studyHand(demographics),
      model: null, modelSha: null, engine: null, sessionLogged: false, replayExhausted: false,
      results: [],
    };
    view = mountTutor(el, { letters, hintPolicy, layout: "study", hand: session.hand,
      ...(EXPERT ? { testLabel: EXPERT_TEXT.label, testHelper: EXPERT_TEXT.helper } : {}) });
    if (debugOn) debug = createDebug(el, { getModel: () => session.model, canSave: !params.has("replay") });
    startOpenFS();
  },

  async nextTrial(index) {
    if (mountError) throw mountError;
    if (index === 0) await loadEverything();
    if (session.replayExhausted) return null;
    const step = session.plan[index];
    if (!step) return null;
    const next = session.plan[index + 1];
    const lastOfPart = next && next.kind !== step.kind;
    return {
      id: `t${String(index + 1).padStart(3, "0")}_${step.letter}_${step.kind}`,
      letter: step.letter,
      kind: step.kind,
      pass: step.pass,
      durationSec: step.kind === "teach" ? TEACH_DURATION_SEC : QUIZ_DURATION_SEC,
      countdownSec: 0,
      skipRest: !lastOfPart,
      ...(lastOfPart ? (EXPERT ? EXPERT_BREAKS : BREAKS)[next.kind] : {}),
      backgroundUpload: true,
    };
  },

  onTrialStart(trial, { tracker }) {
    session.engine.startTrial(trial);
    debug?.trialStart(trial);
    return { tracker, addEvent: null, overlay: true };
  },

  onFrame({ landmarks, handedness, handednessScore, tMs, trial, state, video, addEvent, endTrial }) {
    state.addEvent = addEvent;
    if (!session.sessionLogged) {
      session.sessionLogged = true;
      addEvent("study-session", sessionRecord());
    }
    const flat = landmarks ? flattenRounded(landmarks, DECIMALS) : null;
    const out = session.engine.frame({ tMs, flat, aspect: video.aspect, videoHeight: video.height, handedness });
    view.progress(out.progress);
    view.paused(out.paused);
    applyEffects(out.effects, { trial, addEvent, endTrial });
    debug?.frame({ flat, handedness, handednessScore, trial, videoInfo: video, committerState: session.engine.committerState, progress: out.progress });

    let derived = { progress: round3(out.progress) };
    if (out.committed) derived = { ...derived, committed: true, sign: out.sign };
    if (state.tracker?.exhausted) {
      session.replayExhausted = true;
      if (session.engine.hasPending()) applyEffects(session.engine.flushAll(), { trial, addEvent, endTrial });
      else if (!session.engine.flowState?.ended) endTrial("replay-finished");
    }
    return derived;
  },

  // Dots on the hand in every part (JT): people should see they are tracked.
  draw(ctx, { landmarks, canvas }) {
    drawLandmarks(ctx, canvas, landmarks);
  },

  onTrialEnd({ state, endReason }) {
    if (state.addEvent == null) console.warn("asl-study: a zero-frame trial; its log rows were dropped");
    for (const e of session.engine.finishTrial(endReason)) {
      if (e.kind === "log") state.addEvent?.(e.event, e.data);
    }
    const s = session.engine.summary();
    const row = {
      letter: s.letter, kind: s.kind, attempts: s.attempts, outcome: s.outcome ?? null, wrongHand: !!s.wrongHand,
      // THE study measure: the model accepted it AND it was made with the asked-for hand.
      correct: s.outcome === "accept" && !s.wrongHand,
      firstHoldRight: s.firstHoldRight,
      firstAttemptCorrect: s.firstAttemptCorrect, assisted: s.assisted, finalOutcome: s.finalOutcome,
      gradable: true,
      strictTier: session.model.tiers[s.letter] ?? null,
    };
    if (session.results.length === 0) {
      row.study = { ...sessionRecord(), modelSha256: session.modelSha, plannedTrials: session.plan.length };
    }
    session.results.push(row);
    return row;
  },

  /* For tools/e2e-smoke.sh: the session in a few numbers. */
  e2eSummary(trialSummaries) {
    const n = (f) => trialSummaries.filter(f).length;
    return {
      letters: session.letters.join(""), reps: session.reps, planned: session.plan.length,
      pre: n((s) => s.kind === "pre"), teach: n((s) => s.kind === "teach"), post: n((s) => s.kind === "post"),
      recorded: n((s) => s.finalOutcome === "recorded"),
      quizAccepted: n((s) => (s.kind === "pre" || s.kind === "post") && s.correct === true),
      taught: n((s) => s.kind === "teach" && s.finalOutcome === "intro-done"),
      // the ring this session ran with, as saved with its data (expert mode's is longer)
      ringMs: trialSummaries[0]?.study?.commitOptions?.holdMs ?? null,
    };
  },

  /* The page someone reads for ten seconds after they finish. Pre- and
   * post-test outcomes side by side, for the letters the model grades -- and
   * only there: "correct" on an ungraded letter would be a guess. */
  renderResults(summaries) {
    const by = {};
    for (const s of summaries) {
      if (!s.letter || !s.gradable) continue;
      const r = by[s.letter] ??= { pre: [], post: [], teach: 0, taught: 0 };
      if (s.kind === "teach") { r.teach++; if (s.finalOutcome === "intro-done" && s.firstAttemptCorrect) r.taught++; }
      else if (s.kind === "pre" || s.kind === "post") r[s.kind].push(s.correct === true);
    }
    const letters = Object.keys(by).sort();
    if (!letters.length) return `<p class="subtle">No graded letters in this session.</p>`;
    const pct = (a) => (a.length ? `${Math.round(100 * a.filter(Boolean).length / a.length)}%` : "—");
    const all = (k) => pct(letters.flatMap((l) => by[l][k]));
    if (letters.every((l) => !by[l].pre.length)) {        // expert mode: the test only
      return `<p>How often the model recognized each letter (it never told you during the task):</p>
        <p><strong>All letters: ${all("post")}</strong></p>
        <table class="results"><tr><th>letter</th><th>recognized</th></tr>
        ${letters.map((l) => `<tr><th>${l}</th><td>${pct(by[l].post)}</td></tr>`).join("")}
        </table>
        <p class="subtle">Grading is approximate and based on public data — where you signed a letter correctly and it says otherwise, the model is wrong.
        Handshapes are read with MediaPipe (Google) and OpenFS (KETI), used here for non-commercial research.</p>`;
    }
    return `<p>Your letters before and after the learning part (the model's
        verdict, never shown during the checks; a letter made with the other
        hand counts as not right):</p>
      <p><strong>Before: ${all("pre")} &nbsp; After: ${all("post")}</strong></p>
      <table class="results"><tr><th>letter</th><th>before</th><th>after</th></tr>
      ${letters.map((l) => `<tr><th>${l}</th><td>${pct(by[l].pre)}</td><td>${pct(by[l].post)}</td></tr>`).join("")}
      </table>
      <p class="subtle">Grading is approximate and based on public data — it can be wrong. Handshapes are read with
      MediaPipe (Google) and OpenFS (KETI), used here for non-commercial research.</p>`;
  },
};

async function loadEverything() {
  let text;
  try {
    const res = await fetch(MODEL_PATH, { cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (err) {
    throw new Error(`Could not load the grading model from ${MODEL_PATH} (${err?.message || err}).`);
  }
  session.model = loadModel(JSON.parse(text));
  if (GRADER === "new") {
    let timer;
    await Promise.race([startOpenFS(), new Promise((r) => { timer = setTimeout(r, OPENFS_WAIT_MS); })]);
    clearTimeout(timer);
    if (!openfsReady && !session.openfsError) console.warn("asl-study: OpenFS still loading; grading without its second opinion until it arrives");
  }
  session.engine = createEngine({
    model: session.model, letters: session.letters, hintPolicy, gradeAll: true, hand: session.hand, commitOpts: COMMIT_OPTS,
    mix: GRADER === "new" ? { getOpenFS: () => openfsReady } : null,
    deps: COMPARE ? { quizText, quizDwellMs: QUIZ_DWELL_MS } : {},
  });
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  session.modelSha = [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function sessionRecord() {
  return {
    studyVersion: STUDY_VERSION, tutorVersion: TUTOR_VERSION, hintPolicy,
    letters: session.letters.join(""), reps: session.reps, seed: session.seed, seedSource: session.seedSource,
    plannedTrials: session.plan.length, commitOptions: COMMIT_OPTS, debug: debugOn, hand: session.hand, mode: EXPERT ? "expert" : "study",
    grader: GRADER, openfsError: session.openfsError ?? null, openfsLoadMs: session.openfsLoadMs ?? null,
  };
}

function applyEffects(effects, { trial, addEvent, endTrial }) {
  for (const e of effects) {
    switch (e.kind) {
      case "cue": view.cue(e); break;
      case "feedback":
        view.feedback(e, trial.letter);
        addEvent("feedback", { trialId: trial.id, letter: trial.letter, tone: e.tone, hintId: e.hintId ?? null, showPicture: !!e.showPicture });
        break;
      case "status": view.status(e.text); break;
      case "reward": view.reward(e.points); break;
      case "complete": view.complete(); break;
      case "log":
        addEvent(e.event, e.data);
        if (e.event === "attempt") {
          debug?.attempt(e.data);
          session.wrongStreak = nextWrongStreak(session.wrongStreak ?? 0, e.data);
          if (session.wrongStreak >= WRONG_HAND_LIMIT && !session.handCheck) { session.handCheck = true; endTrial("wrong-hand"); }
        }
        break;
      case "end-trial": endTrial(e.reason); break;
      case "schedule-report": break;   // the study has no adaptive schedule
      default: console.warn(`asl-study: unknown effect ${e.kind}`);
    }
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000;
export { pictureUrl };
