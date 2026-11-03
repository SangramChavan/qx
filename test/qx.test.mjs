import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { buildIndex, answer, suggest } from "../assets/qx-assistant.js";
import { validateEntity, renderEntity, plan, planEntries, esc, jsonForScript, isIndexable } from "../scripts/build.mjs";

const ID = { product: "GD9GGWXP", business: "8M5HS8RG", person: "K56XNYRW", machine: "XKBA6CCG", asset: "3560RN6Q" };
const load = id => JSON.parse(readFileSync(new URL(`../entities/${id}.json`, import.meta.url), "utf8"));
const ask = (type, q) => answer(buildIndex(load(ID[type])), q);
const quoted = r => r.hits.map(h => `${h.label} ${h.title || ""} ${h.text}`).join(" | ").toLowerCase();

// ---- assistant: real questions -> the right source --------------------------------------------
const ANSWERS = [
  ["product", "What is the warranty?", "12 months"],
  ["product", "How heavy is it?", "52 g"],
  ["product", "Can it charge a laptop?", "45 w to 65 w"],
  ["product", "How do I get started?", "usb-c cable"],
  ["product", "Is it safe to use?", "keep it dry"],
  ["business", "What are the opening hours?", "8:00"],
  ["business", "Where are you located?", "example street"],
  ["business", "Where are you?", "example street"],
  ["business", "Do you take bookings?", "groups of 6"],
  ["business", "What services do you offer?", "pastries"],
  ["business", "How do I contact you?", "+1 555 010 0200"],
  ["person", "What is your role?", "product designer"],
  ["person", "Where are you based?", "pune"],
  ["person", "Are you available for freelance work?", "after january"],
  ["person", "What do you work on?", "design systems"],
  ["machine", "What are the safety rules?", "lid while a job"],
  ["machine", "How often should I clean the lens?", "daily"],
  ["machine", "The machine will not start", "emergency stop"],
  ["machine", "What does error E12 mean?", "coolant"],
  ["machine", "What is the laser power?", "60 w"],
  ["asset", "Who is it assigned to?", "design team"],
  ["asset", "Where is it located?", "floor 2"],
  ["asset", "When was it last serviced?", "battery replaced"],
  ["asset", "How do I report a problem?", "asset tag lt-0142"]
];
for (const [type, q, expected] of ANSWERS) {
  test(`${type}: "${q}" is answered from the item`, () => {
    const r = ask(type, q);
    assert.equal(r.kind, "answer", JSON.stringify(r));
    assert.ok(quoted(r).includes(expected.toLowerCase()), `expected "${expected}" in: ${quoted(r)}`);
  });
}

// ---- assistant: it must refuse rather than guess ----------------------------------------------
const REFUSALS = [
  ["product", "What is the price?", "price"],
  ["product", "Does it support wireless charging?", "wireless"],
  ["business", "Do you deliver to my home?", "deliver"],
  ["person", "What is your salary?", "salary"],
  ["machine", "What is the laser wavelength?", "wavelength"],
  ["machine", "Can it cut titanium?", "titanium"],
  ["asset", "What is the operating system version?", "version"],
  ["product", "xyzzy plugh", "xyzzy"]
];
for (const [type, q, word] of REFUSALS) {
  test(`${type}: "${q}" is refused, naming "${word}"`, () => {
    const r = ask(type, q);
    assert.equal(r.kind, "none");
    assert.ok(r.unknown.includes(word), `unknown was ${JSON.stringify(r.unknown)}`);
  });
}

test("an empty or filler-only question gives the overview, not an invented answer", () => {
  for (const q of ["", "tell me about this", "what is this?"]) {
    const r = ask("product", q);
    assert.equal(r.kind, "overview");
    assert.equal(r.hits[0].label, "Overview");
  }
});

test("grounding: every word the assistant quotes exists in the item's own information", () => {
  const w = s => String(s).toLowerCase().match(/[a-z]+|[0-9]+/g) || [];
  const questions = ANSWERS.map(a => [a[0], a[1]]).concat(REFUSALS.map(a => [a[0], a[1]]), [["product", "contact support"], ["business", "bookings and parking"]]);
  for (const [type, q] of questions) {
    const e = load(ID[type]);
    const corpus = new Set(w(JSON.stringify(e).replace(/\\n/g, " ")));  // "\n" escapes would otherwise glue onto the next word
    const r = answer(buildIndex(e), q);
    for (const h of r.hits || []) {
      for (const word of w(`${h.title || ""} ${h.text}`)) {
        assert.ok(corpus.has(word) || /^\d+$/.test(word), `"${word}" in an answer to "${q}" is not in the item`);
      }
    }
  }
});

test("suggested questions always get an answer, and each type has some", () => {
  for (const type of Object.keys(ID)) {
    const idx = buildIndex(load(ID[type]));
    const s = suggest(idx);
    assert.ok(s.length >= 2, `${type} has only ${s.length} suggestions`);
    for (const q of s) assert.equal(answer(idx, q).kind, "answer", q);
  }
});

