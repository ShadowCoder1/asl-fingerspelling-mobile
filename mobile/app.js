/* mobile/app.js: the phone version of the fingerspelling demo (JT, 22 Oct 2026, after the Duolingo meeting: "any
 * possibility that this app could be implemented on the phone? ... yep, just a mobile version of what we have now").
 *
 * A NEW HOST, NOT A NEW TUTOR. experiments/asl-demo.js -- the glove and outline demo JT showed, with its hold ring,
 * grader, coach, hints and drawing -- runs here exactly as js/core/experiment.js runs it on a laptop: mount,
 * nextTrial, onTrialStart, onFrame, draw, onTrialEnd, with the same tracker (js/core/tracker.js), the same trial clock
 * (js/core/trial-loop.js) and the same hand picker. So when a hold is taken, how it is graded and what the learner is
 * told are the demo's own. What is new is everything a phone needs around it:
 *
 *   - The hand tracker (about 11 MB: MediaPipe's runtime and model) downloads while the welcome screen is read, with
 *     a progress line, and is warmed up on a picture of a hand so the first camera frame does not stall.
 *   - The front camera at 640 x 480 (480 x 640 held upright: the tracker never needs more), 30 frames a second.
 *   - Each camera frame is processed ONCE (requestVideoFrameCallback). A laptop's loop looks again on every screen
 *     repaint and re-tracks a picture it has already seen whenever the clock says so -- harmless on a laptop, half a
 *     phone's work wasted.
 *   - The camera's shape is read on EVERY frame: a phone turned on its side turns its camera picture too, and the
 *     grader needs the true width/height ratio (tutor/landmarks.js toPoints) or every angle is distorted. The
 *     laptop host reads it once.
 *   - The camera view is never cropped: it is as large as the screen allows at the camera's own shape, so what the
 *     tracker sees is what the learner sees, and the glove's spot (glove.js GLOVE_SPOT_PORTRAIT) is always on screen.
 *   - The camera check is part of the practice screen (hold up the hand; it moves on by itself), and the keys
 *     (N: next letter) are buttons.
 *   - The screen is kept awake while practising, the camera is picked up again after the phone was locked or another
 *     app was opened, and an in-app browser (Instagram, LinkedIn...) or a blocked camera gets steps that fix it.
 *   - A chime and a buzz when a letter is made (sound can be switched off; it is remembered).
 *
 * THE SAME GRADER AS EVERY OTHER VERSION: tutor/model.json, tutor/mix.js's rules and OpenFS's second opinion on I, M, N
 * and X (its 16 MB of weights load after the hand tracker; a letter it grades waits for them). OpenFS reads the whole
 * trial clip on the main thread at a rejected hold of those letters: ~0.1 s for a short try, ~1 s for 300 frames on a
 * laptop, somewhat more on a phone (the video keeps playing meanwhile).
 *
 * URL: everything asl-demo.js takes (?letters=, ?reps=, ?hand=left, ?look=outline, ?srcmirror=1, ...), plus
 *      ?fps=1 (frame rate and per-frame cost on the camera view), ?replay=<file.json> (a recorded session instead of
 *      the camera, for tests; js/core/replay.js). */

import exp, { DEFAULT_LETTERS, parseDemoLetters, parseDemoReps, demoPlan, LOAD, openfsLoaded } from "../experiments/asl-demo.js";
import { SECOND_OPINION } from "../tutor/mix.js";
import { createTracker } from "../js/core/tracker.js";
import { MEDIAPIPE } from "../config.js";
import { runTrialLoop } from "../js/core/trial-loop.js";
import { pictureUrl } from "../tutor/letters.js";
import { replayRequest, loadReplay, createReplay } from "../js/core/replay.js";
import { shapeDistance, DEFAULTS as COMMIT_DEFAULTS, MIN_PALM_EXIT_FACTOR } from "../tutor/commit.js";
import { flattenRounded, DECIMALS, toPoints } from "../tutor/landmarks.js";
import { palmSize } from "../tutor/hand-frame.js";
import { TUTOR_COMMIT_OPTS } from "../experiments/asl-tutor/engine.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const HAND = params.get("hand") === "left" ? "left" : "right";
const LOOK = ["outline", "picture", "hand", "plain"].includes(params.get("look")) ? params.get("look") : "glove";
/* ?look=plain: the letter and its picture, nothing to fit the hand into; a miss is answered as in every look (asl-demo.js PLAIN). */
const PLAIN = LOOK === "plain";
if (PLAIN) document.documentElement.classList.add("look-plain");
const SHOW_PERF = params.get("fps") === "1";
const REPLAY = replayRequest(params);

/* The camera check: the asked-for hand in view this long, and it moves on by itself. */
const CHECK_HOLD_MS = 1000;
const CHECK_DONE_MS = 650;
/* After the check, the hand that passed it is still up: the first letter waits until it has gone down (out of view for
 * LOWER_GONE_MS) or changed shape (COMMIT_DEFAULTS.heldOverShape, the rule the engine applies to a pose carried into
 * every later letter), at most LOWER_MAX_MS. Otherwise the open hand held up for the check is graded as the first try
 * (the review, 22 Oct; on the laptop the instructions page comes in between). */
const LOWER_GONE_MS = 300;
const LOWER_MAX_MS = 4000;
/* The other hand in view this long before "I sign with my left hand" is offered (a moment's misread is not a choice). */
const OTHER_HAND_OFFER_MS = 1500;
/* A hand seen within this long still counts as there (single dropped frames do not restart the check). */
const SEEN_GRACE_MS = 250;
/* No hand for this long in the camera check: say what usually fixes it. */
const CHECK_HINT_MS = 8000;
const NO_HAND_HINT = "We can't see a hand yet. Move somewhere brighter, and keep your whole hand in the picture.";
/* iOS 17+ draws "Reactions" (balloons for a V, a bubble for a thumbs-up) into the camera picture; only the person can
 * turn them off, in Control Center. Said in the camera check when a letter of this session can set one off. */
const REACTIONS_NOTE = "If balloons or bubbles pop up on the camera, swipe down to Control Center, tap Video Effects and turn Reactions off.";
const AUTOSTART_KEY = "asl-mobile-autostart";
const SOUND_KEY = "asl-mobile-sound";
/* asl-demo.js's own frame budget for the camera (js/core/experiment.js asks config.js RECORDING.video, 640 x 480). */
const CAMERA = Object.freeze({ width: 640, height: 480, frameRate: 30 });
/* MediaPipe's two big files, downloaded here with a progress line and handed to the tracker as they are (the model as
 * bytes, the runtime as a blob URL), so neither is fetched twice whatever the browser's cache does with 8-12 MB
 * responses. The runtime arrives compressed (3.1 MB over the wire); the sizes are what is READ from the stream. */
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MEDIAPIPE.version}`;
const MODEL_BYTES = 7819105;
const WASM_BYTES = { simd: 11756954, nosimd: 10960242 };

const stats = window.__mobile = {
  screen: "welcome", phase: null, delegate: null, video: null, frames: 0, trackMs: [], tutorMs: [], accepted: [],
  summaries: [], errors: [], loaded: 0, warm: false,
};
addEventListener("error", (e) => stats.errors.push(String(e.message || e)));
addEventListener("unhandledrejection", (e) => stats.errors.push(String(e.reason?.message || e.reason)));

/* ---- the session's letters ----------------------------------------------------------------------------------------- */
let LETTERS_ASKED = DEFAULT_LETTERS.slice(), PLAN = demoPlan(LETTERS_ASKED, 1), planError = null;
try {
  LETTERS_ASKED = parseDemoLetters(params.get("letters"));
  PLAN = demoPlan(LETTERS_ASKED, parseDemoReps(params.get("reps")));
} catch (err) { planError = err; }
const UNIQUE = [...new Set(LETTERS_ASKED)];

/* ---- screens ------------------------------------------------------------------------------------------------------- */
function show(screen) {
  document.body.dataset.screen = screen;
  stats.screen = screen;
  window.scrollTo(0, 0);
  if (screen === "results" || screen === "error") $(`#${screen} h1`)?.focus({ preventScroll: true });
}
function phase(p) {
  document.body.classList.toggle("phase-setup", p === "setup");
  document.body.classList.toggle("phase-practice", p === "practice");
  stats.phase = p;
}
let toastTimer = null;
function toast(text) {
  const t = $("#toast");
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2200);
}

