# QX

An open-source round QR code. A standard QR core that any phone camera can scan, wrapped in rings that carry signed time, optional GPS and a serial number, protected by Reed-Solomon error correction.

**Live studio:** https://qx.tapinhere.com

> Status: draft specification and working prototype (v2.5). Not a certified standard. Not yet scanned from printed labels with phones; tested with software decoders only.

## What is in a symbol

A 30 mm disc, from the centre out:

| Layer | What it holds |
|---|---|
| QR core (ISO/IEC 18004, level M, V2-V6) | A URL of up to 106 bytes (105 with non-ASCII, which adds a UTF-8 ECI marker). Best of 8 masks by standard penalty score. 4-module quiet zone. |
| Time marks (48) | Date and time to the second plus CRC-8, in four crescents between the core and the rings. |
| Data rings (80 bytes) | RS(80,48): 48 payload bytes and 32 error-correction bytes. Repairs up to 16 unknown damaged bytes (up to 32 if a reader can mark which are damaged). |

Payload v6 (48 bytes): layout and flags, 32-bit unix time, optional GPS (24-bit lat and lon, about 1.2 m by 2.4 m), an 8-byte tag (CRC-32 of the URL, or a truncated HMAC-SHA256 when an issuer key is used), a 25-byte serial (6-bit packed for `A-Z a-z 0-9 - _`, else UTF-8), and a CRC-32.

## Limits

- Phone cameras read only the QR core. Reading the rings needs a QX reader, which does not exist yet.
- A signature proves who issued a code, not that a label is the original. A photocopy of a valid code still verifies.
- Smallest QR squares are 0.23-0.34 mm; print at 300 DPI or better.
- The centre logo is capped at half of each block's error correction, so short URLs (V2-V3) show no logo.

## Run locally

It is one static file with no build step.

```bash
python3 -m http.server 8790
```

Open http://localhost:8790. Self-checks run from the browser console and throw on failure:

```js
runPolarSelfTest(500)         // RS decoder and payload round trips
runUrlSelfTest()              // tracking-parameter stripping
await runSignatureSelfTest()  // HMAC vector and tamper cases
```

## Privacy

The studio runs entirely in your browser. Nothing is uploaded. An issuer key you type stays in page memory and is never written into a downloaded SVG.

## Licence

MIT. See [LICENSE](LICENSE). The name "QX Verified" is reserved for a future certification programme.
