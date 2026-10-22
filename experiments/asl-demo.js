/* asl-demo.js: the ghost-hand demo (Indranil and JT, 19 Oct 2026, for a meeting with Duolingo).
 *
 * The practice part of the study -- the letter, its picture and description, the hold-still ring, the grader and
 * its one-thing-to-change hints -- with the letter's PICTURE laid over the learner's own hand on the camera view, at
 * their hand's size (experiments/asl-tutor/picture-ghost.js; ?look=hand shows instead the outline of a real hand as
 * the camera sees it, experiments/asl-tutor/ghost.js). It is live: while the hand moves, the finger the grader would
 * ask to change glows amber on the learner's hand, and the picture turns green the moment the grader would accept the
 * hand as it is (experiments/asl-tutor/coach.js).
 *
 * Nothing is saved, ever: this experiment refuses to run where config.js has Firebase settings (the study site), so
 * it can only run on the demo site or locally. No consent or questionnaire screens are shown by it either.
 *
 * What it says after a hold is SPECIFIC (JT's class, 19 Oct: tell them which sign it was and how to fix it): the letter
 * the hand looks like, when the grader is sure of one, and the one thing to change (tutor/feedback.js; flow.js
 * deps.specific). The room is dimmed and blurred around the hand so the outline stands out (JT, 19 Oct; focus.js).
 *
 * GLOVES (20 Oct; Indranil's renders, JT: "a glove that you have to put your hand into"; for Thursday L X G, right
 * hand): a letter with a glove (assets/gloves/gloves.json) shows the glove instead of the outline
 * (experiments/asl-tutor/glove.js), in the same spot, at the same size, saying the same things, and with a jelly
 * wobble when the hold is accepted. Drawing only: the hold, the grader and the words are as before. The demo starts on
 * those three letters.
 *
 * URL: ?exp=asl-demo [&letters=BLYG...] (in that order; default L X G) [&reps=n] (times through, default 1)
 *      [&hand=left] [&ghost=0] (start with the outline off) [&follow=1] (on the hand, not in a spot)
 *      [&look=outline|picture|hand] (default glove, where the letter has one; the outline otherwise)
 *      [&dots=0] (hide the learner's skeleton) [&focus=0] (no dimming) [&meters=1] (a meter per finger, JT's idea)
 *      [&notes=1] (what the tutor read on each hold, for a teacher) [&fade=1] (the outline fades as a letter is learned;
 *      with &reps=) [&srcmirror=1] [&debug=1]
 * Keys while practising: G outline, F dimming, M meters, T the tutor's notes (for a teacher: it shows the grader's
 * numbers, so the learner's screen never mentions it), N or -> next letter. */

import { flattenRounded, DECIMALS } from "../tutor/landmarks.js";
import { loadModel } from "../tutor/verifier.js";
import { loadOpenFS } from "../tutor/openfs.js";
import { LETTERS, pictureUrl } from "../tutor/letters.js";
import { createEngine, TUTOR_COMMIT_OPTS } from "./asl-tutor/engine.js";
import { mountTutor } from "./asl-tutor/ui.js";
import { createDebug } from "./asl-tutor/debug.js";
import { createGhost } from "./asl-tutor/ghost.js";
import { createPictureGhost } from "./asl-tutor/picture-ghost.js";
import { createGloveGhost } from "./asl-tutor/glove.js";
import { createCoach } from "./asl-tutor/coach.js";
import { createFocus } from "./asl-tutor/focus.js";
import { createMeters } from "./asl-tutor/meters.js";
import { createNotesView } from "./asl-tutor/notes-view.js";
import { createMotionGuide } from "./asl-tutor/motion-guide.js";
import { createHandPicker, handSide } from "../tutor/pick-hand.js";
import { configLooksUnfilled } from "../js/core/firebase.js";

export const DEMO_VERSION = "asl-demo/3";
/* What loadEverything prepares. pictureArtForGloveLetters: the outline art of a letter that has a glove is built too,
 * though with the glove look it is never drawn (the laptop has always built it). The phone version (mobile/app.js) turns
 * it off: rasterising and schematizing each picture is a long task on a phone's main thread. Drawing and grading are the
 * same either way. */
export const LOAD = { pictureArtForGloveLetters: true, openfsAtMount: true, openfsWaitMs: 10000 };
/* openfsAtMount / openfsWaitMs (OPENFS_WAIT_MS): when the second opinion's weights (16 MB) start loading, and how long
 * the first letter waits for them. The phone version starts them after its hand tracker and waits for them before any
 * letter they grade instead (openfsLoaded below; mobile/app.js), so those letters always get the same grader. */
const MODEL_PATH = "tutor/model.json";
const GHOST_PATH = "tutor/ghost-hands.json";
const PICTURES_PATH = "tutor/ghost-pictures.json";
const GLOVES_PATH = "assets/gloves/gloves.json";
/* The letters a bare link practises: JT, 20 Oct ("For now just right hand: let's just do, L X G"), the three with gloves. */
export const DEFAULT_LETTERS = Object.freeze(["L", "X", "G"]);
/* A letter stays up until it is made (or skipped): the tutor's own safety valve still ends it after five different
 * missed hands, so a letter the grader cannot see never traps anyone. */
