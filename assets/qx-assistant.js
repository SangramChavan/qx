// QX "Ask about this item".
// Answers ONLY by quoting passages from one entity's own information. No network, no model.
// If a word in the question appears nowhere in that information, it says so instead of guessing.

export const VERSION = 1;

const STOP = new Set(("a an the is are was were be been am do does did can could should would will shall may might must " +
  "i you we they he she it its this that these those of to in on at for from by with about as into than then so if or " +
  "and but not no yes what which who whom whose when where why how please tell me my your our their there here any " +
  "some more most much many also just very really ok okay have has had get got").split(" "));
// Words that say nothing about the topic of a question
const GENERIC = new Set(("item thing product machine device asset unit info information detail details know need needed " +
  "needs want give show use using period type kind way list overview offer offers offering provide provides available " +
  "rule rules often usually long last required require mean means meaning explain describe").split(" "));

const SYN_GROUPS = [
  ["warranty", "guarantee", "claim"],
  ["contact", "call", "phone", "reach", "number", "email", "mail", "whatsapp", "message", "support", "help"],
  ["address", "location", "located", "directions", "map", "find", "based", "visit"],
  ["hours", "open", "opening", "timing", "close", "closing", "time"],
  ["fix", "repair", "troubleshoot", "troubleshooting", "problem", "issue", "fault", "error", "broken", "fail", "failure", "wrong"],
  ["maintenance", "maintain", "servicing", "serviced", "checks", "inspection"],
  ["spec", "specs", "specification", "specifications"],
  ["manual", "guide", "instruction", "instructions", "documentation", "docs", "start", "started", "setup"],
  ["safe", "safety", "danger", "hazard", "warning", "caution", "risk"],
  ["size", "dimension", "dimensions"],
  ["weight", "heavy", "weigh"],
  ["power", "wattage", "output"],
  ["charge", "charger", "charging"],
  ["work", "works", "working", "job", "role", "profession", "occupation"],
  ["assigned", "custodian", "owner", "owned", "belongs"],
  ["price", "cost", "pricing", "fee", "fees", "rate", "rates"]
];

// Plural first, then -ing / -ed, then a trailing e, so "bookings", "booking" and "book" all meet
function stem(w) {
  let s = w;
  if (s.length > 4 && s.endsWith("ies")) s = s.slice(0, -3) + "y";
  else if (s.length > 3 && /(s|x|z|ch|sh)es$/.test(s)) s = s.slice(0, -2);
  else if (s.length > 3 && s.endsWith("s") && !s.endsWith("ss")) s = s.slice(0, -1);
  if (s.length > 5 && s.endsWith("ing")) s = s.slice(0, -3);
  else if (s.length > 4 && s.endsWith("ed")) s = s.slice(0, -2);
  if (s.length > 4 && s.endsWith("e")) s = s.slice(0, -1);
  return s;
}

// Letters and digits are split apart so "20W" and "20 W" match
function words(text) {
  return (String(text).toLowerCase().match(/[a-z]+|[0-9]+/g) || []).filter(w => w.length > 1 || /[0-9]/.test(w));
}

const GENERIC_STEMS = new Set([...GENERIC].map(stem));
const isFiller = w => STOP.has(w) || GENERIC.has(w) || GENERIC_STEMS.has(stem(w));

const SYN = new Map();
for (const g of SYN_GROUPS) {
  const stems = new Set(g.map(stem));
  for (const s of stems) SYN.set(s, new Set([...(SYN.get(s) || []), ...stems]));
}
const expand = s => [...(SYN.get(s) || [s])];

function describeAction(a) {
  const href = a.href || "";  // a "Save contact" action has no link until the page is built
  let value = "";
  if (href.startsWith("tel:")) value = href.slice(4);
  else if (href.startsWith("mailto:")) value = href.slice(7).split("?")[0];
  else if (href.startsWith("https://wa.me/")) value = "+" + href.slice(14).split("?")[0];
  return value ? `${a.label}: ${value}` : a.label;
}

