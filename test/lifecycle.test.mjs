import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import * as L from "../assets/qx-lifecycle.js";
import { loadEngine } from "./inline.mjs";

const eng = loadEngine();
eng.ctx.QXL = L;  // the inline code reads the module through this global, as the studio page does
const { QXPayloadV8: P, QXChronoEngine, GF256 } = eng;
const engine = new QXChronoEngine();
const URL_ = "https://qx.tapinhere.com/e/GD9GGWXP/";
const seed = new Uint8Array(32).map((_, i) => i + 1);
const base = { unixSec: 1793000000, gps: null, urlStr: URL_, metaStr: "" };
const obj = (recs, dates = {}) => ({ records: recs.map(r => typeof r === "string" ? L.parseNotation(r) : r), dates });
const lcBytes = (recs, dates) => L.encodeLifecycleObject(obj(recs, dates));
const rng = (a => () => { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; })(7);
const rnd = n => Math.floor(rng() * n);
const plain = a => JSON.parse(JSON.stringify(a));  // values from the vm realm compare equal after a JSON round trip

// ---- A. encoding and decoding -----------------------------------------------------------------
const roundTrip = o => L.decodeLifecycleObject(L.encodeLifecycleObject(o));

test("single warranty record round-trips", () => {
  const r = roundTrip(obj(["2Y-W@P"], { P: "2026-11-03" }));
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lifecycle.dates, { P: "2026-11-03" });
  assert.deepEqual({ ...r.lifecycle.records[0] }, { type: "W", mode: "duration", value: 2, unit: "Y", event: "P", supported: true });
});

test("multiple records, an absolute expiry and after-opening validity round-trip together", () => {
  const o = obj(["2Y-W@P", "1Y-G@P", "6M-O", "2027-01-01-E", "7D-B@M", "5Y-S@I", "1Y-L@A"], {});
  o.records.pop(); o.records.pop();  // 5 records + 0 dates fits; the 7-record case is in the capacity test
  const r = roundTrip({ ...o, dates: { P: "2026-11-03", M: "2026-10-01" } });
  assert.equal(r.lifecycle.records.length, 5);
  assert.deepEqual(r.lifecycle.records.map(L.formatNotation), ["2Y-W@P", "1Y-G@P", "6M-O", "2027-01-01-E", "7D-B@M"]);
  assert.equal(r.lifecycle.records[2].event, "O");
});

test("a missing reference event is kept as missing and never filled in", () => {
  const r = roundTrip(obj(["2Y-W"])).lifecycle.records[0];
  assert.equal(r.event, null);
  assert.equal(L.calculateLifecycleStatus(r, {}, "2026-11-03").status, "pending");
});

test("all eight types and every unit and event survive encoding", () => {
  for (const t of Object.keys(L.TYPES)) {
    const rec = t === "O" ? "3D-O" : `3D-${t}@A`;
    assert.equal(L.formatNotation(roundTrip(obj([rec])).lifecycle.records[0]), rec);
  }
  for (const u of L.UNITS) for (const e of L.EVENTS) {
    assert.equal(L.formatNotation(roundTrip(obj([`16383${u}-W@${e}`])).lifecycle.records[0]), `16383${u}-W@${e}`);
  }
});

test("an unsupported lifecycle identifier decodes as unsupported and does not break the other records", () => {
  const region = new Array(24).fill(0);
  const w2 = (12 << 20) | 1, w0 = 1;  // type 12 (unassigned), type 0 (reserved)
  const body = [0, w2 >> 16, (w2 >> 8) & 255, w2 & 255, w0 >> 16, (w0 >> 8) & 255, w0 & 255, ...lcBytes(["1Y-W@P"]).slice(3, 6)];
  region.splice(0, 2 + body.length, 1, body.length, ...body);
  const r = L.decodeLifecycleObject(region);
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.lifecycle.records.map(x => x.supported), [false, false, true]);
  assert.equal(r.lifecycle.records[0].typeId, 12);
  assert.equal(L.calculateLifecycleStatus(r.lifecycle.records[0], {}, "2026-11-03").status, "unknown");
  assert.throws(() => L.encodeLifecycleObject({ records: [{ type: "Z", mode: "duration", value: 1, unit: "D" }] }), /unknown lifecycle type/);
});

