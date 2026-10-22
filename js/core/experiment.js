/* experiment.js: the runner.
 *
 * You should not need to change this file to build a new experiment. It takes
 * an experiment definition (see experiments/_template.js) and walks the
 * participant through: consent -> camera -> instructions -> trials -> upload.
 *
 * THE FRAME LOOP, in one paragraph:
 * Every time the browser paints (~60x per second), we check whether the webcam
 * has produced a new picture. If it has, we send it to MediaPipe, get back the
 * hand landmarks, hand them to your experiment's onFrame(), store the frame,
 * and let your draw() paint the overlay. Frames where no hand was visible are
 * still stored, as nulls, so gaps in your data stay visible instead of silently
 * disappearing. */

import { STUDY, CONSENT, SCREENS, RECORDING, ACTIVE_EXPERIMENT } from "../../config.js";
import { DEMOGRAPHIC_QUESTIONS, POST_QUESTIONS } from "../../questions.js";
import { renderForm, readForm, focusField } from "./form.js";
import { startCamera, stopCamera } from "./camera.js";
import { createTracker } from "./tracker.js";
import { Recorder } from "./recorder.js";
import { runTrialLoop } from "./trial-loop.js";
import { makeTrialSource } from "./trial-source.js";
import { uploadWithOneRetry } from "./upload-retry.js";
import * as fb from "./firebase.js";
import { getParticipant, getEnvironment, requestedExperiment, requestedReplay } from "./participant.js";
import { createReplay, loadReplay, replayPathComplaint, startAutorun, stopAutorun,
         markE2eDone, markE2eError } from "./replay.js";
import * as ui from "./ui.js";

const SPACE = SCREENS?.spaceToContinue === true;
const SPACE_LABEL = "Press space to continue";

export async function main() {
  const name = requestedExperiment(ACTIVE_EXPERIMENT);

  let exp;
  try {
    exp = (await import(`../../experiments/${name}.js`)).default;
  } catch (err) {
    return fail(
      `Could not load the experiment "${name}".`,
      `Check that experiments/${name}.js exists and has no syntax errors. ` +
      `Original error: ${err.message}`
    );
  }

  try {
    await run(exp);
  } catch (err) {
    fail("Something went wrong.", err?.message || String(err));
  }
}

/* One way out for every fatal error. The participant gets the error screen; an
 * unattended run (tools/e2e-smoke.sh) also gets data-e2e="error" with the
 * message in it, so a run that breaks FAILS the smoke test instead of quietly
 * running out of time.
 *
 * The marker is written ONLY under ?autorun=1. Test scaffolding has no business
 * on a participant's page: someone whose camera failed should leave behind an
 * error screen, not an error screen plus a machine-readable report nobody asked
 * for. The smoke test does not depend on this alone -- it checks the error
 * screen's visibility separately -- so gating it costs no detection. */
function fail(message, detail = "") {
  stopAutorun();
  ui.fatal(message, detail);
  // Read from the URL rather than passed in: a fatal can happen before the run
  // has worked out anything at all, and this is the same answer either way.
  if (requestedReplay().autorun) markE2eError(message, detail);
}

