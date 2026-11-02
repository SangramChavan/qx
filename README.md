# QX

An open-source round QR code, by [Tap In Here](https://tapinhere.com). Scan it with any phone camera: it opens a page in the browser that shows what the code is attached to, with the right information and buttons, and lets you ask questions answered from that item's own information. No app, no sign-up.

**Live:** https://qx.tapinhere.com (landing, demos and the studio that draws the symbols)

> Status: draft specification and working prototype. Not a certified standard. Not yet scanned from printed labels with phones; tested with software decoders only.

```
scan  ->  instant context  ->  useful information  ->  ask when needed  ->  done
```

## How a scan works

1. The phone camera reads the QR core of the symbol. It holds a short, permanent address: `https://qx.tapinhere.com/e/<ID>/`.
2. That address is a pre-built static page, so it loads fast and shows its core information even with JavaScript off.
3. The page layout depends on the type: **product**, **business**, **person**, **machine** or **asset** each get their own sections and buttons (call, directions, support, save contact, report a fault).
4. "Ask about this item" runs in the browser. It finds passages in that page's own information and quotes them with their section name. It never writes new text, makes no network request, and says so when something is not in the information.
5. The address never changes. Editing the information changes the page, not the printed code.

## Add your own item

Each page is one JSON file in `entities/`, named after its ID.

```bash
node scripts/build.mjs     # validate everything and write e/<ID>/ pages and sitemap.xml
node --test test/qx.test.mjs
```

- **ID:** 8 characters from `0-9 A-H J K M N P-T V-Z` (no I, L, O, U), the same alphabet Tap In Here tags use. IDs must differ from each other in at least 3 characters. A lower-case or mistyped ID is redirected by `404.html`.
- **Fields:** `type`, `title`, `subtitle`, `summary`, `badges`, `facts` (label/value), `sections` (`text`, `list`, `steps`, `callout`, `table`), `documents`, `faqs`, `records` (dated history), `actions`, `updated`. See the five demos in `entities/`.
- **Actions:** `call` (`tel:`), `email` (`mailto:`), `whatsapp` (`https://wa.me/`), `directions` and `link` (`https://` only), and `vcard` for people (the file is generated for you).
- **Search engines:** product and business pages are indexed; person, machine and asset pages are `noindex` and left out of the sitemap unless you set `"indexable": true`.

The build rejects unknown fields, unsafe links and malformed data, and escapes all text. Pages carry a strict content-security policy with no inline scripts or styles.

### Everything in `entities/` is public

There is deliberately no field for private information. Anything you commit is published and stays in git history even after you remove it. Do not put private data in an entity file.

## What this version does not do

Pages are static and public, so these parts of a fuller "AI-ready" product are not here:

- **Private information and owner sign-in.** No per-owner access control, no private fields, no editing without a commit.
- **Generated answers.** The ask box quotes; it does not summarise or reason, so a question phrased very differently from the page text can be missed (it refuses rather than guesses). Questions like "who has this laptop?" are a known weak case.
- **Enquiry capture and scan analytics.** Buttons open the visitor's own phone, mail or WhatsApp app. Nothing is recorded.
- **A public API or MCP server.** Each page also publishes its data at `e/<ID>/entity.json`, which is just a file.

A backend can be added later without changing any printed address: the page already reads its own data as JSON, so a server-side resolver (private entities, a generative model, analytics) can serve the same URLs.

## The symbol

A 30 mm disc, from the centre out:

| Layer | What it holds |
|---|---|
| QR core (ISO/IEC 18004, level M, V2-V6) | A URL of up to 106 bytes (105 with non-ASCII, which adds a UTF-8 ECI marker). Best of 8 masks by standard penalty score. 4-module quiet zone. |
| Time marks (48) | Date and time to the second plus CRC-8, in four crescents between the core and the rings. |
| Data rings (152 bytes) | 12 data rings plus a sync ring. RS(152,104): 104 data bytes and 48 error-correction bytes. Repairs up to 24 unknown damaged bytes (up to 48 if a reader can mark which are damaged). |

Payload v7 (104 bytes): layout and flags, 32-bit unix time, optional GPS (24-bit lat and lon, about 1.2 m by 2.4 m), a 4-byte URL CRC-32 (unsigned symbols only), a 21-byte serial (6-bit packed for `A-Z a-z 0-9 - _`, up to 27 characters, else UTF-8), a CRC-32 of those 36 bytes, and a 64-byte Ed25519 signature (zero when unsigned). The signature covers the QR URL and the 36 bytes above.

Limits of the symbol itself:

- Phone cameras read only the QR core. Reading the rings needs a QX reader, which does not exist yet.
- A signature proves who issued a code, not that a label is the original. A photocopy of a valid code still verifies.
- Smallest QR squares are 0.23-0.34 mm; print at 300 DPI or better.
- The centre logo is capped at half of each block's error correction, so short URLs (V2-V3) show no logo. A standard `/e/<ID>/` address is a V3 code, so QX symbols for these pages carry no centre logo.

## Run locally

Static files, no build step for the studio:

```bash
python3 -m http.server 8790
```

Open http://localhost:8790. Self-checks run from the browser console and throw on failure:

```js
runPolarSelfTest(500)         // RS decoder and payload round trips
runUrlSelfTest()              // tracking-parameter stripping
await runSignatureSelfTest()  // RFC 8032 Ed25519 vector and tamper cases
```

## Privacy

Pages make no network requests beyond loading their own files, and the ask box sends nothing anywhere. The studio runs entirely in your browser; an issuer key you type stays in page memory and is never written into a downloaded SVG.

## Licence

MIT. See [LICENSE](LICENSE). The name "QX Verified" is reserved for a future certification programme.