// Turn an entity into quotable passages. Every passage is text the entity itself contains.
export function buildIndex(entity) {
  const chunks = [];
  const add = (label, text, extra = {}) => {
    if (!text) return;
    const { matchLabel = true, ...rest } = extra;  // action passages don't match on their label, or every button would match "contact"
    const match = `${matchLabel ? label : ""} ${rest.title || ""} ${text}`;
    chunks.push({ label, text, ...rest, terms: new Set(words(match).map(stem)), len: 0 });
  };

  add("Overview", entity.summary);
  for (const f of entity.facts || []) add("Details", `${f.label}: ${f.value}`);
  for (const s of entity.sections || []) {
    if (s.kind === "table") {
      for (const row of s.rows) add(s.title, s.columns.map((c, i) => `${c}: ${row[i]}`).join(" · "));
    } else {
      (s.items || []).forEach((it, i) => add(s.title, s.kind === "steps" ? `${i + 1}. ${it}` : it));
    }
  }
  for (const d of entity.documents || []) {
    d.text.split(/\n{2,}/).map(p => p.trim()).filter(Boolean).forEach(p => add(d.title, p));
  }
  for (const f of entity.faqs || []) add("FAQ", f.a, { title: f.q });
  for (const r of entity.records || []) add("History", `${r.date}: ${r.text}`);
  for (const a of entity.actions || []) add("Contact and actions", describeAction(a), { matchLabel: false, ...(a.href ? { action: { label: a.label, href: a.href } } : {}) });

  const df = new Map();
  let total = 0;
  for (const c of chunks) {
    c.len = c.terms.size || 1;
    total += c.len;
    for (const t of c.terms) df.set(t, (df.get(t) || 0) + 1);
  }
  return { chunks, df, avgLen: total / (chunks.length || 1), n: chunks.length, entity };
}

const K1 = 1.2;

function scoreChunk(index, c, terms) {
  let score = 0, matched = 0;
  for (const { exact, alts } of terms) {
    let best = 0;
    for (const a of alts) {
      if (!c.terms.has(a)) continue;
      const df = index.df.get(a) || 1;
      const idf = Math.log(1 + (index.n - df + 0.5) / (df + 0.5));
      const norm = 1 + 0.75 * (c.len / index.avgLen - 1);  // longer passages count for slightly less
      const weight = a === exact ? 1 : 0.5;                 // the word actually asked beats a synonym
      best = Math.max(best, weight * idf * (K1 + 1) / (1 + K1 * Math.max(norm, 0.3)));
    }
    if (best > 0) { matched++; score += best; }
  }
  // Buttons are short, so they would otherwise outrank the passages that actually answer
  return { score: c.action ? score * 0.6 : score, matched };
}

// -> { kind: "answer", hits } | { kind: "overview", hits } | { kind: "none", unknown }
export function answer(index, question, maxHits = 3) {
  const content = words(question).filter(w => !isFiller(w)).map(w => ({ word: w, stem: stem(w) }));
  // "Where ...?" asks for a place, but only when this item has any location information to find
  if (/\bwhere\b/i.test(question) && expand(stem("location")).some(t => index.df.has(t))) content.push({ word: "where", stem: stem("location") });
  if (!content.length) return { kind: "overview", hits: index.chunks.slice(0, 1) };

  const terms = content.map(c => ({ exact: c.stem, alts: expand(c.stem) }));
  // A word that appears nowhere in this item's information cannot be answered from it
  const unknown = content.filter((c, i) => !terms[i].alts.some(t => index.df.has(t))).map(c => c.word);
  if (unknown.length) return { kind: "none", unknown };

  const scored = index.chunks
    .map(c => ({ c, ...scoreChunk(index, c, terms) }))
    .filter(s => s.matched > 0)
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  if (!top || top.matched / terms.length < 0.5) return { kind: "none", unknown: [] };

  const seen = new Set();
  const hits = [];
  for (const s of scored) {
    if (hits.length >= maxHits || s.score < top.score * 0.6) break;
    if (seen.has(s.c.text)) continue;
    seen.add(s.c.text);
    hits.push(s.c);
  }
  return { kind: "answer", hits };
}

const CANDIDATES = {
  product: ["What are the specifications?", "What is the warranty?", "How do I get started?", "Is it safe to use?", "How do I contact support?", "How heavy is it?"],
  business: ["What services do you offer?", "What are the opening hours?", "Where are you located?", "How do I contact you?"],
  person: ["What is your role?", "How can I contact you?", "Where are you based?", "What do you work on?"],
  machine: ["What are the safety rules?", "What maintenance is needed?", "How do I fix a fault?", "What are the specifications?", "Who do I contact for support?"],
  asset: ["Who is it assigned to?", "Where is it located?", "When was it last serviced?", "How do I report an issue?"]
};

// Only suggest questions this item can actually answer
export function suggest(index, max = 4) {
  return (CANDIDATES[index.entity.type] || []).filter(q => answer(index, q).kind === "answer").slice(0, max);
}
