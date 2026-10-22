/* firebase.js: signs the participant in anonymously and saves their data.
 *
 * HOW THE DATA IS LAID OUT IN FIRESTORE
 *
 *   sessions/{sessionId}                     <- one small document per session:
 *                                               who, when, settings, per-trial
 *                                               summary numbers, event times.
 *                                               This is what you usually read.
 *
 *   sessions/{sessionId}/chunks/{trial}_{n}  <- the raw frame-by-frame
 *                                               landmarks, split into pieces
 *                                               (see recorder.js).
 *
 * The session document is written LAST, once the participant has finished.
 * That means a session folder with chunks but no session document is someone
 * who dropped out partway, fetch_data.py reports those separately instead of
 * silently mixing them into your dataset.
 *
 * See firestore.rules for the matching security rules. */

import { FIREBASE } from "../../config.js";

const SDK = "https://www.gstatic.com/firebasejs/12.17.1";

let app = null, db = null, auth = null, uid = null;

// False when config.js has not been filled in. The experiment still runs, it
// just does not save anything. See initFirebase().
let enabled = false;

/** True if config.js still has the placeholder values in it. */
export function configLooksUnfilled() {
  return Object.values(FIREBASE).some(
    (v) => typeof v === "string" && v.includes("PASTE_YOUR")
  );
}

/**
 * Start Firebase and sign in anonymously.
 *
 * If config.js has not been filled in, this does NOT fail. It returns
 * `{ enabled: false }` and the experiment runs in demo mode: the task works
 * normally and the participant sees their live tap count, but nothing is
 * uploaded. That way the study is something you can click and try before you
 * have set up any accounts.
 *
 * Anonymous sign-in gives every participant a unique id without asking them for
 * an account, and lets the security rules reject writes from bots.
 *
 * @returns {Promise<{uid: string|null, enabled: boolean}>}
 */
export async function initFirebase() {
  if (uid) return { uid, enabled: true };

  if (configLooksUnfilled()) {
    enabled = false;
    return { uid: null, enabled: false };
  }

  const { initializeApp } = await import(`${SDK}/firebase-app.js`);
  const { getAuth, signInAnonymously } = await import(`${SDK}/firebase-auth.js`);
  const { getFirestore } = await import(`${SDK}/firebase-firestore.js`);

  app  = initializeApp(FIREBASE);
  auth = getAuth(app);
  db   = getFirestore(app);

  try {
    const cred = await signInAnonymously(auth);
    uid = cred.user.uid;
    enabled = true;
  } catch (err) {
    if (String(err?.code).includes("operation-not-allowed")) {
      throw new Error(
        "Anonymous sign-in is turned off for this Firebase project. Go to " +
        "Firebase Console -> Build -> Authentication -> Sign-in method, and " +
        "enable 'Anonymous'. (docs/SETUP.md step 3)"
      );
    }
    throw new Error(`Could not sign in to Firebase: ${err?.message || err}`);
  }

  return { uid, enabled: true };
}

/** Is data actually being saved? False in demo mode. */
export function isEnabled() { return enabled; }

/** A readable, sortable, collision-proof session id. */
export function newSessionId() {
  // "2026-08-18T20:39:27.123Z" -> "20260818203927" (14 characters, no dot,
  // so it is safe as both a Firestore document id and a filename).
  const iso = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 8);
  return `${iso}_${rand}`;
}

/**
 * Upload the raw frames for one trial. Safe to call after every trial, so a
 * participant who quits halfway still leaves usable data behind.
 *
 * RESUMING. Each chunk is written under a fixed name (000_000, 000_001, …) and
 * the security rules allow creating a chunk but never updating one. So an
 * upload that failed partway CANNOT simply be run again: its first write would
 * hit an existing document and be refused. It has to carry on from where it
 * stopped, which is what `startIndex` is for. Every failure therefore throws an
 * error carrying `chunksWritten`, the index of the first chunk that did not
 * land, and js/core/upload-retry.js turns that into the next `startIndex`. The
 * document a given chunk index produces is identical either way, so a resumed
 * upload leaves exactly the same data behind as one that never failed.
 *
 * @param {string} sessionId
 * @param {number} trialIndex
 * @param {Array<Array>} chunks   output of Recorder#toChunks()
 * @param {object} meta           { experimentId, trialId }
 * @param {(done:number,total:number)=>void} [onProgress]
 * @param {number} [startIndex]   first chunk to write (default 0: all of them)
 * @throws {Error} with `.chunksWritten` set, and the original message kept
 */
export async function uploadTrialChunks(sessionId, trialIndex, chunks, meta, onProgress, startIndex = 0) {
  if (!enabled) return;          // demo mode: nothing is saved

  let firestore;
  try {
    firestore = await import(`${SDK}/firebase-firestore.js`);
  } catch (err) {
    // Nothing was written, so the first chunk still missing is the one we were
    // about to start on. Saying so lets the retry resume correctly.
    throw failedAt(err, startIndex);
  }
  const { doc, setDoc, serverTimestamp } = firestore;

  for (let i = startIndex; i < chunks.length; i++) {
    const ref = doc(db, "sessions", sessionId, "chunks", `${pad(trialIndex)}_${pad(i)}`);
    try {
      await setDoc(ref, {
        uid,
        sessionId,
        experimentId: meta.experimentId,
        trialIndex,
        trialId: meta.trialId,
        chunkIndex: i,
        chunkCount: chunks.length,
        frames: chunks[i],
        ...(i === chunks.length - 1 && meta.trialSummary ? { trialSummary: firestoreSafe(meta.trialSummary) } : {}),
        ...(i === 0 && meta.early ? { early: firestoreSafe(meta.early) } : {}),
        uploadedAt: serverTimestamp(),
      });
    } catch (err) {
      throw failedAt(err, i);    // chunks [0, i) are up; chunk i is not
    }
    onProgress?.(i + 1, chunks.length);
  }
}

/* Firestore refuses `undefined`; a JSON round trip drops it (and turns
 * Infinity/NaN into null), which is what these small records need. */
function firestoreSafe(v) {
  return JSON.parse(JSON.stringify(v));
}

/* Re-throwable copy of an upload error that also says how far the upload got.
 * The original message is kept word for word: it is the only evidence of what
 * actually went wrong, and the whole point of resuming is to avoid replacing it
 * with a misleading "insufficient permissions". */
function failedAt(err, chunksWritten) {
  const wrapped = new Error(err?.message || String(err), { cause: err });
  wrapped.chunksWritten = chunksWritten;
  // Firestore's own error code ("permission-denied", "unavailable", …) is the
  // most useful thing in the original error, so carry it across too.
  if (err?.code !== undefined) wrapped.code = err.code;
  return wrapped;
}

/**
 * Write the small summary document. Call this once, at the very end.
 * @param {string} sessionId
 * @param {object} payload  everything except uid/timestamps, which we add here
 */
export async function saveSession(sessionId, payload) {
  if (!enabled) return;          // demo mode: nothing is saved
  const { doc, setDoc, serverTimestamp } = await import(`${SDK}/firebase-firestore.js`);
  await setDoc(doc(db, "sessions", sessionId), {
    ...payload,
    uid,
    sessionId,
    finishedAt: serverTimestamp(),
  });
}

/** Current anonymous user id, or null before initFirebase() has run. */
export function currentUid() { return uid; }

function pad(n) { return String(n).padStart(3, "0"); }
