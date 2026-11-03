# QX Lifecycle Data Object (payload layout 9)

Status: implemented in the working prototype; draft specification, not a certified standard.
Code: [assets/qx-lifecycle.js](../assets/qx-lifecycle.js) (records, dates, status) and the payload and ring code in [index.html](../index.html) (`QXPayloadV8`, `QXChronoEngine`). Tests: [test/lifecycle.test.mjs](../test/lifecycle.test.mjs).

"MUST", "MUST NOT" and "SHOULD" mark **normative** text. Paragraphs headed *Recommendation* or *Note* are not normative.

## 1. Architecture it builds on

The repository has no document called QX-R2. This spec treats it as the shipped polar ring pattern: 12 data rings plus a sync ring, 1,472 bit cells, unchanged. `docs/layout-v8-draft.md` is out of date (v8 shipped); the code is the source of truth.

| Part | Fact |
|---|---|
| Payload | v8: 104 data bytes = 36 core + CRC-32 (4) + Ed25519 signature (64) |
| Protection | RS(152,104) over GF(256), 24 correctable bytes. 152 of the 184 bytes the rings can hold are used; the other 32 are blank |
| Signature | Ed25519 (WebCrypto) over a domain tag, the length-prefixed URL and the 36 core bytes |
| Extension policy | A reader that decodes a codeword with an unknown layout nibble rejects it (`UNKNOWN PAYLOAD LAYOUT`) |

The lifecycle object adds no new cryptography, no new checksum and no second payload architecture.

## 2. Layouts

| | Layout 8 (today) | Layout 9 (this spec) |
|---|---|---|
| Used when | no lifecycle object | a lifecycle region is present |
| Data bytes | 104 | 128 (104 + 24 lifecycle) |
| Code | RS(152,104), 48 parity | RS(184,128), 56 parity |
| Correctable bytes | 24 (15.8%) | 28 (15.2%) |
| Interleave | byte *i* to slot (37*i* + 7) mod 152 | byte *i* to slot (37*i* + 7) mod 184 |

An encoder MUST write layout 8, byte-identical to before, when there is no lifecycle object. It MUST write layout 9 only when it carries one. Ring radii, sector counts and every module coordinate are unchanged; layout 9 prints ink in the 32 bytes of cells that layout 8 leaves blank.

Layout 9 data block:

| Offset | Bytes | Field |
|---|---|---|
| 0-35 | 36 | Core, as v8, except the layout nibble is 9 |
| 36-39 | 4 | CRC-32 over bytes 0-35 **and** 104-127 |
| 40-103 | 64 | Ed25519 signature (zero when unsigned) |
| 104-127 | 24 | Lifecycle region |

## 3. Lifecycle region (24 bytes)

A list of `[tag u8][length u8][body]` objects, then zero padding. A tag of 0 ends the list.

| Tag | Object |
|---|---|
| 0x01 | LIFECYCLE |
| 0x00 | end of list |
| other | unknown: a reader MUST skip it by its length and MUST NOT fail |

A reader MUST treat a length that runs past the region as an error in the region, not in the symbol: the main payload still decodes. At most one LIFECYCLE object is allowed.

### LIFECYCLE body

```
[event mask u8] [u16 date for each set mask bit, in event order] [3-byte record] x N
```

Event mask bits (bit 0 = least significant): M, P, A, O, I, D. Bits 6 and 7 MUST be 0; a reader that sees them set MUST ignore the whole LIFECYCLE object as unsupported.
A date is a big-endian u16 count of days since 2000-01-01 (range 2000-01-01 to 2179-06-06).
The body length minus the mask and date table MUST be a multiple of 3. The record count follows from the length.

### Records (24 bits, big-endian, always 3 bytes)

```
duration   tttt 0 uu eee vvvvvvvvvvvvvv
absolute   tttt 1 000 dddddddddddddddd
```

| Field | Bits | Meaning |
|---|---|---|
| type *t* | 4 | 1 W Warranty, 2 G Guarantee, 3 E Expiry, 4 B Best Before, 5 O After Opening, 6 S Service, 7 L License, 8 C Certification. 0 and 9-15 are unassigned |
| mode | 1 | 0 duration, 1 absolute end date |
| unit *u* | 2 | 0 D days, 1 M calendar months, 2 Y calendar years (3 unassigned) |
| event *e* | 3 | 0 none, 1 M, 2 P, 3 A, 4 O, 5 I, 6 D (7 unassigned) |
| value *v* | 14 | integer 1 to 16383 |
| date *d* | 16 | days since 2000-01-01 |

Because the record length is fixed, a reader can step over a record whose type it does not know. It MUST keep reading the remaining records and MUST NOT show an unassigned type as valid: its status is Unknown.