async function run(exp) {
  const participant = getParticipant();
  const startedAt = new Date().toISOString();

  /* ---- 0. Replay mode ----------------------------------------------------
   * ?replay=<file> feeds recorded landmarks through this same page instead of
   * a camera, and ?autorun=1 (only ever honored alongside it) ticks and clicks
   * its way through the run. Everything downstream of the tracker is the code
   * a participant runs, which is the entire point: see js/core/replay.js.
   * The file is fetched before the consent screen so that a bad path fails
   * immediately rather than after somebody has agreed to take part. */
  const replay = requestedReplay();

  /* A `?replay=` that is there but unusable stops the run. Carrying on would
   * start the CAMERA instead, which is the opposite of what whoever typed that
   * link believed they were doing -- and if Firebase is configured, that
   * session uploads. A participant's link never carries `replay=`, so nobody
   * loses anything by this being strict. */
  if (replay.present && !replay.valid) {
    return fail("This link is not usable.", replayPathComplaint(replay.raw));
  }

  // Phones cannot do this task (it needs a webcam and a screen big enough for
  // the camera beside the letter). Prolific's desktop-only filter is the
  // first line; this is the second, for anyone who gets past it.
  const isPhone = typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches
    && Math.min(screen.width, screen.height) < 700;
  if (!replay.path && isPhone) {
    const h = document.querySelector("#screen-error h2");
    if (h) { h.textContent = "This study needs a computer"; h.classList.remove("bad"); }
    return fail("Please use a laptop or desktop computer.",
      "This study needs a webcam and a larger screen, so it can't be done on a phone. Open the same link on a computer to take part.");
  }

  const replayData = replay.path ? await loadReplay(replay.path) : null;
  if (replay.autorun) {
    startAutorun({ onError: (err) => fail("The unattended run could not continue.", err?.message || String(err)) });
  }

  // Flag demo mode up front, before the consent screen: someone should know
  // that nothing is being recorded *before* they agree to anything.
  if (replayData) {
    // A replay is not a participant, so nothing it produces is participant
    // data and nothing is uploaded even when Firebase IS configured. This
    // banner says so, and it replaces the demo one rather than sitting next to
    // it: two banners about the same fact is one too many.
    ui.$("#replay-banner").hidden = false;
    ui.setText("#replay-file", `${replay.path} (${replayData.frames.length} frames)`);
    console.warn(`Replay mode: playing ${replay.path}. The camera is not used and nothing is saved.`);
  } else if (fb.configLooksUnfilled()) {
    if (SCREENS.demoBanner !== false) ui.$("#demo-banner").hidden = false;
    console.warn(
      "Demo mode: Firebase is not configured, so nothing will be saved. " +
      "Fill in FIREBASE in config.js to collect data (see docs/SETUP.md)."
    );
  }

  /* ---- 1. Consent -------------------------------------------------------
   * The consent document comes first, before anything else happens and before
   * the camera is touched. Each statement in CONSENT.affirmations has to be
   * ticked, and which ones were agreed to is stored with the session. */
  ui.setText("#study-title", STUDY.title);
  ui.setText("#study-lab", STUDY.labName);
  if (!STUDY.labName) ui.$("#study-lab").hidden = true;
  ui.setHtml("#consent-intro", STUDY.consentIntroHtml ?? "");
  ui.setText("#experiment-title", exp.title);
  // The same words twice, one under the other, is just an echo: show the
  // experiment's title only when it says something the study title doesn't.
  if (!exp.title || exp.title.trim() === String(STUDY.title ?? "").trim()) ui.$("#experiment-title").hidden = true;

  if (CONSENT.pdf) {
    ui.$("#consent-doc").src = CONSENT.pdf;
    ui.$("#consent-download").href = CONSENT.pdf;
  } else {
    ui.$("#consent-doc-wrap").hidden = true;
  }

  // SCREENS.consent (config.js) turns the whole screen off. The session record
  // then says so in as many words: a record with an empty `agreedTo` and no
  // explanation would read as somebody who was asked and ticked nothing.
  let consentRecord;
  if (SCREENS?.consent === false) {
    consentRecord = { skipped: true, document: null, agreedTo: [], agreedAt: null };
  } else {
    const agreed = await collectConsent(CONSENT.affirmations ?? []);
    consentRecord = {
      document: CONSENT.pdf ?? null,
      agreedTo: agreed,
      agreedAt: new Date().toISOString(),
    };
  }

  /* ---- 2. Demographics ---------------------------------------------------
   * Built from questions.js. Edit that file to change what is asked. */
  let demographics = {};
  // An experiment may ask its own list instead (asl-study's expert link does).
  const demographicQuestions = exp.demographicQuestions ?? DEMOGRAPHIC_QUESTIONS;
  if (SCREENS?.demographics !== false && demographicQuestions.length) {
    const formEl = ui.$("#demographics-form");
    // (A "Your Prolific ID" box for links that arrived without one was asked
    // here during the Prolific runs; removed 2026-09-28 before sharing the
    // link with other researchers.)
    const questions = demographicQuestions;
    renderForm(formEl, questions, {});
    ui.showScreen("screen-demographics");

    while (true) {
      await ui.waitForClick("#btn-demographics");
      const { ok, values, firstError } = readForm(formEl, questions);
      if (ok) { demographics = values; break; }
      focusField(formEl, firstError);
    }
  }

  // A question with id "participantId" doubles as the participant's ID.
  if (!participant.participantId) {
    participant.participantId = demographics.participantId?.trim()
      || `anon_${Math.random().toString(36).slice(2, 8)}`;
    // Typed in by hand rather than read from the link: say so in the data.
    if (demographics.participantId) participant.source = "typed-prolific-id";
  }

  /* ---- 2. Firebase (optional) ------------------------------------------ */
  // If config.js has not been filled in, the study still runs, it just does
  // not save. That keeps the live demo usable by anyone who clicks the link.
  // A replay skips this section outright: never connecting is the only version
  // of "do not upload this" that cannot be got wrong later.
  let saving = false;
  if (!replayData) {
    ui.showScreen("screen-loading");
    ui.setText("#loading-text", "Connecting…");
    ({ enabled: saving } = await fb.initFirebase());
  }
  if (saving && consentRecord.skipped) {
    console.warn(
      "Consent is switched OFF (SCREENS.consent in config.js) and this session IS being saved. " +
      "That is fine for your own piloting; turn consent back on before anyone else takes part."
    );
  }
  const sessionId = fb.newSessionId();

  /* ---- 2b. Screening (optional) ------------------------------------------
   * An experiment may check, before the camera starts, that this person is who
   * the study is for (asl-study: the ASL check on the Prolific expert link,
   * experiments/sign-quiz.js). exp.screening() returns null when it does not
   * apply, or a record with `passed`. Someone who does not pass is thanked and
   * stops here: their questionnaire and answers are saved, nothing else is
   * recorded, and the camera is never turned on. A replay is nobody, so it
   * skips this. */
  let screening = null;
  if (!replayData && typeof exp.screening === "function") {
    screening = await exp.screening({
      participant, demographics,
      root: ui.$("#screening-body"),
      show: () => ui.showScreen("screen-screening"),
      form: { renderForm, readForm, focusField },
    });
    if (screening && screening.passed === false) {
      return screenedOut({ exp, participant, startedAt, consentRecord, demographics, screening, sessionId, saving });
    }
  }

  /* ---- 2c. Questions before the task (optional) -------------------------
   * An experiment may ask a few questions after the screening and before the
   * camera (asl-study's expert link: how they learned to fingerspell, to set
   * them thinking about learning before they see the tutor). Saved under
   * `preTaskQuestionnaire`. */
  let preTaskQuestionnaire = null;
  const preTaskQuestions = exp.preTaskQuestions ?? [];
  if (preTaskQuestions.length) {
    const formEl = ui.$("#pretask-form");
    renderForm(formEl, preTaskQuestions, {});
    ui.showScreen("screen-pretask");
    while (true) {
      await ui.waitForClick("#btn-pretask");
      const { ok, values, firstError } = readForm(formEl, preTaskQuestions);
      if (ok) { preTaskQuestionnaire = values; break; }
      focusField(formEl, firstError);
    }
  }

  /* ---- 3. Camera + tracker --------------------------------------------- */
  let video, tracker;
  if (replayData) {
    // The recording stands in for both: a <div> with a video's three
    // properties, and a tracker that hands out the file's landmarks one frame
    // per call. Nothing downstream can tell the difference.
    ({ video, tracker } = createReplay(replayData));
  } else {
    ui.setText("#loading-text", "Starting your camera…");
    video = await startCamera(RECORDING.video);

    ui.setText("#loading-text", "Loading the hand tracking model (a few MB, first visit only)…");
    tracker = await createTracker(exp.tracker ?? "hand", exp.trackerOptions ?? {});
    if (tracker.delegate === "CPU") {
      ui.$("#cpu-banner").hidden = false;
    }
  }

  const stage = ui.$("#stage");
  const canvas = ui.$("#overlay");
  stage.querySelector(".mirror").prepend(video);
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext("2d");
  stage.hidden = false;

  /* The camera's REAL frame size, which is not always the size asked for in
   * config.js: the browser gives you something close to what you requested.
   * Anything that turns landmarks into angles needs the true aspect ratio,
   * because MediaPipe measures x across the width and y down the height, so a
   * guessed ratio quietly distorts every angle. It is computed once here and
   * handed to the experiment (onFrame, mount) and stored with the session, so
   * nobody downstream has to guess either. */
  const videoInfo = {
    width: video.videoWidth,
    height: video.videoHeight,
    aspect: video.videoWidth / video.videoHeight,
  };

  // The experiment's objection to the hand in view, if it has one (the ASL
  // study: the other hand). Shared by the camera check and the re-check below.
  const handObjection = (res, k) => {
    try { return exp.handProblem?.(res, k, { aspect: videoInfo.aspect, demographics }) ?? null; }
    catch (err) { console.warn("handProblem failed; letting the hand pass", err); return null; }
  };

  /* ---- 4. Positioning check -------------------------------------------- */
  // A live preview with the landmarks drawn on top. Participants fix their own
  // lighting and framing here, which is far more effective than instructions.
  //
  // A replay skips it: there is nothing to aim, and the preview tracks frames
  // of its own, which would eat the start of the recording before the first
  // trial ever began. The stage still has to be moved into the trial screen,
  // which is the other thing positioningLoop does.
  if (replayData) {
    ui.$("#trial-stage-slot").append(stage);
  } else {
    ui.showScreen("screen-position");
    // An experiment can word the camera check itself (the study names the
    // hand to use here, since its instructions page is off).
    const positionText = exp.positionText?.({ demographics });
    if (positionText) ui.setText("#position-text", positionText);
    if (SPACE) ui.setText("#btn-position-done", SPACE_LABEL);
    await positioningLoop(video, tracker, ctx, canvas, stage, (res) => handIndex(exp, res, videoInfo, demographics), handObjection);
  }

  /* ---- 5. Instructions -------------------------------------------------- */
  // May be a function of the questionnaire answers (the study words its
  // instructions around the participant's dominant hand).
  // Off in config.js SCREENS.instructions: the task starts straight after the
  // camera check. An experiment's own showInstructions (a boolean) wins: the
  // study's expert mode has nothing else that says what to do.
  if (typeof exp.showInstructions === "boolean" ? exp.showInstructions : SCREENS?.instructions !== false) {
    ui.setHtml("#instructions-text", (typeof exp.instructions === "function" ? exp.instructions({ demographics, participant }) : exp.instructions) ?? "");
    if (SPACE) ui.setText("#btn-start", SPACE_LABEL);
    ui.showScreen("screen-instructions");
    await ui.waitForContinue("#btn-start", { space: SPACE });
  }

  /* ---- 6. Trials -------------------------------------------------------- */
  // A fixed list (finger tapping, the feature probe) or trials chosen one at a
  // time by exp.nextTrial (a tutor, which cannot know the next letter until it
  // has seen how the last one went). Both look the same to the loop below; see
  // js/core/trial-source.js.
  const trialSource = makeTrialSource(exp);

  /* What "wait, then look again" means between frames. A camera run waits for
   * the next repaint, because a new picture can only have arrived by then. A
   * replay has no pictures to wait for, and a headless browser may repaint
   * slowly or never, so it ticks on a timer instead. Same loop either way,
   * see js/core/trial-loop.js. */
  /* A replay ticks at the RECORDING's own frame interval, not as fast as the
   * timer will go. It used to use setTimeout(…, 0), and that was wrong in a
   * way nothing noticed until an experiment cared about time: the page's clock
   * (performance.now, which is what tMs is) then advanced by one timer clamp
   * per frame -- about 4 ms in headless Chrome -- so a 90-frame recording of
   * three real seconds played back as a third of a second of tMs. Anything
   * measuring a DURATION from a replay measured the browser's timer clamp
   * instead: a hold-still ring that wants 600 ms never filled, a trial's
   * durationSec cap covered thousands of frames, and a rate in Hz came out ten
   * times too fast. One frame per fps interval makes a replayed second a
   * second, and under --virtual-time-budget it still costs no real time. */
  const replayFrameMs = replayData ? 1000 / replayData.fps : 0;
  const waitForFrame = replayData ? () => new Promise((r) => setTimeout(r, replayFrameMs)) : nextFrame;

  const recorder = new Recorder();
  const trialSummaries = [];
  /* What each trial's own onTrialEnd() returned, kept apart from the merged
   * summary above so the unattended run can report the experiment's numbers
   * separately from the runner's. Never uploaded; see markE2eDone below. */
  const experimentSummaries = [];
  const demoFrames = [];    // only used when nothing is being uploaded

  /* Uploads that were started but not waited for (trial.backgroundUpload), and
   * the ones that failed twice. Both are dealt with before the session document
   * is written, further down. */
  const pendingUploads = [];
  const uploadErrors = [];

  /* An optional slot in the trial screen for the experiment's own HTML. A task
   * that needs more than the video and a line of text (a table of live numbers,
   * a target letter, a picture to copy) builds it here, once, and updates it
   * from onFrame. It sits OUTSIDE the mirrored part of the stage, so text in it
   * reads the right way round. An experiment with no mount() never un-hides it
   * and the trial screen looks exactly as it always did. */
  if (exp.mount) {
    const mountEl = ui.$("#exp-mount");
    mountEl.hidden = false;
    exp.mount(mountEl, {
      participant,
      demographics,
      condition: participant.condition,
      video: videoInfo,
    });
  }

  // The first trial has to be fetched before the loop can even start; every
  // later one is fetched at the bottom of the loop body, one trial ahead of
  // where the loop is (see the "look ahead" comment below for why).
  let i = 0;
  let trial = await trialSource.next(trialSummaries);

  while (trial) {
    const trialId = trial.id ?? `trial_${i}`;
    const state = exp.onTrialStart?.(trial, { tracker }) ?? {};

    ui.showScreen("screen-trial");
    ui.setProgress(i + 1, trialSource.total);
    ui.setHtml("#trial-prompt", trial.prompt ?? exp.trialPrompt ?? "");
    ui.setHtml("#live-readout", "");

    // countdownSec: 0 skips the countdown entirely (not a zero-length one).
    // Three seconds of "3, 2, 1, GO" before each of forty short trials is most
    // of the session; a tutor sets this to 0 and keeps the participant moving.
    const countdownSec = trial.countdownSec ?? 3;
    if (countdownSec > 0) await ui.countdown(countdownSec);

    recorder.reset();
    const endReason = await recordTrial({
      video, videoInfo, tracker, ctx, canvas, exp, trial, state, recorder,
      waitForFrame, pick: (res) => handIndex(exp, res, videoInfo, demographics),
    });

    const summary = exp.onTrialEnd?.({
      frames: recorder.frames, events: recorder.events, trial, state, endReason,
    }) ?? {};
    experimentSummaries.push(summary);

    trialSummaries.push({
      index: i,
      id: trialId,
      ...trial,
      frameCount: recorder.frames.length,
      detectionRate: round(recorder.detectionRate(), 4),
      events: recorder.events,
      ...summary,
      // Why this trial stopped: "duration" when the timer ran out, otherwise
      // whatever the experiment passed to endTrial(). Worth having: a trial
      // that ended because the sign was accepted and one that ended because
      // time ran out mean very different things in the analysis.
      //
      // LAST, after ...summary, on purpose. An onTrialEnd that returns an
      // endReason of its own is answering a question it was already given the
      // answer to (endReason is handed to it above), and letting that answer
      // overwrite this one would put a reason on the record that the trial did
      // not actually end for -- including "duration" on a trial that was
      // stopped early, which is the one confusion endTrial's own reserved-word
      // check exists to prevent.
      endReason,
    });

    if (saving) {
      /* Upload straight away, so someone who quits mid-study still leaves data. */
      const chunks = recorder.toChunks();
      // The trial's summary and events ride on its LAST chunk, and the
      // questionnaire on trial 0's: the session document is written only at
      // the very end, and the first two pilots (2026-09-22) both stopped
      // early and kept nothing but landmarks.
      const meta = {
        experimentId: exp.id, trialId,
        trialSummary: trialSummaries[trialSummaries.length - 1],
        ...(i === 0 ? { early: { participantId: participant.participantId, demographics, consent: consentRecord, startedAt, ...(screening ? { screening } : {}), ...(preTaskQuestionnaire ? { preTaskQuestionnaire } : {}) } } : {}),
      };

      if (trial.backgroundUpload) {
        // Start the upload and move on without waiting for it. This is what
        // makes dozens of short trials bearable: a two-second sign followed by
        // a four-second "Saving…" screen is mostly saving. The chunk arrays
        // are the recorder's frame OBJECTS, and reset() replaces the frame
        // array rather than emptying it, so the next trial cannot scribble on
        // an upload that is still in flight.
        // Kept with the trial it belongs to, so that if one of these promises
        // ever rejects (it should not: see uploadInBackground) the record we
        // write can still name the trial it was for.
        pendingUploads.push({
          trialIndex: i,
          trialId,
          promise: uploadInBackground(sessionId, i, chunks, meta, uploadErrors),
        });
      } else {
        ui.showScreen("screen-saving");
        await fb.uploadTrialChunks(
          sessionId, i, chunks, meta,
          (done, total) => ui.setText("#saving-text", `Saving… ${done}/${total}`)
        );
      }
    } else {
      // Nowhere to upload to, so hold onto the frames and offer them as a
      // download at the end. The file matches what fetch_data.py produces, so
      // it can go straight into the Python analysis. Note this happens whether
      // or not the trial asked for a background upload: in demo mode there is
      // nothing to upload in the background.
      demoFrames[i] = recorder.frames.slice();
    }

    /* Ask what comes next now -- with this trial's own summary already on
     * trialSummaries (pushed above) -- and BEFORE deciding on the rest screen.
     * A lazy source has no way to answer "is this the last trial?" without
     * looking ahead, so the loop fetches trial i+1 here and uses whether it
     * exists as that answer. This also means nextTrial(i+1, summariesSoFar) is
     * called after trial i's summary has been recorded, which is exactly what
     * an adaptive experiment (a tutor deciding the next letter) wants: it sees
     * how the trial that just happened went before it has to choose the next
     * one. For a fixed trials array this simply asks for trials[i+1], which is
     * already known, so it changes nothing about the order or timing of what
     * an array-based experiment does. */
    /* The experiment can ask for the camera check again between trials (the
     * ASL study: several holds in a row with the other hand). Not in a replay:
     * there is no one to hold anything up. */
    if (!replayData && exp.needsHandCheck?.()) {
      const t = exp.handCheckText?.({ demographics }) ?? {};
      ui.setText("#position-heading", t.heading ?? "Let's check your camera");
      if (t.text) ui.setText("#position-text", t.text);
      ui.showScreen("screen-position");
      await positioningLoop(video, tracker, ctx, canvas, stage, (res) => handIndex(exp, res, videoInfo, demographics), handObjection);
      exp.handCheckDone?.();
    }

    const upcoming = await trialSource.next(trialSummaries);

    // skipRest: no "take a break" screen after this trial. Rest screens exist
    // so people can shake out a tired hand after fifteen seconds of tapping;
    // after a two-second handshape they are just a click in the way.
    if (upcoming && !trial.skipRest) {
      // An experiment may use the break to announce its next part.
      ui.setText("#rest-heading", trial.restHeading ?? "Nice work");
      ui.setHtml("#rest-text", trial.restHtml ?? "<p>Take a short break. Shake out your hand if you'd like.</p>");
      ui.setText("#btn-next-trial", SPACE ? SPACE_LABEL : trial.restButton ?? "Start the next one");
      ui.showScreen("screen-rest");
      ui.setText("#rest-progress", trialSource.total != null
        ? `${i + 1} of ${trialSource.total} done`
        : `${i + 1} done`);
      await ui.waitForContinue("#btn-next-trial", { space: SPACE });
    }

    trial = upcoming;
    i++;
  }

  /* Anything still uploading has to finish before the session document is
   * written, because that document is what marks the session complete (see
   * firebase.js). allSettled, not all: one failed upload must not stop the
   * other trials' data or the session document from being saved. */
  if (pendingUploads.length) {
    ui.showScreen("screen-saving");
    ui.setText("#saving-text", "Finishing saving your data…");
    const settled = await Promise.allSettled(pendingUploads.map((u) => u.promise));
    // uploadInBackground already records its own failures, so a rejection here
    // would mean a bug in that function rather than a network problem. Record
    // it anyway, and keep the trial it belonged to: the one thing we must never
    // do is lose data quietly, and an unattributed error is nearly as bad.
    settled.forEach((s, k) => {
      if (s.status === "rejected") {
        const message = `Unexpected upload failure: ${s.reason?.message || s.reason}`;
        uploadErrors.push({
          trialIndex: pendingUploads[k].trialIndex,
          trialId: pendingUploads[k].trialId,
          message,
          firstMessage: message,
          chunksWritten: null,
          chunkCount: null,
        });
        console.error(message, s.reason);
      }
    });
  }

  /* ---- 6b. Questions after the task -------------------------------------
   * questions.js POST_QUESTIONS, before the results page (so the answers are
   * not coloured by a score). Written into the session document. This screen
   * was specified on 2026-09-21 but the wiring never landed; the first
   * finished session (2026-09-23) went straight to "thank you". */
  let postQuestionnaire = {};
  // An experiment may ask its own list here too (asl-study's expert link does).
  const postQuestions = exp.postQuestions ?? POST_QUESTIONS;
  if (SCREENS?.postQuestions !== false && postQuestions?.length) {
    const formEl = ui.$("#post-form");
    renderForm(formEl, postQuestions, {});
    ui.showScreen("screen-post");
    while (true) {
      await ui.waitForClick("#btn-post");
      const { ok, values, firstError } = readForm(formEl, postQuestions);
      if (ok) { postQuestionnaire = values; break; }
      focusField(formEl, firstError);
    }
  }

  /* ---- 7. Session summary ----------------------------------------------- */
  if (saving) {
    ui.showScreen("screen-saving");
    ui.setText("#saving-text", "Saving your results…");
  }

  const sessionDoc = {
    experimentId: exp.id,
    experimentTitle: exp.title,
    participantId: participant.participantId,
    participantSource: participant.source,
    prolific: participant.prolific,
    condition: participant.condition,
    startedAt,
    consent: consentRecord,
    demographics,
    // The ASL check's record, when the experiment ran one (step 2b).
    ...(screening ? { screening } : {}),
    // Answers asked before the task, when the experiment asks any (step 2c).
    ...(preTaskQuestionnaire ? { preTaskQuestionnaire } : {}),
    postQuestionnaire,
    trials: trialSummaries,
    // How trials were chosen: "list" for a fixed array (or a function that
    // built one), "nextTrial" for an experiment that decided each trial as it
    // went (see js/core/trial-source.js). `trialSourceEnded` is only present
    // when a "nextTrial" source stopped because of a cap rather than because
    // it simply ran out of trials on its own -- worth knowing, because a
    // capped run stopped earlier than the experiment's own logic wanted to.
    // Additive to schema v2 (see docs/DATA_FORMAT.md); the version number does
    // not change for it.
    trialSource: trialSource.kind,
    ...(trialSource.endedBecause ? { trialSourceEnded: trialSource.endedBecause } : {}),
    // `decimals` is spread in from the recorder rather than read from
    // RECORDING, which no longer carries one (see config.js): a saved session
    // has to state the precision its own numbers were really rounded to, not
    // the precision some config file claims.
    settings: {
      recording: { ...RECORDING, decimals: recorder.decimals },
      trackerOptions: exp.trackerOptions ?? {},
    },
    environment: {
      ...getEnvironment(),
      // "GPU" or "CPU". CPU machines run at a lower frame rate, which is worth
      // knowing before you wonder why one participant's data looks coarse.
      trackerDelegate: tracker.delegate,
      trackerErrors: tracker.errorCount,
      // The camera resolution actually granted, which is often not the one
      // requested in config.js. Anything re-measuring angles from the saved
      // landmarks needs it (see videoInfo above).
      video: { width: videoInfo.width, height: videoInfo.height },
    },
    // Empty when everything uploaded. A non-empty list means the raw frames for
    // those trials never reached Firestore, so the session is incomplete in a
    // specific, known way rather than in a way you have to discover by counting
    // chunks. See uploadInBackground().
    uploadErrors,
    // 2: frames carry h/hs/vt, trials carry endReason, and the session carries
    // environment.video and uploadErrors. See docs/DATA_FORMAT.md.
    schemaVersion: 2,
  };
  await fb.saveSession(sessionId, sessionDoc);

  if (saving && RECORDING.alsoDownloadLocally) {
    ui.downloadJson(`${sessionId}.json`, sessionDoc);
  }

  /* ---- 8. Done ----------------------------------------------------------- */
  stopCamera(video);
  tracker.close();
  stage.hidden = true;

  // Show people what they just did. In demo mode this IS the point of the page.
  // An experiment can replace the default table with its own summary (a tutor
  // shows letters learned, not tap counts) by exporting renderResults().
  ui.setHtml("#done-results",
    exp.renderResults ? exp.renderResults(trialSummaries) : resultsTable(exp, trialSummaries));

  // Say so, on the screen, if some data did not make it. The participant is
  // finished either way, so this does not block anything, but a silent failure
  // here is a trial that quietly vanishes from the dataset.
  if (uploadErrors.length) {
    // The console line comes first and is unconditional: if the warning element
    // were ever renamed or removed, the failure still has to leave a trace.
    console.error(
      `${uploadErrors.length} of ${trialSummaries.length} recordings could not be uploaded.`,
      uploadErrors
    );
    const warning = ui.$("#done-upload-warning");
    if (warning) warning.hidden = false;
    ui.setText("#done-upload-warning-count",
      `${uploadErrors.length} of ${trialSummaries.length}`);
  }

  if (saving) {
    ui.setText("#done-session-id", sessionId);
  } else {
    ui.$("#done-saved-line").hidden = true;
    ui.$("#done-demo").hidden = false;
    if (replayData) {
      ui.setText("#done-demo-reason",
        "Nothing was saved. This run replayed recorded landmarks from a file, " +
        "which is not somebody's session to save.");
    }
    ui.$("#btn-download-demo").onclick = () => {
      const copy = structuredClone(sessionDoc);
      copy.trials.forEach((t, i) => { t.frames = demoFrames[i] ?? []; });
      ui.downloadJson(`${sessionId}.json`, copy);
    };
  }

  /* Stopped BEFORE the done screen appears, not after: the autorun clicker
   * presses whatever button it finds, and the one on this screen starts a file
   * download. */
  stopAutorun();
  if (replay.autorun) {
    // What tools/e2e-smoke.sh reads back. Deliberately the numbers that would
    // change if any part of the chain misbehaved: how many frames were
    // recorded, how many held a hand, and why the trial stopped.
    //
    // Those four all come from the RUNNER, though, and an experiment whose
    // onFrame did no work at all would produce exactly the same four. So
    // `summary` carries through what the experiment's own onTrialEnd()
    // returned, which is the only part of the payload that moves when the
    // experiment's measurements do.
    // An experiment may add its own whole-session numbers under `experiment`
    // (optional exp.e2eSummary, see experiments/_template.js). The per-trial
    // `summary` above is scalars only, so a check that spans trials -- "exactly
    // one trial was corrected after a rejected first attempt" -- has nowhere
    // else to be computed. It runs in autorun mode only and is never uploaded,
    // never shown to a participant, and never read by anything but the smoke
    // test, so an experiment without one is unaffected.
    markE2eDone({
      experimentId: exp.id,
      ...(exp.e2eSummary ? { experiment: exp.e2eSummary(trialSummaries) } : {}),
      trials: trialSummaries.map((t, i) => ({
        id: t.id,
        endReason: t.endReason,
        frameCount: t.frameCount,
        detectionRate: t.detectionRate,
        summary: scalarsOnly(experimentSummaries[i]),
      })),
      uploadErrors: uploadErrors.length,
    });
  }
  ui.showScreen("screen-done");

  // Only people Prolific sent here go back to it: anyone else (a lab's own
  // link, 2026-10-08) was landing on a Prolific login page after the results.
  if (saving && STUDY.completionRedirectUrl && participant.prolific) {
    ui.setText("#done-redirect-note", "Returning you to Prolific in 5 seconds…");
    await ui.sleep(5000);
    location.href = STUDY.completionRedirectUrl;
  }
}