// ---- generator: validation --------------------------------------------------------------------
const good = () => ({ ...load(ID.product) });
const errs = e => validateEntity(e, "t.json");

test("the five demo entities are valid and the whole set builds", () => {
  const { errors, count } = plan();
  assert.deepEqual(errors, []);
  assert.equal(count, 5);
});

test("unknown fields are rejected, so private data has nowhere to go", () => {
  for (const k of ["private", "password", "token", "visibility", "ownerPhone"]) {
    assert.ok(errs({ ...good(), [k]: "x" }).some(m => m.includes("unknown field")), k);
  }
});

test("links: only safe, well-formed targets are accepted", () => {
  const withAction = (kind, href) => ({ ...good(), actions: [{ kind, label: "x", href }] });
  for (const [kind, href] of [["link", "javascript:alert(1)"], ["link", "http://example.com"], ["link", "https://user:pw@example.com"],
    ["link", "data:text/html,hi"], ["call", "tel:abc"], ["call", "tel:+1 555"], ["email", "mailto:not-an-email"],
    ["whatsapp", "https://evil.example/15550100200"], ["link", "https://exa mple.com"]]) {
    assert.ok(errs(withAction(kind, href)).length > 0, `${kind} ${href} should be rejected`);
  }
  for (const [kind, href] of [["link", "https://example.com/a?b=1"], ["call", "tel:+15550100100"], ["email", "mailto:a@example.com?subject=Hi%20there"],
    ["whatsapp", "https://wa.me/15550100200?text=Hello"]]) {
    assert.deepEqual(errs(withAction(kind, href)), [], `${kind} ${href}`);
  }
});

test("IDs: wrong alphabet, length and mismatched file names are rejected", () => {
  for (const id of ["GD9GGWXI", "GD9GGWXL", "GD9GGWXO", "GD9GGWXU", "gd9ggwxp", "GD9GGWX", "GD9GGWXPP"]) {
    assert.ok(errs({ ...good(), id }).some(m => m.includes("id:")), id);
  }
  const r = planEntries([{ file: "AAAAAAAA.json", data: good() }]);
  assert.ok(r.errors.some(m => m.includes("file name must be")));
});

test("IDs that differ in fewer than 3 characters are rejected", () => {
  const a = { ...good(), id: "GD9GGWXP" }, b = { ...good(), id: "GD9GGWXQ" };
  const r = planEntries([{ file: "GD9GGWXP.json", data: a }, { file: "GD9GGWXQ.json", data: b }]);
  assert.ok(r.errors.some(m => m.includes("at least 3 characters")));
});

test("table rows must match their columns; control characters and bad dates are rejected", () => {
  const t = { title: "T", kind: "table", columns: ["A", "B"], rows: [["only one"]] };
  assert.ok(errs({ ...good(), sections: [t] }).some(m => m.includes("must have 2 cells")));
  assert.ok(errs({ ...good(), title: "bad\u0000title" }).length > 0);
  assert.ok(errs({ ...good(), title: "line\nbreak" }).length > 0);
  assert.ok(errs({ ...good(), updated: "2026-02-30" }).length > 0);
  assert.ok(errs({ ...good(), type: "gadget" }).length > 0);
});

// ---- generator: output safety and content -----------------------------------------------------
const pages = Object.fromEntries(Object.entries(ID).map(([t, id]) => [t, renderEntity(load(id))]));