/* ---- what kind of phone and browser ---------------------------------------------------------------------------- */
const UA = navigator.userAgent || "";
const IOS = /iPad|iPhone|iPod/.test(UA) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
const ANDROID = /Android/i.test(UA);
const IN_APP = (() => {
  const plain = (IOS && !/Safari\//.test(UA) && !navigator.standalone) || (ANDROID && /; wv\)/.test(UA));
  const m = UA.match(/\b(FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|TikTok|musical_ly|BytedanceWebview|Line\/|KAKAOTALK|MicroMessenger|Pinterest|Twitter)\b/i);
  if (!m) return plain ? "this app" : null;
  const k = m[1].toLowerCase();
  return k.startsWith("fb") ? "Facebook" : k === "instagram" ? "Instagram" : k === "linkedinapp" ? "LinkedIn" : k.includes("tiktok") || k.includes("musical") || k.includes("bytedance") ? "TikTok" : "this app";
})();
const BROWSER = IOS ? "Safari" : ANDROID ? "Chrome" : "your browser";
/* A phone's front camera never sends a mirror image, so on a phone the other hand in the camera check is just the other
 * hand: it is offered as the hand to use (?hand=left), and the laptop's "flip the camera" offer is not shown. */
const PHONE = IOS || ANDROID;
if (PHONE) document.documentElement.classList.add("is-phone");
/* A link carrying ?srcmirror=1 (made on a laptop whose camera mirrors; this site shares its storage, and so its
 * remembered flip, with the laptop demos) would flip every phone's hand, and the undo is not shown on a phone: a phone
 * is never flipped. "0", not removed, so asl-demo.js's remembered flip cannot put it back. */
if (PHONE && params.get("srcmirror") === "1") {
  const q = new URLSearchParams(location.search);
  q.set("srcmirror", "0");
  location.replace(`?${q}`);
}
if (HAND === "left") document.documentElement.classList.add("hand-left");
/* The link to pass on: without this device's own settings or the testing options. */
function shareableUrl() {
  const q = new URLSearchParams(location.search);
  for (const k of ["srcmirror", "autostart", "ping", "fps", "vfc", "replay", "debug"]) q.delete(k);
  const qs = q.toString();
  return `${location.origin}${location.pathname}${qs ? `?${qs}` : ""}`;
}

/* ---- welcome ------------------------------------------------------------------------------------------------------- */
function listWords(xs) {
  if (xs.length <= 1) return xs.join("");
  if (xs.length > 6) return `${xs.length} letters`;
  return `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`;
}
let gloveLetters = new Set();
async function renderWelcome() {
  $("#welcome-letters").textContent = listWords(UNIQUE);
  $("#step-hand").textContent = HAND;
  $("#step-phone-hand").textContent = HAND === "right" ? "left" : "right";
  $("#setup-title").textContent = `Hold up your ${HAND} hand`;
  if (LOOK === "glove") {
    try {
      const g = await (await fetch("assets/gloves/gloves.json")).json();
      gloveLetters = new Set(Object.keys(g.letters ?? {}));
    } catch { /* no gloves: the outline everywhere */ }
  }
  const withGlove = UNIQUE.filter((c) => gloveLetters.has(c));
  const shape = withGlove.length === UNIQUE.length ? "glove" : withGlove.length ? "glove or outline" : "outline";
  for (const el of document.querySelectorAll(".shape-word")) el.textContent = shape;
  $("#welcome-lede").textContent = PLAIN
    ? `Copy each letter's picture with your ${HAND} hand. Your camera checks your handshape and tells you what to change.`
    : `Make each letter with your ${HAND} hand. Your camera checks your handshape and shows you what to change, as you go.`;
  if (PLAIN) {
    $("#step-fit").innerHTML = `Copy the letter's picture with your <b>${HAND}</b> hand. The blue lines are your hand.`;
    $("#step-hold").textContent = "Then hold still until the ring around the letter fills.";
  }
  const hero = $("#hero");
  // the page already shows the default letters' gloves (index.html); rebuilt only for other letters or the other hand
  if (hero.dataset.default === UNIQUE.slice(0, 3).join("") && withGlove.length === UNIQUE.length && HAND === "right") {
    if (IN_APP) { $("#inapp-browser").textContent = BROWSER; $("#inapp-note").hidden = false; }
    return;
  }
  hero.innerHTML = "";
  for (const c of UNIQUE.slice(0, 3)) {
    const tile = document.createElement("div");
    const glove = gloveLetters.has(c);
    tile.className = `hero-tile${glove ? " hero-glove" : ""}`;
    const img = document.createElement("img");
    img.alt = "";
    img.decoding = "async";
    img.src = glove ? `assets/gloves/${c}.png` : pictureUrl(c);
    // the gloves are right hands as seen on the learner's own (mirrored) screen; a left-handed session sees them flipped
    if (glove && HAND === "left") img.style.transform = "scaleX(-1)";
    const b = document.createElement("b");
    b.textContent = c;
    tile.append(img, b);
    hero.append(tile);
  }
  if (IN_APP) {
    $("#inapp-browser").textContent = BROWSER;
    $("#inapp-note").hidden = false;
  }
}

/* ---- loading the tracker, with a progress line ------------------------------------------------------------------- */
function setLoad(frac, text) {
  const f = Math.max(0, Math.min(1, frac));
  stats.loaded = f;
  $("#loadbar-fill").style.width = `${Math.round(f * 100)}%`;
  if (text) $("#loadline-text").textContent = text;
  if (stageWaiting === "tracker") stageMessage(`Loading the hand tracker… ${Math.round(f * 100)}%`);
}
const progressOf = new Map();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function showLoad(text) {
  let a = 0, b = 0;
  for (const [x, y] of progressOf.values()) { a += x; b += y; }
  setLoad(b ? 0.9 * (a / b) : 0, text);
}
/* One of MediaPipe's two files, with the progress line. A response that stops sending for STALL_MS is given up and
 * tried again (three tries, a moment apart): on a phone a download that goes quiet without failing is ordinary (a
 * fading signal, a switch to another app). The runtime comes back as a Blob built from its chunks and the model as
 * bytes in one buffer sized up front, so the peak memory is about one copy of each. */
const STALL_MS = 15000;
async function download(url, bytes, { asBlob = false } = {}) {
  let last = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) { progressOf.set(url, [0, bytes]); showLoad("Slow connection, trying again…"); await sleep(1000 * attempt); }
    const ctrl = new AbortController();
    let timer = null;
    const arm = () => { clearTimeout(timer); timer = setTimeout(() => ctrl.abort(), STALL_MS); };
    try {
      arm();
      const res = await fetch(url, { signal: ctrl.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (!res.body) { const whole = asBlob ? await res.blob() : new Uint8Array(await res.arrayBuffer()); clearTimeout(timer); return whole; }
      const reader = res.body.getReader();
      const parts = [];
      let out = asBlob ? null : new Uint8Array(bytes), got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        arm();
        if (asBlob) parts.push(value);
        else {
          if (got + value.byteLength > out.length) { const more = new Uint8Array(Math.ceil((got + value.byteLength) * 1.25)); more.set(out.subarray(0, got)); out = more; }
          out.set(value, got);
        }
        got += value.byteLength;
        progressOf.set(url, [Math.min(got, bytes), bytes]);
        showLoad("Getting the hand tracker ready…");
      }
      clearTimeout(timer);
      return asBlob ? new Blob(parts, { type: "application/wasm" }) : out.subarray(0, got);
    } catch (err) {
      clearTimeout(timer);
      last = err;
    }
  }
  const e = new Error(`Could not load the hand tracker (${last?.name === "AbortError" ? "the download stalled" : last?.message || last}).`);
  e.kind = "load";
  throw e;
}
/* The runtime's blob URL is kept for the page's life: tracker.js keeps the file set it was first given, and a tracker
 * rebuilt after a lost GPU (track() below) loads its runtime from it again. */
