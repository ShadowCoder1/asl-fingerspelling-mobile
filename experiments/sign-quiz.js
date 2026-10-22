/* sign-quiz.js: a short ASL check before the expert fingerspelling test (JT, 2026-10-18).
 *
 * Prolific's "experts" were not fluent (2026-10-04/05: they reported 1-5 years of ASL and fingerspelled like novices),
 * so the Prolific expert link now checks two things first:
 *   1. how they describe their ASL, on the first page of questions (questions.js EXPERT_DEMOGRAPHIC_QUESTIONS, two
 *      answers): anyone who does not say fluent (ASL_FLUENT) stops there, before any video (JT, 2026-10-18), and
 *   2. ten short videos of everyday ASL signs (not fingerspelling), each with four English words to choose from.
 * Only someone fluent who gets at least PASS_SCORE of the ten right, and takes more than SLOW_MS on fewer than
 * SLOW_LIMIT of them (JT: someone that slow may be looking them up; the third such answer ends the check at once),
 * goes on to the fingerspelling test; everyone else is thanked and the session ends (js/core/experiment.js).
 *
 * The signs (tools/sign-quiz/answers.json, which says how they were chosen): PopSign ASL v1.0 clips that are
 * one-handed and in their citation form, hard to guess for people who do not sign (ASL-LEX 2.0 iconicity rated by
 * hearing non-signers <= 2.5 of 7; not initialized, so knowing the alphabet does not give them away) and well known
 * to deaf signers (ASL-LEX frequency >= 4.5 of 7). The three wrong words are from the same category (a colour among
 * colours), so knowing what kind of word it is does not help. Guessing four-way, 8 of 10 happens about 4 times in
 * 10,000. No answer is ever marked right or wrong on the screen.
 *
 * The page never names the right option: the clips have opaque names and each question carries only a hash of its
 * answer (sign-quiz-key.js). Everything a participant chose, and how long they took, is saved under `screening`. */
import { QUESTIONS } from "./sign-quiz-data.js";
import { answerKey } from "./sign-quiz-key.js";
import { createPrng } from "../tutor/prng.js";
import { ASL_FLUENT } from "../questions.js";

// 2 (2026-10-18, JT): fluency asked on the first page with two answers; three answers over 30 s end the check.
export const QUIZ_VERSION = "sign-quiz/2";
export const PASS_SCORE = 8;
export const SLOW_MS = 30000;
export const SLOW_LIMIT = 3;
export const CREDIT = "Sign videos: PopSign ASL v1.0 (Starner et al., 2023), CC BY 4.0.";

/** The questions in this participant's order, each with its options in this participant's order. Pure. */
export function quizOrder(seed, questions = QUESTIONS) {
  const prng = createPrng(seed);
  return prng.shuffle(questions).map((q) => ({ ...q, options: prng.shuffle(q.options) }));
}

export async function isCorrect(question, option) {
  return (await answerKey(question.qid, option)) === question.key;
}

/** Why someone stops, or "passed": not fluent by their own answer, too slow on SLOW_LIMIT signs, or too few right. */
export function screeningOutcome({ fluency, score, slow }) {
  if (fluency !== ASL_FLUENT) return "not-fluent";
  if (slow >= SLOW_LIMIT) return "slow";
  return score >= PASS_SCORE ? "passed" : "score";
}

/* ---- the screens ---------------------------------------------------------- */
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

/**
 * Runs the check in `root` (the runner's #screening-body) and resolves with the record saved under `screening`.
 * `fluency` is their answer on the first page; anyone not fluent is out at once, without seeing anything.
 * @param {{seed:number, fluency:string, root:HTMLElement, show:() => void, now?:() => number}} ctx
 */
export async function runSignQuiz({ seed, fluency, root, show, now = () => performance.now() }) {
  const startedAt = new Date().toISOString();
  const base = { version: QUIZ_VERSION, startedAt, seed, fluency, passScore: PASS_SCORE, slowMs: SLOW_MS, slowLimit: SLOW_LIMIT };
  if (fluency !== ASL_FLUENT) {
    return { ...base, durationMs: 0, answers: [], score: 0, slow: 0, of: 0, outcome: "not-fluent", passed: false };
  }
  const t0 = now();
  show();
  root.innerHTML = `
    <h2>First, a short ASL check</h2>
    <div class="prose">
      <p>This study is for people who are fluent in American Sign Language (ASL).</p>
      <p>You will see <strong>10 short videos of everyday ASL signs</strong>. For each one, choose the English word it means.
         Each video repeats. Please answer each one within 30 seconds.</p>
    </div>
    <button id="sign-quiz-start" class="primary">Start</button>`;
  await click(root.querySelector("#sign-quiz-start"));

  // the ten signs, one at a time, no feedback; the third answer over SLOW_MS ends it
  const order = quizOrder(seed);
  const answers = [];
  let slow = 0;
  for (let i = 0; i < order.length; i++) {
    const q = order[i];
    root.innerHTML = `
      <p class="subtle sign-quiz-progress">Sign ${i + 1} of ${order.length}</p>
      <h2 class="sign-quiz-ask">What does this sign mean?</h2>
      <div class="sign-quiz-video"><video src="${esc(q.clip)}" autoplay loop muted playsinline preload="auto"
        aria-label="A short video of an ASL sign"></video></div>
      <div class="sign-quiz-options">
        ${q.options.map((o, k) => `<button type="button" class="sign-quiz-option" data-k="${k}">${esc(o)}</button>`).join("")}
      </div>
      <p class="subtle sign-quiz-credit">${esc(CREDIT)}</p>`;
    const shownAt = now();
    const k = await new Promise((resolve) => {
      root.querySelectorAll(".sign-quiz-option").forEach((b) => {
        b.onclick = () => {
          root.querySelectorAll(".sign-quiz-option").forEach((x) => { x.disabled = true; });
          resolve(Number(b.dataset.k));
        };
      });
    });
    const chosen = q.options[k];
    const rtMs = Math.round(now() - shownAt);
    answers.push({ qid: q.qid, clip: q.clip, options: q.options, chosen, correct: await isCorrect(q, chosen), rtMs });
    if (rtMs > SLOW_MS) slow += 1;
    if (slow >= SLOW_LIMIT) break;
  }
  root.innerHTML = "";
  const score = answers.filter((a) => a.correct).length;
  const outcome = screeningOutcome({ fluency, score, slow });
  return { ...base, durationMs: Math.round(now() - t0), answers, score, slow, of: answers.length, outcome, passed: outcome === "passed" };
}

function click(button) {
  return new Promise((resolve) => { button.addEventListener("click", resolve, { once: true }); });
}