const TRIAL_SEC = 300;
const OPENFS_WAIT_MS = 10000;

/* J and Z move: the line says how, with the gold path (motion-guide.js) to follow. */
export const MOTION_LIVE = Object.freeze({
  J: "Make an I, then draw the J along the gold path.",
  Z: "Point your index finger, then draw the Z along the gold path.",
});
/* What the line under the letter says while the hand moves, for each look. */
export const LIVE_TEXT = Object.freeze({
  match: "That's it. Hold it still.",
  accepted: "",
  neutral: "Put your hand inside the outline.",
  reshape: "Shape your hand like the picture.",
  orientation: "Turn your hand to match the outline.",
  spread: "Match the gaps between your fingers.",
  thumb: "Move your thumb where the gold one goes.",
  finger: (f) => `Move your ${f} finger where the gold one goes.`,
  digits: (ds) => `Move your ${digitsPhrase(ds)} where the gold ones go.`,
});
/* The same with a glove: no gold lines (Indranil, 20 Oct: "the mismatch between skeleton and glove provides enough
 * corrective feedback"), so the words say what to match. */
export const GLOVE_TEXT = Object.freeze({
  ...LIVE_TEXT,
  neutral: "Put your hand inside the glove.",
  orientation: "Turn your hand to match the glove.",
  thumb: "Move your thumb to match the glove.",
  finger: (f) => `Move your ${f} finger to match the glove.`,
  digits: (ds) => `Move your ${digitsPhrase(ds)} to match the glove.`,
});
/* ...prefixed, once it has settled (coach.js LOOKS_SETTLE_MS), with the letter the hand looks like instead. */
export const looksText = (L) => `Looks like ${L}. `;
/* `noun`: what is drawn for the hand to fit, "outline" or "glove". */
export function liveText(look, noun = "outline") {
  const T = noun === "glove" ? GLOVE_TEXT : LIVE_TEXT;
  if (!look) return T.neutral;
  if (look.state === "match") return T.match;
  if (look.state === "accepted") return T.accepted;
  const named = look.looksLike ? looksText(look.looksLike) : "";
  // a hand that is another letter, with no one part to change: the shape is what to fix, not where the hand is
  if (look.state !== "fix" || !look.blocks.length) return named ? named + T.reshape : T.neutral;
  const b = look.blocks[0];
  if (b === "orientation") return named + T.orientation;
  if (b === "spread") return named + T.spread;
  const digits = look.blocks.filter((x) => x !== "orientation" && x !== "spread");
  if (digits.length > 1) return named + T.digits(digits);
  if (b === "thumb") return named + T.thumb;
  return named + T.finger(b);
}
/* "index finger and thumb", "middle, ring and pinky fingers": every golden finger, by name. */
export function digitsPhrase(digits) {
  const fingers = digits.filter((d) => d !== "thumb"), thumb = digits.includes("thumb");
  const f = !fingers.length ? "" : fingers.length === 1 ? `${fingers[0]} finger` : `${fingers.slice(0, -1).join(", ")} and ${fingers[fingers.length - 1]} fingers`;
  return thumb ? (f ? `${f} and thumb` : "thumb") : f;
}

/* Forgiving on purpose (a demo link gets typed and pasted): anything that is not a letter is ignored -- a full stop
 * pasted from the end of a sentence, spaces, commas. Only a link with no letters at all is refused. */
export function parseDemoLetters(raw) {
  if (raw === null || raw.trim() === "") return DEFAULT_LETTERS.slice();
  const letters = raw.toUpperCase().split("").filter((c) => LETTERS.includes(c));
  if (!letters.length) throw new Error(`?letters=${raw} has no letters in it. Use A-Z, for example ?letters=BLFG.`);
  return letters;
}
export function parseDemoReps(raw) {
  if (raw === null || raw === "") return 1;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error(`?reps=${raw} should be a whole number from 1 to 20.`);
  return n;
}
/** The letters in the order given, `reps` times through. */
export const demoPlan = (letters, reps) => Array.from({ length: reps }, (_, r) => letters.map((letter) => ({ letter, pass: r }))).flat();

const params = new URLSearchParams(typeof location === "undefined" ? "" : location.search);
const HAND = params.get("hand") === "left" ? "left" : "right";
const debugOn = params.get("debug") === "1";
/* What is drawn for the hand to fit: the letter's GLOVE where it has one (default; Indranil's renders, 20 Oct), else the
 * letter's picture SCHEMATIZED to its clean outline (Indranil, 19 Oct: "more of a schematized outline (no details like
 * knuckles)", so a right hand's skeleton sits inside it); ?look=outline, the outline for every letter; ?look=picture,
 * the whole picture; ?look=hand, the outline of a real hand (experiments/asl-tutor/ghost.js). */
const LOOK_STYLE = ["outline", "picture", "hand", "plain"].includes(params.get("look")) ? params.get("look") : "glove";
/* ?look=plain (the phone version's version without a glove, 22 Oct; the owner: "the simple clean version where it shows
 * them the letter and they sign it ... none of the yellow feedback"; "i want the pose diagram on the hand"): nothing
 * drawn to fit the hand into and no live coaching -- the letter, its picture, the learner's own hand skeleton and the
 * hold ring; a hold that is not the letter is answered "Not quite. Try again." instead of what to change. When a hold is taken and how it is graded are exactly as in the other looks. */