const trackerReady = (async () => {
  if (REPLAY.valid) return null;
  const { FilesetResolver } = await import(`${CDN}/vision_bundle.mjs`);
  const simd = await FilesetResolver.isSimdSupported();
  const name = `vision_wasm${simd ? "" : "_nosimd"}_internal`;
  const wasmUrl = `${CDN}/wasm/${name}.wasm`, wasmBytes = simd ? WASM_BYTES.simd : WASM_BYTES.nosimd;
  progressOf.set(wasmUrl, [0, wasmBytes]);
  progressOf.set(MEDIAPIPE.models.hand, [0, MODEL_BYTES]);
  const [wasm, model] = await Promise.all([download(wasmUrl, wasmBytes, { asBlob: true }), download(MEDIAPIPE.models.hand, MODEL_BYTES)]);
  const blobUrl = URL.createObjectURL(wasm);
  setLoad(0.93, "Starting the hand tracker…");
  const tracker = await createTracker(exp.tracker ?? "hand", {
    ...(exp.trackerOptions ?? {}),
    fileset: { wasmLoaderPath: `${CDN}/wasm/${name}.js`, wasmBinaryPath: blobUrl },
    modelAssetBuffer: model,
  });
  stats.delegate = tracker.delegate;
  openfsLoaded().then((o) => { stats.openfs = !!o; });
  await warmUp(tracker);
  setLoad(1, "Ready");
  if (SHOW_PERF) $("#loadline-text").textContent = `Hand tracker ready: ${tracker.delegate}${stats.warm ? ", warmed up" : ""}`;
  else $("#loadline").classList.add("loadline-done");
  return tracker;
})();
/* A load that failed is said on the welcome screen at once, and Start becomes a reload, rather than surfacing only
 * after the camera prompt. */
let loadError = null;
function loadFailed(err) {
  if (loadError) return;
  loadError = err;
  if (stats.screen !== "welcome") return;
  $("#loadline").classList.remove("loadline-done");
  $("#loadline-text").textContent = "Couldn't load the hand tracker. Check your connection, then try again.";
  $("#btn-start").textContent = "Try again";   // start() reloads
}
trackerReady.catch((err) => loadFailed(err));

/* The first picture with a hand in it compiles the hand model's GPU programs: up to a second or two on a phone, which
 * would freeze the first camera frame. A glove render is a hand MediaPipe finds (X: 26 of 28), so do it now. Nothing
 * here is shown or graded, and the tracker's picker never sees it. */
async function warmUp(tracker) {
  try {
    const img = new Image();
    img.src = "assets/gloves/X.png";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = 360; c.height = 480;
    const g = c.getContext("2d");
    g.fillStyle = "#6b6259";
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(img, 30, 60, 300, 300 * img.height / img.width);
    for (let i = 0; i < 3; i++) tracker.track(c, performance.now() + i);
    stats.warm = true;
  } catch (err) {
    console.warn(`mobile: warm-up skipped (${err?.message || err})`);
  }
}

/* ---- the experiment: mounted now, so its pictures, gloves and grading model load while the welcome is read ---- */
const video = $("#cam");
const canvas = $("#overlay");
const ctx = canvas.getContext("2d");
/* The same grader as every other version (tutor/model.json, tutor/mix.js's rules and OpenFS's second opinion on
 * I, M, N and X): the hand tracker downloads first, then OpenFS's weights, and a letter OpenFS grades waits for them
 * (practice() below) instead of the first letter waiting up to 10 s. No outline art for glove letters (never drawn). */
LOAD.pictureArtForGloveLetters = false;
LOAD.openfsAtMount = false;
LOAD.openfsWaitMs = 0;
exp.mount($("#exp-mount"), { participant: {}, demographics: {}, condition: null, video: { width: CAMERA.height, height: CAMERA.width, aspect: 0.75 } });
/* The letter with its ring and the letter's picture go ON the camera view (outside the mirrored box, so they read the
 * right way round). The tutor keeps its own references to these nodes, so moving them changes nothing it does. */
const hud = $("#hud");
const cueWrap = $("#exp-mount .tutor-cue-wrap");
const reference = $("#tutor-reference");
if (cueWrap) hud.append(cueWrap);
if (reference) hud.append(reference);
let firstTrial = planError ? Promise.reject(planError) : exp.nextTrial(0);
firstTrial.catch((err) => { if (!planError) loadFailed(err); });

/* ---- sound and a buzz --------------------------------------------------------------------------------------------- */
let audio = null;
let soundOn = (() => { try { return localStorage.getItem(SOUND_KEY) !== "off"; } catch { return true; } })();
function unlockAudio() {
  try {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    audio ??= new AC();
    if (audio.state === "suspended") audio.resume();
    // iOS opens the audio path on a sound started inside the tap
    const b = audio.createBuffer(1, 1, 22050), s = audio.createBufferSource();
    s.buffer = b; s.connect(audio.destination); s.start(0);
  } catch { audio = null; }
}
function tone(freq, at, dur, peak = 0.16, type = "triangle") {
  const o = audio.createOscillator(), g = audio.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, at);
  g.gain.setValueAtTime(0.0001, at);
  g.gain.exponentialRampToValueAtTime(peak, at + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, at + dur);
  o.connect(g).connect(audio.destination);
  o.start(at); o.stop(at + dur + 0.02);
}
function chime(kind) {
  if (kind === "made") navigator.vibrate?.(35);
  if (kind === "done") navigator.vibrate?.([30, 70, 40]);
  if (!soundOn || !audio) return;
  try {
    if (audio.state === "suspended") audio.resume();
    const t = audio.currentTime + 0.01;
    if (kind === "made") { tone(784, t, 0.16); tone(1175, t + 0.09, 0.28); }
    else if (kind === "done") { [523, 659, 784, 1047].forEach((f, i) => tone(f, t + i * 0.1, 0.35, 0.13)); }
  } catch { /* no sound is fine */ }
}
function renderSound() {
  const b = $("#btn-sound");
  b.setAttribute("aria-pressed", String(soundOn));
}