/* -------------------------------------------------------------------------
 * The end for someone the screening did not let through (step 2b): save what
 * they answered, thank them, and send Prolific participants back with the
 * screen-out code (config.js STUDY.screenoutRedirectUrl) so they are paid for
 * their time. Nothing about whether they "passed" is shown.
 * ---------------------------------------------------------------------- */
async function screenedOut({ exp, participant, startedAt, consentRecord, demographics, screening, sessionId, saving }) {
  if (saving) {
    ui.showScreen("screen-saving");
    ui.setText("#saving-text", "Saving…");
  }
  try {
    await fb.saveSession(sessionId, {
      experimentId: exp.id,
      experimentTitle: exp.title,
      participantId: participant.participantId,
      participantSource: participant.source,
      prolific: participant.prolific,
      condition: participant.condition,
      startedAt,
      consent: consentRecord,
      demographics,
      screening,
      screenedOut: true,
      trials: [],
      environment: getEnvironment(),
      schemaVersion: 2,
    });
  } catch (err) {
    console.error("The screened-out session could not be saved.", err);
  }
  ui.showScreen("screen-screened-out");
  if (saving && STUDY.screenoutRedirectUrl && participant.prolific) {
    ui.setText("#screened-out-redirect-note", "Returning you to Prolific in 5 seconds…");
    await ui.sleep(5000);
    location.href = STUDY.screenoutRedirectUrl;
  }
}

