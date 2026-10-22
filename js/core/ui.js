/* ui.js: small helpers for showing one screen at a time, counting down, and
 * telling the participant what is going on.
 *
 * The screens themselves live in index.html as <section class="screen"> blocks.
 * This file just shows and hides them. */

/** Show exactly one screen (by its id) and hide the rest. */
export function showScreen(id) {
  document.querySelectorAll(".screen").forEach((el) => {
    el.classList.toggle("visible", el.id === id);
  });
  window.scrollTo(0, 0);
}

export function $(sel) { return document.querySelector(sel); }

export function setText(sel, text) {
  const el = $(sel);
  if (el) el.textContent = text;
}

export function setHtml(sel, html) {
  const el = $(sel);
  if (el) el.innerHTML = html;
}

/** Show a blocking error screen. Nothing recoverable happens after this. */
export function fatal(message, detail = "") {
  setText("#error-message", message);
  setText("#error-detail", detail);
  showScreen("screen-error");
  console.error(message, detail);
}

/**
 * Big "3 . 2 . 1 . GO" overlay.
 * @param {number} seconds
 * @param {string} goWord  what to show at zero
 */
export async function countdown(seconds = 3, goWord = "GO") {
  const el = $("#countdown");
  el.classList.add("visible");
  for (let n = seconds; n > 0; n--) {
    el.textContent = String(n);
    el.classList.remove("pulse");
    void el.offsetWidth;          // restart the CSS animation
    el.classList.add("pulse");
    await sleep(1000);
  }
  el.textContent = goWord;
  await sleep(500);
  el.classList.remove("visible");
}

/** "Trial 2 of 6" plus a progress bar, or just "Trial 2" when `total` is not
 * known yet (an experiment choosing each trial as it goes; see
 * js/core/trial-source.js). There is nothing to show a fraction of in that
 * case, so the bar is left empty rather than showing a stale or wrong width. */
export function setProgress(current, total, label = "") {
  setText("#progress-label",
    label || (total == null ? `Trial ${current}` : `Trial ${current} of ${total}`));
  const bar = $("#progress-bar-fill");
  if (bar) bar.style.width = total == null ? "0%" : `${(current / total) * 100}%`;
}

/** Countdown of seconds remaining inside a trial. */
export function setTimeRemaining(secondsLeft) {
  setText("#trial-timer", `${Math.max(0, Math.ceil(secondsLeft))}s`);
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Wait for the participant to click a button. Resolves when they do. */
export function waitForClick(sel) {
  return new Promise((resolve) => {
    const el = $(sel);
    const handler = () => { el.removeEventListener("click", handler); resolve(); };
    el.addEventListener("click", handler);
  });
}

/* Wait for a click on `sel`, or the space bar while that button is enabled
 * (SCREENS.spaceToContinue). Space typed into a text box does nothing. */
export function waitForContinue(sel, { space = false } = {}) {
  return new Promise((resolve) => {
    const el = $(sel);
    const done = () => { el.removeEventListener("click", done); document.removeEventListener("keydown", onKey); resolve(); };
    const onKey = (e) => {
      if (e.code !== "Space" && e.key !== " ") return;
      if (el.disabled || el.offsetParent === null) return;
      if (e.target.closest?.("input, textarea, select")) return;
      e.preventDefault();
      done();
    };
    el.addEventListener("click", done);
    if (space) document.addEventListener("keydown", onKey);
  });
}

/** Offer the collected data as a .json download (used when piloting). */
export function downloadJson(filename, obj) {
  const blob = new Blob([JSON.stringify(obj, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
