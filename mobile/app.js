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
 * WHAT IT DOES NOT HAVE. OpenFS's second opinion on I, M, N and X (tutor/mix.js SECOND_OPINION): its weights are
 * 16 MB, its licence is non-commercial research only, and it reads the whole trial clip on the main thread at a
 * rejected hold (~3 ms a frame on a laptop, several times that on a phone: a visible freeze). The site is built
 * without them, so loadOpenFS() fails at once and the demo grades exactly as it does whenever OpenFS has not loaded.
 * Its effect on the experts' signs was on M (6 of the 13 signs the fixes changed); none of the three default letters.
 *
 * URL: everything asl-demo.js takes (?letters=, ?reps=, ?hand=left, ?look=outline, ?srcmirror=1, ...), plus
 *      ?fps=1 (frame rate and per-frame cost on the camera view), ?replay=<file.json> (a recorded session instead of
 *      the camera, for tests; js/core/replay.js). */

import exp, { DEFAULT_LETTERS, parseDemoLetters, parseDemoReps, demoPlan } from "../experiments/asl-demo.js";
import { createTracker } from "../js/core/tracker.js";
import { MEDIAPIPE } from "../config.js";
import { runTrialLoop } from "../js/core/trial-loop.js";
import { pictureUrl } from "../tutor/letters.js";
import { replayRequest, loadReplay, createReplay } from "../js/core/replay.js";

const $ = (s) => document.querySelector(s);
const params = new URLSearchParams(location.search);
const HAND = params.get("hand") === "left" ? "left" : "right";
const LOOK = ["outline", "picture", "hand"].includes(params.get("look")) ? params.get("look") : "glove";
const SHOW_PERF = params.get("fps") === "1";
const REPLAY = replayRequest(params);

/* The camera check: the asked-for hand in view this long, and it moves on by itself. */
const CHECK_HOLD_MS = 1000;
const CHECK_DONE_MS = 650;
/* No hand for this long in the camera check: say what usually fixes it. */
const CHECK_HINT_MS = 8000;
const NO_HAND_HINT = "We can't see a hand yet. Move somewhere brighter, and keep your whole hand in the picture.";
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
  const m = UA.match(/\b(FBAN|FBAV|FB_IAB|Instagram|LinkedInApp|Snapchat|TikTok|musical_ly|BytedanceWebview|Line\/|KAKAOTALK|MicroMessenger|Pinterest|Twitter)\b/i);
  if (!m) return null;
  const k = m[1].toLowerCase();
  return k.startsWith("fb") ? "Facebook" : k === "instagram" ? "Instagram" : k === "linkedinapp" ? "LinkedIn" : k.includes("tiktok") || k.includes("musical") || k.includes("bytedance") ? "TikTok" : "this app";
})();
const BROWSER = IOS ? "Safari" : ANDROID ? "Chrome" : "your browser";
/* A phone's front camera never sends a mirror image, so on a phone the other hand in the camera check is just the other
 * hand: it is offered as the hand to use (?hand=left), and the laptop's "flip the camera" offer is not shown. */
