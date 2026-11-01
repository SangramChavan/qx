// Wires the "Ask about this item" box. Reads the page's own data; makes no network requests.
import { buildIndex, answer, suggest } from "/assets/qx-assistant.js";

const dataEl = document.getElementById("qx-data");
const ask = document.getElementById("ask");

if (dataEl && ask) {
  const entity = JSON.parse(dataEl.textContent);
  const index = buildIndex(entity);
  const form = ask.querySelector("form");
  const input = ask.querySelector("input");
  const out = ask.querySelector(".answers");
  const chips = ask.querySelector(".suggest");
  const SAFE_HREF = /^(https:|tel:|mailto:)/;

  const el = (tag, cls, text) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;  // textContent only: entity text is never parsed as HTML
    return n;
  };
  const button = a => {
    const link = el("a", "btn", a.label);
    if (SAFE_HREF.test(a.href)) link.href = a.href;
    return link;
  };

  function render(question) {
    const res = answer(index, question);
    const box = el("div", "answer" + (res.kind === "none" ? " none" : ""));
    box.append(el("div", "q", question));
    if (res.kind === "none") {
      const missing = res.unknown.length ? res.unknown.map(w => `“${w}”`).join(", ") : "";
      box.append(el("p", "", missing
        ? `Nothing about ${missing} in this item's information.`
        : "This item's information doesn't answer that directly."));
      const contact = (entity.actions || []).filter(a => /^(tel:|mailto:|https:\/\/wa\.me\/)/.test(a.href)).slice(0, 2);
      if (contact.length) { box.append(el("p", "from", "You can ask the owner:")); contact.forEach(a => box.append(button(a))); }
    } else {
      for (const hit of res.hits) {
        const part = el("div");
        part.append(el("div", "from", `From: ${hit.label}`));
        if (hit.title) part.append(el("div", "q", hit.title));
        if (!hit.action || hit.text !== hit.action.label) part.append(el("p", "", hit.text));  // a bare button needs no caption
        if (hit.action) part.append(button(hit.action));
        box.append(part);
      }
    }
    out.prepend(box);
    while (out.children.length > 5) out.lastChild.remove();
  }

  const run = q => { const t = q.trim(); if (t) { render(t); input.value = ""; } };
  form.addEventListener("submit", e => { e.preventDefault(); run(input.value); });
  for (const q of suggest(index)) {
    const li = el("li");
    const b = el("button", "", q);
    b.type = "button";
    b.addEventListener("click", () => run(q));
    li.append(b);
    chips.append(li);
  }

  ask.hidden = false;
  document.querySelectorAll("[data-needs-js]").forEach(n => { n.hidden = false; });
}
