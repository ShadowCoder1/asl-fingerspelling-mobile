/* replay.js: run the whole page from a recorded file instead of a camera.
 *
 * WHY THIS EXISTS
 * Everything downstream of the tracker -- the trial loop, the recorder, an
 * experiment's onFrame, the results screen -- is ordinary code that can be
 * wrong in ordinary ways. None of it could be exercised without a person, a
 * webcam and good light, so none of it was ever checked automatically. Replay
 * mode swaps ONLY the two things that need hardware (the camera and MediaPipe)
 * for a file of landmarks that were recorded once. The rest of the page is the
 * same page a participant gets, which is the whole point: a test that runs a
 * special code path proves things about the special code path.
 *
 *   index.html?exp=asl-probe&replay=tests/fixtures/replay-hand.json
 *
 * THE FILE FORMAT (tools/make-replay-fixture.mjs writes one):
 *   { "video": { "width": 640, "height": 480 },
 *     "fps": 30,
 *     "frames": [ { "lm": number[63]|null,    image landmarks, as recorded
 *                   "wl": number[63]|null,    world landmarks, meters
 *                   "h":  "L"|"R"|null,       MediaPipe's label, as reported
 *                   "hs": number|null }, … ] }  …and its confidence
 * which is deliberately the same per-frame shape the recorder saves, so a real
 * session downloaded from Firestore can be replayed later without conversion.
 *
 * NOTHING IS EVER UPLOADED IN REPLAY MODE. The landmarks in the file are not
 * this participant's data -- there is no participant -- so js/core/experiment.js
 * forces demo mode when a replay is requested, whether or not Firebase is
 * configured, and says so on screen.
 *
 * This file also holds the `?autorun=1` clicker and the two machine-readable
 * markers the headless smoke test reads (tools/e2e-smoke.sh). They live here
 * rather than in the runner because they are all one thing: the harness that
 * lets the page run with nobody sitting in front of it. */

/* ---------------------------------------------------------------------------
 * 1. What the URL is allowed to ask for
 * -------------------------------------------------------------------------*/

/* A replay path comes out of the URL, so it is the one part of replay mode
 * that somebody else chooses. It may only name a .json file sitting next to
 * the page: no parent directories, no absolute paths, no other origin, no
 * other file type. The page would refuse to parse anything else anyway, but a
 * URL that can make the page fetch an arbitrary address is worth closing off
 * on its own account. */
const REPLAY_PATH = /^[a-zA-Z0-9_./-]+\.json$/;

/** The path if it is safe to fetch, otherwise null. */
export function validReplayPath(raw) {
  if (typeof raw !== "string" || !REPLAY_PATH.test(raw)) return null;
  if (raw.includes("..")) return null;        // no climbing out of the folder
  if (raw.startsWith("/")) return null;       // same-origin RELATIVE paths only
  if (raw.includes("://")) return null;       // (the regex bars ":" already)
  return raw;
}

/**
 * Read both replay switches out of a URL, together.
 *
 * They are read in one place because `autorun=1` is only safe in replay mode:
 * it ticks the consent boxes and clicks every button, so on a real
 * participant's link it would consent on their behalf. It is therefore
 * IGNORED unless a valid `replay=` file was asked for as well.
 *
 * WHY `present` IS SEPARATE FROM `valid`. A mistyped path cannot hurt a
 * participant -- it is refused, and their link never carries `replay=` anyway.
 * The person it can hurt is whoever typed it: they believe they are replaying a
 * file and that nothing will be saved, and a runner that treated "unusable" the
 * same as "absent" would quietly give them a LIVE CAMERA session that uploads.
 * So the runner is told the difference and stops (js/core/experiment.js). A
 * well-formed path that is not there already fails loudly with a 404; a
 * malformed one has to fail just as loudly.
 *
 * @param {URLSearchParams} params
 * @returns {{present: boolean, valid: boolean, raw: string|null,
 *            path: string|null, autorun: boolean}}
 *          `raw` is what the URL said, kept so the error message can show the
 *          operator their own typo. `path` is null unless `valid`.
 */