const PLAIN = LOOK_STYLE === "plain";
export const PLAIN_RETRY = "Not quite. Try again.";
const gloveFor = (letter) => LOOK_STYLE === "glove" && !!session?.glove?.has(letter);
const shapeWord = () => (LOOK_STYLE === "glove" ? "glove" : "outline");
// The picture stays in one spot for the hand to fit into (the owner, 19 Oct); ?follow=1 puts it on the hand instead.
const FOLLOW = params.get("follow") === "1";
// the learner's own tracked skeleton, to compare with the outline (Indranil, 19 Oct: "retain the hand skeleton");
// ?dots=0 hides it
const DOTS = params.get("dots") !== "0";
// the room dimmed around the hand (JT, 19 Oct): with the outline; not with a glove (Indranil, 20 Oct: "the glove and
// skeleton are prominent enough"); ?focus=1 / 0 either way, or F
const FOCUS_ON = params.get("focus") === "1" || (params.get("focus") !== "0" && LOOK_STYLE !== "glove" && !PLAIN);
// a meter per finger (JT's "symbolic" feedback, thinking it through, 19 Oct): off unless ?meters=1 (or M)
const METERS_ON = params.get("meters") === "1";
// what the tutor read on each hold (the CHI 2026 paper's decomposition): off unless ?notes=1 (or T)
const NOTES_ON = params.get("notes") === "1";
/* ?fade=1: the guidance fades as each letter is learned (Hsieh et al., CHI 2026: a ghost hand whose transparency
 * followed performance beat a fixed one on retention; YouMove's stages; the guidance hypothesis, Salmoni et al. 1984).
 * Each time a letter is made, its outline (and golden finger, and J/Z path) is shown fainter the next time it comes
 * round -- full, 60%, 30%, then gone: from memory -- and it comes back in full after two misses on that letter in a
 * row. Only letters that come round more than once fade (use with &reps=). */
const FADE = params.get("fade") === "1";
export const FADE_STEPS = Object.freeze([1, 0.6, 0.3, 0]);
export const FADE_BACK_AFTER = 2;
export const guidanceFor = (made, misses) => (misses >= FADE_BACK_AFTER ? 1 : FADE_STEPS[Math.min(made, FADE_STEPS.length - 1)]);
export const FROM_MEMORY = "From memory: make the letter, then hold it still.";
export const FROM_MEMORY_MOTION = Object.freeze({
  J: "From memory: make an I, then draw a J in the air with your pinky.",
  Z: "From memory: point your index finger and draw a Z in the air.",
});

let session = null, view = null, debug = null, mountError = null, picker = null, focus = null, meters = null, notesView = null;
let openfsReady = null, openfsPromise = null;
/** The second opinion's weights, loading (started on the first call); resolves to the model, or null if they failed. */
export const openfsLoaded = () => startOpenFS();
function startOpenFS() {
  openfsPromise ??= loadOpenFS().then((o) => { openfsReady = o; return o; }).catch((err) => {
    console.warn(`asl-demo: OpenFS not loaded, grading without its second opinion (${err?.message || err})`);
    return null;
  });
  return openfsPromise;
}

