/* debug-recording.js: the ?debug=1 recording, without the DOM.
 *
 * Kept apart from debug.js so that the one property that matters -- a saved
 * file LOADS in replay mode (js/core/replay.js) -- is checked under Node
 * (tests/tutor-debug-recording.test.js) rather than discovered by the first
 * person who tries to replay a session they cannot record again.
 *
 * The file is replay format (`video`, `fps`, `frames[{lm, wl, h, hs}]`) with a
 * `debug` block beside it: per-frame wall times, which letter was being asked
 * for over which frames, and the tutor's own attempt rows. */

/* 30 minutes at 30 fps. Past this the recorder stops taking frames and says so
 * in the file, rather than growing until the tab dies and takes the recording
 * with it. */
export const MAX_FRAMES = 54000;

export function createRecording({ maxFrames = MAX_FRAMES } = {}) {
  const frames = [], times = [], labels = [], attempts = [];
  let holed = 0, dropped = 0;

  return {
    trialStart(trial) {
      const prev = labels[labels.length - 1];
      if (prev && prev.toFrame === null) prev.toFrame = frames.length;
      labels.push({ trialId: trial.id, letter: trial.letter, kind: trial.kind, fromFrame: frames.length, toFrame: null });
    },

    /* `flat` is flattenRounded's output, or null. A row with ANY non-finite
     * coordinate is stored as "no hand": replay mode refuses a whole file over
     * one such row, and the tutor treated that frame as no hand anyway
     * (tutor/commit.js frameStatus). Counted, so it is not silent. */
    addFrame({ flat, handedness, handednessScore, tWallMs }) {
      if (frames.length >= maxFrames) { dropped++; return false; }
      let lm = flat;
      if (lm !== null && !lm.every(Number.isFinite)) { lm = null; holed++; }
      frames.push({
        lm, wl: null,
        h: lm === null ? null : handedness === "Left" ? "L" : handedness === "Right" ? "R" : null,
        hs: lm === null || typeof handednessScore !== "number" ? null : handednessScore,
      });
      times.push(Math.round(tWallMs));
      return true;
    },

    attempt(data) { attempts.push({ frame: frames.length, ...data }); },
    frameCount: () => frames.length,
    times: () => times,

    doc({ video, userAgent = null, savedAt = null } = {}) {
      const closed = labels.map((l, i) => (i === labels.length - 1 && l.toFrame === null ? { ...l, toFrame: frames.length } : l));
      // The median frame interval, not frames/span: trials have pauses between
      // them (uploads, screens), and one long pause would drag a mean fps down
      // and make the whole replay run slow.
      const gaps = [];
      for (let i = 1; i < times.length; i++) gaps.push(times[i] - times[i - 1]);
      gaps.sort((a, b) => a - b);
      const medianGap = gaps.length ? gaps[Math.floor(gaps.length / 2)] : 0;
      const fps = medianGap > 0 ? Math.round(100000 / medianGap) / 100 : 30;
      return {
        generatedBy: "experiments/asl-tutor/debug.js",
        note: "A ?debug=1 session: real camera landmarks with the letter that was being asked for. Replays with ?replay=.",
        savedAt, userAgent,
        video: video ?? { width: 640, height: 480 },
        fps,
        frames,
        debug: { times, labels: closed, attempts, holedFrames: holed, droppedAfterCap: dropped },
      };
    },
  };
}