export function replayRequest(params) {
  const raw = params.get("replay");           // null only when it is absent
  const path = validReplayPath(raw);
  return {
    present: raw !== null,
    valid: path !== null,
    raw,
    path,
    autorun: path !== null && params.get("autorun") === "1",
  };
}

/* What to say when `?replay=` is there but unusable. Kept beside the rule it
 * describes, so the two cannot drift apart. */
export function replayPathComplaint(raw) {
  return `The ?replay= value in this link, "${raw}", is not a usable replay path. ` +
    "It has to be a relative path to a .json file inside this folder -- no \"..\", " +
    "no leading \"/\", and no address on another site. For example: " +
    "?replay=tests/fixtures/replay-hand.json";
}

/* ---------------------------------------------------------------------------
 * 2. Loading and playing a recording
 * -------------------------------------------------------------------------*/

/** Fetch and parse a replay file. Throws with something readable on screen. */
export async function loadReplay(path) {
  const safe = validReplayPath(path);
  if (!safe) {
    throw new Error(
      `"${path}" is not a usable replay path. It has to be a .json file next to ` +
      "this page, for example ?replay=tests/fixtures/replay-hand.json"
    );
  }

  let response;
  try {
    response = await fetch(safe, { cache: "no-store" });
  } catch (err) {
    throw new Error(`Could not fetch the replay file "${safe}": ${err?.message || err}`);
  }
  if (!response.ok) {
    throw new Error(
      `Could not read the replay file "${safe}" (HTTP ${response.status}). ` +
      "Check the path is right and that you are serving the folder this page is in."
    );
  }
  try {
    return await response.json();
  } catch (err) {
    throw new Error(`The replay file "${safe}" is not valid JSON: ${err?.message || err}`);
  }
}

const COORDS = 63;   // 21 landmarks x, y, z

/* A malformed file has to fail here, loudly, and not as a pile of NaNs three
 * modules downstream. This runs once per file and checks every frame, which is
 * a few hundred microseconds for a 90-frame recording. */
function validate(data) {
  const fail = (why) => { throw new Error(`Not a replay recording: ${why}. See js/core/replay.js for the format.`); };

  const width = data?.video?.width, height = data?.video?.height;
  if (!(width > 0) || !(height > 0)) {
    fail(`video.width and video.height must be positive numbers (got width ${width}, height ${height})`);
  }
  if (!(data.fps > 0)) fail(`fps must be a positive number (got ${data.fps})`);
  if (!Array.isArray(data.frames) || data.frames.length === 0) {
    fail(`frames must be a non-empty array (got ${Array.isArray(data.frames) ? "an empty array" : typeof data.frames})`);
  }
  data.frames.forEach((frame, i) => {
    for (const key of ["lm", "wl"]) {
      const row = frame?.[key];
      if (row === null || row === undefined) continue;
      if (!Array.isArray(row) || row.length !== COORDS) {
        fail(`frame ${i} ${key} must be null or ${COORDS} numbers (got ${Array.isArray(row) ? `${row.length} numbers` : typeof row})`);
      }
      // Checked here rather than left to fail as NaN three modules downstream:
      // a coordinate that is a string or a null is a broken file, and a broken
      // file should say so before the run starts.
      const bad = row.findIndex((v) => !Number.isFinite(v));
      if (bad !== -1) fail(`frame ${i} ${key}[${bad}] is ${JSON.stringify(row[bad])}, not a number`);
    }
  });
}

/** 63 flat numbers -> the 21 {x, y, z} objects MediaPipe hands back. */
function toLandmarkObjects(flat) {
  const out = new Array(COORDS / 3);
  for (let i = 0; i < out.length; i++) {
    out[i] = { x: flat[3 * i], y: flat[3 * i + 1], z: flat[3 * i + 2] };
  }
  return out;
}

/* Measured on this platform's unmirrored picture (research/live/REPORT.md
 * section 1), a physical right hand is reported "Right", not "Left". The
 * file stores the label the way the recorder does ("L"/"R"); this turns it
 * back into the tracker's own wording without correcting it. */