/* ---- the camera ---------------------------------------------------------------------------------------------------- */
class CameraError extends Error {
  constructor(kind, detail) { super(kind); this.kind = kind; this.detail = detail; }
}
let stream = null;
async function openCamera() {
  if (!window.isSecureContext) throw new CameraError("insecure");
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError("unsupported");
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: false,
      video: { facingMode: "user", width: { ideal: CAMERA.width }, height: { ideal: CAMERA.height }, frameRate: { ideal: CAMERA.frameRate } },
    });
  } catch (err) {
    throw new CameraError(err?.name || "unknown", err?.message);
  }
  const track = stream.getVideoTracks()[0];
  track?.addEventListener("ended", () => { if (document.visibilityState === "visible") resumeCamera(); });
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  // play() settles only once a picture arrives: a camera held by a call never sends one, so it is not awaited unbounded
  await Promise.race([video.play().catch(() => {}), sleep(5000)]);
  for (let i = 0; i < 100 && !(video.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 50));
  if (!(video.videoWidth > 0)) throw new CameraError("NoFrames");
  stats.video = { w: video.videoWidth, h: video.videoHeight, settings: track?.getSettings?.() ?? null };
  watchFrames();
}
/* When the camera last showed a frame (requestVideoFrameCallback; without it the watchdog stays off). */
let aliveAt = 0, aliveGen = 0;
function watchFrames() {
  if (typeof video.requestVideoFrameCallback !== "function") return;
  const g = ++aliveGen;
  aliveAt = performance.now();
  const tick = () => video.requestVideoFrameCallback(() => { if (g !== aliveGen) return; aliveAt = performance.now(); tick(); });
  tick();
}
/* A camera that stops sending frames while the page is in view (taken by another app, stalled after Control Center or
 * a lock) is reopened, at most every few seconds. */
const STALL_FRAMES_MS = 2500;
let reopenedAt = 0;
setInterval(() => {
  if (document.visibilityState !== "visible" || !stream || resuming || halted || REPLAY.valid || !aliveAt) return;
  if (stats.screen !== "practice") return;
  const now = performance.now();
  if (now - aliveAt > STALL_FRAMES_MS && now - reopenedAt > 6000) { reopenedAt = now; resumeCamera(true); }
}, 1000);
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}
let resuming = null;
/* After a lock, an app switch or a stall: play again, or reopen the camera (`force`: even if the track says it is
 * live). A camera just let go by another app can refuse once, so a reopen is tried three times before the error page. */
function resumeCamera(force = false) {
  if (resuming) return resuming;
  resuming = (async () => {
    try {
      const track = stream?.getVideoTracks()[0];
      if (force || !track || track.readyState === "ended") {
        for (let attempt = 0; ; attempt++) {
          try { stopCamera(); await openCamera(); break; }
          catch (err) { if (attempt >= 2) throw err; await sleep(700); }
        }
        layout();
        clock?.rearm();
      } else if (video.paused) {
        await Promise.race([video.play().catch(() => {}), sleep(3000)]);
      }
    } catch (err) {
      fail(err);
    }
  })().finally(() => { resuming = null; });
  return resuming;
}

/* ---- one new camera frame at a time ------------------------------------------------------------------------------ */
/* With requestVideoFrameCallback each camera frame is flagged once, as it is shown, and the loop (on the screen's
 * repaints, like the laptop's) processes it once. The laptop's own test -- has the media time moved? -- is true on
 * nearly every repaint (measured in Chrome: 283 of 285 repaints with a 30 fps camera), so it re-tracks each picture
 * about twice; it is used only until the first callback, or where there is none. Once the callbacks have started they
 * are the only test: a picture that stops coming (a camera stalled or interrupted) is not re-tracked, since a frozen
 * picture is a perfectly still hand and the ring would take it; if they go quiet for a second the chain is armed again
 * (one chain counts, by generation). Nothing is tracked while the video has no picture (a camera being reopened). A
 * replay has no pictures: one recorded frame per tick of its own frame rate, with the laptop's test, as
 * js/core/experiment.js runs it (it stops when the recording does). */
const VFC_QUIET_MS = 1000;
/* Set when the error page goes up: the frame loops stop where they are (the page is reloaded to go on). */
let halted = false;
function createClock(src, replayFps = null) {
  const next = (wait) => (halted ? new Promise(() => {}) : new Promise(wait));
  if (replayFps) {
    const ms = 1000 / replayFps;
    let last = -1;
    return { hasNew: () => src.currentTime !== last, done() { last = src.currentTime; }, rearm() {}, next: () => next((r) => setTimeout(r, ms)) };
  }
  let seq = 0, doneSeq = 0, lastTime = -1, vfcAt = -Infinity, gen = 0;
  // ?vfc=0: the laptop's test only (for comparing the two hosts frame for frame)
  const vfc = typeof src.requestVideoFrameCallback === "function" && params.get("vfc") !== "0";
  const arm = () => {
    const g = ++gen;
    const tick = () => src.requestVideoFrameCallback(() => { if (g !== gen) return; seq++; vfcAt = performance.now(); tick(); });
    tick();
  };
  if (vfc) arm();
  return {
    hasNew() {
      if (!(src.readyState >= 2 && src.videoWidth > 0)) return false;
      if (vfcAt === -Infinity) return src.currentTime !== lastTime;
      if (performance.now() - vfcAt > VFC_QUIET_MS) { vfcAt = performance.now(); arm(); }
      return seq !== doneSeq;
    },
    done() { doneSeq = seq; lastTime = src.currentTime; },
    rearm() { if (vfc) { vfcAt = performance.now(); arm(); } },
    next: () => next((r) => requestAnimationFrame(() => r())),
  };
}

/* ---- the camera view's size: as big as the room allows, at the camera's own shape ------------------------------ */
// until the camera says otherwise: the screen's own way round (a phone held upright gets 480 x 640)
let [srcW, srcH] = innerWidth > innerHeight ? [CAMERA.width, CAMERA.height] : [CAMERA.height, CAMERA.width];
function sourceSize(src) {
  const w = src.videoWidth, h = src.videoHeight;
  if (w > 0 && h > 0) { srcW = w; srcH = h; }
  return { width: srcW, height: srcH, aspect: srcW / srcH };
}
/* Upright, the camera view takes the width and as much height as leaves the words their room (PANEL_MIN_PX), and the
 * words get whatever is left, so the view never changes size when a hint grows a line. On its side (and on a laptop),
 * the view fills the space beside the words. */
const PANEL_MIN_PX = 172;
const landscape = () => matchMedia("(orientation: landscape)").matches;
function layout() {
  const main = $(".practice-main"), wrap = $("#stage-wrap"), stage = $("#stage");
  if (!main || !wrap || !stage || !main.clientHeight) return;
  const ar = srcW / srcH;
  let W, H;
  if (landscape()) {
    wrap.style.flex = "";
    wrap.style.height = "";
    W = wrap.clientWidth; H = wrap.clientHeight;
  } else {
    const cs = getComputedStyle(main);
    W = main.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
    H = main.clientHeight - parseFloat(cs.paddingBottom) - parseFloat(cs.rowGap || cs.gap || 0) - PANEL_MIN_PX;
  }
  if (!(W > 0 && H > 0)) return;
  let w = W, h = W / ar;
  if (h > H) { h = H; w = H * ar; }
  w = Math.floor(w); h = Math.floor(h);
  if (!landscape()) { wrap.style.flex = "0 0 auto"; wrap.style.height = `${h}px`; }
  stage.style.aspectRatio = "auto";
  stage.style.width = `${w}px`;
  stage.style.height = `${h}px`;
  // the drawing at the screen's pixel density, at most 2 canvas pixels per camera pixel: crisp lines on a phone without a
  // huge canvas; not tied to the view's size, so a palm keeps its size on the canvas when the phone turns
  // (glove.js and picture-ghost.js ease their size in canvas pixels)
  const k = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  const cw = Math.round(srcW * k), ch = Math.round(srcH * k);
  if (canvas.width !== cw || canvas.height !== ch) { canvas.width = cw; canvas.height = ch; }
}
new ResizeObserver(() => layout()).observe($(".practice-main"));
addEventListener("orientationchange", () => setTimeout(layout, 250));
video.addEventListener("resize", () => { sourceSize(video); layout(); });