/* -------------------------------------------------------------------------
 * Draw one checkbox per consent statement and wait until all are ticked.
 * Returns the statements that were agreed to, so the record stored with the
 * session is the wording the participant actually saw.
 * ---------------------------------------------------------------------- */
async function collectConsent(statements) {
  const box = ui.$("#consent-affirmations");
  const button = ui.$("#btn-consent");
  box.innerHTML = "";

  const boxes = statements.map((text, i) => {
    const row = document.createElement("label");
    row.className = "q-choice affirm";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = `affirm-${i}`;
    row.append(input, document.createTextNode(" " + text));
    box.append(row);
    return input;
  });

  const refresh = () => { button.disabled = !boxes.every((b) => b.checked); };
  boxes.forEach((b) => b.addEventListener("change", refresh));
  refresh();

  ui.showScreen("screen-consent");
  await ui.waitForClick("#btn-consent");
  return statements.filter((_, i) => boxes[i].checked);
}

/* -------------------------------------------------------------------------
 * The positioning preview: run the tracker live until the participant has been
 * visible for a couple of continuous seconds, then let them continue.
 * ---------------------------------------------------------------------- */
async function positioningLoop(video, tracker, ctx, canvas, stage, pick = () => 0, problem = () => null) {
  ui.$("#position-stage-slot").append(stage);

  let stop = false;
  let visibleSince = null;
  const btn = ui.$("#btn-position-done");
  btn.disabled = true;
  ui.waitForContinue("#btn-position-done", { space: SPACE }).then(() => { stop = true; });

  let lastVideoTime = -1;
  while (!stop) {
    if (video.currentTime !== lastVideoTime) {
      lastVideoTime = video.currentTime;
      const res = tracker.track(video, performance.now());
      const k = pick(res);
      drawLandmarks(ctx, canvas, k >= 0 ? res.landmarks[k] : null);

      // A hand the experiment objects to (the other hand, in the ASL study)
      // does not count as seen, and the status line says why.
      const objection = k >= 0 ? problem(res, k) : null;
      const seen = k >= 0 && !objection;
      if (seen && visibleSince === null) visibleSince = performance.now();
      if (!seen) visibleSince = null;

      const heldFor = visibleSince ? performance.now() - visibleSince : 0;
      if (heldFor > 1500) {
        btn.disabled = false;
        ui.setText("#position-status", "Looking good, you can continue.");
        ui.$("#position-status").className = "status good";
      } else {
        btn.disabled = true;
        ui.setText("#position-status",
          objection ?? (seen ? "Hold still…" : "Your hand is not visible. Move it into the frame."));
        ui.$("#position-status").className = seen ? "status" : "status bad";
      }
    }
    await nextFrame();
  }
  // Move the camera view into the trial screen for the rest of the study.
  ui.$("#trial-stage-slot").append(stage);
}