function toHandednessLabel(h) {
  if (h === "L") return "Left";
  if (h === "R") return "Right";
  return "?";      // the tracker's own word for a hand it could not label
}

/* A fresh object each time, not one shared frozen constant: the runner hands
 * these straight to experiment code, and a shared result would let one badly
 * behaved experiment corrupt every later frame. */
const empty = () => ({ landmarks: [], worldLandmarks: [], handedness: [], handednessScore: [] });

/**
 * Build the camera-and-tracker pair for one recording.
 *
 * @param {object} data  a parsed replay file
 * @returns {{video: object, tracker: object}}
 *
 * `video` is a plain <div> standing in for the <video> element. The runner only
 * ever asks a video for three things -- videoWidth, videoHeight and
 * currentTime -- and a real <video> will not let anyone set those, so a div
 * with the same three properties is both simpler and more honest than trying
 * to drive a media element frame by frame.
 *
 * `tracker` has the shape js/core/tracker.js returns, so nothing downstream can
 * tell the difference: one entry per detected hand in each of four arrays, and
 * all four EMPTY on a frame where nothing was detected.
 */
export function createReplay(data) {
  validate(data);

  const { width, height } = data.video;
  const frames = data.frames;
  const fps = data.fps;

  const video = document.createElement("div");
  video.className = "replay-video";
  video.videoWidth = width;
  video.videoHeight = height;
  /* Media time, in seconds, of the last picture handed out. The runner uses it
   * exactly as it uses a real video's: to tell whether there is a new picture
   * to track. It advances one frame per track() call and then STOPS at the end
   * of the file, so a trial that runs past the end records nothing more rather
   * than filling up with invented dropouts. */
  video.currentTime = 0;

  let next = 0;

  const tracker = {
    kind: "hand",
    numLandmarks: 21,
    // Where the real tracker reports "GPU" or "CPU". It is saved with the
    // session, so a replayed run can never be mistaken for a recorded one.
    delegate: "REPLAY",
    errorCount: 0,
    // True once a track() call has gone PAST the last frame. An experiment
    // watches this to end its trial when the recording runs out
    // (see experiments/asl-probe.js); nothing else in the platform reads it.
    exhausted: false,

    /* The video element and the timestamp a real tracker needs are ignored:
     * the file's own frame order is the clock here. Both are still accepted so
     * that the call site is the ordinary tracker.track(video, tMs). */
    track() {
      if (next >= frames.length) {
        tracker.exhausted = true;
        return empty();
      }

      const frame = frames[next++];
      video.currentTime = next / fps;

      if (frame.lm === null || frame.lm === undefined) return empty();

      return {
        landmarks: [toLandmarkObjects(frame.lm)],
        // A recording with image landmarks but no world landmarks is honest
        // about it: the array stays empty, and the runner stores wl as null
        // for that frame rather than inventing meters it does not have.
        worldLandmarks: frame.wl ? [toLandmarkObjects(frame.wl)] : [],
        handedness: [toHandednessLabel(frame.h)],
        handednessScore: [typeof frame.hs === "number" ? frame.hs : null],
      };
    },

    close() {},
  };

  return { video, tracker };
}

/* ---------------------------------------------------------------------------
 * 3. Running with nobody sitting there (?autorun=1)
 * -------------------------------------------------------------------------*/

const TICK_MS = 20;
// What gets typed into any question the autorun run has to answer. It ends up
// in the session as the participant id, so a run driven by this is obvious at
// a glance in the data it leaves behind.
const E2E_ANSWER = "e2e";

let autorunTimer = null;

/**
 * Tick every box and click every button, until the run reaches the end.
 *
 * Deliberately generic rather than a list of button ids: the point of the
 * smoke test is that it walks the REAL screens, so it should keep working when
 * a screen gains a button, and fail when a screen gains one that never becomes
 * clickable. Nothing here runs unless `?autorun=1` came with a valid `?replay=`
 * (see replayRequest above).
 *
 * @param {{onError: (err: Error) => void}} o  what to do if a tick throws --
 *        without it a broken autorun would just stop, silently, and the run
 *        would hang until the browser gave up.
 */
