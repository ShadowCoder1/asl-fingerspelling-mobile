/* meters.js: one meter per finger (JT, 19 Oct 2026, thinking it through: "every finger had a score, and you can see like
 * a meter for each finger, and you want each finger's score to hit top of the meter"). Off unless ?meters=1 or M.
 *
 * Laid out like the five-finger display of Ghavampour et al. 2025 (J Neurophysiol; Diedrichsen lab: a column per
 * finger, thumb to pinky, a target band, all fingers in their bands at once is the shape), plus the two things a
 * handshape has that are not one finger: the gaps between the fingers and which way the hand points.
 *
 * WHAT A METER SAYS. Its level is tutor/feedback.js blockLevels: how much fixing that part alone would raise the grade,
 * on blame's own scale -- full (in the band) when the part is not what is holding the letter back. Not each finger's
 * likeness on its own: on the fluent signers' signs an S's thumb is a perfectly typical A thumb, and only the grader's
 * comparison of the whole hand tells them apart. So the meters agree with the grader by construction: when it accepts,
 * every meter is in the band; the part the words name is never shown in the band; and inside the band a meter sits
 * still (tracking noise never moves a part that is fine -- Lee & Carnahan 1990's bandwidth feedback, and Fidalgo et al.
 * 2025's learners disliked bars that were never full). No red anywhere: amber is "change this".
 *
 * The panel is HTML laid over the camera view (outside its mirrored box, so the words read the right way round), on
 * the side away from where the hand goes. */

export const METER_PARTS = Object.freeze(["thumb", "index", "middle", "ring", "pinky", "spread", "orientation"]);
const LABEL = { thumb: "Thumb", index: "Index", middle: "Middle", ring: "Ring", pinky: "Pinky", spread: "Gaps", orientation: "Turn" };
const DIR_WORD = { bend: "bend", straighten: "straighten", apart: "apart", together: "together", cross: "cross" };
export const METER_EASE = 0.35;   // how fast a meter follows (per frame), so it moves smoothly but promptly

/* A part in range fills its column to the top, into the band; a part that is not stops short of the band (BELOW_BAND
 * of the way up at most), so "in the band" and "green" are one and the same thing. */
export const BELOW_BAND = 0.8;
export const NAMED_MIN = 0.14;

/** The state of one meter, from the coach's levels and its settled look: its height (0..1), tone, and the way to move.
 * Pure. */
export function meterState(part, levels, look) {
  if (levels === "accepted" || look?.state === "match" || look?.state === "accepted") return { level: 1, tone: "good", dir: null };
  // a hand that is another letter with no one part to change: per-part levels would mislead (each is judged with the
  // rest of the hand as it is -- an L's straight index reads as wrong for B while the others are curled), so the panel
  // greys out and the words ("Looks like L.") carry it
  if (look?.looksLike && look.state !== "fix") return { level: 0, tone: "idle", dir: null };
  const v = levels?.[part];
  if (!v) return { level: 0, tone: "idle", dir: null };
  const named = look?.state === "fix" && look.blocks.includes(part);
  const height = v.level >= 1 && !named ? 1 : BELOW_BAND * Math.min(v.level, 1);
  // the part being named always shows a little amber, however far off it is
  if (named) return { level: Math.max(height, NAMED_MIN), tone: "fix", dir: DIR_WORD[v.dir] ?? null };
  return { level: height, tone: height >= 1 ? "good" : "off", dir: null };
}

/**
 * @param {HTMLElement} stage  #stage
 * @param {{hand?: "right"|"left"}} [o]
 */
export function createMeters(stage, { hand = "right" } = {}) {
  const el = document.createElement("div");
  el.className = `demo-meters demo-meters-${hand === "left" ? "right" : "left"}`;
  el.hidden = true;
  el.setAttribute("role", "img");
  el.setAttribute("aria-label", "How close each finger is to the letter");
  el.innerHTML = METER_PARTS.map((p) => `
    <div class="meter${p === "spread" ? " meter-gap-before" : ""}" data-part="${p}" data-tone="idle">
      <div class="meter-track"><div class="meter-band"></div><div class="meter-fill"></div></div>
      <span class="meter-label">${LABEL[p]}</span><span class="meter-dir"></span>
    </div>`).join("");
  stage.append(el);
  const cols = Object.fromEntries(METER_PARTS.map((p) => {
    const c = el.querySelector(`[data-part="${p}"]`);
    return [p, { c, fill: c.querySelector(".meter-fill"), dir: c.querySelector(".meter-dir"), level: 0, tone: "idle", word: "" }];
  }));
  return {
    show(on) { el.hidden = !on; },
    /* Stand aside (J and Z have no finger levels): the panel is hidden while on, without turning the meters off. */
    idle(on) { el.classList.toggle("demo-meters-aside", !!on); },
    get shown() { return !el.hidden; },
    update(levels, look) {
      if (el.hidden) return;
      for (const p of METER_PARTS) {
        const m = cols[p], s = meterState(p, levels, look);
        m.level += METER_EASE * (s.level - m.level);
        if (Math.abs(m.level - s.level) < 0.005) m.level = s.level;
        m.fill.style.transform = `scaleY(${m.level.toFixed(3)})`;
        if (m.tone !== s.tone) { m.tone = s.tone; m.c.dataset.tone = s.tone; }
        const word = s.dir ?? "";
        if (m.word !== word) { m.word = word; m.dir.textContent = word; }
      }
    },
    reset() { for (const p of METER_PARTS) { cols[p].level = 0; } },
  };
}