/* -------------------------------------------------------------------------
 * One trial's frame loop.
 *
 * The timing lives in trial-loop.js so it can be tested without a browser;
 * everything here is the browser half: track, record, draw.
 *
 * Returns why the trial ended: "duration" when the timer ran out, or whatever
 * the experiment passed to endTrial().
 * ---------------------------------------------------------------------- */
async function recordTrial({ video, videoInfo, tracker, ctx, canvas, exp, trial, state, recorder,
                             waitForFrame = nextFrame, pick = () => 0 }) {
  const durationMs = (trial.durationSec ?? 15) * 1000;
  let lastVideoTime = -1;

  const { endReason } = await runTrialLoop({
    durationMs,
    now: () => performance.now(),
    nextFrame: waitForFrame,
    // A webcam produces new pictures far less often than the screen repaints,
    // so most animation frames show us a picture we have already processed.
    hasNewFrame: () => video.currentTime !== lastVideoTime,
    step: (tMs, endTrial) => {
      lastVideoTime = video.currentTime;
      const res = tracker.track(video, performance.now());

      // Which of the hands found is the one to use: the first, unless the
      // experiment says otherwise (exp.pickHand; see handIndex below).
      const k = pick(res);
      const lm = k >= 0 ? res.landmarks[k] ?? null : null;
      const wl = k >= 0 ? res.worldLandmarks[k] ?? null : null;
      const handedness = k >= 0 ? res.handedness[k] ?? null : null;
      // ?. so a tracker that reports no scores at all gives null here instead
      // of ending the session mid-trial: a missing confidence number is worth
      // far less than the rest of the recording.
      const handednessScore = k >= 0 ? res.handednessScore?.[k] ?? null : null;

      const derived = exp.onFrame?.({
        landmarks: lm,
        worldLandmarks: wl,
        handedness,
        handednessScore,
        tMs, trial, state,
        addEvent: (type, data) => recorder.addEvent(tMs, type, data),
        // Stop the trial now, after this frame, with a reason recorded on the
        // trial summary. `durationSec` is still the cap: this only ever makes
        // a trial shorter. An experiment that never calls it runs exactly as
        // it did before this hook existed.
        endTrial,
        // The camera's true width, height and aspect ratio (see videoInfo).
        video: videoInfo,
      }) ?? {};

      recorder.addFrame(tMs, lm, wl, derived, {
        // MediaPipe's handedness label, stored AS REPORTED.
        // We deliberately do NOT "correct" the label: measured on this
        // platform's unmirrored image (research/live/REPORT.md section 1), a
        // physical RIGHT hand is reported "Right" (a mirrored/hflipped frame
        // reports the opposite). Code that needs the real hand derives it
        // from the geometry (tutor/hand-frame.js) instead, because that test
        // needs no assumption about mirroring and the label can flip at frame
        // edges; the label is kept raw as a cross-check on that, and a
        // "corrected" label could not be used as a cross-check.
        h: handLabel(handedness),
        hs: handednessScore,
        // The media time of the picture these landmarks came from. Read from
        // lastVideoTime, captured at the top of this step: that is the exact
        // value that made this frame count as new, so `vt` always identifies
        // the picture that was actually tracked.
        vt: lastVideoTime,
      });

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (exp.draw) {
        exp.draw(ctx, {
          landmarks: lm, derived, state, trial, canvas, tMs,
          // Text drawn on the canvas would appear mirrored, so live numbers go
          // into an HTML element sitting on top of the video instead.
          setReadout: (html) => ui.setHtml("#live-readout", html),
        });
      } else {
        drawLandmarks(ctx, canvas, lm);
      }

      ui.setTimeRemaining((durationMs - tMs) / 1000);
    },
  });

  return endReason;
}