const PHONE = IOS || ANDROID;
if (PHONE) document.documentElement.classList.add("is-phone");

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
  $("#setup-title").textContent = `Hold up your ${HAND} hand`;
  if (LOOK === "glove") {
    try {
      const g = await (await fetch("assets/gloves/gloves.json")).json();
      gloveLetters = new Set(Object.keys(g.letters ?? {}));
    } catch { /* no gloves: the outline everywhere */ }
  }
  const withGlove = UNIQUE.filter((c) => gloveLetters.has(c));
  $("#step-shape").textContent = withGlove.length === UNIQUE.length ? "glove" : withGlove.length ? "glove or outline" : "outline";
  $("#welcome-lede").textContent = `Make each letter with your ${HAND} hand. Your camera checks your handshape and shows you what to change, as you go.`;
  const hero = $("#hero");
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
async function download(url, bytes) {
  const res = await fetch(url);
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
  const reader = res.body.getReader();
  const parts = [];
  let got = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    got += value.byteLength;
    progressOf.set(url, [Math.min(got, bytes), bytes]);
    let a = 0, b = 0;
    for (const [x, y] of progressOf.values()) { a += x; b += y; }
    setLoad(0.9 * (a / b), "Getting the hand tracker ready…");
  }
  const out = new Uint8Array(got);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.byteLength; }
  return out;
}
const trackerReady = (async () => {
  if (REPLAY.valid) return null;
  let given = {}, blobUrl = null;
  try {
    const { FilesetResolver } = await import(`${CDN}/vision_bundle.mjs`);
    const simd = await FilesetResolver.isSimdSupported();
    const name = `vision_wasm${simd ? "" : "_nosimd"}_internal`;
    progressOf.set(`${CDN}/wasm/${name}.wasm`, [0, simd ? WASM_BYTES.simd : WASM_BYTES.nosimd]);
    progressOf.set(MEDIAPIPE.models.hand, [0, MODEL_BYTES]);
    const [wasm, model] = await Promise.all([
      download(`${CDN}/wasm/${name}.wasm`, simd ? WASM_BYTES.simd : WASM_BYTES.nosimd),
      download(MEDIAPIPE.models.hand, MODEL_BYTES),
    ]);
    blobUrl = URL.createObjectURL(new Blob([wasm], { type: "application/wasm" }));
    given = { fileset: { wasmLoaderPath: `${CDN}/wasm/${name}.js`, wasmBinaryPath: blobUrl }, modelAssetBuffer: model };
  } catch (err) {
    console.warn(`mobile: download failed, the tracker will fetch its own files (${err?.message || err})`);
  }
  setLoad(0.93, "Starting the hand tracker…");
  const tracker = await createTracker(exp.tracker ?? "hand", { ...(exp.trackerOptions ?? {}), ...given });
  if (blobUrl) URL.revokeObjectURL(blobUrl);
  stats.delegate = tracker.delegate;
  await warmUp(tracker);
  setLoad(1, "Ready");
  if (SHOW_PERF) $("#loadline-text").textContent = `Hand tracker ready: ${tracker.delegate}${stats.warm ? ", warmed up" : ""}`;
  else $("#loadline").classList.add("loadline-done");
  return tracker;
})();
trackerReady.catch(() => {});

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
exp.mount($("#exp-mount"), { participant: {}, demographics: {}, condition: null, video: { width: CAMERA.height, height: CAMERA.width, aspect: 0.75 } });
/* The letter with its ring and the letter's picture go ON the camera view (outside the mirrored box, so they read the
 * right way round). The tutor keeps its own references to these nodes, so moving them changes nothing it does. */
const hud = $("#hud");
const cueWrap = $("#exp-mount .tutor-cue-wrap");
const reference = $("#tutor-reference");
if (cueWrap) hud.append(cueWrap);
if (reference) hud.append(reference);
const firstTrial = planError ? Promise.reject(planError) : exp.nextTrial(0);
firstTrial.catch(() => {});

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
  b.setAttribute("aria-label", soundOn ? "Sound is on" : "Sound is off");
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
  try { await video.play(); } catch { /* autoplay of a muted inline video is allowed; play() can still reject once */ }
  for (let i = 0; i < 100 && !(video.videoWidth > 0); i++) await new Promise((r) => setTimeout(r, 50));
  if (!(video.videoWidth > 0)) throw new CameraError("NoFrames");
  stats.video = { w: video.videoWidth, h: video.videoHeight, settings: track?.getSettings?.() ?? null };
}
function stopCamera() {
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  video.srcObject = null;
}
let resuming = null;
function resumeCamera() {
  resuming ??= (async () => {
    try {
      const track = stream?.getVideoTracks()[0];
      if (!track || track.readyState === "ended") { stopCamera(); await openCamera(); layout(); }
      else if (video.paused) await video.play().catch(() => {});
    } catch (err) {
      fail(err);
    } finally { resuming = null; }
  })();
  return resuming;
}