/* ---- the frame: track, pick the hand, hand it to the demo, draw (js/core/experiment.js recordTrial) ------------- */
let src = video, tracker = null, clock = null;
const noop = () => {};
function handIndex(res, vi) {
  const n = res.landmarks?.length ?? 0;
  if (!exp.pickHand || n === 0) return n ? 0 : -1;
  try {
    const k = exp.pickHand(res, { aspect: vi.aspect, demographics: {} });
    return Number.isInteger(k) && k >= -1 && k < n ? k : 0;
  } catch (err) {
    console.warn("pickHand failed; using the first hand", err);
    return 0;
  }
}
const NO_HANDS = Object.freeze({ landmarks: [], worldLandmarks: [], handedness: [], handednessScore: [] });
let rebuilding = null;
/* tracker.js gives up after ~3 s of failed frames (a GPU context lost when the phone was locked: WebKit lost them on
 * some iOS versions). Rather than end the session, build a new tracker (from the kept runtime and the model's cached
 * download) and carry on; only a failed rebuild, or a third loss, ends it. */
function rebuildTracker(err) {
  if (rebuilding) return;
  if (REPLAY.valid || (stats.rebuilt ?? 0) >= 2) { fail(err); return; }
  rebuilding = (async () => {
    await null;
    stageMessage("Restarting the hand tracker…");
    try {
      const t = await createTracker(exp.tracker ?? "hand", { ...(exp.trackerOptions ?? {}) });
      try { tracker.close(); } catch { /* already gone */ }
      tracker = t;
      stats.rebuilt = (stats.rebuilt ?? 0) + 1;
      stageMessage(null);
    } catch (e) {
      fail(e);
    } finally {
      rebuilding = null;
    }
  })();
}
function track() {
  const t0 = performance.now();
  let res = NO_HANDS;
  if (!rebuilding) {
    try { res = tracker.track(src, performance.now()); }
    catch (err) { rebuildTracker(err); }
  }
  const vi = sourceSize(src);
  if (canvas.width / canvas.height > 1 !== vi.aspect > 1 || Math.abs(canvas.width / canvas.height - vi.aspect) > 0.01) layout();
  stats.trackMs.push(performance.now() - t0);
  if (stats.trackMs.length > 600) stats.trackMs.splice(0, 300);
  stats.frames++;
  return { res, vi };
}

/* ---- the hand's size, as the ring measures it ---------------------------------------------------------------------- */
/* tutor/commit.js will not start a hold while the palm (in the picture's short side, the median of the last 5 frames)
 * is under TUTOR_COMMIT_OPTS.minPalm, and lets go only above it times MIN_PALM_EXIT_FACTOR. The tutor says "Move your
 * hand closer." once, for 2.5 s, and meanwhile the glove can turn green from a size the grader still reads: so the
 * camera check and the camera view say "closer" exactly while no hold could start, by the same numbers. */
const PALM_MIN = TUTOR_COMMIT_OPTS.minPalm, PALM_EXIT = PALM_MIN * MIN_PALM_EXIT_FACTOR;
function createSizeWatch() {
  let rows = [], small = false;
  const median = (v) => { const a = v.length % 2 ? v : v.slice(1); return [...a].sort((x, y) => x - y)[(a.length - 1) / 2]; };
  return (lm, aspect) => {
    if (!lm) { rows = []; small = false; return false; }
    const S = palmSize(toPoints(flattenRounded(lm, DECIMALS), aspect)) / (aspect < 1 ? aspect : 1);
    if (!(S > 0)) return small;
    rows.push(S);
    if (rows.length > 5) rows.shift();
    const m = median(rows);
    if (!small && m < PALM_MIN) small = true;
    else if (small && m > PALM_EXIT) small = false;
    return small;
  };
}

/* ---- the camera check: the asked-for hand in view for a moment, then straight on ---------------------------------- */
const OTHER = HAND === "right" ? "left" : "right";
async function cameraCheck() {
  phase("setup");
  const status = $("#setup-status");
  const say = (text, tone = "") => {
    if (status.textContent !== text) status.textContent = text;
    const c = `setup-status${tone ? ` ${tone}` : ""}`;
    if (status.className !== c) status.className = c;
  };
  const sizeOf = createSizeWatch();
  const draw = (lm) => { ctx.clearRect(0, 0, canvas.width, canvas.height); exp.draw(ctx, { landmarks: lm, canvas, trial: null, tMs: 0 }); };
  let since = null, seenAt = -Infinity, lastHandAt = performance.now(), objectionSince = null, passPose = null;
  for (;;) {
    if (clock.hasNew()) {
      clock.done();
      const { res, vi } = track();
      const k = handIndex(res, vi);
      const lm = k >= 0 ? res.landmarks[k] : null;
      draw(lm);
      let objection = null;
      if (k >= 0) {
        try { objection = exp.handProblem?.(res, k, { aspect: vi.aspect, demographics: {} }) ?? null; }
        catch (err) { console.warn("handProblem failed; letting the hand pass", err); }
      }
      const now = performance.now();
      const small = sizeOf(objection ? null : lm, vi.aspect);
      objectionSince = objection ? objectionSince ?? now : null;
      otherHandOffer.hidden = !(objectionSince !== null && now - objectionSince >= OTHER_HAND_OFFER_MS);
      if (lm) lastHandAt = now;
      if (lm && !objection && !small) seenAt = now;
      const present = now - seenAt < SEEN_GRACE_MS;
      if (!present) since = null;
      else since ??= now;
      if (since !== null && lm && !objection && now - since >= CHECK_HOLD_MS) {
        passPose = toPoints(flattenRounded(lm, DECIMALS), vi.aspect);
        break;
      }
      if (objection) say(PHONE ? `That looks like your ${OTHER} hand. Hold the phone in your ${OTHER} hand, and hold up your ${HAND}.` : objection, "bad");
      else if (small) say("Bring your hand a little closer to the camera.", "bad");
      else if (present) say("Hold it there…", "good");
      else if (IOS && /[VA]/.test(LETTERS_ASKED.join("")) && now - lastHandAt > CHECK_HINT_MS / 2) say(REACTIONS_NOTE);
      else say(now - lastHandAt > CHECK_HINT_MS ? NO_HAND_HINT : "Hold it up in front of the camera, where you can see it on screen.");
    }
    await clock.next();
  }
  otherHandOffer.hidden = true;
  // the hand that passed goes down (or changes shape) before the first letter can take a hold
  say("Great! Now lower your hand to begin.", "good");
  const t0 = performance.now();
  let goneAt = null;
  while (performance.now() - t0 < LOWER_MAX_MS) {
    if (clock.hasNew()) {
      clock.done();
      const { res, vi } = track();
      const k = handIndex(res, vi);
      const lm = k >= 0 ? res.landmarks[k] : null;
      draw(lm);
      if (!lm) {
        goneAt ??= performance.now();
        if (performance.now() - goneAt >= LOWER_GONE_MS) break;
      } else {
        goneAt = null;
        if (shapeDistance(passPose, toPoints(flattenRounded(lm, DECIMALS), vi.aspect)) > TUTOR_COMMIT_OPTS.heldOverShape) break;
      }
    }
    await clock.next();
  }
}