/* Which of the tracked hands an experiment wants, as an index into the
 * tracker's result, or -1 for none. Without exp.pickHand it is the first hand
 * found, as it always was. An experiment that tracks two hands but is about
 * ONE (the ASL study: the dominant hand only) picks it here, and only that
 * hand is handed to onFrame, drawn and saved. A picker that throws or returns
 * nonsense falls back to the first hand rather than ending the session. */
function handIndex(exp, res, videoInfo, demographics) {
  const n = res.landmarks?.length ?? 0;
  if (!exp.pickHand || n === 0) return n ? 0 : -1;
  try {
    const k = exp.pickHand(res, { aspect: videoInfo.aspect, demographics });
    return Number.isInteger(k) && k >= -1 && k < n ? k : 0;
  } catch (err) {
    console.warn("pickHand failed; using the first hand", err);
    return 0;
  }
}

/* The plain numbers, strings and booleans out of an experiment's own trial
 * summary, for the unattended run's report. Scalars only: this is a short line
 * a shell script reads, not a second copy of the session document, and an
 * experiment that returns a whole frame array from onTrialEnd should not put
 * it on the page. Nothing here is uploaded or shown to a participant. */
function scalarsOnly(summary) {
  const out = {};
  for (const [key, value] of Object.entries(summary ?? {})) {
    const t = typeof value;
    if (value === null || t === "number" || t === "string" || t === "boolean") out[key] = value;
  }
  return out;
}

