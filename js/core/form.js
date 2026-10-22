/* form.js: builds the demographics form from questions.js.
 *
 * You should not need to edit this file. To change what is asked, edit
 * questions.js. */

/**
 * Draw the questions into a container element.
 *
 * @param {HTMLElement} container
 * @param {Array<object>} questions  the list from questions.js
 * @param {object} prefill           values to fill in, keyed by question id
 */
export function renderForm(container, questions, prefill = {}) {
  container.innerHTML = "";

  for (const q of questions) {
    if (!q?.id || !q?.label) {
      console.warn("Skipping a question with no id or no label:", q);
      continue;
    }

    // A section title between questions (and an optional note under it): nothing to answer.
    if (q.type === "heading") {
      const h = document.createElement("h3");
      h.className = "q-heading";
      h.textContent = q.label;
      container.append(h);
      if (q.help) {
        const note = document.createElement("p");
        note.className = "q-help";
        note.textContent = q.help;
        container.append(note);
      }
      continue;
    }

    const field = document.createElement("div");
    field.className = "q";
    field.dataset.qid = q.id;

    const label = document.createElement("label");
    label.setAttribute("for", `q-${q.id}`);
    label.innerHTML = q.required
      ? `${escapeHtml(q.label)} <span class="req" aria-hidden="true">*</span>`
      : escapeHtml(q.label);
    field.append(label);

    if (q.help) {
      const help = document.createElement("p");
      help.className = "q-help";
      help.textContent = q.help;
      field.append(help);
    }

    field.append(buildInput(q, prefill[q.id]));

    const error = document.createElement("p");
    error.className = "q-error";
    error.id = `err-${q.id}`;
    error.hidden = true;
    field.append(error);

    container.append(field);
  }
}

function buildInput(q, value) {
  const name = `q-${q.id}`;

  switch (q.type) {
    case "select": {
      const el = document.createElement("select");
      el.id = name;
      el.append(new Option(q.placeholder ?? "Select...", "", value == null, value == null));
      el.firstChild.disabled = true;
      for (const opt of q.options ?? []) {
        el.append(new Option(opt, opt, false, opt === value));
      }
      return el;
    }

    case "radio":
    case "checkboxes": {
      const group = document.createElement("div");
      group.className = "q-group";
      group.id = name;
      const many = q.type === "checkboxes";
      const chosen = many ? (Array.isArray(value) ? value : []) : [value];
      for (const [i, opt] of (q.options ?? []).entries()) {
        const row = document.createElement("label");
        row.className = "q-choice";
        const input = document.createElement("input");
        input.type = many ? "checkbox" : "radio";
        input.name = name;
        input.value = opt;
        input.id = `${name}-${i}`;
        input.checked = chosen.includes(opt);
        row.append(input, document.createTextNode(" " + opt));
        group.append(row);
      }
      return group;
    }

    case "textarea": {
      const el = document.createElement("textarea");
      el.id = name;
      el.rows = 3;
      if (q.placeholder) el.placeholder = q.placeholder;
      if (value != null) el.value = value;
      return el;
    }

    case "range": {
      // A slider has a value from the start, so it would always look answered.
      // It counts as unanswered until the participant moves it (data-touched),
      // and says so beside it; the value is never a default nobody chose.
      const wrap = document.createElement("div");
      wrap.className = "q-range";
      const el = document.createElement("input");
      el.type = "range";
      el.id = name;
      el.min = q.min ?? 0;
      el.max = q.max ?? 100;
      el.step = q.step ?? 1;
      const out = document.createElement("output");
      out.htmlFor = name;
      const show = () => { out.textContent = el.dataset.touched === "1" ? `${el.value}${q.unit ? ` ${q.unit}` : ""}` : "Drag to answer"; };
      if (value != null) { el.value = value; el.dataset.touched = "1"; } else { el.dataset.touched = "0"; }
      // "input" while dragging, "change" when let go (and from the keyboard): either one is an answer.
      const touch = () => {
        el.dataset.touched = "1";
        show();
        // answered now: clear an earlier "Please answer this question."
        const field = el.closest(".q");
        field?.classList.remove("bad-field");
        const err = field?.querySelector(".q-error");
        if (err) err.hidden = true;
      };
      el.addEventListener("input", touch);
      el.addEventListener("change", touch);
      show();
      wrap.append(el, out);
      return wrap;
    }

    case "number": {
      const el = document.createElement("input");
      el.type = "number";
      el.id = name;
      el.inputMode = "numeric";
      if (q.min != null) el.min = q.min;
      if (q.max != null) el.max = q.max;
      if (q.placeholder) el.placeholder = q.placeholder;
      if (value != null) el.value = value;
      return el;
    }

    default: {
      const el = document.createElement("input");
      el.type = "text";
      el.id = name;
      el.autocomplete = "off";
      if (q.placeholder) el.placeholder = q.placeholder;
      if (value != null) el.value = value;
      return el;
    }
  }
}

/**
 * Read the form back.
 * @returns {{ok: boolean, values: object, firstError: string|null}}
 *          When ok is false the offending fields already show their message.
 */
export function readForm(container, questions) {
  const values = {};
  let firstError = null;

  for (const q of questions) {
    if (!q?.id || !q?.label || q.type === "heading") continue;

    const value = readOne(q);
    const problem = validate(q, value);

    const errorEl = container.querySelector(`#err-${CSS.escape(q.id)}`);
    const fieldEl = container.querySelector(`[data-qid="${CSS.escape(q.id)}"]`);
    if (problem) {
      if (errorEl) { errorEl.textContent = problem; errorEl.hidden = false; }
      fieldEl?.classList.add("bad-field");
      if (!firstError) firstError = q.id;
    } else {
      if (errorEl) errorEl.hidden = true;
      fieldEl?.classList.remove("bad-field");
      // Leave blank optional answers out of the data rather than storing "".
      if (value !== "" && value != null && !(Array.isArray(value) && !value.length)) {
        values[q.id] = value;
      }
    }
  }

  return { ok: firstError === null, values, firstError };
}

function readOne(q) {
  const name = `q-${q.id}`;

  if (q.type === "checkboxes") {
    return [...document.querySelectorAll(`input[name="${name}"]:checked`)]
      .map((i) => i.value);
  }
  if (q.type === "radio") {
    return document.querySelector(`input[name="${name}"]:checked`)?.value ?? "";
  }

  const el = document.getElementById(name);
  if (!el) return "";
  if (q.type === "range") return el.dataset.touched === "1" ? Number(el.value) : "";
  const raw = el.value.trim();
  if (q.type === "number") return raw === "" ? "" : Number(raw);
  return raw;
}

function validate(q, value) {
  const empty = value === "" || value == null ||
                (Array.isArray(value) && value.length === 0);

  if (q.required && empty) return "Please answer this question.";
  if (empty) return null;

  if (q.pattern && !new RegExp(q.pattern).test(String(value).trim())) return q.patternMessage ?? "Please check this answer.";
  if (q.type === "number" || q.type === "range") {
    if (!Number.isFinite(value)) return "Please enter a number.";
    if (q.min != null && value < q.min) return `Please enter ${q.min} or more.`;
    if (q.max != null && value > q.max) return `Please enter ${q.max} or less.`;
  }
  return null;
}

/** Scroll to a field and focus it, so a long form does not hide its own errors. */
export function focusField(container, id) {
  const field = container.querySelector(`[data-qid="${CSS.escape(id)}"]`);
  field?.scrollIntoView({ behavior: "smooth", block: "center" });
  field?.querySelector("input, select, textarea")?.focus({ preventScroll: true });
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}
