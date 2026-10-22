/* notes-view.js: what the tutor saw on the last hold, for a teacher or a researcher (T, or ?notes=1). It lays out
 * tutor/feedback.js teacherNotes the way the CHI 2026 egocentric-ASL paper decomposes a sign (Cai, Li et al., fig. 5:
 * handshape, orientation, location, movement; the primary error; the details), with the record itself one click away.
 * Off by default: a learner is never shown a number (experiments/asl-tutor/ui.js). */

const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
const PART = { thumb: "thumb", index: "index finger", middle: "middle finger", ring: "ring finger", pinky: "pinky", spread: "gaps between fingers", orientation: "hand direction" };
const RULE = {
  "b-thumb": "B's thumb rule (the thumb out to the side is not a B)",
  "p-rule": "P's rule (P points down)",
  "o-e-rule": "E's rule (an E's fingertips rest on the thumb)",
  "second-opinion": "the second reader (OpenFS)",
};
const CHANGE = { bend: "bend it", straighten: "straighten it", apart: "spread them", together: "close them", cross: "cross them" };

/** The notes as HTML (pure; for the panel and its test). */
export function renderNotes(n) {
  if (!n) return `<p class="notes-empty">Hold a letter still to see what the tutor read.</p>`;
  const p = n.parameters ?? {};
  const mark = (ok) => (ok === true ? `<span class="notes-ok">✓</span>` : ok === false ? `<span class="notes-off">✗</span>` : `<span class="notes-na">–</span>`);
  const hs = p.handshape, or = p.orientation, loc = p.location, mv = p.movement;
  const rows = [
    ["Handshape", hs?.ok, hs ? (hs.ok ? "every part in range" : hs.off.map((b) => PART[b] ?? b).join(", ")) : "not measured"],
    ["Orientation", or?.ok, or ? `palm ${or.palmDeg ?? "?"}°, pointing ${or.pointingDeg ?? "?"}° from the letter's average` : "not measured"],
    ["Location", null, loc ? `not measured (${loc.wholeHandInView ? "whole hand in view" : "hand partly out of view"})` : "not measured"],
    ["Movement", mv?.ok ?? null, mv?.reason ? `movement: ${mv.reason}` : mv?.note ?? "held still"],
  ];
  const primary = n.primaryError
    ? `${n.primaryError.parameter} · ${PART[n.primaryError.part] ?? n.primaryError.part}${n.primaryError.change ? ` (${CHANGE[n.primaryError.change] ?? n.primaryError.change})` : ""}`
    : n.accepted ? "none" : "no single part";
  const g = n.grader ?? {};
  return `
    <p class="notes-head"><strong>${esc(n.target)}</strong> · ${n.accepted ? `<span class="notes-ok">accepted</span>` : "not yet"}${n.looksLike ? ` · looks like <strong>${esc(n.looksLike)}</strong>` : ""}</p>
    <table class="notes-table">${rows.map(([k, ok, v]) => `<tr><th>${k}</th><td>${mark(ok)}</td><td>${esc(v)}</td></tr>`).join("")}</table>
    <p class="notes-line"><span>Primary error</span> ${esc(primary)}${n.secondaryError ? `; then ${esc(PART[n.secondaryError.part] ?? n.secondaryError.part)}` : ""}</p>
    <p class="notes-line"><span>Said</span> “${esc(n.studentFeedback)}”</p>
    ${g.by ? `<p class="notes-line"><span>Decided by</span> ${esc(RULE[g.by] ?? g.by)}${g.by !== "second-opinion" && !n.accepted ? ", although the score alone would pass" : ""}</p>` : ""}
    <p class="notes-line notes-small"><span>Grader</span> score ${g.score ?? "–"} (accept ≥ ${g.accept ?? "–"}), distance ${g.d2 ?? "–"} (≤ ${g.gate ?? "–"})${g.rival ? `, rival ${esc(g.rival)}` : ""}</p>
    <details class="notes-json"><summary>Record</summary><pre>${esc(JSON.stringify(n, null, 1))}</pre></details>`;
}

/** The panel: `update(notes)` after each graded hold; `show(on)`. */
export function createNotesView(parent) {
  const el = document.createElement("section");
  el.className = "demo-notes";
  el.hidden = true;
  el.setAttribute("aria-label", "What the tutor read on the last hold");
  el.innerHTML = `<h3>What the tutor read <kbd>T</kbd></h3><div class="demo-notes-body">${renderNotes(null)}</div>`;
  parent.append(el);
  const body = el.querySelector(".demo-notes-body");
  let last = null;
  return {
    show(on) { el.hidden = !on; if (on) body.innerHTML = renderNotes(last); },
    get shown() { return !el.hidden; },
    update(notes) { last = notes; if (!el.hidden) body.innerHTML = renderNotes(notes); },
    reset() { last = null; if (!el.hidden) body.innerHTML = renderNotes(null); },
  };
}
