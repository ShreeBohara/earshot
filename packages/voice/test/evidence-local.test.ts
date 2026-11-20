// Evidence clips never leave the device (Phase 5 spec decision 6, WP9; ADR-0036): nothing in
// `@earshot/voice/evidence` can send a byte anywhere or write one to a log. The module reaches only
// IndexedDB, WebCrypto, and Web Audio; this holds its source to that, so a later change that adds a
// request, a socket, a message to another window, or a log line fails here first.
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const DIR = fileURLToPath(new URL("../src/evidence/", import.meta.url));

/** Ways out of the page, and ways into a log. */
const FORBIDDEN: readonly [string, RegExp][] = [
  ["fetch", /\bfetch\s*\(/],
  ["XMLHttpRequest", /\bXMLHttpRequest\b/],
  ["sendBeacon", /\bsendBeacon\b/],
  ["WebSocket", /\bWebSocket\b/],
  ["EventSource", /\bEventSource\b/],
  ["RTCPeerConnection", /\bRTCPeerConnection\b/],
  ["postMessage", /\bpostMessage\b/],
  ["BroadcastChannel", /\bBroadcastChannel\b/],
  ["console", /\bconsole\s*\./],
  ["a dynamic import", /\bimport\s*\(/],
];

/** The source without comments, so prose about the network doesn't count. */
function code(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("@earshot/voice/evidence", () => {
  const files = readdirSync(DIR).filter((file) => file.endsWith(".ts"));

  it("has its modules where the check looks", () => {
    expect(files.sort()).toEqual(["clip-player.ts", "clip-span.ts", "clip-store.ts", "index.ts"]);
  });

  it.each(files)("%s has no way to send audio off the device or into a log", (file) => {
    const source = code(readFileSync(path.join(DIR, file), "utf8"));
    for (const [name, pattern] of FORBIDDEN) {
      expect(pattern.test(source), `${file} uses ${name}`).toBe(false);
    }
  });

  it("imports nothing but its own modules and the engine's audio constants", () => {
    const imports = files.flatMap((file) =>
      [...readFileSync(path.join(DIR, file), "utf8").matchAll(/from\s+"([^"]+)"/g)].map(
        (match) => match[1],
      ),
    );
    expect(new Set(imports)).toEqual(
      new Set([
        "./clip-player",
        "./clip-span",
        "./clip-store",
        "../capture/dsp",
        "../witness/turn-audio",
      ]),
    );
  });
});