test("every page has a strict content policy, no inline scripts and no inline styles", () => {
  for (const [t, html] of Object.entries(pages)) {
    assert.ok(html.includes("Content-Security-Policy"), t);
    assert.ok(/script-src 'self'; style-src 'self'/.test(html), t);
    assert.ok(!/\sstyle=/i.test(html), `${t} has an inline style`);
    assert.ok(!/\son[a-z]+\s*=/i.test(html), `${t} has an inline event handler`);
    for (const m of html.matchAll(/<script\b([^>]*)>/g)) {
      assert.ok(/type="application\/(ld\+)?json"|src="\/assets\//.test(m[1]), `${t}: executable inline script ${m[0]}`);
    }
  }
});

test("hostile text cannot break out of the page or its embedded data", () => {
  const evil = { ...load(ID.product), title: "</script><img src=x onerror=alert(1)>", summary: "<b>bold</b> & \"quotes\" \u2028 </script>",
    facts: [{ label: "<i>x</i>", value: "</script><script>alert(1)</script>" }] };
  assert.deepEqual(errs(evil), []);
  const html = renderEntity(evil);
  assert.ok(!html.includes("<img src=x"));
  assert.ok(!html.includes("<script>alert(1)"));
  assert.equal(html.split("</script>").length - 1, 3, "only the page's own three script tags may close");
  const data = JSON.parse(html.match(/id="qx-data">([\s\S]*?)<\/script>/)[1]);
  assert.equal(data.title, evil.title, "embedded data must round-trip exactly");
});

test("core information is in the raw HTML, so it works with no JavaScript", () => {
  assert.ok(pages.product.includes("20 W USB-C Power Delivery") && pages.product.includes("Getting started"));
  assert.ok(pages.business.includes("Mon–Sat 8:00–20:00") && pages.business.includes('href="tel:+15550100200"'));
  assert.ok(pages.machine.includes("Troubleshooting") && pages.machine.includes("Twist the red button"));
  assert.ok(pages.asset.includes("Serviced by IT") && pages.asset.includes("Report an issue"));
});

test("each type gets its own layout, not one generic page", () => {
  assert.ok(pages.person.includes('class="avatar"') && pages.person.includes("contact.vcf"));
  assert.ok(pages.machine.indexOf("callout") < pages.machine.indexOf("Machine details"), "machine: safety comes first");
  assert.ok(pages.product.indexOf("Specifications") < pages.product.indexOf("Getting started"), "product: specs come first");
  assert.ok(pages.business.indexOf("Services") < pages.business.indexOf("Hours and details"), "business: services come first");
  assert.ok(pages.asset.includes('class="timeline"') && pages.asset.includes('class="status"'));
});

test("private-by-default types are noindex and left out of the sitemap", () => {
  const { files } = plan();
  for (const t of ["person", "machine", "asset"]) assert.ok(pages[t].includes('name="robots" content="noindex"'), t);
  for (const t of ["product", "business"]) assert.ok(!pages[t].includes("noindex"), t);
  for (const t of ["person", "machine", "asset"]) assert.ok(!files["sitemap.xml"].includes(ID[t]), t);
  for (const t of ["product", "business"]) assert.ok(files["sitemap.xml"].includes(ID[t]), t);
  assert.ok(isIndexable({ type: "person", indexable: true }), "an owner can opt in");
});

test("llms.txt lists indexable items with their data links, and leaves out private-by-default ones", () => {
  const { files } = plan();
  const txt = files["llms.txt"];
  for (const t of ["product", "business"]) assert.ok(txt.includes(`${ID[t]}/entity.json`), t);
  for (const t of ["person", "machine", "asset"]) assert.ok(!txt.includes(ID[t]), t);
  assert.ok(txt.startsWith("# QX\n"));
});

const services = () => ({
  id: "S7V3N9ZR", type: "services", title: "Quick Fix Plumbing", subtitle: "Home repairs across Pune (demo service)",
  summary: "Emergency and scheduled plumbing repairs for homes and small offices. This is a demonstration page showing how a QX opens a service.",
  facts: [{ label: "Service area", value: "Pune and nearby suburbs" }, { label: "Response time", value: "Within 4 hours" }],
  sections: [{ title: "What is included", kind: "list", items: ["Leak repair", "Tap and fixture fitting"] }],
  faqs: [{ q: "Do you work on weekends?", a: "Yes, from 9:00 to 17:00." }],
  actions: [{ kind: "call", label: "Call us", href: "tel:+15550100400" }], updated: "2026-11-03"
});

test("services pages validate, render, are indexed and carry Service data", () => {
  assert.deepEqual(validateEntity(services(), "t.json"), []);
  const html = renderEntity(services());
  assert.ok(html.includes('class="t-services"') && html.includes("Ask about this service"));
  assert.ok(!html.includes('name="robots" content="noindex"'), "services pages are indexed like businesses");
  assert.ok(html.includes('"@type":"Service"') && html.includes('"areaServed":"Pune and nearby suburbs"'));
  const demos = Object.values(ID).map(id => ({ file: `${id}.json`, data: load(id) }));
  const { files, errors } = planEntries([...demos, { file: "S7V3N9ZR.json", data: services() }]);
  assert.deepEqual(errors, []);
  assert.ok(files["sitemap.xml"].includes("S7V3N9ZR") && files["llms.txt"].includes("S7V3N9ZR/entity.json"));
});

test("person pages ship a vCard", () => {
  const { files } = plan();
  const v = files[`e/${ID.person}/contact.vcf`];
  assert.ok(v.startsWith("BEGIN:VCARD\r\n") && v.includes("FN:Asha Rao") && v.includes("TEL;TYPE=CELL:+15550100300") && v.endsWith("END:VCARD\r\n"));
});

test("helpers escape correctly", () => {
  assert.equal(esc(`<a href="x">&'`), "&lt;a href=&quot;x&quot;&gt;&amp;&#39;");
  const j = jsonForScript({ a: "</script><!--&\u2028" });
  assert.ok(!/[<>&\u2028]/.test(j));
  assert.deepEqual(JSON.parse(j), { a: "</script><!--&\u2028" });
});