export default {
  id: "asl-demo",
  title: "Fingerspelling practice with a ghost hand",
  tracker: "hand",
  trackerOptions: { numHands: 2 },
  pickHand(res, { aspect }) {
    picker ??= createHandPicker(HAND);
    return picker(res, aspect);
  },
  /* The camera check lets only the asked-for hand through (as the study's does). A camera that sends a mirror image
   * makes a right hand look like a left one, and nothing would ever be accepted: so it also offers to flip it. */
  handProblem(res, k, { aspect }) {
    const side = handSide(res.landmarks[k], res.handedness?.[k], aspect);
    const wrong = side && side !== HAND;
    showFlipOffer(wrong);
    return wrong ? `That looks like your ${side} hand. Please hold up your ${HAND} hand.` : null;
  },

  maxTrials: (() => { try { return demoPlan(parseDemoLetters(params.get("letters")), parseDemoReps(params.get("reps"))).length; } catch { return 26; } })(),
  demographicQuestions: [],
  postQuestions: [],
  showInstructions: true,
  positionText: () => `Hold up your ${HAND} hand in front of the camera. When we can see it clearly, the button below will turn on.`,
  instructions: () => `
    <p><strong>Fingerspell each letter with your ${HAND} hand.</strong> ${LOOK_STYLE === "glove"
      ? "A glove for the letter sits in the camera view, sized to your hand: put your hand into the glove, turned and shaped to fit. The letter's picture is on the right."
      : "The letter's picture is on the right, and the same picture is drawn in the camera view, sized to your hand: put your hand into it, turned and shaped to fit."}</p>
    <ul class="demo-legend-list">
      <li><span class="demo-chip demo-chip-neutral"></span> Fit your hand into the ${LOOK_STYLE === "glove" ? "glove" : "picture"}.</li>
      ${LOOK_STYLE === "glove" ? "" : `<li><span class="demo-chip demo-chip-fix"></span> A gold finger shows which finger to move, and where to.</li>`}
      <li><span class="demo-chip demo-chip-match"></span> Green: that's the letter. Hold still until the circle fills.</li>
    </ul>
    <p>If your hand makes a different letter, it says which one, and what to change.</p>
    <p class="subtle">Keys: <kbd>G</kbd> ${shapeWord()}, <kbd>F</kbd> dimming, <kbd>M</kbd> a meter per finger, <kbd>N</kbd> next letter.
       Nothing is recorded or saved.</p>`,

  mount(el) {
    let letters = DEFAULT_LETTERS.slice(), reps = 1;
    try {
      if (!configLooksUnfilled()) throw new Error("The ghost-hand demo saves nothing, so it runs only on the demo site, not where the study saves data.");
      letters = parseDemoLetters(params.get("letters"));
      reps = parseDemoReps(params.get("reps"));
    } catch (err) {
      mountError = err;
    }
    session = { letters, reps, plan: demoPlan(letters, reps), model: null, engine: null, ghost: null, coach: null,
      ghostOn: params.get("ghost") !== "0" && !PLAIN, endTrial: null, trial: null, look: null, results: [], made: {} };
    view = mountTutor(el, { letters, hintPolicy: "strict", layout: "study", hand: HAND });
    /* ONE line of words under the letter (ui.js shows the status line only while there is no feedback): the ghost's
     * live line, except for a moment after the tutor itself says something ("I keep losing your hand"; renderLine).
     * A correction from the last hold gives way to it (FEEDBACK_HOLD_MS), so the two never contradict each other. */
    session.statusNode = el.querySelector("#tutor-status");
    session.feedbackNode = el.querySelector("#tutor-feedback");
    session.tutorStatus = "";
    const cue = view.cue.bind(view), feedback = view.feedback.bind(view);
    view.status = (text) => {
      // "Hold still when you have the shape" is what the ghost's own line already says, better; the rest are shown
      session.tutorStatus = text === MOVED_LINE ? "" : text || "";
      session.tutorStatusAt = performance.now();
      renderLine();
    };
    view.cue = (e) => { cue(e); session.tutorStatus = ""; session.feedbackAt = null; renderLine(); };
    view.feedback = (e, letter) => { feedback(e, letter); session.feedbackAt = e.tone === "correction" ? performance.now() : null; };
    /* the legend and the tutor's notes go UNDER the panel, in its column: inside it they would squeeze the letter and
     * the picture (the panel is exactly as tall as the camera, split in two) */
    const side = document.createElement("div");
    side.className = "demo-side";
    const panel = el.querySelector(".tutor-panel");
    if (panel) panel.after(side); else el.append(side);
    side.insertAdjacentHTML("beforeend", `
      <div class="demo-legend" id="demo-legend">
        <span><span class="demo-chip demo-chip-neutral"></span>the shape to make</span>
        <span><span class="demo-chip demo-chip-you"></span>your hand</span>
        ${LOOK_STYLE === "glove" ? "" : `<span><span class="demo-chip demo-chip-fix"></span>change this</span>`}
        <span><span class="demo-chip demo-chip-match"></span>that's it</span>
        <span class="demo-keys"><span class="demo-key"><kbd>G</kbd> ${shapeWord()} <span id="demo-ghost-state">on</span></span>
          <span class="demo-key"><kbd>F</kbd> dimming <span id="demo-focus-state">on</span></span>
          <span class="demo-key"><kbd>M</kbd> meters <span id="demo-meters-state">off</span></span>
          <span class="demo-key"><kbd>N</kbd> next letter</span></span>
      </div>`);
    session.ghostState = el.querySelector("#demo-ghost-state");
    session.ghostState.textContent = session.ghostOn ? "on" : "off";
    const stage = document.querySelector("#stage");
    if (stage) {
      focus = createFocus(stage);
      focus.set(FOCUS_ON);
      meters = createMeters(stage, { hand: HAND });
      meters.show(METERS_ON);
    }
    // under the camera, where there is room for it
    const notesSlot = document.createElement("div");
    notesSlot.className = "demo-notes-slot";
    side.after(notesSlot);
    notesView = createNotesView(notesSlot);
    notesView.show(NOTES_ON);
    session.stateNodes = { focus: el.querySelector("#demo-focus-state"), meters: el.querySelector("#demo-meters-state"), notes: el.querySelector("#demo-notes-state") };
    showStates();
    if (debugOn) debug = createDebug(el, { getModel: () => session.model, canSave: false });
    document.addEventListener("keydown", onKey);
    // the platform's end-of-demo download button and its note are for researchers, not for this page
    document.documentElement.classList.add("asl-demo");
    if (LOAD.openfsAtMount) startOpenFS();
  },

  async nextTrial(index) {
    if (mountError) throw mountError;
    if (index === 0) await loadEverything();
    const step = session.plan[index];
    if (!step) return null;
    return {
      id: `d${String(index + 1).padStart(3, "0")}_${step.letter}`, letter: step.letter, kind: "teach", pass: step.pass,
      durationSec: TRIAL_SEC, countdownSec: 0, skipRest: true, backgroundUpload: false,
    };
  },

  onTrialStart(trial, { tracker }) {
    session.engine.startTrial(trial);
    session.coach.reset();
    session.ghost.reset();
    session.picture.reset();
    session.glove?.reset();
    session.motionGuide?.reset();
    meters?.reset();
    meters?.idle("JZ".includes(trial.letter));   // a movement has no finger levels: the panel stands aside
    session.trialLog = { misses: 0, looks: [] };
    session.trial = trial;
    session.celebratedAt = null;
    session.look = null;
    setLive(null);
    debug?.trialStart(trial);
    return { tracker, addEvent: null, overlay: true };
  },

  onFrame({ landmarks, handedness, handednessScore, tMs, trial, video, addEvent, endTrial }) {
    session.endTrial = endTrial;
    const flat = landmarks ? flattenRounded(landmarks, DECIMALS) : null;
    const out = session.engine.frame({ tMs, flat, aspect: video.aspect, videoHeight: video.height, handedness });
    view.progress(out.progress);
    view.paused(out.paused);
    const look = session.coach.update({ flat, aspect: video.aspect, videoHeight: video.height }, trial.letter, tMs);
    applyEffects(out.effects, { trial, addEvent, endTrial });
    if (session.look !== session.coach.look) setLive(session.coach.look);
    session.look = session.coach.look ?? look;
    safely("meters", () => meters?.update(session.coach.levels, session.look));
    renderLine();
    debug?.frame({ flat, handedness, handednessScore, trial, videoInfo: video, committerState: session.engine.committerState, progress: out.progress });
    return { progress: Math.round(out.progress * 1000) / 1000 };
  },

  // the ghost; the learner's own tracked hand on top of it only with ?dots=1 (or with the ghost off, so they can see
  // they are tracked)
  draw(ctx, { landmarks, canvas, trial }) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    if (!session) return;
    session.video ??= document.querySelector("#stage video");
    safely("dimming", () => focus?.draw(session.video, landmarks, performance.now()));
    if (session?.ghostOn && session.ghost && trial) {
      const strength = guidance();
      // J and Z: the picture (with its own drawn arrow) fainter, so the gold path is plainly the one to follow
      const pictureStrength = "JZ".includes(trial.letter) ? 0.4 * strength : strength;
      if (gloveFor(trial.letter)) {
        session.glove.draw(ctx, canvas, landmarks, trial.letter, session.look, performance.now(), strength);
      } else if (LOOK_STYLE !== "hand" && session.picture.has(trial.letter)) {
        session.picture.draw(ctx, canvas, landmarks, trial.letter, session.look, performance.now(), pictureStrength);
      } else if (strength > 0) {
        session.ghost.draw(ctx, canvas, landmarks, trial.letter, HAND, strength, session.look, performance.now());
      }
    }
    if (DOTS || !session?.ghostOn) {
      drawHand(ctx, canvas, landmarks, PLAIN && trial && session.celebratedAt != null ? performance.now() - session.celebratedAt : null);
    }
    // J and Z: the stroke to draw, from the fingertip, and the fingertip's own trail -- on top of the skeleton
    if (session.ghostOn && trial) safely("J/Z path", () => session.motionGuide?.draw(ctx, canvas, landmarks, trial.letter, performance.now(), guidance()));
  },

  onTrialEnd({ endReason }) {
    focus?.hide();
    session.engine.finishTrial(endReason);
    const s = session.engine.summary();
    const correct = s.outcome === "accept", log = session.trialLog ?? { misses: 0, looks: [] };
    if (correct) session.made[s.letter] = (session.made[s.letter] ?? 0) + 1;
    const row = { letter: s.letter, kind: "teach", outcome: s.outcome ?? null, attempts: s.attempts, correct, endReason,
      tries: log.misses + (correct ? 1 : 0), looks: [...new Set(log.looks)] };
    session.results.push(row);
    return row;
  },

  renderResults(summaries) {
    const got = summaries.filter((s) => s.correct).length;
    return `<p><strong>${got} of ${summaries.length} letters made.</strong></p>
      ${resultsTable(summaries)}
      <p><a class="demo-again" href="${location.href}">Practice again</a></p>
      <p class="subtle">Research prototype. Grading is approximate and based on public data — it can be wrong. Hands are read
      with MediaPipe (Google) and OpenFS (KETI), used here for non-commercial research. Nothing was saved.</p>`;
  },
};

