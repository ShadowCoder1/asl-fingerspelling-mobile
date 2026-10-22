/* =============================================================================
 *  config.js, THE ONLY FILE YOU NEED TO EDIT TO GET STARTED
 * =============================================================================
 *
 *  1. Fill in FIREBASE below (see docs/SETUP.md, takes about 15 minutes).
 *  2. Open check.html to confirm everything works.
 *  3. Open index.html to run the experiment.
 *
 *  The demographic questions live in a separate file, questions.js, because
 *  those are the ones you are most likely to change.
 *
 *  Everything in this file is safe to commit to a public repo. Firebase web
 *  API keys are public identifiers, NOT secrets, your data is protected by
 *  firestore.rules, not by hiding this key. (This surprises people. It is
 *  documented by Google: https://firebase.google.com/docs/projects/api-keys)
 * ===========================================================================*/


/* -----------------------------------------------------------------------------
 * 1. FIREBASE, where your participants' data gets saved
 * ---------------------------------------------------------------------------
 * Paste the config object from the Firebase Console here.
 * Firebase Console -> Project settings -> Your apps -> Web app -> Config
 * ---------------------------------------------------------------------------*/
export const FIREBASE = {
  // Phone demo site: blank on purpose, so nothing anyone does here is saved.
  apiKey:            "PASTE_YOUR_API_KEY",
  authDomain:        "",
  projectId:         "",
  storageBucket:     "",
  messagingSenderId: "",
  appId:             "",
};


/* -----------------------------------------------------------------------------
 * 2. WHICH EXPERIMENT TO RUN
 * ---------------------------------------------------------------------------
 * The name of a file in experiments/ (without the .js).
 * You can also override this in the URL:  index.html?exp=my-experiment
 * ---------------------------------------------------------------------------*/
export const ACTIVE_EXPERIMENT = "asl-demo";


/* -----------------------------------------------------------------------------
 * 3. STUDY SETTINGS
 * ---------------------------------------------------------------------------*/
export const STUDY = {
  // Shown on the welcome screen.
  title: "Learning the fingerspelling alphabet",
  labName: "",   // blank hides the line; fill in the lab's name before recruiting
  contactEmail: "sritej.paddy@gmail.com",

  // Shown above the consent form as a short lead-in.
  consentIntroHtml: `
    <p>Please read the consent form below before taking part. You can
    <a href="consent/consent-form.pdf" target="_blank" rel="noopener">open it in
    a new tab</a> or download it to keep.</p>`,

  // Where to send participants when they finish. Prolific gives you a URL
  // like https://app.prolific.com/submissions/complete?cc=XXXXXXXX
  // Leave as null to just show a thank-you screen with no redirect.
  completionRedirectUrl: "https://app.prolific.com/submissions/complete?cc=C1B2RP9Z",

  // Where to send a Prolific participant who did not pass the screening (the
  // ASL check on the expert link, experiments/sign-quiz.js), so they are paid
  // for their time: Prolific's "screened out" completion code, e.g.
  // https://app.prolific.com/submissions/complete?cc=XXXXXXXX. Null shows the
  // thank-you screen with no redirect.
  screenoutRedirectUrl: null,

};


/* -----------------------------------------------------------------------------
 * 3b. WHICH SCREENS COME BEFORE THE TASK
 *
 * Both are OFF: the page goes straight to the camera. That is right for
 * building, piloting on yourself and showing people.
 *
 * TURN THEM BACK ON BEFORE COLLECTING DATA FROM ANYONE ELSE. A session saved
 * with consent off says so in its own record (`consent.skipped: true`), and
 * the browser console warns when consent is off while Firebase is saving.
 * What the two screens contain is set below (CONSENT) and in questions.js.
 * ---------------------------------------------------------------------------*/