Four bits of type rather than three leave seven identifiers free; three bits would have left none.

### Reference events and dates

A duration record names the event its period starts from (`event`), or 0 when the issuer has not named one. The event's date lives once, in the date table, and every record that names the event shares it. Absolute and duration records are independent: an object may hold both.

An encoder MUST NOT derive an event date from the symbol's generation time (`unixSec`), from today's date, or from another event. A reader MUST NOT either.

## 4. Validation (normative)

An encoder MUST refuse, with an error and without truncating, an object that breaks any rule below. A decoder MUST apply the structural rules (length, reserved bits) and report breaches without throwing.

1. At least one record; the object fits in 24 bytes, tag and length included: 2 + 1 + 2 × dates + 3 × records ≤ 24.
2. Type is one of the eight assigned types.
3. Duration: whole number 1-16383; unit D, M or Y; event empty or one of M P A O I D; no date.
4. Absolute: a real date from 2000-01-01 to 2179-06-06; no value, unit or event.
5. Type O (After Opening) MUST use event O. Another event, or none, is rejected.
6. At most one record per (type, mode): two warranties with different durations are ambiguous.
7. Every date-table entry is a real date in range. `2026-02-30` is rejected, never rolled over.

## 5. Date and status rules (normative)

- All dates are civil dates (proleptic Gregorian, no time of day, no time zone). Stored dates carry no zone.
- **Days** are fixed steps of one day. **Months** and **years** are calendar steps from the original date: the day of month is kept and clamped to the last day of a shorter month. Jan 31 + 1 month = Feb 28 (Feb 29 in a leap year); Feb 29 + 1 year = Feb 28.
- Months and years are added to the original date in one step, never by repeating shorter steps. A year is 12 months.
- **The end date is the last day of validity.** A record ending 2027-01-01 is valid on 2027-01-01 and expired from 2027-01-02.
- A reader supplies **today** as a civil date in its own calendar. The library MUST NOT read the clock.

| Status | Condition (first match) |
|---|---|
| Unknown | unsupported or unassigned record |
| Pending Reference Event | duration record whose event is unspecified, or whose event date is not in the table |
| Not Yet Active | the reference date is after today |
| Expired | end date before today |
| Expiring Soon | days left ≤ the reader's threshold (0 days left counts) |
| Active | otherwise |

*Recommendation:* default the Expiring Soon threshold to 30 days. The threshold is a reader setting and is not stored in the symbol.

Display the stored unit: 6 months is shown as "6 Months", not "180 Days".

## 6. Security (normative)

- A signed symbol's signature covers the lifecycle region. The signing input is the tag `QX-HD/v9`, the length-prefixed URL, the 36 core bytes, then the 24 lifecycle bytes. Layout 8 signatures are unchanged (`QX-HD/v8`, no lifecycle bytes).
- The layout nibble is inside the signed core. Removing the lifecycle region, or relabelling a v9 symbol as v8, therefore breaks the signature.
- A v8-only reader cannot decode a v9 symbol at all (its RS and CRC-32 checks fail first), so it never reaches the signature and never shows wrong data.
- A reader MUST report each symbol's lifecycle data as one of: **authenticated** (signed, and a key on the reader's trust list verifies it, with the issuer named), **unauthenticated** (not signed), **invalid** (signed but no trusted key verifies it: edited, stripped or from an unknown issuer). `QXPayloadV8.lifecycleAuth()` implements this.
- The CRC-32 detects damage; only the signature detects deliberate edits. An unsigned lifecycle claim is the label printer's word and nobody else's.
- A valid signature proves who issued the claim and that it was not altered. It does not prove the warranty exists. A photocopy of a valid symbol still verifies.

## 7. Reader behaviour (normative unless marked)

1. Decode the rings. Try layout 8 (RS(152,104) then CRC-32); if that fails, layout 9. Each has its own CRC-32 and layout nibble.
2. If layout 9, decode the lifecycle region. If it cannot be read, the reader MUST still return the main payload, and SHOULD say that lifecycle data is present but unreadable.
3. Resolve reference dates from the table only. Calculate end dates and statuses (section 5).
4. Verify the signature and report the authentication state (section 6).
5. Show each record with its type, stored value, status and end date, plus the authentication state.

The studio shows this in its PRODUCT LIFECYCLE panel. *Recommendation:* a pending record should say what is missing ("waiting for opening date"), never "valid".

## 8. Compatibility