test("unknown optional objects are skipped, and a lifecycle object after them is still read", () => {
  const lc = lcBytes(["2Y-W@P"]);
  const region = [9, 3, 0xAA, 0xBB, 0xCC, ...lc.slice(0, 19)];
  region.length = 24; region.fill(0, 5 + 0 + lc[1] + 2 > 24 ? 24 : 5 + lc[1] + 2);
  const r = L.decodeLifecycleObject(region);
  assert.deepEqual(r.unknownTags, [9]);
  assert.equal(r.lifecycle.records.length, 1);
  const onlyUnknown = L.decodeLifecycleObject([7, 2, 1, 2, ...new Array(20).fill(0)]);
  assert.equal(onlyUnknown.lifecycle, null);
  assert.deepEqual(onlyUnknown.errors, []);
});

test("invalid and ambiguous combinations are rejected, nothing is truncated", () => {
  const bad = [
    [obj(["0D-W"]), /duration/], [{ records: [{ type: "W", mode: "duration", value: 16384, unit: "D" }] }, /duration/],
    [{ records: [{ type: "W", mode: "duration", value: 1, unit: "H" }] }, /unit/],
    [{ records: [{ type: "W", mode: "duration", value: 1.5, unit: "Y" }] }, /whole number/],
    [{ records: [{ type: "O", mode: "duration", value: 1, unit: "M", event: "P" }] }, /After Opening/],
    [{ records: [{ type: "O", mode: "duration", value: 1, unit: "M", event: null }] }, /After Opening/],
    [{ records: [{ type: "W", mode: "duration", value: 1, unit: "Y", event: "X" }] }, /event/],
    [{ records: [{ type: "E", mode: "absolute", date: "2027-02-30" }] }, /date/],
    [{ records: [{ type: "E", mode: "absolute", date: "1999-12-31" }] }, /date/],
    [{ records: [{ type: "E", mode: "absolute", date: "2027-01-01", event: "P" }] }, /absolute/],
    [obj(["1Y-W@P", "2Y-W@M"]), /ambiguous/], [obj(["2027-01-01-E", "2028-01-01-E"]), /ambiguous/],
    [obj(["1Y-W@P"], { P: "2026-13-01" }), /date/], [obj(["1Y-W@P"], { X: "2026-01-01" }), /event/],
    [{ records: [] }, /at least one/], [obj(["1D-W", "1D-G", "1D-E", "1D-B", "1D-S", "1D-L", "1D-C", "2027-01-01-W"]), /bytes/]
  ];
  for (const [o, re] of bad) assert.match(L.validateLifecycleObject(o).join(";"), re);
  assert.equal(L.parseNotation("2Y-X"), null);
  assert.equal(L.parseNotation("2.5Y-W"), null);
  assert.equal(L.parseNotation("2y-w"), null);
});

test("decoding never throws on arbitrary bytes", () => {
  for (let i = 0; i < 3000; i++) {
    const b = Array.from({ length: 24 }, () => rnd(256));
    if (i % 2) b[0] = 1;
    const r = L.decodeLifecycleObject(b);
    if (r.lifecycle) L.evaluateLifecycle(r.lifecycle, "2026-11-03");
  }
});

// ---- B. dates ---------------------------------------------------------------------------------
test("calendar arithmetic: leap years, month ends, year ends", () => {
  const add = (d, v, u) => L.addDuration(d, v, u);
  assert.equal(add("2027-01-31", 1, "M"), "2027-02-28");
  assert.equal(add("2028-01-31", 1, "M"), "2028-02-29");
  assert.equal(add("2026-01-31", 2, "M"), "2026-03-31");
  assert.equal(add("2026-03-31", 1, "M"), "2026-04-30");
  assert.equal(add("2028-02-29", 1, "Y"), "2029-02-28");
  assert.equal(add("2028-02-29", 4, "Y"), "2032-02-29");
  assert.equal(add("2026-12-31", 1, "D"), "2027-01-01");
  assert.equal(add("2026-12-31", 1, "M"), "2027-01-31");
  assert.equal(add("2026-11-30", 3, "M"), "2027-02-28");
  assert.equal(add("2028-02-28", 1, "D"), "2028-02-29");
  assert.equal(add("2027-02-28", 1, "D"), "2027-03-01");
  assert.equal(add("2026-11-03", 365, "D"), "2027-11-03");
  assert.equal(add("2027-11-03", 1, "Y"), "2028-11-03");
  assert.equal(add("2100-02-28", 1, "D"), "2100-03-01", "2100 is not a leap year");
  assert.equal(add("2000-02-28", 1, "D"), "2000-02-29", "2000 is a leap year");
  assert.equal(add("9999-12-31", 1, "D"), null);
  assert.equal(L.dayNumber("2026-02-29"), null);
  assert.equal(L.dayNumber("2026-2-9"), null);
});

