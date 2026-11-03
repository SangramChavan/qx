// Runs the REAL engine code from index.html (sections 1-4: GF256, chrono, QR matrix, payload, rings) in a vm,
// so tests exercise what ships rather than a copy. Sections after the "5. UI Controller" marker need a DOM and are not loaded.
import vm from "node:vm";
import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../index.html", import.meta.url), "utf8");
const start = html.indexOf("<script>\n/**") + "<script>\n".length;
const end = html.lastIndexOf("/**", html.indexOf("5. UI Controller"));

export function loadEngine(extra = {}) {
  const ctx = vm.createContext({ crypto: globalThis.crypto, TextEncoder, TextDecoder, BigInt, console, ...extra });
  const src = html.slice(start, end) + "\n;({ GF256, QXChronoRegister, MultiVersionMatrix, QXPayloadV8, QXChronoEngine })";
  return { ...vm.runInContext(src, ctx), ctx };
}
