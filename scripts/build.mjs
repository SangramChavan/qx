#!/usr/bin/env node
// Builds the static QX pages from entities/*.json. No dependencies.
//   node scripts/build.mjs            write e/<ID>/..., sitemap.xml
// Everything in entities/ is published on a public site: there is deliberately no field for private data.
import { readFileSync, writeFileSync, mkdirSync, rmSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const ORIGIN = "https://qx.tapinhere.com";
const ALPHABET = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";  // Crockford base32, same as Tap In Here tag codes
export const ID_RE = new RegExp(`^[${ALPHABET}]{8}$`);

export const TYPES = {
  product:  { label: "Product",  noun: "product",  indexable: true,  ld: "Product",       facts: "Specifications",      order: ["facts", "sections", "documents", "faqs"] },
  business: { label: "Business", noun: "business", indexable: true,  ld: "LocalBusiness", facts: "Hours and details",   order: ["sections", "facts", "faqs"] },
  person:   { label: "Person",   noun: "person",   indexable: false, ld: "Person",        facts: "Details",             order: ["sections", "facts", "faqs"] },
  machine:  { label: "Machine",  noun: "machine",  indexable: false, ld: "Product",       facts: "Machine details",     order: ["safety", "facts", "sections", "documents", "faqs"] },
  asset:    { label: "Asset",    noun: "asset",    indexable: false, ld: "Thing",         facts: "Asset details",       order: ["facts", "records", "sections", "faqs"] }
};
const ALLOWED_KEYS = new Set(["id", "type", "title", "subtitle", "summary", "badges", "brand", "model", "facts", "sections", "documents", "faqs", "records", "actions", "updated", "indexable"]);
const SECTION_KINDS = new Set(["text", "list", "steps", "callout", "table"]);
const ACTION_KINDS = new Set(["call", "whatsapp", "email", "directions", "link", "vcard"]);
const QUERY = "(\\?[A-Za-z0-9%._~!$&'()*+,;=:@/-]*)?";
const HREF_RULES = {
  call: /^tel:\+?[0-9]{6,15}$/,
  email: new RegExp(`^mailto:[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}${QUERY}$`),
  whatsapp: new RegExp(`^https://wa\\.me/[0-9]{6,15}${QUERY}$`)
};
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;  // tab and newline are checked separately
const isDate = s => typeof s === "string" && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + "T00:00:00Z")) && new Date(s + "T00:00:00Z").toISOString().startsWith(s);

export function hamming(a, b) {
  let d = Math.abs(a.length - b.length);
  for (let i = 0; i < Math.min(a.length, b.length); i++) if (a[i] !== b[i]) d++;
  return d;
}