test("day numbers agree with the JS calendar over 180 years", () => {
  for (let t = Date.UTC(2000, 0, 1); t < Date.UTC(2179, 5, 6); t += 86400000 * 37) {
    const s = new Date(t).toISOString().slice(0, 10);
    assert.equal(L.dateFromDayNumber(L.dayNumber(s)), s);
    assert.equal(L.dayNumber(s) * 86400000, t);
  }
});

const W = { type: "W", mode: "duration", value: 1, unit: "Y", event: "P" };
const st = (rec, dates, today, o) => L.calculateLifecycleStatus(rec, dates, today, o);

test("status: expiry today, tomorrow, yesterday and long ago", () => {
  const E = { type: "E", mode: "absolute", date: "2027-01-01" };
  assert.deepEqual({ ...st(E, {}, "2027-01-01", { soonDays: 0 }) }, { status: "expiring_soon", start: null, end: "2027-01-01", daysLeft: 0 }, "the end day itself is still valid");
  assert.equal(st(E, {}, "2027-01-02").status, "expired");
  assert.equal(st(E, {}, "2026-12-31").status, "expiring_soon");
  assert.equal(st(E, {}, "2026-12-31", { soonDays: 0 }).status, "active");
  assert.equal(st(E, {}, "2026-11-03").status, "active");
  assert.equal(st(E, {}, "2026-12-02").daysLeft, 30);
  assert.equal(st(E, {}, "2026-12-02").status, "expiring_soon");
  assert.equal(st(E, {}, "2026-12-01", { soonDays: 30 }).status, "active");
  assert.equal(st(E, {}, "2020-01-01").status, "active");
  assert.equal(st(E, {}, "2031-06-15").status, "expired");
});

test("status: the soon threshold belongs to the reader, not the payload", () => {
  const E = { type: "E", mode: "absolute", date: "2027-01-01" };
  assert.equal(st(E, {}, "2026-11-03", { soonDays: 90 }).status, "expiring_soon");
  assert.equal(st(E, {}, "2026-11-03", { soonDays: 7 }).status, "active");
});

test("status: duration records follow their reference date; a future reference is not yet active", () => {
  assert.equal(st(W, { P: "2026-11-03" }, "2026-11-03").end, "2027-11-03");
  assert.equal(st(W, { P: "2026-11-03" }, "2027-11-04").status, "expired");
  assert.equal(st(W, { P: "2026-11-03" }, "2026-11-04", { soonDays: 30 }).status, "active");
  assert.equal(st(W, { P: "2026-12-01" }, "2026-11-03").status, "not_yet_active");
  assert.equal(st({ type: "B", mode: "duration", value: 7, unit: "D", event: "M" }, { M: "2026-11-01" }, "2026-11-08").end, "2026-11-08");
});

test("status: a missing reference date is pending, never assumed", () => {
  const r = st(W, {}, "2026-11-03");
  assert.deepEqual({ ...r }, { status: "pending", start: null, end: null, daysLeft: null, pending: "P" });
  assert.equal(st({ ...W, event: null }, { P: "2026-01-01" }, "2026-11-03").pending, "unspecified");
  assert.equal(st({ type: "O", mode: "duration", value: 6, unit: "M", event: "O" }, { P: "2026-01-01" }, "2026-11-03").status, "pending", "a purchase date is not an opening date");
});

test("status needs an explicit today and never reads the clock", () => {
  assert.throws(() => st(W, { P: "2026-11-03" }, undefined), /today/);
  assert.throws(() => st(W, { P: "2026-11-03" }, "2026-02-30"), /today/);
  assert.equal(L.describeDuration({ mode: "duration", value: 6, unit: "M" }), "6 Months", "months are not converted to days");
  assert.equal(L.describeDuration({ mode: "duration", value: 1, unit: "Y" }), "1 Year");
  assert.equal(L.parseEventDates("P=2026-11-03, M=2026-09-01").M, "2026-09-01");
  assert.throws(() => L.parseEventDates("P=2026-11-03,P=2026-11-04"));
});

