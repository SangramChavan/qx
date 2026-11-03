// QX lifecycle data object: warranty, expiry and other validity records carried in payload v9 (bytes 104-127).
// Pure functions, no DOM, no clock: callers pass `today`. Spec: docs/lifecycle-spec.md.
//
// Region layout (24 bytes), a list of [tag u8][len u8][body] objects, then zero padding:
//   tag 0x01 LIFECYCLE   body = [event mask u8][u16 date per set mask bit, event order][3-byte record x N]
//   tag 0x00             end of list (the rest is padding)
//   any other tag        skipped by its length, so older readers survive newer objects
// Record (24 bits, big-endian):
//   duration  tttt 0 uu eee vvvvvvvvvvvvvv   type, mode, unit (0 D,1 M,2 Y), event (0 none,1-6), value 1..16383
//   absolute  tttt 1 000 dddddddddddddddd     type, mode, reserved, end date (days since 2000-01-01)

export const REGION_BYTES = 24;
export const TAG_LIFECYCLE = 1;
export const TYPES = { W: 1, G: 2, E: 3, B: 4, O: 5, S: 6, L: 7, C: 8 };
export const TYPE_NAMES = { W: "Warranty", G: "Guarantee", E: "Expiry", B: "Best Before", O: "After Opening", S: "Service", L: "License", C: "Certification" };
export const EVENTS = ["M", "P", "A", "O", "I", "D"];  // event code = index + 1; mask bit = index
export const EVENT_NAMES = { M: "manufacturing", P: "purchase", A: "activation", O: "opening", I: "installation", D: "delivery" };
export const UNITS = ["D", "M", "Y"];
export const UNIT_NAMES = { D: "Day", M: "Month", Y: "Year" };
export const MAX_VALUE = 0x3FFF;

const TYPE_BY_ID = Object.fromEntries(Object.entries(TYPES).map(([k, v]) => [v, k]));
const EPOCH_DAYS = daysFromCivil(2000, 1, 1);
const MAX_DAY = 0xFFFF;

