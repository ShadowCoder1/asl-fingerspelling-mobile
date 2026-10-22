/* ui.js: every piece of DOM the tutor owns.
 *
 * It sits in #exp-mount, which is OUTSIDE the mirrored video: text drawn on
 * the canvas would come out back to front, so nothing here ever touches the
 * canvas. The only thing the tutor draws on the video is the platform's own
 * landmark skeleton, and only during an intro (experiments/asl-tutor.js).
 *
 * NOTHING HERE DECIDES ANYTHING. It is handed effects by the glue and renders
 * them. That is what lets the rules be tested under Node
 * (experiments/asl-tutor/flow.js) and what keeps "what the learner is told"
 * in one file instead of two.
 *
 * WHAT THE LEARNER NEVER SEES: a score, a distance, a threshold, a percentage
 * or a confidence. The grader's numbers are bootstrap numbers from public data
 * (tutor/model.json provenance) and putting one on screen would dress a guess
 * up as a measurement. The one number on the page is the point counter, which
 * is theirs.
 *
 * ACCESSIBILITY, the basics: the feedback and status lines are aria-live
 * regions so a screen reader announces a correction rather than leaving it to
 * be discovered; the mastery map carries a word per state as well as a color,
 * because four shades of one hue is no information at all to a third of
 * colorblind readers; the reward flash is a brief additive glow, never a
 * flashing element. */

import { LETTERS, PICTURE_CAPTION, pictureMirrored } from "../../tutor/letters.js";

/* The note that has to be on screen the whole time, not behind a link. This
 * tutor grades with a model fitted on posed photographs from public datasets;
 * nobody's hand in front of this camera contributed to it, and it will be
 * wrong about some of them. Saying so is not modesty, it is the finding. */
export const PROTOTYPE_NOTE =
  "Research prototype. Grading is approximate and based on public data — it can be wrong.";
export const NOT_ASL_NOTE =
  "This teaches fingerspelling handshapes, not ASL. To learn ASL, learn from Deaf teachers.";

// The ring is an SVG circle whose dash gap shrinks as the hold fills. r is in
// the viewBox's own units; the circumference below has to match it exactly or
// the ring would finish early or never quite close.
const RING_R = 52;
const RING_C = 2 * Math.PI * RING_R;

/* The burst when a hold is taken: a wave off the ring and twelve sparks, each
 * sent out along its own angle (--a) by tutor.css. Green on a right answer in
 * teaching; orange (the ring's own color) on a test, where it means only
 * "that hold was taken" and is the same whatever the hand was (JT, 2026-09-23). */
const SPARKS = Array.from({ length: 12 }, (_, i) =>
  `<i style="--a:${i * 30}deg;--d:${i % 2 ? 0.78 : 1}"></i>`).join("");
const BURST_MS = 750;

const MASTERY_STATES = {
  untaught: { label: "not yet", className: "tutor-cell" },
  introduced: { label: "shown", className: "tutor-cell tutor-cell-introduced" },
  passed: { label: "got it", className: "tutor-cell tutor-cell-passed" },
  retired: { label: "learned", className: "tutor-cell tutor-cell-retired" },
};

/* `layout: "study"` (experiments/asl-study.js) is JT's stripped screen: the
 * camera, the letter with its ring, the picture -- no points, no letter map,
 * no standing notes (they are on the instructions page instead). Every id the
 * code looks up still exists, so nothing below has to know which layout it is. */