// ---- C. security ------------------------------------------------------------------------------
const lcFields = { ...base, lc: lcBytes(["2Y-W@P", "6M-O"], { P: "2026-11-03" }) };
const decodeOf = payload => engine.encodePolarState(URL_, payload).decode;
const pubHex = async () => Buffer.from(await crypto.subtle.exportKey("raw", (await P.keysFromSeed(seed)).verify)).toString("hex");

test("a valid signature over lifecycle data verifies and names the trusted issuer", async () => {
  const payload = await P.buildSigned(lcFields, seed);
  assert.equal(payload.length, 128);
  const dec = decodeOf(payload);
  assert.ok(dec.ok && dec.signed && dec.layout === 9);
  assert.equal(await P.verify(dec.data, URL_, seed), true);
  const auth = await P.lifecycleAuth(dec, URL_, [{ name: "Acme Ltd", publicKeyHex: await pubHex() }]);
  assert.deepEqual({ ...auth }, { state: "authenticated", issuer: "Acme Ltd" });
  assert.deepEqual(plain(dec.lifecycle.lifecycle.records.map(L.formatNotation)), ["2Y-W@P", "6M-O"]);
});

test("an untrusted or wrong key does not authenticate", async () => {
  const dec = decodeOf(await P.buildSigned(lcFields, seed));
  const other = await P.keysFromSeed(new Uint8Array(32).fill(9));
  const hex = Buffer.from(await crypto.subtle.exportKey("raw", other.verify)).toString("hex");
  assert.equal((await P.lifecycleAuth(dec, URL_, [{ name: "Other", publicKeyHex: hex }])).state, "invalid");
  assert.equal((await P.lifecycleAuth(dec, URL_, [])).state, "invalid");
});

test("any change to lifecycle bytes, the core, the signature or the URL breaks verification", async () => {
  const good = await P.buildSigned(lcFields, seed);
  const flip = (arr, i) => arr.map((b, j) => j === i ? b ^ 1 : b);
  for (const i of [104, 105, 108, 110, 127, 0, 5, 20, 40, 100]) {
    assert.equal(await P.verify(flip(good, i), URL_, seed), false, `byte ${i}`);
  }
  assert.equal(await P.verify(good, "https://qx.tapinhere.com/e/GD9GGWXQ/", seed), false);
  // Re-sealing a tampered record with a fresh CRC-32 still fails: the CRC protects against damage, the signature against edits
  const forged = [...good]; forged[110] ^= 4;
  const resealed = [...P.seal(forged.slice(0, 36), forged.slice(104)), ...forged.slice(40, 104), ...forged.slice(104)];
  assert.ok(decodeOf(resealed).ok, "a re-sealed block decodes");
  assert.equal(await P.verify(decodeOf(resealed).data, URL_, seed), false);
});

test("stripping the lifecycle object from a signed symbol is detected", async () => {
  const good = await P.buildSigned(lcFields, seed);
  const core = good.slice(0, 36); core[0] = (core[0] & 0x0F) | 0x80;  // pose as layout 8
  const stripped = [...P.seal(core), ...good.slice(40, 104)];
  const dec = decodeOf(stripped);
  assert.ok(dec.ok && dec.layout === 8 && dec.lcBytes === null);
  assert.equal(await P.verify(dec.data, URL_, seed), false);
});

test("an unsigned lifecycle object is reported unauthenticated, and never as authenticated", async () => {
  const dec = decodeOf(P.build(lcFields));
  assert.ok(dec.ok && !dec.signed && dec.lcBytes);
  assert.deepEqual({ ...(await P.lifecycleAuth(dec, URL_, [{ name: "Acme", publicKeyHex: await pubHex() }])) }, { state: "unauthenticated", issuer: null });
});