// ---- validation -------------------------------------------------------------------------------
export function validateEntity(e, file = "") {
  const errs = [];
  const bad = (path, msg) => errs.push(`${file} ${path}: ${msg}`.trim());
  const str = (v, path, min, max, { multiline = false } = {}) => {
    if (typeof v !== "string") return bad(path, "must be a string");
    if (v.length < min || v.length > max) return bad(path, `length must be ${min}-${max}`);
    if (CONTROL.test(v) || (!multiline && /[\n\t]/.test(v))) bad(path, "contains control characters or line breaks");
  };
  const arr = (v, path, max) => { if (!Array.isArray(v)) { bad(path, "must be an array"); return []; } if (v.length > max) bad(path, `at most ${max} items`); return v.slice(0, max); };

  if (!e || typeof e !== "object" || Array.isArray(e)) return [`${file}: must be a JSON object`];
  for (const k of Object.keys(e)) {
    if (!ALLOWED_KEYS.has(k)) bad(k, "unknown field (QX pages are public: there is no field for private data)");
  }
  if (!ID_RE.test(e.id || "")) bad("id", "must be 8 characters from 0-9 A-H J K M N P-T V-Z (no I, L, O, U)");
  if (!TYPES[e.type]) bad("type", `must be one of ${Object.keys(TYPES).join(", ")}`);
  str(e.title, "title", 1, 100);
  if (e.subtitle !== undefined) str(e.subtitle, "subtitle", 1, 140);
  str(e.summary, "summary", 1, 600);
  for (const k of ["brand", "model"]) if (e[k] !== undefined) str(e[k], k, 1, 80);
  if (!isDate(e.updated)) bad("updated", "must be a real date YYYY-MM-DD");
  if (e.indexable !== undefined && typeof e.indexable !== "boolean") bad("indexable", "must be true or false");

  if (e.badges !== undefined) arr(e.badges, "badges", 6).forEach((b, i) => str(b, `badges[${i}]`, 1, 40));
  if (e.facts !== undefined) arr(e.facts, "facts", 60).forEach((f, i) => {
    str(f?.label, `facts[${i}].label`, 1, 60); str(f?.value, `facts[${i}].value`, 1, 300);
  });
  if (e.sections !== undefined) arr(e.sections, "sections", 20).forEach((s, i) => {
    const p = `sections[${i}]`;
    str(s?.title, `${p}.title`, 1, 80);
    if (!SECTION_KINDS.has(s?.kind)) return bad(`${p}.kind`, `must be one of ${[...SECTION_KINDS].join(", ")}`);
    if (s.role !== undefined && !/^[a-z]{1,20}$/.test(s.role)) bad(`${p}.role`, "must be lowercase letters");
    if (s.kind === "table") {
      const cols = arr(s.columns, `${p}.columns`, 6);
      if (cols.length < 2) bad(`${p}.columns`, "needs at least 2 columns");
      cols.forEach((c, j) => str(c, `${p}.columns[${j}]`, 1, 40));
      arr(s.rows, `${p}.rows`, 50).forEach((r, j) => {
        if (!Array.isArray(r) || r.length !== cols.length) return bad(`${p}.rows[${j}]`, `must have ${cols.length} cells`);
        r.forEach((c, k) => str(c, `${p}.rows[${j}][${k}]`, 1, 300));
      });
    } else {
      const items = arr(s.items, `${p}.items`, 50);
      if (!items.length) bad(`${p}.items`, "needs at least one item");
      items.forEach((it, j) => str(it, `${p}.items[${j}]`, 1, 600));
    }
  });
  if (e.documents !== undefined) arr(e.documents, "documents", 10).forEach((d, i) => {
    str(d?.title, `documents[${i}].title`, 1, 80); str(d?.text, `documents[${i}].text`, 1, 8000, { multiline: true });
  });
  if (e.faqs !== undefined) arr(e.faqs, "faqs", 30).forEach((f, i) => {
    str(f?.q, `faqs[${i}].q`, 1, 200); str(f?.a, `faqs[${i}].a`, 1, 1000);
  });
  if (e.records !== undefined) arr(e.records, "records", 50).forEach((r, i) => {
    if (!isDate(r?.date)) bad(`records[${i}].date`, "must be a real date YYYY-MM-DD");
    str(r?.text, `records[${i}].text`, 1, 300);
  });
  if (e.actions !== undefined) arr(e.actions, "actions", 8).forEach((a, i) => {
    const p = `actions[${i}]`;
    if (!ACTION_KINDS.has(a?.kind)) return bad(`${p}.kind`, `must be one of ${[...ACTION_KINDS].join(", ")}`);
    str(a.label, `${p}.label`, 1, 40);
    if (a.kind === "vcard") {
      if (e.type !== "person") bad(p, "vcard is only for person pages");
      if (a.href !== undefined) bad(`${p}.href`, "is generated automatically");
    } else if (typeof a.href !== "string") bad(`${p}.href`, "must be a string");
    else if (HREF_RULES[a.kind]) { if (!HREF_RULES[a.kind].test(a.href)) bad(`${p}.href`, `is not a valid ${a.kind} link`); }
    else {
      try {
        const u = new URL(a.href);
        if (u.protocol !== "https:" || u.username || u.password || !u.hostname || /\s/.test(a.href) || a.href.length > 500) bad(`${p}.href`, "must be a plain https:// URL");
      } catch { bad(`${p}.href`, "must be a plain https:// URL"); }
    }
  });
  if (JSON.stringify(e).length > 60000) bad("(entity)", "is larger than 60 KB");
  return errs;
}