/* The session's letters, in order: made at once, made after some tries, not yet; and what each looked like instead
 * along the way (the CHI 2026 paper's learners asked for an error log). */
export function resultsTable(rows) {
  if (!rows.length) return "";
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const result = (r) => (r.correct ? (r.tries <= 1 ? "made, first try" : `made, after ${r.tries} tries`)
    : r.endReason === "skipped" ? "skipped" : "not yet");
  return `<table class="results demo-results">
      <tr><th>letter</th><th>result</th><th>looked like</th></tr>
      ${rows.map((r) => `<tr class="${r.correct ? "demo-made" : "demo-notyet"}"><th>${esc(r.letter)}</th><td>${result(r)}</td>
        <td>${(r.looks ?? []).length ? (r.looks ?? []).map(esc).join(", ") : "—"}</td></tr>`).join("")}
    </table>`;
}

/* Under the camera check, when it sees the other hand: a camera that sends a mirror image (the owner's Mac sometimes
 * does: the picture looks turned the wrong way round and a right hand reads as a left one) is fixed by ?srcmirror=1
 * (js/core/tracker.js). The button reloads with it toggled, and this browser remembers it (FLIP_KEY), so it is asked
 * once: the owner, 20 Oct, "it inverted my camera ... said I was using my left hand when I had my right up", having
 * missed the small link this used to be. */