/* ---- one new camera frame at a time ------------------------------------------------------------------------------ */
/* With requestVideoFrameCallback each camera frame is flagged once, as it is shown, and the loop (on the screen's
 * repaints, like the laptop's) processes it once. The laptop's own test -- has the media time moved? -- is true on
 * nearly every repaint (measured in Chrome: 283 of 285 repaints with a 30 fps camera), so it re-tracks each picture
 * about twice. It is still the test whenever the callback has not fired for a second (before the first one, after the
 * page was blocked, or a browser where it goes quiet), and the callback takes over again as soon as it fires. A replay
 * has no pictures: one recorded frame per tick of its own frame rate, as js/core/experiment.js does. */
const VFC_QUIET_MS = 1000;
/* Set when the error page goes up: the frame loops stop where they are (the page is reloaded to go on). */
let halted = false;
function createClock(src, replayFps = null) {
  if (replayFps) {
    const ms = 1000 / replayFps;
    return { hasNew: () => true, done() {}, next: () => new Promise((r) => setTimeout(r, ms)) };
  }
  let seq = 0, doneSeq = 0, lastTime = -1, vfcAt = -Infinity;
  // ?vfc=0: the laptop's test only (for comparing the two hosts frame for frame)
  if (typeof src.requestVideoFrameCallback === "function" && params.get("vfc") !== "0") {
    const arm = () => src.requestVideoFrameCallback(() => { seq++; vfcAt = performance.now(); arm(); });
    arm();
  }
  return {
    hasNew: () => (performance.now() - vfcAt < VFC_QUIET_MS ? seq !== doneSeq : src.currentTime !== lastTime),
    done() { doneSeq = seq; lastTime = src.currentTime; },
    next: () => (halted ? new Promise(() => {}) : new Promise((r) => requestAnimationFrame(() => r()))),
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
  // the drawing at up to 2 canvas pixels per camera pixel: crisp lines on a phone screen without a huge canvas
  const k = Math.max(1, Math.min(2, (w * (window.devicePixelRatio || 1)) / srcW));
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
function track() {
  const t0 = performance.now();
  const res = tracker.track(src, performance.now());
  const vi = sourceSize(src);
  if (canvas.width / canvas.height > 1 !== vi.aspect > 1 || Math.abs(canvas.width / canvas.height - vi.aspect) > 0.01) layout();
  stats.trackMs.push(performance.now() - t0);
  if (stats.trackMs.length > 600) stats.trackMs.splice(0, 300);
  stats.frames++;
  return { res, vi };
}

/* ---- the camera check: the asked-for hand in view for a moment, then straight on ---------------------------------- */
async function cameraCheck() {
  phase("setup");
  const status = $("#setup-status");
  let since = null, lastHandAt = performance.now();
  for (;;) {
    if (clock.hasNew()) {
      clock.done();
      const { res, vi } = track();
      const k = handIndex(res, vi);
      const lm = k >= 0 ? res.landmarks[k] : null;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      exp.draw(ctx, { landmarks: lm, canvas, trial: null, tMs: 0 });
      let objection = null;
      if (k >= 0) {
        try { objection = exp.handProblem?.(res, k, { aspect: vi.aspect, demographics: {} }) ?? null; }
        catch (err) { console.warn("handProblem failed; letting the hand pass", err); }
      }
      const seen = k >= 0 && !objection;
      if (seen && since === null) since = performance.now();
      if (!seen) since = null;
      const held = since === null ? 0 : performance.now() - since;
      if (held >= CHECK_HOLD_MS) {
        status.textContent = "Great, let's start!";
        status.className = "setup-status good";
        break;
      }
      if (seen || objection) lastHandAt = performance.now();
      const lost = performance.now() - lastHandAt > CHECK_HINT_MS;
      status.textContent = objection ?? (seen ? "Hold it there…" : lost ? NO_HAND_HINT : "Hold it up in front of the camera, where you can see it on screen.");
      status.className = `setup-status${objection ? " bad" : seen ? " good" : ""}`;
      if (objection) otherHandOffer.hidden = false;
    }
    await clock.next();
  }
  await new Promise((r) => setTimeout(r, CHECK_DONE_MS));
}

/* "I sign with my left hand": the same link with ?hand= switched, straight back into the camera check. */
const OTHER = HAND === "right" ? "left" : "right";
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
  $("#progress").setAttribute("aria-valuenow", String(doneCount));
}
async function recordTrial(trial, state) {
  const durationMs = (trial.durationSec ?? 15) * 1000;
  const { endReason } = await runTrialLoop({
    durationMs,
    now: () => performance.now(),
    nextFrame: () => clock.next(),
    hasNewFrame: () => clock.hasNew(),
    step: (tMs, endTrial) => {
      clock.done();
      endCurrent = endTrial;
      const { res, vi } = track();
      const t1 = performance.now();
      const k = handIndex(res, vi);
      const lm = k >= 0 ? res.landmarks[k] ?? null : null;
      const wl = k >= 0 ? res.worldLandmarks[k] ?? null : null;
      const handedness = k >= 0 ? res.handedness[k] ?? null : null;
      const handednessScore = k >= 0 ? res.handednessScore?.[k] ?? null : null;
      const derived = exp.onFrame?.({ landmarks: lm, worldLandmarks: wl, handedness, handednessScore, tMs, trial, state, addEvent: noop, endTrial, video: vi }) ?? {};
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      exp.draw(ctx, { landmarks: lm, derived, state, trial, canvas, tMs, setReadout: noop });
      stats.tutorMs.push(performance.now() - t1);
      if (stats.tutorMs.length > 600) stats.tutorMs.splice(0, 300);
    },
  });
  endCurrent = null;
  return endReason;
}
async function practice() {
  phase("practice");
  $("#practice-actions").hidden = false;
  practising = true;
  keepAwake();
  let i = 0;
  let trial = await firstTrial;
  while (trial) {
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
  new MutationObserver(() => {
    cue.classList.remove("cue-in");
    void cue.offsetWidth;
    cue.classList.add("cue-in");
  }).observe(cue, { childList: true, characterData: true, subtree: true });
}

/* ---- the end ----------------------------------------------------------------------------------------------------- */
const CHECK_SVG = `<svg viewBox="0 0 24 24"><path d="M5 12.5l4.5 4.5L19 7.5"/></svg>`;
const DASH_SVG = `<svg viewBox="0 0 24 24"><path d="M7 12h10"/></svg>`;
function finish() {
  stopCamera();
  const rows = stats.summaries;
  const made = rows.filter((r) => r.correct).length;
  const all = rows.length;
  $("#results-title").textContent = made === all && all ? "Nice work!" : made ? "Good practice!" : "Keep at it!";
  $("#results-lede").textContent = `You made ${made} of ${all} letter${all === 1 ? "" : "s"}.`;
  const trophy = $("#trophy");
  trophy.className = `trophy${made === all ? "" : " trophy-partial"}`;
  const colors = ["#1e9e6a", "#f5a524", "#38bdf8", "#a78bfa", "#f472b6", "#34d399"];
  trophy.innerHTML = `<div class="trophy-disc">${made ? CHECK_SVG : `<svg viewBox="0 0 24 24"><path d="M8 13.5c1-1.3 2.4-2 4-2s3 .7 4 2"/><path d="M9 9h.01M15 9h.01"/></svg>`}</div>`
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
    return { title: "Allow the camera", body: `<p>The camera is how the app sees your hand. Nothing is recorded or sent anywhere.</p>${browserSteps}` };
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
  if (/Could not load the|Failed to fetch|NetworkError|Load failed|network/i.test(String(err?.message || ""))) {
    return { title: "Couldn't load the lesson", body: `<p>Part of the app didn't download. Check your connection, then try again.</p>
      <p class="fineprint">${String(err?.message || err).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</p>` };
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
  try { wake = await navigator.wakeLock?.request("screen"); } catch { wake = null; }
}
function releaseAwake() { try { wake?.release(); } catch { /* already gone */ } wake = null; }
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState !== "visible") return;
  if (practising) { keepAwake(); if (!REPLAY.valid) resumeCamera(); }
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
async function start() {
  if (started) return;
  started = true;
  unlockAudio();
  if (planError) return fail(planError);
  show("practice");
  phase("setup");
  layout();
  try {
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
      stageMessage("Starting your camera…");
      $("#setup-status").textContent = "Starting your camera…";
      await openCamera();
      sourceSize(video);
      layout();
      if (stats.loaded < 1) { stageWaiting = "tracker"; setLoad(stats.loaded); }
      $("#setup-status").textContent = "Loading the hand tracker…";
      tracker = await trackerReady;
      stageWaiting = null;
      stageMessage(null);
      clock = createClock(video);
      await cameraCheck();
    }
    let ready = false;
    firstTrial.then(() => { ready = true; }, () => { ready = true; });
    await new Promise((r) => setTimeout(r, 0));
    if (!ready) stageMessage("Getting your first letter ready…");
    await firstTrial;
    stageMessage(null);
    await practice();
  } catch (err) {
    fail(err);
  }
}

$("#btn-start").addEventListener("click", start);
$("#btn-skip").addEventListener("click", () => endCurrent?.("skipped"));
$("#btn-close").addEventListener("click", () => { $("#quit-sheet").hidden = false; $("#btn-keep").focus(); });
$("#btn-keep").addEventListener("click", () => { $("#quit-sheet").hidden = true; });
$("#quit-sheet").addEventListener("click", (e) => { if (e.target === e.currentTarget) $("#quit-sheet").hidden = true; });
$("#btn-quit").addEventListener("click", () => { stopCamera(); location.reload(); });
$("#btn-sound").addEventListener("click", () => {
  soundOn = !soundOn;
  try { localStorage.setItem(SOUND_KEY, soundOn ? "on" : "off"); } catch { /* this visit only */ }
  renderSound();
  if (soundOn) { unlockAudio(); chime("made"); }
});
$("#btn-again").addEventListener("click", () => {
  try { sessionStorage.setItem(AUTOSTART_KEY, "1"); } catch { /* the welcome again, then */ }
  location.reload();
});
$("#btn-retry").addEventListener("click", () => location.reload());
async function copyLink() {
  const url = location.href;
  try { await navigator.clipboard.writeText(url); toast("Link copied"); }
  catch { window.prompt("Copy this link:", url); }
}
$("#btn-copy").addEventListener("click", copyLink);
$("#btn-copy-inapp").addEventListener("click", copyLink);
$("#btn-share").addEventListener("click", async () => {
  const url = location.origin + location.pathname + location.search.replace(/([?&])srcmirror=1&?/, "$1").replace(/[?&]$/, "");
  if (navigator.share) {
    try { await navigator.share({ title: "Fingerspelling practice", text: "Practice fingerspelling with your phone's camera.", url }); return; }
    catch (err) { if (err?.name === "AbortError") return; }
  }
  try { await navigator.clipboard.writeText(url); toast("Link copied"); }
  catch { window.prompt("Copy this link:", url); }
});

/* The camera-flip offer (asl-demo.js showFlipOffer) reloads the page with ?srcmirror=1: carry on straight into the
 * camera check rather than back to the welcome screen. Set in the capture phase, before the offer's own handler. */
document.addEventListener("click", (e) => {
  if (e.target?.closest?.(".demo-flip-btn")) { try { sessionStorage.setItem(AUTOSTART_KEY, "1"); } catch { /* welcome again */ } }
}, true);
// the first tap anywhere opens the audio path (a page started without a tap, or audio interrupted by a call)
addEventListener("pointerdown", () => { if (!audio || audio.state !== "running") unlockAudio(); }, { passive: true });

renderSound();
renderWelcome();
$("#btn-start").disabled = false;
$("#btn-start").textContent = "Start";
let autostart = false;
try { autostart = sessionStorage.getItem(AUTOSTART_KEY) === "1"; sessionStorage.removeItem(AUTOSTART_KEY); } catch { /* none */ }
// ?autostart=1: straight past the welcome (for driving the page where nothing can tap it, like a simulator)
if ((autostart && !REPLAY.present) || params.get("autostart") === "1") start();
if (REPLAY.present && !REPLAY.valid) fail(new Error(`?replay=${REPLAY.raw} is not a usable replay path.`));
