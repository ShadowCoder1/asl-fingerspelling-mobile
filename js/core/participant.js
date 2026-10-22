/* participant.js: works out who this participant is and where to send them
 * when they are done.
 *
 * PROLIFIC
 * Prolific adds identifiers to the URL it sends people to, e.g.
 *   https://yourname.github.io/your-repo/?PROLIFIC_PID=abc&STUDY_ID=xyz&SESSION_ID=123
 * We read those automatically. Nothing to configure.
 *
 * ANYTHING ELSE (Qualtrics, SONA, an email link, testing on your own machine)
 * Add ?pid=whatever to the URL, or leave it off and the participant is asked
 * to type an ID on the welcome screen. */

import { replayRequest } from "./replay.js";

const params = new URLSearchParams(location.search);

/** Everything we know about who is sitting in front of the camera. */
export function getParticipant() {
  const prolificPid = params.get("PROLIFIC_PID");
  const manualPid   = params.get("pid") || params.get("participant");

  return {
    participantId: prolificPid || manualPid || null,
    source: prolificPid ? "prolific" : manualPid ? "url" : "manual",
    prolific: prolificPid
      ? {
          pid: prolificPid,
          studyId: params.get("STUDY_ID"),
          sessionId: params.get("SESSION_ID"),
        }
      : null,
    // Handy for debugging a specific participant's data later.
    condition: params.get("condition") || null,
  };
}

/** Which experiment file to load, ?exp=... beats config.js. */
export function requestedExperiment(fallback) {
  const name = params.get("exp");
  // Only allow simple names, so a URL can never be used to load a script from
  // somewhere else.
  return name && /^[a-z0-9_-]+$/i.test(name) ? name : fallback;
}

/**
 * Is this a replay run, and may it drive itself?
 *
 *   ?replay=tests/fixtures/replay-hand.json   play a recorded file instead of
 *                                             the camera (js/core/replay.js)
 *   ?autorun=1                                tick and click through the whole
 *                                             run with nobody sitting there
 *
 * The two are read together, in replay.js, because autorun is only safe in
 * replay mode: on a real participant's link it would consent on their behalf,
 * so it is ignored unless a valid replay file was asked for as well.
 *
 * @returns {{present: boolean, valid: boolean, raw: string|null,
 *            path: string|null, autorun: boolean}}
 *   `present` is whether `?replay=` was in the URL at all and `valid` whether
 *   it named a usable file; `raw` is what was typed, for the error message.
 *   The pair matters: present-but-invalid is a mistyped path, which stops the
 *   run rather than quietly starting the camera instead. `path` is the
 *   checked path, or null.
 */
export function requestedReplay() {
  return replayRequest(params);
}

/** Browser / hardware details worth having when a participant's data looks odd. */
export function getEnvironment() {
  return {
    userAgent: navigator.userAgent,
    platform: navigator.platform || null,
    language: navigator.language || null,
    screenW: window.screen?.width ?? null,
    screenH: window.screen?.height ?? null,
    devicePixelRatio: window.devicePixelRatio ?? null,
    hardwareConcurrency: navigator.hardwareConcurrency ?? null,
    deviceMemoryGb: navigator.deviceMemory ?? null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    timezoneOffsetMin: new Date().getTimezoneOffset(),
  };
}