export const FLIP_KEY = "asl-demo-srcmirror";
(() => {
  try {
    const q = new URLSearchParams(location.search);
    if (!q.has("srcmirror") && localStorage.getItem(FLIP_KEY) === "1") { q.set("srcmirror", "1"); location.replace(`?${q}`); }
  } catch { /* no page or no storage (tests, a private window): the button still works for this visit */ }
})();
let flipOffer = null;
function showFlipOffer(on) {
  if (typeof document === "undefined") return;
  if (!flipOffer) {
    // ABOVE the camera picture: under it (where the status line is) it was below the bottom of the screen
    const slot = document.querySelector("#position-stage-slot");
    if (!slot) return;
    flipOffer = document.createElement("div");
    flipOffer.className = "demo-flip";
    const q = new URLSearchParams(location.search);
    const mirrored = q.get("srcmirror") === "1";
    if (mirrored) q.delete("srcmirror"); else q.set("srcmirror", "1");
    const other = HAND === "right" ? "left" : "right";
    flipOffer.innerHTML = mirrored
      ? `<span>We see a ${other} hand. If you are holding up your ${HAND} hand, your camera may not need the flip:</span>
         <button type="button" class="demo-flip-btn">Undo the camera flip</button>`
      : `<span>We see a ${other} hand. If you are holding up your ${HAND} hand, your camera is sending a mirror image:</span>
         <button type="button" class="demo-flip-btn">This is my ${HAND} hand: flip the camera</button>`;
    flipOffer.querySelector("button").onclick = () => {
      try { if (mirrored) localStorage.removeItem(FLIP_KEY); else localStorage.setItem(FLIP_KEY, "1"); } catch { /* this visit only */ }
      location.href = `?${q}`;
    };
    slot.before(flipOffer);
  }
  flipOffer.hidden = !on;
}