export function mountTutor(el, { letters, hintPolicy, layout = "tutor", hand = "right", testLabel = null, testHelper = null }) {
  /* Two groups, so the stylesheet can put them where it likes: the PANEL (the
   * letter, what the tutor says, the reference picture) sits beside the camera
   * on a wide screen; the FOOT (points, the letter map, the standing notes)
   * runs underneath both. Every id and class the code below looks up is
   * unchanged. */
  el.innerHTML = `
    <div class="tutor tutor-layout-${layout}">
      <div class="tutor-panel">
        <div class="tutor-main">
          <p class="tutor-label" id="tutor-label">Sign this letter</p>
          <div class="tutor-cue-wrap">
            <svg class="tutor-ring" viewBox="0 0 120 120" aria-hidden="true">
              <circle class="tutor-ring-track" cx="60" cy="60" r="${RING_R}"></circle>
              <circle class="tutor-ring-fill" cx="60" cy="60" r="${RING_R}"
                      stroke-dasharray="${RING_C.toFixed(2)}" stroke-dashoffset="${RING_C.toFixed(2)}"></circle>
            </svg>
            <div class="tutor-cue" id="tutor-cue" aria-label="sign this letter">—</div>
            <div class="tutor-burst" aria-hidden="true"><span class="tutor-burst-wave"></span>${SPARKS}</div>
          </div>
          <div class="tutor-said">
            <p class="tutor-feedback" id="tutor-feedback" aria-live="polite" role="status"></p>
            <p class="tutor-status" id="tutor-status" aria-live="polite"></p>
          </div>
        </div>

        <div class="tutor-picture-slot">
          <figure class="tutor-reference" id="tutor-reference" hidden>
            <img class="tutor-picture" id="tutor-picture" alt="" hidden>
            <figcaption class="tutor-caption" id="tutor-caption">${PICTURE_CAPTION}</figcaption>
            <p class="tutor-describe" id="tutor-describe"></p>
            <p class="tutor-mnemonic" id="tutor-mnemonic" hidden></p>
          </figure>
        </div>
      </div>

      <div class="tutor-foot"${layout === "study" ? " hidden" : ""}>
        <div class="tutor-score">
          <span class="tutor-points"><span id="tutor-points">0</span> right</span>
          <span class="tutor-policy subtle">hints: ${hintPolicy}</span>
        </div>

        <div class="tutor-map" id="tutor-map" role="list" aria-label="letters in this session"></div>

        <p class="tutor-note">${PROTOTYPE_NOTE}</p>
        <p class="tutor-note">${NOT_ASL_NOTE}</p>
      </div>
    </div>`;

  const $ = (id) => el.querySelector(`#${id}`);
  const nodes = {
    cue: $("tutor-cue"),
    label: $("tutor-label"),
    ringFill: el.querySelector(".tutor-ring-fill"),
    feedback: $("tutor-feedback"),
    status: $("tutor-status"),
    reference: $("tutor-reference"),
    picture: $("tutor-picture"),
    caption: $("tutor-caption"),
    describe: $("tutor-describe"),
    mnemonic: $("tutor-mnemonic"),
    points: $("tutor-points"),
    map: $("tutor-map"),
    cueWrap: el.querySelector(".tutor-cue-wrap"),
    burst: el.querySelector(".tutor-burst"),
  };

  // The whole alphabet, always: which letters this session does NOT teach is
  // part of what the map says. Letters that are in the session but untaught
  // still read "not yet", so the map never implies a letter was failed.
  const taught = new Set(letters);
  const cells = {};
  for (const letter of LETTERS) {
    const cell = document.createElement("div");
    cell.className = "tutor-cell";
    cell.setAttribute("role", "listitem");
    cell.innerHTML = `<span class="tutor-cell-letter">${letter}</span><span class="tutor-cell-state"></span>`;
    if (!taught.has(letter)) cell.classList.add("tutor-cell-absent");
    nodes.map.append(cell);
    cells[letter] = cell;
  }

  let points = 0;
  let flashTimer = null;
  let burstTimer = null;
  // While the burst plays, the ring stays closed: the engine's progress drops
  // back to 0 the moment a hold is taken, and a ring that emptied under its
  // own burst would read as the hold being lost.
  let fullUntil = 0;
  const now = () => (typeof performance !== "undefined" ? performance.now() : Date.now());
  const burst = (tone) => {
    nodes.burst.className = "tutor-burst";
    nodes.cueWrap.classList.remove("tutor-burst-good", "tutor-burst-done");
    void nodes.burst.offsetWidth;   // restart the animation if one is still running
    nodes.burst.className = `tutor-burst tutor-burst-go tutor-burst-${tone}`;
    nodes.cueWrap.classList.add(`tutor-burst-${tone}`);
    nodes.ringFill.setAttribute("stroke-dashoffset", "0");
    nodes.ringFill.style.opacity = "";
    fullUntil = now() + BURST_MS;
    if (burstTimer !== null) clearTimeout(burstTimer);
    burstTimer = setTimeout(() => {
      nodes.burst.className = "tutor-burst";
      nodes.cueWrap.classList.remove("tutor-burst-good", "tutor-burst-done");
    }, BURST_MS);
  };
  // The standing instruction for this trial, shown whenever the tutor has
  // nothing more specific to say -- until the trial is decided, after which an
  // empty status line is the right one.
  let helper = "";
  let decided = false;

  const setReference = ({ showPicture, pictureUrl, describe, mnemonic, letter }) => {
    if (!showPicture && !describe) {
      nodes.reference.hidden = true;
      return;
    }
    nodes.reference.hidden = false;
    // All 26 letters ship a picture today, but pictureUrl is allowed to return
    // null for one that does not (tutor/letters.js), and the fallback is kept
    // rather than assumed away: the description then does the whole job, and
    // the caption goes with the picture, instead of an empty frame pretending
    // there is something to look at.
    const hasPicture = showPicture && typeof pictureUrl === "string";
    nodes.picture.hidden = !hasPicture;
    nodes.caption.hidden = !hasPicture;
    if (hasPicture) {
      nodes.picture.src = pictureUrl;
      nodes.picture.alt = `The handshape for the letter ${letter}.`;
      nodes.picture.classList.toggle("tutor-picture-flip", pictureMirrored(letter, hand));
    }
    nodes.describe.textContent = describe ?? "";
    nodes.describe.hidden = !describe;
    nodes.mnemonic.textContent = mnemonic ?? "";
    nodes.mnemonic.hidden = !mnemonic;
  };

  return {
    /* The cue. `showPicture` is true only on an intro: on a test the letter
     * stands alone, because recalling the shape from the letter is the thing
     * being taught. */
    cue({ letter, showPicture, pictureUrl, describe, mnemonic }) {
      nodes.cue.textContent = letter;
      // Copying a picture and recalling a shape are different jobs; say which.
      nodes.label.textContent = showPicture ? "Copy this letter" : testLabel ?? (layout === "study" ? "Make this letter" : "Sign this letter");
      nodes.feedback.textContent = "";
      nodes.feedback.className = "tutor-feedback";
      helper = showPicture ? "Copy the picture, then hold your hand still." : testHelper ?? "Make the shape, then hold your hand still.";
      decided = false;
      nodes.status.textContent = helper;
      setReference({ showPicture, pictureUrl, describe, mnemonic, letter });
      fullUntil = 0;
      this.progress(0);
    },

    /* The hold-still ring. It fills on stillness alone and says nothing about
     * whether the shape is right (tutor/commit.js is correctness-blind), so it
     * looks the same for a perfect V and a closed fist. That is deliberate:
     * a ring that filled only for correct hands would grade the learner before
     * they had finished declaring their answer. */
    progress(p) {
      if (now() < fullUntil) return;
      const clipped = Math.max(0, Math.min(1, Number.isFinite(p) ? p : 0));
      nodes.ringFill.setAttribute("stroke-dashoffset", (RING_C * (1 - clipped)).toFixed(2));
      // an empty ring is empty: a round line cap would otherwise leave a dot at twelve
      nodes.ringFill.style.opacity = clipped > 0 ? "" : "0";
    },

    /* The ring is held shut: the learner is reading, or the trial is decided. */
    paused(on) {
      nodes.cueWrap.classList.toggle("tutor-paused", !!on);
    },

    feedback({ text, tone, showPicture, pictureUrl, describe }, letter) {
      if (tone === "correct" || tone === "reveal" || tone === "done") decided = true;
      nodes.feedback.textContent = text ?? "";
      nodes.feedback.className = `tutor-feedback tutor-tone-${tone ?? "neutral"}`;
      if (showPicture || describe) setReference({ showPicture, pictureUrl, describe, mnemonic: null, letter });
    },

    status(text) {
      nodes.status.textContent = text ? text : (decided ? "" : helper);
    },

    /* A brief flash and one more point. No streak, no combo, nothing that can
     * be lost: the design note (A9) is that a learner who puts the tutor down
     * for a week should not be punished for it on their way back in. */
    reward(n = 1) {
      // n may be 0: an intro made correctly gets the glow but not a point.
      points += n;
      nodes.points.textContent = String(points);
      nodes.cueWrap.classList.add("tutor-flash");
      if (flashTimer !== null) clearTimeout(flashTimer);
      flashTimer = setTimeout(() => nodes.cueWrap.classList.remove("tutor-flash"), 600);
      burst("good");
    },

    /* A test hold was taken: the same burst, in the ring's orange. Nothing
     * about whether it was right. */
    complete() {
      burst("done");
    },

    /* letter -> "untaught" | "introduced" | "passed" | "retired". A word as
     * well as a color, so the map is readable without color vision. */
    mastery(states) {
      for (const [letter, state] of Object.entries(states)) {
        const cell = cells[letter];
        if (!cell) continue;
        const style = MASTERY_STATES[state] ?? MASTERY_STATES.untaught;
        cell.className = `${style.className}${taught.has(letter) ? "" : " tutor-cell-absent"}`;
        cell.querySelector(".tutor-cell-state").textContent = taught.has(letter) ? style.label : "";
      }
    },

    points: () => points,
  };
}