// ---- civil dates (proleptic Gregorian, no time zone, no clock) ---------------------------------
export function daysFromCivil(y, m, d) {
  y -= m <= 2;
  const era = Math.floor(y / 400), yoe = y - era * 400;
  const doy = Math.floor((153 * (m + (m > 2 ? -3 : 9)) + 2) / 5) + d - 1;
  return era * 146097 + yoe * 365 + Math.floor(yoe / 4) - Math.floor(yoe / 100) + doy - 719468;
}
export function civilFromDays(z) {
  z += 719468;
  const era = Math.floor(z / 146097), doe = z - era * 146097;
  const yoe = Math.floor((doe - Math.floor(doe / 1460) + Math.floor(doe / 36524) - Math.floor(doe / 146096)) / 365);
  const doy = doe - (365 * yoe + Math.floor(yoe / 4) - Math.floor(yoe / 100));
  const mp = Math.floor((5 * doy + 2) / 153);
  const d = doy - Math.floor((153 * mp + 2) / 5) + 1, m = mp + (mp < 10 ? 3 : -9);
  return { y: yoe + era * 400 + (m <= 2), m, d };
}
const daysInMonth = (y, m) => [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
const iso = ({ y, m, d }) => `${String(y).padStart(4, "0")}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

// "YYYY-MM-DD" -> day number, or null when malformed or not a real date (2026-02-30 is rejected, never rolled over)
export function dayNumber(s) {
  const m = typeof s === "string" && /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  return mo >= 1 && mo <= 12 && d >= 1 && d <= daysInMonth(y, mo) ? daysFromCivil(y, mo, d) : null;
}
export const dateFromDayNumber = n => iso(civilFromDays(n));

// Calendar addition. Days are fixed 24-hour steps. Months and years keep the day of month and clamp to the last
// day of a shorter month (Jan 31 + 1M = Feb 28/29; Feb 29 + 1Y = Feb 28). Always computed from the original date,
// never by repeated steps. Returns null when the result leaves years 0001-9999.
export function addDuration(dateStr, value, unit) {
  const n = dayNumber(dateStr);
  if (n === null) return null;
  if (unit === "D") { const r = civilFromDays(n + value); return r.y > 9999 ? null : iso(r); }
  const { y, m, d } = civilFromDays(n);
  const total = y * 12 + (m - 1) + value * (unit === "Y" ? 12 : 1);
  const ny = Math.floor(total / 12), nm = total % 12 + 1;
  return ny > 9999 ? null : iso({ y: ny, m: nm, d: Math.min(d, daysInMonth(ny, nm)) });
}

const toBinaryDay = s => { const n = dayNumber(s); return n === null ? null : n - EPOCH_DAYS; };
const inRange = s => { const b = toBinaryDay(s); return b !== null && b >= 0 && b <= MAX_DAY; };

// ---- building and validating -------------------------------------------------------------------
export const createLifecycleObject = () => ({ records: [], dates: {} });
export function addLifecycleRecord(obj, record) { obj.records.push(record); return obj; }

// Notation: "2Y-W", "6M-O", "2Y-W@P" (event P), "2027-01-01-E" (absolute end date). A bare duration has no
// reference event: it stays pending until the issuer names one. "-O" implies event O.
export function parseNotation(text) {
  const abs = /^(\d{4}-\d{2}-\d{2})-([WGEBOSLC])$/.exec(text);
  if (abs) return { type: abs[2], mode: "absolute", date: abs[1] };
  const m = /^(\d{1,5})([DMY])-([WGEBOSLC])(?:@([MPAOID]))?$/.exec(text);
  if (!m) return null;
  return { type: m[3], mode: "duration", value: +m[1], unit: m[2], event: m[4] || (m[3] === "O" ? "O" : null) };
}
export const formatNotation = r => r.mode === "absolute" ? `${r.date}-${r.type}` : `${r.value}${r.unit}-${r.type}${r.event && !(r.type === "O" && r.event === "O") ? `@${r.event}` : ""}`;

export function parseEventDates(text) {
  const dates = {};
  for (const part of text.split(",").map(s => s.trim()).filter(Boolean)) {
    const m = /^([MPAOID])=(\d{4}-\d{2}-\d{2})$/.exec(part);
    if (!m || dates[m[1]]) throw new Error(`Bad event date "${part}" (use P=2026-11-03)`);
    dates[m[1]] = m[2];
  }
  return dates;
}

const sizeOf = obj => 1 + 2 * Object.keys(obj.dates || {}).length + 3 * (obj.records || []).length;

// Returns a list of problems; empty means the object can be encoded.
export function validateLifecycleObject(obj) {
  const errs = [];
  if (!obj || !Array.isArray(obj.records)) return ["lifecycle object needs a records array"];
  const dates = obj.dates || {};
  for (const [ev, d] of Object.entries(dates)) {
    if (!EVENTS.includes(ev)) errs.push(`unknown reference event "${ev}"`);
    else if (!inRange(d)) errs.push(`${ev} date "${d}" must be a real date from 2000-01-01 to 2179-06-06`);
  }
  if (!obj.records.length) errs.push("at least one record is required");
  const seen = new Set();
  obj.records.forEach((r, i) => {
    const at = `record ${i + 1}`;
    if (!TYPES[r?.type]) return errs.push(`${at}: unknown lifecycle type "${r?.type}"`);
    const key = `${r.type}/${r.mode}`;
    if (seen.has(key)) errs.push(`${at}: more than one ${r.mode} ${r.type} record is ambiguous`);
    seen.add(key);
    if (r.mode === "absolute") {
      if (!inRange(r.date)) errs.push(`${at}: date "${r.date}" must be a real date from 2000-01-01 to 2179-06-06`);
      if (r.value !== undefined || r.unit !== undefined || r.event) errs.push(`${at}: an absolute date takes no duration, unit or event`);
    } else if (r.mode === "duration") {
      if (!Number.isInteger(r.value) || r.value < 1 || r.value > MAX_VALUE) errs.push(`${at}: duration must be a whole number from 1 to ${MAX_VALUE}`);
      if (!UNITS.includes(r.unit)) errs.push(`${at}: unit must be D, M or Y`);
      if (r.event != null && !EVENTS.includes(r.event)) errs.push(`${at}: unknown reference event "${r.event}"`);
      if (r.type === "O" && r.event !== "O") errs.push(`${at}: After Opening must use reference event O`);
      if (r.date !== undefined) errs.push(`${at}: a duration takes no date`);
    } else errs.push(`${at}: mode must be "duration" or "absolute"`);
  });
  if (!errs.length && 2 + sizeOf(obj) > REGION_BYTES) errs.push(`needs ${2 + sizeOf(obj)} bytes, only ${REGION_BYTES} are available`);
  return errs;
}

// ---- binary ------------------------------------------------------------------------------------
// Returns the 24-byte region. Throws on an invalid object: nothing is ever truncated or guessed.
export function encodeLifecycleObject(obj) {
  const errs = validateLifecycleObject(obj);
  if (errs.length) throw new Error(`Invalid lifecycle object: ${errs.join("; ")}`);
  const dates = obj.dates || {};
  const body = [EVENTS.reduce((m, ev, i) => m | (dates[ev] ? 1 << i : 0), 0)];
  EVENTS.forEach(ev => { if (dates[ev]) { const b = toBinaryDay(dates[ev]); body.push(b >> 8, b & 0xFF); } });
  for (const r of obj.records) {
    const t = TYPES[r.type];
    const word = r.mode === "absolute"
      ? (t << 20) | (1 << 19) | toBinaryDay(r.date)
      : (t << 20) | (UNITS.indexOf(r.unit) << 17) | ((r.event ? EVENTS.indexOf(r.event) + 1 : 0) << 14) | r.value;
    body.push(word >> 16, (word >> 8) & 0xFF, word & 0xFF);
  }
  const out = [TAG_LIFECYCLE, body.length, ...body];
  return out.concat(new Array(REGION_BYTES - out.length).fill(0));
}

// Reads a region. Unknown object tags are skipped, unknown record types are kept (supported: false) so the
// rest of the object still reads. Never throws. Returns { lifecycle, unknownTags, errors }.
export function decodeLifecycleObject(bytes) {
  const res = { lifecycle: null, unknownTags: [], errors: [] };
  let p = 0;
  while (p + 1 < bytes.length && bytes[p] !== 0) {
    const tag = bytes[p], len = bytes[p + 1], body = bytes.slice(p + 2, p + 2 + len);
    if (body.length < len) { res.errors.push("object length runs past the region"); break; }
    p += 2 + len;
    if (tag !== TAG_LIFECYCLE) { res.unknownTags.push(tag); continue; }
    if (res.lifecycle || res.errors.length) { res.errors.push("more than one lifecycle object"); continue; }
    const obj = readBody(body, res.errors);
    if (obj) res.lifecycle = obj;
  }
  return res;
}

function readBody(body, errors) {
  const mask = body[0];
  if (body.length < 1 || mask >> EVENTS.length) { errors.push("lifecycle object uses a layout this reader does not know"); return null; }
  const dates = {};
  let p = 1;
  for (let i = 0; i < EVENTS.length; i++) {
    if (!(mask >> i & 1)) continue;
    if (p + 2 > body.length) { errors.push("lifecycle date table is cut short"); return null; }
    dates[EVENTS[i]] = dateFromDayNumber(EPOCH_DAYS + ((body[p] << 8) | body[p + 1]));
    p += 2;
  }
  if ((body.length - p) % 3) { errors.push("lifecycle records are cut short"); return null; }
  const records = [];
  for (; p < body.length; p += 3) {
    const w = (body[p] << 16) | (body[p + 1] << 8) | body[p + 2];
    const id = w >> 20, absolute = !!(w >> 19 & 1);
    const type = TYPE_BY_ID[id];
    let r;
    if (absolute) r = { type, mode: "absolute", date: dateFromDayNumber(EPOCH_DAYS + (w & 0xFFFF)), supported: !!type && ((w >> 16) & 7) === 0 };
    else {
      const unit = UNITS[(w >> 17) & 3], ev = (w >> 14) & 7;
      r = { type, mode: "duration", value: w & MAX_VALUE, unit, event: ev ? EVENTS[ev - 1] : null,
        supported: !!type && !!unit && ev <= EVENTS.length && (w & MAX_VALUE) > 0 };
    }
    if (!type) r.typeId = id;
    records.push(r);
  }
  return { records, dates };
}

// ---- dates and status --------------------------------------------------------------------------
// { start, end, pending } for one record. `end` is the last day the record is valid (inclusive).
// An unknown reference date is reported as pending, never assumed.
export function calculateExpiryDate(record, dates = {}) {
  if (record.mode === "absolute") return { start: null, end: record.date, pending: null };
  if (!record.event) return { start: null, end: null, pending: "unspecified" };
  const start = dates[record.event];
  if (!start) return { start: null, end: null, pending: record.event };
  return { start, end: addDuration(start, record.value, record.unit), pending: null };
}

export const STATUS_LABELS = { active: "Active", expiring_soon: "Expiring Soon", expired: "Expired", not_yet_active: "Not Yet Active", pending: "Pending Reference Event", unknown: "Unknown" };

// `today` is a civil date "YYYY-MM-DD" in the reader's own calendar; this function never reads the clock.
// The end day itself is still valid: expiry today is Expiring Soon (0 days left), expiry yesterday is Expired.
// `soonDays` is the reader's choice and is not part of the payload.
export function calculateLifecycleStatus(record, dates, today, { soonDays = 30 } = {}) {
  const t = dayNumber(today);
  if (t === null) throw new Error(`today must be a real date YYYY-MM-DD, got "${today}"`);
  if (record.supported === false || !TYPES[record.type]) return { status: "unknown", start: null, end: null, daysLeft: null };
  const { start, end, pending } = calculateExpiryDate(record, dates);
  if (pending) return { status: "pending", start, end: null, daysLeft: null, pending };
  if (!end) return { status: "unknown", start, end: null, daysLeft: null };
  const daysLeft = dayNumber(end) - t;
  const status = start && dayNumber(start) > t ? "not_yet_active" : daysLeft < 0 ? "expired" : daysLeft <= soonDays ? "expiring_soon" : "active";
  return { status, start, end, daysLeft };
}

// "2 Years", "1 Month", "180 Days": the stored unit is shown, never converted
export const describeDuration = r => r.mode === "absolute" ? r.date : UNIT_NAMES[r.unit] ? `${r.value} ${UNIT_NAMES[r.unit]}${r.value === 1 ? "" : "s"}` : "unsupported unit";

// One display row per record for a reader
export function evaluateLifecycle(lifecycle, today, opts) {
  return lifecycle.records.map(record => {
    const s = calculateLifecycleStatus(record, lifecycle.dates, today, opts);
    return { record, name: TYPE_NAMES[record.type] || `Unknown type ${record.typeId}`, value: describeDuration(record), ...s, label: STATUS_LABELS[s.status] };
  });
}