export const SCREENS = {
  // On since data is being saved (2026-09-21): the public link must not save
  // a stranger's hands without asking. Off is only for a demo that saves nothing.
  consent: false,   // demo site: nothing is saved
  // On: the short questionnaire (questions.js) is part of the study design.
  demographics: false,   // demo site: nothing is saved
  postQuestions: false,   // demo site: nothing is saved
  // The yellow "Demo mode. Firebase is not set up, so nothing is being saved"
  // strip across the top. Off for the shared demo link, where it reads as an
  // error to a visitor. The same sentence still goes to the browser console.
  // It only ever shows while FIREBASE above is unfilled, so turning it back on
  // costs nothing once data is really being collected.
  demoBanner: false,
  // The instructions page before the first trial. Off (JT, 2026-09-24): its
  // demo film gives some signs a head start. Set true to bring it back; the
  // hand to use is said on the camera check instead.
  instructions: false,
  // The buttons that move between parts of the task say "Press space to
  // continue" and the space bar works them (JT, 2026-09-24).
  spaceToContinue: true,
};


/* -----------------------------------------------------------------------------
 * 4. CONSENT
 * ---------------------------------------------------------------------------*/
export const CONSENT = {
  // The consent document participants read. Replace this file with your own
  // approved form, or point this at a different path. Set to null to show only
  // the statements below with no document.
  pdf: "consent/consent-form.pdf",

  // Each of these becomes a checkbox that must be ticked before continuing.
  // These match the statements at the end of the included form. Change them to
  // match yours. Which ones were agreed to is saved with every session.
  affirmations: [
    "I am age 18 or older.",
    "I have read and understand the information above.",
    "I want to participate in this research and continue with the task.",
  ],
};


/* -----------------------------------------------------------------------------
 * 5. RECORDING SETTINGS: most people never need to change these
 * ---------------------------------------------------------------------------*/
export const RECORDING = {
  // Target camera resolution. Lower = faster on weak laptops.
  video: { width: 640, height: 480 },

  // How many frames go into one Firestore document.
  // WHY THIS EXISTS: a Firestore document can hold at most 1 MiB. One frame of
  // hand data is roughly 1.2 KB, so 250 frames is about 300 KB, a safe margin.
  // If you record many more landmarks per frame, lower this number.
  chunkFrames: 250,

  // NOT HERE: how many decimal places each coordinate keeps. That lives in
  // tutor/landmarks.js, as DECIMALS, and it is 4 -- well below the tracker's
  // noise floor, and roughly half the storage of the full float.
  // WHY IT IS NOT A KNOB: the grader reads back the very same rounded numbers
  // the recorder saved, so a sign graded in the browser can be re-graded from
  // the stored data and come out identical. Two places to set the precision
  // means they can disagree, and then one number is graded and a different one
  // is saved, with nothing to say which is right. Change DECIMALS if the
  // precision itself is wrong; putting a `decimals` back here throws at
  // startup (js/core/recorder.js).

  // Also hand the participant a JSON copy of their session summary (the same
  // document that goes to Firebase: identity, settings, and the per-trial
  // numbers). The raw frame-by-frame landmarks are NOT included -- those only
  // go to Firebase. Useful while piloting; leave off for real collection.
  alsoDownloadLocally: false,
};


/* -----------------------------------------------------------------------------
 * 6. MEDIAPIPE VERSIONS, pinned on purpose
 * ---------------------------------------------------------------------------
 * Pinned so that your study does not silently change halfway through data
 * collection because Google shipped a new model. Only bump these between
 * studies, and re-run check.html when you do.
 * ---------------------------------------------------------------------------*/
export const MEDIAPIPE = {
  version: "1.0.1",

  // "auto" tries the graphics card and falls back to the CPU if that fails,
  // which is what you want almost always. Force "CPU" if a participant's
  // machine is unstable on the GPU, or "GPU" to refuse to run without it.
  // A URL can override this for one participant:  index.html?delegate=cpu
  delegate: "auto",

  models: {
    hand: "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task",
    pose: "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task",
  },
};