function onKey(e) {
  if (e.target?.closest?.("input, textarea") || e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();
  if (k === "g") {
    session.ghostOn = !session.ghostOn;
    session.ghostState.textContent = session.ghostOn ? "on" : "off";
    setLive(session.look);
  } else if (k === "f" && focus) {
    focus.set(!focus.on);
    showStates();
  } else if (k === "m" && meters) {
    meters.show(!meters.shown);
    showStates();
  } else if (k === "t" && notesView) {
    notesView.show(!notesView.shown);
    showStates();
  } else if ((k === "n" || e.key === "ArrowRight") && session.endTrial && document.querySelector("#screen-trial.visible")) {
    session.endTrial("skipped");
  }
}

/* The add-ons drawn on top (the dimming, the J/Z path, the meters, the notes) must never be able to stop the frame
 * loop, which also runs the tracker and the grader: an error in one is reported once and that frame's drawing skipped. */
const reported = new Set();
function safely(what, fn) {
  try { fn(); } catch (err) {
    if (!reported.has(what)) { reported.add(what); console.error(`asl-demo: the ${what} failed and is skipped (${err?.message || err})`); }
  }
}

/* How much of the outline to show for the letter now up (1 without ?fade=1). */
function guidance() {
  if (!FADE || !session?.trial) return 1;
  return guidanceFor(session.made[session.trial.letter] ?? 0, session.trialLog?.misses ?? 0);
}

function showStates() {
  const n = session?.stateNodes;
  if (!n) return;
  if (n.focus) n.focus.textContent = focus?.on ? "on" : "off";
  if (n.meters) n.meters.textContent = meters?.shown ? "on" : "off";
  if (n.notes) n.notes.textContent = notesView?.shown ? "on" : "off";
}

/* A correction from the last hold stays up this long, then gives way to the ghost's live line, so the two never sit
 * side by side saying different things; a green ghost clears it at once ("that is a different sign" under a green
 * ghost would contradict it). "Good job" is never cleared. */
export const FEEDBACK_HOLD_MS = 2500;
function setLive(look) {
  if (session?.statusNode) renderLine(look);
}

/* What the tutor itself says (the hand is too small or keeps being lost, the hand has not let go of the last
 * letter, the same shape again, how to draw a J or Z) is shown for TUTOR_LINE_MS, then the ghost's line comes back;
 * on J and Z (no live grading) the tutor's line stays. */
export const TUTOR_LINE_MS = 2500;
const MOVED_LINE = "Hold still when you have the shape.";
function renderLine(look = session.look) {
  const n = session.statusNode;
  if (session.feedbackAt != null && session.ghostOn && (look?.state === "match" || performance.now() - session.feedbackAt >= FEEDBACK_HOLD_MS)) {
    session.feedbackNode.textContent = "";
    session.feedbackNode.className = "tutor-feedback";
    session.feedbackAt = null;
  }
  const motion = session.trial && "JZ".includes(session.trial.letter);
  let text, state;
  if (session.tutorStatus && (motion || performance.now() - session.tutorStatusAt < TUTOR_LINE_MS)) {
    text = session.tutorStatus; state = "tutor";
  } else if (!session.ghostOn) {
    text = "Copy the picture, then hold your hand still."; state = "tutor";
  } else if (guidance() === 0) {
    text = motion ? FROM_MEMORY_MOTION[session.trial.letter] : FROM_MEMORY; state = "tutor";
  } else if (motion) {
    text = MOTION_LIVE[session.trial.letter]; state = "neutral";
  } else {
    text = liveText(look, gloveFor(session.trial?.letter) ? "glove" : "outline"); state = look?.state ?? "neutral";
  }
  if (n.textContent !== text) n.textContent = text;
  if (n.dataset.state !== state) n.dataset.state = state;
}

async function loadEverything() {
  /* Three tries, a moment apart (the phone version, 22 Oct: on a phone network one failed request is ordinary, and it
   * used to end the session before it began). A file that is really missing still fails, with the same message. */
  const get = async (path, what) => {
    let last = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 600 * attempt));
      try {
        const res = await fetch(path, { cache: "no-store" });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return await res.json();
      } catch (err) {
        last = err;
        if (/^HTTP 4/.test(err?.message)) break;
      }
    }
    throw new Error(`Could not load the ${what} from ${path} (${last?.message || last}).`);
  };
  const [model, ghosts, pictures] = await Promise.all([get(MODEL_PATH, "grading model"), get(GHOST_PATH, "ghost hands"),
    get(PICTURES_PATH, "picture points")]);
  session.model = loadModel(model);
  session.ghost = createGhost(ghosts.letters);
  session.picture = createPictureGhost({ points: pictures.letters, templates: ghosts.letters, hand: HAND, follow: FOLLOW,
    style: LOOK_STYLE === "picture" ? "picture" : "outline" });
  const gloves = LOOK_STYLE === "glove" ? await get(GLOVES_PATH, "gloves") : null;
  const pictureLetters = gloves && !LOAD.pictureArtForGloveLetters ? session.letters.filter((L) => !gloves.letters?.[L]) : session.letters;
  if (LOOK_STYLE !== "hand" && !PLAIN) await session.picture.load(pictureLetters, pictureUrl);
  if (LOOK_STYLE === "glove") {
    session.glove = createGloveGhost({ gloves: gloves.letters, hand: HAND });
    await session.glove.load(session.letters);
  }
  session.motionGuide = createMotionGuide({ hand: HAND });
  session.coach = createCoach(session.model, { hand: HAND, bThumb: true, looksLike: true, levels: () => !!meters?.shown });
  if (LOAD.openfsWaitMs > 0) {
    let timer;
    await Promise.race([startOpenFS(), new Promise((r) => { timer = setTimeout(r, LOAD.openfsWaitMs); })]);
    clearTimeout(timer);
  }
  // EXACTLY the study's practice: its ring (0.9 s still), its grader, its hints. (The first demo used the expert ring,
  // 1.5 s after a 0.5 s settle: on the same real footage it took 10 letters where the study's practice took 16, and
  // Indranil and the owner both struggled to get to the next letter, 19 Oct.)
  // + the B thumb rule (tutor/mix.js) and, in the words only, the letter the hand looks like (deps.specific): neither
  // changes when a hold is taken or what it is graded, outside B's thumb (tools/ghost-hands/parity.mjs)
  session.engine = createEngine({ model: session.model, letters: session.letters, hintPolicy: "strict", gradeAll: true, hand: HAND,
    commitOpts: TUTOR_COMMIT_OPTS, mix: { getOpenFS: () => openfsReady, bThumb: true, looksLike: true }, deps: { specific: true } });
}

function applyEffects(effects, { trial, addEvent, endTrial }) {
  for (const e of effects) {
    switch (e.kind) {
      case "cue": view.cue(e); break;
      case "feedback":
        view.feedback(PLAIN && e.tone === "correction" ? { ...e, text: PLAIN_RETRY, tone: "neutral" } : e, trial.letter);
        if (e.tone === "correct") {
          session.coach.accepted(); setLive(session.coach.look); session.glove?.celebrate(performance.now());
          if (PLAIN) session.celebratedAt = performance.now();
        }
        break;
      case "status": view.status(e.text); break;
      case "reward": view.reward(e.points); break;
      case "complete": view.complete(); break;
      case "log":
        if (e.event === "attempt") {
          debug?.attempt(e.data);
          if (e.data.notes) safely("notes", () => notesView?.update(e.data.notes));
          const tl = session.trialLog;
          if (tl && !e.data.wrongHand && !e.data.repeat) {
            if (e.data.outcome === "reject") tl.misses++;
            if (e.data.looksLike) tl.looks.push(e.data.looksLike);
          }
        }
        addEvent?.(e.event, e.data);
        break;
      case "end-trial": endTrial(e.reason); break;
      default: break;
    }
  }
}