/* "I sign with my left hand": the same link with ?hand= switched, straight back into the camera check. */
const otherHandOffer = (() => {
  const b = document.createElement("button");
  b.type = "button";
  b.className = "btn btn-ghost other-hand";
  b.textContent = `I sign with my ${OTHER} hand`;
  b.hidden = true;
  b.addEventListener("click", () => {
    const q = new URLSearchParams(location.search);
    q.set("hand", OTHER);
    try { sessionStorage.setItem(AUTOSTART_KEY, "1"); } catch { /* welcome again */ }
    location.href = `?${q}`;
  });
  $("#setup-card").append(b);
  return b;
})();

/* ---- the practice ----------------------------------------------------------------------------------------------- */
let endCurrent = null;
let practising = false;
let doneCount = 0;
function setProgress(n) {
  doneCount = Math.max(doneCount, n);
  const fill = $("#progress-fill"), total = PLAN.length || 1;
  fill.style.width = `${Math.round((100 * doneCount) / total)}%`;
  fill.classList.toggle("progress-zero", doneCount === 0);
  const bar = $("#progress");
  bar.setAttribute("aria-valuemax", String(PLAN.length));
  bar.setAttribute("aria-valuenow", String(doneCount));
  bar.setAttribute("aria-valuetext", `${doneCount} of ${PLAN.length} letters`);
}
const hudNote = $("#hud-note");
let trialStartedAt = 0;
async function recordTrial(trial, state) {
  const durationMs = (trial.durationSec ?? 15) * 1000;
  const sizeOf = createSizeWatch();
  let noteOn = false;
  trialStartedAt = performance.now();
  const { endReason } = await runTrialLoop({
    durationMs,
    now: () => performance.now(),
    nextFrame: () => clock.next(),
    hasNewFrame: () => clock.hasNew(),
    step: (tMs, endTrial) => {
      clock.done();
      endCurrent = endTrial;
      try { frame(tMs, endTrial); frameErrors = 0; }
      catch (err) {
        if (++frameErrors === 1) console.error("mobile: a frame failed and was skipped", err);
        if (frameErrors >= 30) throw err;
      }
    },
  });
  endCurrent = null;
  hudNote.hidden = true;
  return endReason;

  function frame(tMs, endTrial) {
    const { res, vi } = track();
    const t1 = performance.now();
    const k = handIndex(res, vi);
    const lm = k >= 0 ? res.landmarks[k] ?? null : null;
    const wl = k >= 0 ? res.worldLandmarks[k] ?? null : null;
    const handedness = k >= 0 ? res.handedness[k] ?? null : null;
    const handednessScore = k >= 0 ? res.handednessScore?.[k] ?? null : null;
    const derived = exp.onFrame?.({ landmarks: lm, worldLandmarks: wl, handedness, handednessScore, tMs, trial, state, addEvent: noop, endTrial, video: vi }) ?? {};
    const small = sizeOf(lm, vi.aspect);
    if (small !== noteOn) { noteOn = small; hudNote.hidden = !small; }
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    exp.draw(ctx, { landmarks: lm, derived, state, trial, canvas, tMs, setReadout: noop });
    stats.tutorMs.push(performance.now() - t1);
    if (stats.tutorMs.length > 600) stats.tutorMs.splice(0, 300);
  }
}
let frameErrors = 0;
async function practice() {
  phase("practice");
  $("#practice-actions").hidden = false;
  practising = true;
  keepAwake();
  let i = 0;
  let trial = await firstTrial;
  while (trial) {
    if (SECOND_OPINION.letters.includes(trial.letter) && stats.openfs === undefined) await waitForOpenFS();
    const state = exp.onTrialStart?.(trial, { tracker }) ?? {};
    currentIndex = i;
    const endReason = await recordTrial(trial, state);
    const summary = exp.onTrialEnd?.({ frames: [], events: [], trial, state, endReason }) ?? {};
    stats.summaries.push({ index: i, id: trial.id, letter: trial.letter, ...summary, endReason });
    i++;
    setProgress(i);
    trial = await exp.nextTrial(i);
  }
  practising = false;
  releaseAwake();
  finish();
}
let currentIndex = 0;
/* Before a letter OpenFS grades: its weights, if they are still on their way (they start after the hand tracker). If
 * they cannot load, the letter goes ahead as it would on the laptop without them. */
async function waitForOpenFS() {
  if (REPLAY.valid) { stats.openfs = !!(await Promise.race([openfsLoaded(), sleep(20000)])); return; }
  stageMessage("Getting the next letter ready…");
  const o = await Promise.race([openfsLoaded(), sleep(45000).then(() => null)]);
  stats.openfs = !!o;
  stageMessage(null);
}

/* "Good job" (the tutor's correct tone) and a new letter: a chime, the bar moves, the letter pops in */
new MutationObserver(() => {
  const fb = $("#tutor-feedback");
  if (fb?.classList.contains("tutor-tone-correct") && stats.accepted[stats.accepted.length - 1]?.index !== currentIndex) {
    stats.accepted.push({ index: currentIndex, letter: $("#tutor-cue")?.textContent, at: performance.now() });
    setProgress(currentIndex + 1);
    chime("made");
  }
}).observe($("#tutor-feedback") ?? document.body, { attributes: true, attributeFilter: ["class"] });
const cue = $("#tutor-cue");
if (cue) {
  cue.removeAttribute("aria-label");
  new MutationObserver(() => {
    cue.classList.remove("cue-in");
    void cue.offsetWidth;
    cue.classList.add("cue-in");
    if (/^[A-Z]$/.test(cue.textContent)) $("#announce").textContent = `Next letter: ${cue.textContent}`;
  }).observe(cue, { childList: true, characterData: true, subtree: true });
}