test("signatures stay domain-separated: a v8 signature never verifies a v9 block and vice versa", async () => {
  const v8 = await P.buildSigned(base, seed);
  const v9 = await P.buildSigned(lcFields, seed);
  assert.notDeepEqual(plain(P.signingInput(v8.slice(0, 36), URL_)), plain(P.signingInput(v9.slice(0, 36), URL_, v9.slice(104))));
  const mixed = [...v9.slice(0, 40), ...v8.slice(40, 104), ...v9.slice(104)];
  assert.equal(await P.verify(mixed, URL_, seed), false);
});

// ---- D. compatibility -------------------------------------------------------------------------
const sha = s => createHash("sha256").update(s).digest("hex");
test("codes without lifecycle data are byte-identical to the frozen v8 outputs", async () => {
  const golden = JSON.parse(readFileSync(new URL("./golden-v8.json", import.meta.url), "utf8"));
  const cases = { plain: base, full: { unixSec: 1793000000, gps: { lat: 18.5204, lon: 73.8567 }, urlStr: URL_, metaStr: "BATCH-09_x", type: 3, safety: true, digestHex: "3f9a0c1b2d" } };
  for (const [name, f] of Object.entries(cases)) for (const signed of [false, true]) {
    const payload = signed ? await P.buildSigned(f, seed) : P.build(f);
    assert.equal(payload.length, 104);
    const stt = engine.encodePolarState(URL_, payload);
    const svg = engine.renderChronoMandala(URL_, f.metaStr, "2026-11-03T10:00:00Z", { dotScale: 0.37, colorChrono: true, showEmblem: true, showGuides: false, forExport: true, payload }).svgGroup;
    const key = `${name}${signed ? "-signed" : ""}`;
    assert.deepEqual({ payload: sha(payload.join(",")), physical: sha(stt.physical.join(",")), rings: sha(JSON.stringify(stt.dataRings)), svg: sha(svg) }, golden[key], key);
    assert.equal(stt.decode.lifecycle, null);
    assert.equal(stt.decode.layout, 8);
  }
});

test("geometry is untouched: same ring specs, v9 adds ink only where v8 leaves cells blank", () => {
  assert.deepEqual(plain(engine.dataSectors), [96, 96, 104, 112, 112, 120, 128, 128, 136, 144, 144, 152]);
  const bits = engine.dataSectors.reduce((a, b) => a + b, 0);
  assert.equal(bits, 184 * 8);
  const a = engine.encodePolarState(URL_, P.build(base)), b = engine.encodePolarState(URL_, P.build(lcFields));
  assert.equal(JSON.stringify(Object.keys(a.cellToCluster).filter(k => !(k in b.cellToCluster))), "[]");
  assert.ok(Object.keys(b.cellToCluster).length > Object.keys(a.cellToCluster).length);
});

test("a v9 symbol decodes through the shared ring reader and v8 symbols still do", () => {
  for (const f of [base, lcFields]) {
    const stt = engine.encodePolarState(URL_, P.build(f));
    const r = engine.decodeRings(stt.physical.concat(new Array(184 - stt.physical.length).fill(0)), URL_);
    assert.ok(r.ok);
    assert.equal(r.layout, f.lc ? 9 : 8);
  }
});

test("a layout 8 reader cannot decode a layout 9 symbol, and shows nothing wrong", () => {
  const stt = engine.encodePolarState(URL_, P.build(lcFields));
  const asV8 = Array.from({ length: 152 }, (_, i) => stt.physical[(engine.stride * i + engine.offset) % 152]);
  const r = engine.decodePolar(asV8, URL_);
  assert.equal(r.ok, false);
  assert.equal(r.unknownLayout, undefined, "it fails at RS/CRC, before any layout nibble is read");
  // a layout 9 nibble inside a 152-byte codeword is reported, not misread
  const data = P.build(base); data[0] = 0x90 | (data[0] & 15);
  const forged = [...P.seal(data.slice(0, 36)), ...data.slice(40)];
  const cw = [...forged, ...GF256.rsEncode(forged, 48)];
  assert.equal(engine.decodePolar(cw, URL_).unknownLayout, 9);
});

test("a v9 block whose lifecycle region is unreadable still returns the main payload", () => {
  const f = { ...base, lc: [0xFF, 0xFF, ...new Array(22).fill(0)] };
  const dec = engine.encodePolarState(URL_, P.build(f)).decode;
  assert.ok(dec.ok && dec.lcBytes);
  assert.equal(dec.entityId, "GD9GGWXP");
  assert.ok(dec.lifecycle.errors.length > 0 && dec.lifecycle.lifecycle === null);
});