export function normalizeEntity(e) {
  return { ...e, actions: (e.actions || []).map(a => a.kind === "vcard" ? { ...a, href: `/e/${e.id}/contact.vcf` } : a) };
}

// ---- rendering --------------------------------------------------------------------------------
export const esc = s => String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
// Safe to place inside <script type="application/json">: nothing can close the tag or inject markup
export const jsonForScript = o => JSON.stringify(o).replace(/</g, "\\u003c").replace(/>/g, "\\u003e").replace(/&/g, "\\u0026").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");

const fact = (e, re) => (e.facts || []).find(f => re.test(f.label))?.value;
const initials = t => t.split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join("");
const shorten = (s, n) => s.length <= n ? s : s.slice(0, n - 1).replace(/\s+\S*$/, "") + "…";

function button(a, primary) {
  const ext = a.href.startsWith("https:") ? ' rel="noopener noreferrer"' : "";
  const dl = a.kind === "vcard" ? " download" : "";
  return `<a class="btn${primary ? " primary" : ""}" href="${esc(a.href)}"${ext}${dl}>${esc(a.label)}</a>`;
}

const paras = text => text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).map(p => `<p>${esc(p)}</p>`).join("");

function sectionBlock(s) {
  const h = `<h2>${esc(s.title)}</h2>`;
  switch (s.kind) {
    case "text": return `<section class="block">${h}<div class="card prose">${s.items.map(p => `<p>${esc(p)}</p>`).join("")}</div></section>`;
    case "list": return `<section class="block">${h}<div class="card"><ul class="list">${s.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul></div></section>`;
    case "steps": return `<section class="block">${h}<div class="card"><ol class="steps">${s.items.map(i => `<li>${esc(i)}</li>`).join("")}</ol></div></section>`;
    case "callout": return `<section class="block callout" role="note">${h}<ul>${s.items.map(i => `<li>${esc(i)}</li>`).join("")}</ul></section>`;
    default: return `<section class="block">${h}<div class="card tablewrap"><table><thead><tr>${s.columns.map(c => `<th scope="col">${esc(c)}</th>`).join("")}</tr></thead><tbody>${s.rows.map(r => `<tr>${r.map(c => `<td>${esc(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div></section>`;
  }
}

function blocks(e) {
  const t = TYPES[e.type];
  const safetyFirst = t.order.includes("safety");
  const secs = (e.sections || []).filter(s => !(safetyFirst && s.role === "safety"));
  const make = {
    safety: () => (e.sections || []).filter(s => s.role === "safety").map(sectionBlock).join(""),
    facts: () => e.facts?.length ? `<section class="block"><h2>${t.facts}</h2><div class="card"><dl class="facts">${e.facts.map(f => `<dt>${esc(f.label)}</dt><dd>${esc(f.value)}</dd>`).join("")}</dl></div></section>` : "",
    sections: () => secs.map(sectionBlock).join(""),
    documents: () => (e.documents || []).map(d => `<section class="block"><h2>${esc(d.title)}</h2><div class="card prose">${paras(d.text)}</div></section>`).join(""),
    faqs: () => e.faqs?.length ? `<section class="block"><h2>Frequently asked questions</h2><div class="card">${e.faqs.map(f => `<details class="faq"><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join("")}</div></section>` : "",
    records: () => e.records?.length ? `<section class="block"><h2>History</h2><div class="card"><ol class="timeline">${[...e.records].sort((a, b) => b.date.localeCompare(a.date)).map(r => `<li><time datetime="${esc(r.date)}">${esc(r.date)}</time><span>${esc(r.text)}</span></li>`).join("")}</ol></div></section>` : ""
  };
  return t.order.map(k => make[k]()).join("\n");
}

function jsonLd(e) {
  const url = `${ORIGIN}/e/${e.id}/`;
  const ld = { "@context": "https://schema.org", "@type": TYPES[e.type].ld, name: e.title, description: e.summary, url };
  const tel = (e.actions || []).find(a => a.kind === "call")?.href.slice(4);
  if (e.type === "product" || e.type === "machine") {
    if (e.brand) ld.brand = { "@type": "Brand", name: e.brand };
    if (e.model) ld.model = e.model;
    const serial = fact(e, /^serial/i); if (serial) ld.serialNumber = serial;
  }
  if (e.type === "business") { if (tel) ld.telephone = tel; const a = fact(e, /address/i); if (a) ld.address = a; }
  if (e.type === "person") { const r = fact(e, /^role$/i); if (r) ld.jobTitle = r; }
  return ld;
}

export function isIndexable(e) { return e.indexable ?? TYPES[e.type].indexable; }

export function renderEntity(raw) {
  const e = normalizeEntity(raw);
  const t = TYPES[e.type];
  const url = `${ORIGIN}/e/${e.id}/`;
  const desc = shorten(e.summary, 155);
  const title = `${e.title} · QX`;
  const actions = (e.actions || []).map((a, i) => button(a, i === 0)).join("");
  const status = e.type === "asset" ? fact(e, /^status$/i) : "";
  const csp = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<meta name="theme-color" content="#FF4500">
${isIndexable(e) ? "" : '<meta name="robots" content="noindex">\n'}<link rel="canonical" href="${url}">
<link rel="icon" href="/assets/tap-in-here.svg" type="image/svg+xml">
<link rel="stylesheet" href="/assets/qx.css">
<meta property="og:type" content="website">
<meta property="og:site_name" content="QX by Tap In Here">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${url}">
<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<script type="application/ld+json">${jsonForScript(jsonLd(e))}</script>
</head>
<body class="t-${e.type}">
<a class="skip" href="#main">Skip to content</a>
<div class="wrap">
<header class="top">
  <a class="brand" href="https://tapinhere.com"><img src="/assets/tap-in-here.svg" alt="" width="28" height="28"><span>Tap In Here</span></a>
  <span class="chip">${t.label}</span>
</header>
<main id="main">
  <section class="hero">
    ${e.type === "person" ? `<div class="avatar" aria-hidden="true">${esc(initials(e.title))}</div>` : ""}
    <h1>${esc(e.title)}</h1>
    ${e.subtitle || status ? `<p class="sub">${e.subtitle ? esc(e.subtitle) : ""}${status ? `<span class="status">${esc(status)}</span>` : ""}</p>` : ""}
    <p class="summary">${esc(e.summary)}</p>
    ${e.badges?.length ? `<ul class="badges">${e.badges.map(b => `<li>${esc(b)}</li>`).join("")}</ul>` : ""}
    <div class="actions">${actions}<a class="btn" href="#ask" data-needs-js hidden>Ask a question</a></div>
  </section>
  <section class="ask" id="ask" aria-labelledby="ask-h" hidden>
    <h2 id="ask-h">Ask about this ${t.noun}</h2>
    <p class="hint">Answers are quoted from the information on this page. Nothing you type is sent anywhere.</p>
    <form><input type="text" name="q" placeholder="Type a question" aria-label="Your question" autocomplete="off" maxlength="200"><button class="btn primary" type="submit">Ask</button></form>
    <ul class="suggest"></ul>
    <div class="answers" aria-live="polite"></div>
  </section>
  <noscript><p class="foot">Questions need JavaScript. Everything on this page is shown here without it.</p></noscript>
${blocks(e)}
</main>
<footer class="foot">
  <p>Information provided by the owner of this QX. Last updated ${esc(e.updated)}.</p>
  <p><a href="https://tapinhere.com">Tap In Here</a> · <a href="/">About QX</a> · Open source (MIT)</p>
</footer>
</div>
<script type="application/json" id="qx-data">${jsonForScript(e)}</script>
<script type="module" src="/assets/qx-page.js"></script>
</body>
</html>
`;
}

function vcard(e) {
  const v = s => String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n");
  const parts = e.title.trim().split(/\s+/);
  const family = parts.length > 1 ? parts.pop() : "";
  const tel = e.actions.find(a => a.kind === "call")?.href.slice(4);
  const mail = e.actions.find(a => a.kind === "email")?.href.slice(7).split("?")[0];
  const site = e.actions.find(a => a.kind === "link")?.href;
  const role = fact(e, /^role$/i);
  const lines = ["BEGIN:VCARD", "VERSION:3.0", `FN:${v(e.title)}`, `N:${v(family)};${v(parts.join(" "))};;;`,
    role && `TITLE:${v(role)}`, tel && `TEL;TYPE=CELL:${tel}`, mail && `EMAIL:${v(mail)}`, site && `URL:${site}`, "END:VCARD"];
  return lines.filter(Boolean).join("\r\n") + "\r\n";
}

// ---- build ------------------------------------------------------------------------------------
// Returns { files: { relativePath: content }, errors: [...] } without touching disk.
export function plan(entityDir = join(ROOT, "entities")) {
  const errors = [], entries = [];
  for (const f of readdirSync(entityDir).filter(f => f.endsWith(".json") && !f.startsWith("_")).sort()) {
    try { entries.push({ file: f, data: JSON.parse(readFileSync(join(entityDir, f), "utf8")) }); }
    catch (err) { errors.push(`${f}: invalid JSON (${err.message})`); }
  }
  const out = planEntries(entries);
  out.errors.unshift(...errors);
  return out;
}

// Pure: takes [{ file, data }] and returns { files, errors, count } without touching the disk
export function planEntries(entries) {
  const errors = [], entities = [];
  for (const { file: f, data: e } of entries) {
    const errs = validateEntity(e, f);
    if (e?.id && f !== `${e.id}.json`) errs.push(`${f}: file name must be ${e.id}.json`);
    if (errs.length) errors.push(...errs); else entities.push(e);
  }
  for (let i = 0; i < entities.length; i++) for (let j = i + 1; j < entities.length; j++) {
    if (hamming(entities[i].id, entities[j].id) < 3) errors.push(`${entities[i].id} and ${entities[j].id}: IDs must differ in at least 3 characters (a misprint must not land on another item)`);
  }
  const files = {};
  for (const e of entities) {
    files[`e/${e.id}/index.html`] = renderEntity(e);
    files[`e/${e.id}/entity.json`] = JSON.stringify(normalizeEntity(e), null, 2) + "\n";
    if (e.type === "person") files[`e/${e.id}/contact.vcf`] = vcard(normalizeEntity(e));
  }
  const pages = entities.filter(isIndexable).map(e => `  <url>\n    <loc>${ORIGIN}/e/${e.id}/</loc>\n    <lastmod>${e.updated}</lastmod>\n  </url>`);
  const latest = entities.map(e => e.updated).sort().pop() || "2026-11-01";
  files["sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url>\n    <loc>${ORIGIN}/</loc>\n    <lastmod>${latest}</lastmod>\n  </url>\n${pages.join("\n")}\n</urlset>\n`;
  // Plain-text catalogue for AI agents. Only indexable items: private-by-default pages stay out of it, as they do the sitemap.
  const catalogue = entities.filter(isIndexable).sort((a, b) => a.id.localeCompare(b.id))
    .map(e => `- [${e.title}](${ORIGIN}/e/${e.id}/): ${e.type}. ${shorten(e.summary, 155)} Data: ${ORIGIN}/e/${e.id}/entity.json`);
  files["llms.txt"] = `# QX\n\n> A universal visual language for identity, authentication and AI-readable provenance: open-source round codes built on a standard QR core. Each item below has a page for people and a machine-readable record.\n\n## Items\n\n${catalogue.join("\n")}\n`;
  return { files, errors, count: entities.length };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { files, errors, count } = plan();
  if (errors.length) { console.error("Build failed:\n- " + errors.join("\n- ")); process.exit(1); }
  rmSync(join(ROOT, "e"), { recursive: true, force: true });  // e/ is generated output only
  for (const [rel, content] of Object.entries(files)) {
    const dest = join(ROOT, rel);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, content);
  }
  console.log(`Built ${count} entities, ${Object.keys(files).length} files.`);
}