| Case | Behaviour |
|---|---|
| Codes without lifecycle data | layout 8, identical bytes, identical SVG (frozen in `test/golden-v8.json`) |
| Optional feature | no lifecycle input, no change |
| v8 reader meets v9 | cannot decode it and reports the symbol unreadable, the same message as heavy damage; no wrong data is shown |
| Unknown object tag in the lifecycle region | skipped |
| Unassigned lifecycle type | record kept, status Unknown, other records read |
| Geometry | unchanged; v9 inks cells that v8 leaves blank |

## 9. Capacity

| Option | Data bytes for lifecycle | Correctable bytes | Notes |
|---|---|---|---|
| Layout 9, RS(184,128) (chosen) | 24 | 28 (15.2%) | one codeword, one CRC, one signature input |
| Separate RS(32,24) block + CRC-32 | 20 | 4 of 32 (12.5%) | two decoders, a flag, signature appended |
| Inside the 104-byte block | 0 | 24 | would remove the serial or GPS slot |

Per record: 3 bytes. Shared dates: 2 bytes per event. Examples that fit: 7 records and no dates; 6 records and 1 date; 3 records and 6 dates.

Overhead: layout 9 adds 24 data bytes and 8 parity bytes (+32 bytes, 152 to 184). Memory use was not measured beyond that. The example in section 10 uses 17 of 24 bytes; the same information as ASCII would take 44 bytes. Encoding a symbol takes about 0.56 ms against 0.42 ms for layout 8; decoding about 0.5 ms.

## 10. Examples

Notation (interface only; the symbol stores the binary form): `2Y-W@P` is a 2-year warranty from purchase, `6M-O` is 6 months after opening, `2027-01-01-E` is an absolute expiry. A bare `2Y-W` has no reference event and stays pending.

**Duration records.** `2Y-W@P, 1Y-G@P, 6M-O` with purchase date 2026-11-03:

```
01 0c  02  26 4b  14 80 02  24 80 01  53 00 06  00 ... (padding to 24 bytes)
```

- `01 0c`: LIFECYCLE, body length 12.
- `02`: mask, bit 1 set = event P has a date.
- `26 4b`: 0x264B = 9803 days after 2000-01-01 = 2026-11-03.
- `14 80 02` = `0001 0 10 010 00000000000010`: type 1 (W), duration, unit 2 (Y), event 2 (P), value 2.
- `24 80 01`: type 2 (G), Y, P, value 1.
- `53 00 06` = `0101 0 01 100 00000000000110`: type 5 (O), unit 1 (M), event 4 (O), value 6.

On 2026-11-03 a reader shows: Warranty 2 Years, Active, until 2028-11-03. Guarantee 1 Year, Active, until 2027-11-03. After Opening 6 Months, Pending Reference Event: the opening date is unknown, and the purchase date is not used in its place.

**Absolute expiry.** `2027-01-01-E`:

```
01 04  00  38 26 86  00 ...
```

`38 26 86` = `0011 1 000 0010011010000110`: type 3 (E), absolute, reserved 0, date 0x2686 = 9862 days = 2027-01-01.

## 11. Known limitations

- The studio is the only reader; there is no camera reader yet, and nothing has been printed and scanned. Phone cameras read only the QR core.
- A v8-only reader gives no "unknown layout" message for a v9 symbol, only "decode failed". The existing extension policy (reject on an unknown layout nibble) is not met for old readers, because v9 changes the codeword length and the nibble is unreachable. Readers should be updated before v9 symbols are printed.
- Symbols with lifecycle data have 28 correctable bytes spread over 184, a slightly lower tolerance in percent than layout 8, and need the full outer ring area printed cleanly.
- At most 7 records. Each (type, mode) pair can appear once, so two different warranties on one symbol are not possible.
- Dates run from 2000-01-01 to 2179-06-06. Durations up to 16383 units.
- Nothing proves a real-world claim is true or that a label is the original item.
- No reference event can be "learned" after printing: a pending event stays pending unless the reader obtains the date from outside the symbol.
- The studio checks signatures with the issuer key you type; a trust-list reader exists only as `verifyTrusted` / `lifecycleAuth`.

## 12. Affected files

| File | Change |
|---|---|
| [assets/qx-lifecycle.js](../assets/qx-lifecycle.js) | new: record model, validation, binary codec, dates, status, notation |
| [index.html](../index.html) | layout 9 in `QXPayloadV8` and `QXChronoEngine`; studio inputs and lifecycle panel |
| [test/lifecycle.test.mjs](../test/lifecycle.test.mjs), [test/inline.mjs](../test/inline.mjs), [test/golden-v8.json](../test/golden-v8.json) | new tests, a loader that runs the shipped inline code, frozen v8 outputs |
| [package.json](../package.json) | `npm test` runs every `test/*.test.mjs` |
| [README.md](../README.md), this file | documentation |