const BONES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
/* The learner's tracked hand: a sky-blue skeleton with white joints, over the outline, so the two can be told apart
 * (js/core/experiment.js drawLandmarks would clear the outline away).
 *
 * `sinceMs` (the plain look, once the letter is made; the owner, 22 Oct: "when they get it right, it turns green with a
 * cute non distracting animation"): the skeleton turns green in 150 ms and stays green until the next letter; the
 * joints give one small bounce (and a smaller second one, settled by ~0.5 s); one soft ring leaves the palm and the
 * fingertips twinkle once, all inside the accepted letter's dwell. With reduced motion it only turns green. */
const SKY = [56, 189, 248], MINT = [34, 197, 94];
export const CELEBRATE = Object.freeze({ greenMs: 150, ringMs: 650, twinkleMs: 520 });
const REDUCED_MOTION = typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;
/* One bump up and back by 260 ms, then a smaller one by 480 ms: 0..1. */
export function celebratePop(ms) {
  if (!(ms >= 0)) return 0;
  if (ms < 260) return Math.sin(Math.PI * (ms / 260)) * Math.exp(-ms / 300);
  if (ms < 480) return 0.3 * Math.sin(Math.PI * ((ms - 260) / 220)) * Math.exp(-(ms - 260) / 250);
  return 0;
}
function drawHand(ctx, canvas, lm, sinceMs = null) {
  if (!lm || lm.length !== 21) return;
  const W = canvas.width, H = canvas.height, s = Math.max(1.8, H / 300);
  const won = sinceMs !== null && sinceMs >= 0;
  const green = won ? Math.min(1, sinceMs / CELEBRATE.greenMs) : 0;
  const col = SKY.map((c, i) => Math.round(c + (MINT[i] - c) * green)).join(", ");
  const pop = won && !REDUCED_MOTION ? celebratePop(sinceMs) : 0;
  ctx.save();
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  const bones = () => { ctx.beginPath(); for (const [a, b] of BONES) { ctx.moveTo(lm[a].x * W, lm[a].y * H); ctx.lineTo(lm[b].x * W, lm[b].y * H); } };
  if (green > 0) {
    // a soft green glow under the lines (a wide faint stroke: no per-frame blur)
    ctx.strokeStyle = `rgba(${MINT.join(", ")}, ${(0.3 * green).toFixed(3)})`;
    ctx.lineWidth = s * (3.4 + 1.2 * pop);
    bones(); ctx.stroke();
  }
  ctx.strokeStyle = `rgba(${col}, 0.95)`;
  ctx.lineWidth = s * (1 + 0.35 * pop + 0.5 * green);
  bones(); ctx.stroke();
  ctx.fillStyle = "#ffffff";
  const r = 1.6 * s * (1 + 0.7 * pop + 0.1 * green);
  for (const p of lm) { ctx.beginPath(); ctx.arc(p.x * W, p.y * H, r, 0, 2 * Math.PI); ctx.fill(); }
  if (won && !REDUCED_MOTION) {
    const palm = Math.hypot((lm[9].x - lm[0].x) * W, (lm[9].y - lm[0].y) * H);
    // one soft ring from the middle of the palm
    if (sinceMs < CELEBRATE.ringMs) {
      const k = sinceMs / CELEBRATE.ringMs, ease = 1 - (1 - k) ** 3;
      const cx = [0, 5, 9, 13, 17].reduce((a, i) => a + lm[i].x, 0) / 5 * W, cy = [0, 5, 9, 13, 17].reduce((a, i) => a + lm[i].y, 0) / 5 * H;
      ctx.strokeStyle = `rgba(${MINT.join(", ")}, ${(0.55 * (1 - k)).toFixed(3)})`;
      ctx.lineWidth = s * 1.6;
      ctx.beginPath(); ctx.arc(cx, cy, palm * (0.9 + 1.5 * ease), 0, 2 * Math.PI); ctx.stroke();
    }
    // a twinkle at each fingertip
    if (sinceMs < CELEBRATE.twinkleMs) {
      const k = sinceMs / CELEBRATE.twinkleMs, size = s * 3.2 * Math.sin(Math.PI * k);
      ctx.fillStyle = `rgba(255, 255, 255, ${(0.95 * (1 - k)).toFixed(3)})`;
      for (const i of [4, 8, 12, 16, 20]) {
        const x = lm[i].x * W, y = lm[i].y * H;
        ctx.beginPath();
        ctx.moveTo(x, y - size); ctx.lineTo(x + size * 0.28, y - size * 0.28); ctx.lineTo(x + size, y); ctx.lineTo(x + size * 0.28, y + size * 0.28);
        ctx.lineTo(x, y + size); ctx.lineTo(x - size * 0.28, y + size * 0.28); ctx.lineTo(x - size, y); ctx.lineTo(x - size * 0.28, y - size * 0.28);
        ctx.closePath(); ctx.fill();
      }
    }
  }
  ctx.restore();
}