/* ---- the end ----------------------------------------------------------------------------------------------------- */
const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const DASH_SVG = `<svg viewBox="0 0 24 24"><path d="M7 12h10"/></svg>`;
const HAND_SVG = `<svg viewBox="0 0 24 24"><path d="M8 13V5.5a1.5 1.5 0 0 1 3 0V12m0-1V4a1.5 1.5 0 0 1 3 0v7m0-.5V5.5a1.5 1.5 0 0 1 3 0V14c0 4-2.5 7-6.5 7S6 18.5 5 16l-1.6-3.3a1.4 1.4 0 0 1 2.4-1.4L8 14"/></svg>`;
function finish() {
  stopCamera();
  const rows = stats.summaries;
  const made = rows.filter((r) => r.correct).length;
  const all = rows.length;
  const skippedAll = all > 0 && rows.every((r) => !r.correct && r.endReason === "skipped");
  $("#results-title").textContent = made === all && all ? "Nice work!" : made ? "Good practice!" : "Good start!";
  $("#results-lede").textContent = made ? `You made ${made} of ${all} letter${all === 1 ? "" : "s"}.`
    : skippedAll ? `You skipped ${all === 1 ? "the letter" : `all ${all} letters`}. Try them now?`
    : `You tried ${all} letter${all === 1 ? "" : "s"}. They get easier with practice.`;
  const trophy = $("#trophy");
  trophy.className = `trophy${made === all ? "" : " trophy-partial"}`;
  const colors = ["#1e9e6a", "#f5a524", "#38bdf8", "#a78bfa", "#f472b6", "#34d399"];
  trophy.innerHTML = `<div class="trophy-disc">${made ? CHECK_SVG : HAND_SVG}</div>`
    + (made ? Array.from({ length: 18 }, (_, k) => `<i class="confetti" style="--a:${k * 20}deg;--d:${70 + (k % 3) * 18}px;--delay:${120 + (k % 4) * 40}ms;background:${colors[k % colors.length]}"></i>`).join("") : "");
  const esc = (v) => String(v ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  $("#result-list").innerHTML = rows.map((r, k) => {
    const what = r.correct ? (r.tries <= 1 ? "Made it, first try" : `Made it after ${r.tries} tries`)
      : r.endReason === "skipped" ? "Skipped" : "Not yet";
    const looks = (r.looks ?? []).filter((c) => c !== r.letter);
    return `<li class="${r.correct ? "result-made" : "result-notyet"}" style="--delay:${150 + k * 90}ms">
        <span class="result-letter">${esc(r.letter)}</span>
        <span class="result-text"><b>${what}</b>${looks.length ? `<span>Looked like ${looks.map(esc).join(", ")} on the way</span>` : ""}</span>
        <span class="result-mark" aria-hidden="true">${r.correct ? CHECK_SVG : DASH_SVG}</span></li>`;
  }).join("");
  show("results");
  if (made) chime("done");
}

/* ---- when something goes wrong ------------------------------------------------------------------------------------ */
function errorCopy(err) {
  const kind = err?.kind ?? null;
  const browserSteps = IOS
    ? (/CriOS/.test(UA)
      ? `<ol><li>Open your iPhone's <b>Settings</b>, scroll to <b>Chrome</b>, and turn <b>Camera</b> on.</li><li>Come back here and tap <b>Try again</b>.</li></ol>`
      : `<ol><li>Tap <b>aA</b> (or the page icon) at the side of the address bar.</li><li>Tap <b>Website Settings</b>, then set <b>Camera</b> to <b>Allow</b>.</li><li>Tap <b>Try again</b>.</li></ol>`)
    : ANDROID
      ? `<ol><li>Tap the icon at the left of the address bar.</li><li>Tap <b>Permissions</b> (or <b>Site settings</b>) and allow the <b>Camera</b>.</li><li>Tap <b>Try again</b>.</li></ol>`
      : `<ol><li>Click the camera icon in the address bar and choose <b>Allow</b>.</li><li>Click <b>Try again</b>.</li></ol>`;
  if (kind === "unsupported" || (IN_APP && (kind === "NotAllowedError" || kind === "NotSupportedError"))) {
    return { title: "Open this page in your browser", copy: true,
      body: `<p>${IN_APP ? `${IN_APP}'s built-in browser` : "This browser"} can't use the camera.</p>
        <p>Open the page in <b>${BROWSER}</b>: ${IN_APP ? "tap the <b>•••</b> menu and choose <b>Open in browser</b>, or " : ""}copy the link and paste it there.</p>` };
  }
  if (kind === "NotAllowedError" || kind === "SecurityError" || kind === "PermissionDeniedError") {
    return { title: "Allow the camera", copy: true, body: `<p>The camera is how the app sees your hand. Nothing is recorded or sent anywhere.</p>${browserSteps}
      <p>Opened from another app? Then open the page in <b>${BROWSER}</b> instead: copy the link and paste it there.</p>` };
  }
  if (kind === "NotReadableError" || kind === "TrackStartError" || kind === "AbortError") {
    return { title: "Your camera is busy", body: `<p>Another app may be using the camera (a video call, the Camera app). Close it, then try again.</p>` };
  }
  if (kind === "NotFoundError" || kind === "OverconstrainedError" || kind === "DevicesNotFoundError") {
    return { title: "No camera found", body: `<p>This device didn't offer a front camera. Try another phone, or a laptop with a webcam.</p>` };
  }
  if (kind === "insecure") {
    return { title: "Open the secure link", copy: true, body: `<p>Browsers only allow the camera on <b>https://</b> pages.</p>` };
  }
  if (kind === "NoFrames") {
    return { title: "The camera didn't start", body: `<p>The camera turned on but sent no picture. Close other apps that use it and try again.</p>` };
  }
  if (kind === "load" || /Could not load the|Failed to fetch|NetworkError|Load failed|network|Importing a module script failed|module script|dynamically imported module/i.test(String(err?.message || ""))) {
    return { title: "Couldn't load the lesson", body: `<p>Part of the app didn't download. Check your connection, then try again.</p>
      <p class="fineprint">${String(err?.message || err).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</p>` };
  }
  if (/hand tracking model could not start|Hand tracking stopped working/i.test(String(err?.message || ""))) {
    return { title: "The hand tracker stopped", body: `<p>The hand tracker couldn't keep running on this phone's graphics. Close other tabs and apps, then try again.</p>` };
  }
  return { title: "Something went wrong", body: `<p>${String(err?.message || err).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]).replace(/\n/g, "<br>")}</p>` };
}
function fail(err) {
  console.error("mobile:", err);
  halted = true;
  stats.errors.push(String(err?.kind || err?.message || err));
  practising = false;
  releaseAwake();
  stopCamera();
  const e = errorCopy(err);
  $("#error-title").textContent = e.title;
  $("#error-body").innerHTML = e.body;
  $("#btn-copy").hidden = !e.copy;
  show("error");
}

/* ---- keeping the screen on, and coming back to the page ---------------------------------------------------------- */
let wake = null;
async function keepAwake() {
  if (wake && !wake.released) return;
  try { wake = await navigator.wakeLock?.request("screen"); } catch { wake = null; }
}
function releaseAwake() { try { wake?.release(); } catch { /* already gone */ } wake = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (stats.screen === "practice" && stream && !REPLAY.valid) { aliveAt = performance.now(); keepAwake(); resumeCamera(); }
  if (audio?.state === "suspended") audio.resume().catch(() => {});
});
// back to a page restored from the browser's memory: the camera is gone, start clean
addEventListener("pageshow", (e) => { if (e.persisted) location.reload(); });

/* ---- the frame-rate readout (?fps=1) --------------------------------------------------------------------------- */
if (SHOW_PERF) {
  const el = $("#perf");
  el.hidden = false;
  let lastN = 0, lastT = performance.now();
  const med = (a) => { if (!a.length) return 0; const b = a.slice(-60).sort((x, y) => x - y); return b[Math.floor(b.length / 2)]; };
  setInterval(() => {
    const t = performance.now(), fps = ((stats.frames - lastN) * 1000) / (t - lastT);
    lastN = stats.frames; lastT = t;
    el.textContent = `${fps.toFixed(0)} fps · track ${med(stats.trackMs).toFixed(0)} ms · tutor ${med(stats.tutorMs).toFixed(1)} ms · ${stats.delegate ?? "…"} · ${srcW}×${srcH}`;
  }, 500);
}

/* ?ping=1: the page's state, every 2 s, as a request to its own site (for reading a page that cannot be inspected,
 * like a phone simulator; nothing but these numbers is sent, and only with this option). */
if (params.get("ping") === "1") {
  setInterval(() => {
    const s = stats;
    const now = { screen: s.screen, phase: s.phase, delegate: s.delegate, warm: s.warm, loaded: s.loaded, frames: s.frames,
      video: s.video && [s.video.w, s.video.h], accepted: s.accepted.map((a) => a.letter), errors: s.errors.slice(-3),
      done: s.summaries.map((r) => `${r.letter}:${r.correct ? "made" : r.endReason}`), cue: $("#tutor-cue")?.textContent,
      said: $("#tutor-feedback")?.textContent || $("#tutor-status")?.textContent, ua: UA.slice(0, 60) };
    fetch(`ping?s=${encodeURIComponent(JSON.stringify(now))}`, { cache: "no-store" }).catch(() => {});
  }, 2000);
}

/* ---- start ------------------------------------------------------------------------------------------------------ */
let stageWaiting = null;
function stageMessage(text) {
  const m = $("#stage-message");
  m.hidden = !text;
  if (text) $("#stage-message-text").textContent = text;
}
let started = false;
/* `tapped`: called from a tap (the Start button). A page that starts by itself (after "I sign with my left hand", or the
 * camera-flip offer) asks for one tap first: sound and the screen's wake lock are only granted inside a tap, and on an
 * iPhone a signing learner never touches the screen again. */
async function start(tapped = true) {
  if (started) return;
  if (loadError && stats.screen === "welcome") { location.reload(); return; }
  started = true;
  if (tapped) { keepAwake(); unlockAudio(); guardBack(); }
  if (planError) return fail(planError);
  show("practice");
  phase("setup");
  layout();
  try {
    if (!tapped) await waitForTap();
    await session();
  } catch (err) {
    fail(err);
  }
}
async function waitForTap() {
  const title = $("#setup-title"), status = $("#setup-status"), b = $("#btn-ready");
  title.textContent = "Ready?";
  status.textContent = `Tap Start, then hold up your ${HAND} hand.`;
  b.hidden = false;
  await new Promise((r) => b.addEventListener("click", r, { once: true }));
  b.hidden = true;
  title.textContent = `Hold up your ${HAND} hand`;
  keepAwake();
  unlockAudio();
  guardBack();
}
/* The camera, the camera check and the letters (again from "Practice again", with the tracker kept). */
async function session() {
  if (REPLAY.valid) {
    stageMessage("Loading the recording…");
    const data = await loadReplay(REPLAY.path);
    ({ video: src, tracker } = createReplay(data));
    stats.delegate = tracker.delegate;
    sourceSize(src);
    layout();
    clock = createClock(src, data.fps);
    stageMessage(null);
  } else {
    if (loadError) throw loadError;
    stageMessage("Starting your camera…");
    $("#setup-status").textContent = "Tap Allow when your browser asks to use the camera.";
    await openCamera();
    sourceSize(video);
    layout();
    if (stats.loaded < 1) { stageWaiting = "tracker"; setLoad(stats.loaded); }
    $("#setup-status").textContent = "Loading the hand tracker…";
    tracker = await trackerReady;
    stageWaiting = null;
    stageMessage(null);
    clock ??= createClock(video);
    await cameraCheck();
  }
  let ready = false;
  firstTrial.then(() => { ready = true; }, () => { ready = true; });
  await sleep(0);
  if (!ready) stageMessage("Getting your first letter ready…");
  await firstTrial;
  stageMessage(null);
  await practice();
}
/* Back during the camera check or the letters (an Android edge swipe brushed while holding the phone; in Slack's or
 * Gmail's browser it would close the page) opens "Stop practicing?" instead of leaving. */
function guardBack() {
  try { if (history.state?.practice !== 1) history.pushState({ practice: 1 }, ""); } catch { /* no history API */ }
}
addEventListener("popstate", () => {
  if (stats.screen !== "practice") return;
  guardBack();
  $("#quit-sheet").hidden = false;
  $("#btn-keep").focus({ preventScroll: true });
});
/* "Practice again": the same page and the same tracker (no download, no compile, no warm-up, no new page to grant the
 * camera and sound to), the experiment's own files fetched again by nextTrial(0), the camera reopened inside the tap. */
async function again() {
  if (!tracker || REPLAY.valid) { location.reload(); return; }
  keepAwake();
  unlockAudio();
  guardBack();
  stats.summaries.length = 0;
  stats.accepted.length = 0;
  doneCount = 0;
  setProgress(0);
  firstTrial = exp.nextTrial(0);
  firstTrial.catch(() => {});
  show("practice");
  phase("setup");
  $("#setup-title").textContent = `Hold up your ${HAND} hand`;
  layout();
  try { await session(); } catch (err) { fail(err); }
}

$("#btn-start").addEventListener("click", () => start(true));
/* Safari ignores overscroll-behavior on a page that does not scroll: a drag starting on the practice screen (outside a
 * card whose words overflow) would rubber-band the page or pull it to refresh mid-letter. Taps are untouched. */
$("#practice").addEventListener("touchmove", (e) => {
  const c = e.target.closest?.("#exp-mount .tutor-main, .setup-card");
  if (!c || c.scrollHeight <= c.clientHeight) e.preventDefault();
}, { passive: false });
// a double tap on Skip must not skip the next letter too
$("#btn-skip").addEventListener("click", () => { if (performance.now() - trialStartedAt > 700) endCurrent?.("skipped"); });
$("#btn-close").addEventListener("click", () => { $("#quit-sheet").hidden = false; $("#btn-keep").focus(); });
const closeSheet = () => { $("#quit-sheet").hidden = true; $("#btn-close").focus({ preventScroll: true }); };
$("#btn-keep").addEventListener("click", closeSheet);
$("#quit-sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) closeSheet(); });
$("#btn-quit").addEventListener("click", () => { stopCamera(); location.replace(location.href); });
$("#btn-sound").addEventListener("click", () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch { /* this visit only */ }
  renderSound();
  if (soundOn) { unlockAudio(); chime("made"); }
});
$("#btn-again").addEventListener("click", () => again());
$("#btn-retry").addEventListener("click", () => location.reload());
/* Copy the link; where neither the clipboard nor a prompt works (many in-app browsers), show it to copy by hand. */
async function copyLink() {
  const url = shareableUrl();
  try { await navigator.clipboard.writeText(url); toast("Link copied"); return; } catch { /* below */ }
  const box = $("#error-body");
  if (document.body.dataset.screen === "error" && box && !box.querySelector(".link-out")) {
    box.insertAdjacentHTML("beforeend", `<p>Copy this link: <code class="link-out"></code></p>`);
    box.querySelector(".link-out").textContent = url;
  } else {
    toast(url);
  }
}
$("#btn-copy").addEventListener("click", copyLink);
$("#btn-copy-inapp").addEventListener("click", copyLink);
$("#btn-share").addEventListener("click", async () => {
  const url = shareableUrl();
  if (navigator.share) {
    try { await navigator.share({ title: "Fingerspelling practice", text: "Practice fingerspelling with your phone's camera.", url }); return; }
    catch (err) { if (err?.name === "AbortError") return; }
  }
  copyLink();
});

/* The camera-flip offer (asl-demo.js showFlipOffer) reloads the page with ?srcmirror=1: carry on straight into the
 * camera check rather than back to the welcome screen. Set in the capture phase, before the offer's own handler. */
document.addEventListener("click", (e) => {
  if (e.target?.closest?.(".demo-flip-btn")) { try { sessionStorage.setItem(AUTOSTART_KEY, "1"); } catch { /* welcome again */ } }
}, true);
// a tap (touchend / click carry the user activation; pointerdown does not) opens the audio path, after a page that
// started without one or audio interrupted by a call, and asks for the wake lock again while there is a camera
for (const type of ["touchend", "click"]) {
  addEventListener(type, () => {
    if (!audio || audio.state !== "running") unlockAudio();
    if (stream && (!wake || wake.released)) keepAwake();
  }, { passive: true, capture: true });
}

renderSound();
renderWelcome();
$("#btn-start").disabled = false;
$("#btn-start").textContent = "Start";
let autostart = false;
try { autostart = sessionStorage.getItem(AUTOSTART_KEY) === "1"; sessionStorage.removeItem(AUTOSTART_KEY); } catch { /* none */ }
// ?autostart=1: straight past the welcome (for driving the page where nothing can tap it, like a simulator)
if (params.get("autostart") === "1") start(true);
else if (autostart && !REPLAY.present) start(false);
if (REPLAY.present && !REPLAY.valid) fail(new Error(`?replay=${REPLAY.raw} is not a usable replay path.`));