export function startAutorun({ onError } = {}) {
  stopAutorun();
  autorunTimer = setInterval(() => {
    try {
      tick();
    } catch (err) {
      stopAutorun();
      onError?.(err);
    }
  }, TICK_MS);
  return { stop: stopAutorun };
}

export function stopAutorun() {
  if (autorunTimer !== null) clearInterval(autorunTimer);
  autorunTimer = null;
}

function tick() {
  const screen = document.querySelector(".screen.visible");
  if (!screen) return;
  // The last two screens are where the run is already over: the done screen's
  // button starts a file download, and clicking anything on the error screen
  // would paper over the failure the smoke test exists to catch.
  if (screen.id === "screen-done" || screen.id === "screen-error") return;

  answerEverything(screen);

  // Buttons that are still disabled are a gate that has not opened yet (the
  // consent boxes, the positioning hold). Waiting for them is the test.
  // The screen's main button when it has one: a screen can also carry small
  // extra buttons (the demo film's "Sound on"), and clicking those forever
  // would stall the run on a page a person gets past with one click.
  (screen.querySelector("button.primary:not(:disabled)") ?? screen.querySelector("button:not(:disabled)"))?.click();
}

/* Fill in whatever the visible screen is asking for: the consent affirmations,
 * and any demographic question that has to be answered before its Continue
 * button will accept the form. Anything already answered is left alone. */
function answerEverything(screen) {
  for (const box of screen.querySelectorAll('input[type="checkbox"]')) {
    if (!box.checked) check(box);
  }
  for (const radio of screen.querySelectorAll('input[type="radio"]')) {
    // CSS.escape for the same reason js/core/form.js uses it: a question id
    // comes out of questions.js, and nobody should have to know which
    // characters are safe to put in a selector.
    if (!screen.querySelector(`input[name="${CSS.escape(radio.name)}"]:checked`)) check(radio);
  }
  for (const select of screen.querySelectorAll("select")) {
    if (select.value !== "") continue;
    const option = [...select.options].find((o) => !o.disabled && o.value !== "");
    if (option) { select.value = option.value; fire(select); }
  }
  for (const slider of screen.querySelectorAll('input[type="range"]')) {
    // A slider counts as unanswered until it is moved (js/core/form.js, the
    // expert link's years of ASL): move it, to its smallest value.
    if (slider.dataset.touched === "1") continue;
    slider.value = slider.min || "0";
    fire(slider);
  }
  for (const field of screen.querySelectorAll('input[type="text"], input[type="number"], textarea')) {
    if (field.value !== "") continue;
    // A number question usually has a minimum (age starts at 18), and the
    // smallest allowed answer is the one guaranteed to validate.
    // The Prolific ID box only takes a 24-character ID: give it one that is
    // plainly a test run in the data.
    const isPid = field.name === "participantId" || /participantId$/.test(field.id);
    field.value = field.type === "number" ? (field.min || "1") : isPid ? E2E_ANSWER.padEnd(24, "0") : E2E_ANSWER;
    fire(field);
  }
}

function check(input) { input.checked = true; fire(input); }

// The consent button watches for "change", and a value set from script does
// not fire one by itself.
function fire(el) { el.dispatchEvent(new Event("change", { bubbles: true })); }

/* ---------------------------------------------------------------------------
 * 4. Saying how it went, in a form a script can read
 * -------------------------------------------------------------------------*/

/* tools/e2e-smoke.sh dumps the finished page and reads these two: the
 * attribute says whether the run got to the end, and the <pre> says what
 * happened. Both are written for every replay run, including a failed one --
 * a smoke test that can only report success is not a test. */
function markE2e(status, payload) {
  if (document.body) document.body.dataset.e2e = status;
  const el = document.getElementById("e2e-result");
  if (el) el.textContent = JSON.stringify(payload, null, 2);
}

export function markE2eDone(summary) { markE2e("done", summary); }

export function markE2eError(message, detail = "") {
  markE2e("error", { error: String(message), detail: String(detail) });
}
