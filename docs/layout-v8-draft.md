# QX-HD payload v8 (draft, not implemented)

Status: draft for review. No code changes yet. v7 stays the shipped layout.

## Goal

Let an AI agent or QX reader decide what to do with a symbol before fetching anything:
which item type it is, whether it carries a safety notice, which item it identifies, and
whether the page it fetches still matches what was issued. All new fields sit inside the
Ed25519 signature.

## Byte budget (104 data bytes, unchanged codeword RS(152,104))

| Offset | Bytes | Field | Notes |
|---|---|---|---|
| 0 | 1 | Layout (high nibble = 8) and flags (low nibble) | GPS, packed serial, signed, safety notice |
| 1 | 1 | Entity type (3 bits) and reserved (5 bits) | product, business, person, machine, asset |
| 2 | 4 | Unix seconds | as v7 |
| 6 | 6 | GPS (optional) | as v7 |
| 12 | 5 | Entity ID | 8 Crockford characters (5 bits each) packed into 40 bits |
| 17 | 5 | Content digest | first 5 bytes of SHA-256 of the item's canonical `entity.json` |
| 22 | 14 | Serial / batch | 6-bit packed up to 17 characters, else UTF-8 up to 14 bytes |
| 36 | 4 | CRC-32 of bytes 0-35 | as v7 |
| 40 | 64 | Ed25519 signature | covers the URL and bytes 0-35 (zero when unsigned) |

Total: 36 + 4 + 64 = 104. Parity stays at 48 bytes.

## Flags (low nibble of byte 0)

- `0x1` GPS present
- `0x2` serial packed
- `0x4` signed
- `0x8` safety notice (an AI or reader should show the safety notice first)

All four bits are used, so any later flag needs a new layout version.

## Changes from v7

- **Serial shrinks from 21 bytes to 14** (packed capacity from 27 to 17 characters). The
  current demo serial `AMB-2026-PUN-BATCH09` (20 characters) would no longer pack and would
  not fit as UTF-8 either, so it has to be shortened.
- **URL CRC removed.** Unsigned symbols bind to the item through the entity ID and the
  content digest instead of a CRC of the URL.
- **Entity ID and content digest added.**

## Decisions needed

1. **Serial size.** Shrink it to 14 bytes (this draft), or drop the entity ID and keep the
   21-byte serial, relying on the URL for identity?
2. **Digest source.** A studio-generated code has no page to hash. The digest has to be
   supplied by the issuer's build step (`scripts/build.mjs`), as the signing key is.
3. **Digest length.** Now 5 bytes, using the spare byte. Deliberate edits still rely on the
   signature.

## Compatibility

v7 readers reject v8 symbols because the layout nibble differs (`UNKNOWN PAYLOAD LAYOUT`),
which is the intended behaviour. v8 readers should keep reading v7 until v7 symbols are
retired.

## Validation before adoption

- Deterministic test vectors for packing, digest and signature.
- Round-trip tests for the 14-byte serial and the packed entity ID.
- A check that the RS and ring capacity are unchanged.
- Printed samples before the layout is frozen (see Phase 1 of the roadmap).