/* "Left" -> "L", "Right" -> "R", anything else -> null. "Anything else" covers
 * the tracker's own "?" for an unlabelled hand, a frame with no hand in it, and
 * pose tracking, which has no handedness at all. */
function handLabel(handedness) {
  if (handedness === "Left") return "L";
  if (handedness === "Right") return "R";
  return null;
}

/* -------------------------------------------------------------------------
 * Upload one trial's frames without holding up the next trial.
 *
 * This never rejects. A background upload that failed with nobody waiting on
 * it would become an unhandled promise rejection: a red line in a console
 * nobody is reading, and a trial missing from the dataset with no record of
 * why. So: try, retry once RESUMING from the first chunk that did not land
 * (see upload-retry.js for why resuming, not restarting), and if it still
 * fails write it down in uploadErrors, which goes into the session document
 * and onto the participant's screen.
 * ---------------------------------------------------------------------- */
async function uploadInBackground(sessionId, trialIndex, chunks, meta, uploadErrors) {
  const failure = await uploadWithOneRetry({
    upload: (startIndex) =>
      fb.uploadTrialChunks(sessionId, trialIndex, chunks, meta, undefined, startIndex),
    chunkCount: chunks.length,
    onRetry: (err, resumeFrom) => console.warn(
      `Upload of trial ${trialIndex} failed; retrying from chunk ${resumeFrom}.`, err
    ),
  });

  if (failure) {
    uploadErrors.push({ trialIndex, trialId: meta.trialId, ...failure });
    console.error(
      `Upload of trial ${trialIndex} failed twice ` +
      `(${failure.chunksWritten ?? "unknown"} of ${failure.chunkCount} chunks landed); ` +
      "recorded in uploadErrors.",
      failure
    );
  }
}