test("capacity: the largest object that fits is accepted, one more byte is refused", () => {
  assert.equal(L.encodeLifecycleObject(obj(["1D-W", "1D-G", "1D-E", "1D-B", "1D-S", "1D-L", "1D-C"])).length, 24);
  assert.equal(L.validateLifecycleObject(obj(["1D-W", "1D-G", "1D-E", "1D-B", "1D-S", "1D-L", "1D-C", "2027-01-01-W"])).length, 1);
  const allDates = Object.fromEntries(L.EVENTS.map((e, i) => [e, `2026-0${i + 1}-15`]));
  assert.equal(roundTrip(obj(["1Y-W@M", "2Y-G@P", "3Y-S@I"], allDates)).lifecycle.records.length, 3);
  assert.ok(L.validateLifecycleObject(obj(["1Y-W@M", "2Y-G@P", "3Y-S@I", "1Y-L@A"], allDates)).length > 0);
  assert.throws(() => P.build({ ...base, lc: [1, 2, 3] }), /24 bytes/);
});

test("error correction: v9 repairs 28 damaged bytes, v8 still repairs 24, over-capacity damage is rejected not misread", () => {
  const damage = (physical, count) => { const p = [...physical], seen = new Set(); while (seen.size < count) seen.add(rnd(p.length)); seen.forEach(i => { p[i] ^= 1 + rnd(255); }); return p; };
  const v9 = engine.encodePolarState(URL_, P.build(lcFields)), v8 = engine.encodePolarState(URL_, P.build(base));
  const pad = p => p.concat(new Array(184 - p.length).fill(0));
  for (let t = 0; t < 60; t++) {
    const a = engine.decodeRings(damage(v9.physical, 28), URL_);
    assert.ok(a.ok && a.corrected === 28 && a.lifecycle.lifecycle.records.length === 2, `v9 trial ${t}`);
    const b = engine.decodeRings(pad(damage(v8.physical, 24)), URL_);
    assert.ok(b.ok && b.corrected === 24, `v8 trial ${t}`);
  }
  for (let t = 0; t < 60; t++) {
    const c = engine.decodeRings(damage(v9.physical, 45), URL_);
    assert.ok(!c.ok || c.lcBytes.join() === lcFields.lc.join(), "never a wrong payload");
    assert.equal(c.ok, false);
  }
});

// ---- E. performance ---------------------------------------------------------------------------
test("performance and overhead", async () => {
  const rows = [];
  const time = (name, n, fn) => { const t = performance.now(); for (let i = 0; i < n; i++) fn(); const ms = (performance.now() - t) / n; rows.push(`${name.padEnd(34)} ${ms.toFixed(3)} ms`); return ms; };
  const o = obj(["2Y-W@P", "1Y-G@P", "6M-O", "2027-01-01-E"], { P: "2026-11-03" });
  const encLc = time("encode lifecycle object", 2000, () => L.encodeLifecycleObject(o));
  const region = L.encodeLifecycleObject(o);
  const decLc = time("decode lifecycle object", 2000, () => L.decodeLifecycleObject(region));
  time("encode v8 symbol (RS + rings)", 100, () => engine.encodePolarState(URL_, P.build(base)));
  const e9 = time("encode v9 symbol (RS + rings)", 100, () => engine.encodePolarState(URL_, P.build({ ...base, lc: region })));
  const phys = engine.encodePolarState(URL_, P.build({ ...base, lc: region })).physical;
  const d9 = time("decode v9 symbol (v8 try, then v9)", 100, () => engine.decodeRings(phys, URL_));
  const rec = o.records.map(r => L.formatNotation(r)).join(",");
  console.log(`\n${rows.join("\n")}\n` +
    `payload: v8 104 B data + 48 parity = 152 B; v9 128 B data + 56 parity = 184 B (+24 data, +8 parity, +32 B total)\n` +
    `lifecycle object "${rec}": ${region[1] + 2} of 24 B used; as ASCII it would be ${new TextEncoder().encode(rec + ",P=2026-11-03").length} B`);
  assert.ok(encLc < 5 && decLc < 5 && e9 < 500 && d9 < 500, "far below any human-visible delay");
  assert.ok(region[1] + 2 <= 24);
});