/* The results screen: one row per letter, what happened to it, in words. The
 * per-trial detail is in the session document; this is the page someone reads
 * for ten seconds after they finish. */
export function renderTutorResults(summaries) {
  const byLetter = new Map();
  for (const s of summaries) {
    if (!s.letter) continue;
    const row = byLetter.get(s.letter) ?? { letter: s.letter, intro: 0, tests: 0, first: 0, helped: 0, failed: 0, sensor: 0 };
    if (s.kind === "intro") row.intro++;
    else {
      row.tests++;
      if (s.firstAttemptCorrect && !s.assisted) row.first++;
      else if (s.finalOutcome === "corrected") row.helped++;
      else if (s.finalOutcome === "failed") row.failed++;
      else if (s.finalOutcome === "sensor") row.sensor++;
    }
    byLetter.set(s.letter, row);
  }

  const rows = [...byLetter.values()].map((r) => `<tr>
    <th>${r.letter}</th>
    <td>${r.tests} tried</td>
    <td>${r.first} first time</td>
    <td>${r.helped} after a hint</td>
    <td>${r.failed ? `${r.failed} not yet` : "—"}</td>
    <td>${r.sensor ? `${r.sensor} camera trouble` : "—"}</td>
  </tr>`);

  if (!rows.length) return `<p class="subtle">No letters were tested in this session.</p>`;
  return `<table class="results">
      <tr><th>letter</th><th>tests</th><th>unaided</th><th>with help</th><th>missed</th><th>not graded</th></tr>
      ${rows.join("")}
    </table>
    <p class="subtle">${PROTOTYPE_NOTE}</p>
    <p class="subtle">${NOT_ASL_NOTE}</p>`;
}