/* -------------------------------------------------------------------------
 * Default overlay: dots on every landmark, lines along the fingers.
 * ---------------------------------------------------------------------- */
const HAND_BONES = [
  [0,1],[1,2],[2,3],[3,4],          // thumb
  [0,5],[5,6],[6,7],[7,8],          // index
  [5,9],[9,10],[10,11],[11,12],     // middle
  [9,13],[13,14],[14,15],[15,16],   // ring
  [13,17],[17,18],[18,19],[19,20],  // pinky
  [0,17],
];

export function drawLandmarks(ctx, canvas, landmarks, color = "#4ade80") {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;
  const W = canvas.width, H = canvas.height;

  ctx.strokeStyle = color;
  ctx.lineWidth = 3;
  if (landmarks.length === 21) {
    for (const [a, b] of HAND_BONES) {
      ctx.beginPath();
      ctx.moveTo(landmarks[a].x * W, landmarks[a].y * H);
      ctx.lineTo(landmarks[b].x * W, landmarks[b].y * H);
      ctx.stroke();
    }
  }
  ctx.fillStyle = "#ffffff";
  for (const p of landmarks) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

/** A small table of what happened, shown on the final screen. */
function resultsTable(exp, summaries) {
  const rows = summaries.map((t) => {
    const bits = [];
    if (t.tapCount != null) bits.push(`<td>${t.tapCount}</td>`);
    if (t.tapRateHz != null) bits.push(`<td>${t.tapRateHz.toFixed(2)} Hz</td>`);
    if (t.detectionRate != null) {
      const pct = Math.round(t.detectionRate * 100);
      bits.push(`<td class="${pct < 90 ? "bad" : ""}">${pct}%</td>`);
    }
    return `<tr><th>${t.hand ?? t.id}</th>${bits.join("")}</tr>`;
  });
  if (!rows.length) return "";
  const headers = ["", summaries[0].tapCount != null ? "taps" : null,
                   summaries[0].tapRateHz != null ? "rate" : null,
                   summaries[0].detectionRate != null ? "hand visible" : null]
                  .filter((h) => h !== null);
  return `<table class="results">
    <tr>${headers.map((h) => `<th>${h}</th>`).join("")}</tr>
    ${rows.join("")}
  </table>`;
}

function nextFrame() {
  return new Promise((r) => requestAnimationFrame(r));
}

function round(v, d) { const p = 10 ** d; return Math.round(v * p) / p; }
