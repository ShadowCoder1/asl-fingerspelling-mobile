/* upload-retry.js: should a failed upload be retried, and from where?
 *
 * WHY RETRYING IS NOT AS SIMPLE AS CALLING IT AGAIN
 * A trial's frames go up as several chunk documents with fixed names
 * (000_000, 000_001, …). The security rules let a participant CREATE a chunk
 * and never update one, which is what stops a participant rewriting data they
 * already sent. So a retry that starts again from chunk 0 is denied by the
 * rules on its very first write, and the error you end up recording is
 * "Missing or insufficient permissions" rather than the network failure that
 * actually happened. The upload has to RESUME from the first chunk that did
 * not land.
 *
 * That is why this file exists on its own, with no DOM and no Firebase in it:
 * the resume-or-give-up decision is the part that has to be right, and this
 * way it can be tested in Node with a fake upload (tests/upload-retry.test.js).
 */

/**
 * Upload something in chunks, retrying once if we know where it stopped.
 *
 * NEVER REJECTS. A background upload has nobody waiting on it, so a rejection
 * here would become an unhandled promise rejection: a red line in a console
 * nobody is reading and a trial missing from the dataset with no explanation.
 * Failures come back as a plain object to be written into the session document.
 *
 * @param {object} o
 * @param {(startIndex: number) => Promise<void>} o.upload  uploads chunks from
 *        startIndex onwards. On failure it should throw an error carrying
 *        `chunksWritten`: the index of the first chunk that did NOT land.
 * @param {number} o.chunkCount  how many chunks there are in total.
 * @param {(err: unknown, resumeFrom: number) => void} [o.onRetry]  called once
 *        before a retry, for logging.
 * @returns {Promise<null|{message: string, firstMessage: string,
 *                        chunksWritten: number|null, chunkCount: number}>}
 *          null when everything landed. Otherwise: the last attempt's error
 *          message, the first attempt's error message (the same string when no
 *          retry was possible), how many chunks are known to have landed, and
 *          how many there should be. `chunksWritten: null` means the failure
 *          did not say how far it got, so no retry was attempted.
 */
export async function uploadWithOneRetry({ upload, chunkCount, onRetry }) {
  let first;
  try {
    await upload(0);
    return null;
  } catch (err) {
    first = err;
  }

  const resumeFrom = progressOf(first);
  if (resumeFrom === null) {
    // We do not know what landed, so any retry is a guess. Guessing wrong
    // means overwriting an existing chunk, which the rules refuse, which would
    // replace this real error message with a confusing one. Record and stop.
    return record(first, first, null, chunkCount);
  }

  onRetry?.(first, resumeFrom);

  try {
    await upload(resumeFrom);
    return null;
  } catch (second) {
    return record(second, first, progressOf(second), chunkCount);
  }
}

/* How far did this failure get? Only a whole, non-negative count counts as
 * knowing; anything else (no property, undefined, NaN, a string) is "unknown".
 * Deliberately strict: a wrong number here re-uploads or skips real data. */
function progressOf(err) {
  const n = err?.chunksWritten;
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function record(last, first, chunksWritten, chunkCount) {
  return {
    message: messageOf(last),
    firstMessage: messageOf(first),
    chunksWritten,
    chunkCount,
  };
}

/* Anything can be thrown in JavaScript, including nothing at all. The record
 * has to end up with a readable string either way. */
function messageOf(err) {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === "string" && err) return err;
  return `Upload failed with no error message (${String(err)})`;
}
