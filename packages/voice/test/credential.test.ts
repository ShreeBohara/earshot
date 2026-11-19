import { describe, expect, it } from "vitest";
import type { TempCredential } from "../src/stt/adapter";
import { providerSocketUrl } from "../src/stt/credential";
import { createDeepgramFluxAdapter } from "../src/stt/deepgram-flux";
import { createDeepgramNova3Adapter } from "../src/stt/deepgram-nova3";
import { FakeSocketServer } from "../src/testing/fake-socket";

// The body POST /api/voice/token answers with (WP3): `url` is a base the adapter extends.
const deepgram: TempCredential = {
  provider: "deepgram",
  credential: "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjcmVkIn0.c2lnLWNyZWQ",
  expiresAt: "2026-11-15T12:00:30.000Z",
  url: "wss://api.deepgram.com",
};

describe("providerSocketUrl", () => {
  it("appends the provider's path to a bare origin", () => {
    expect(providerSocketUrl(deepgram, "deepgram", "/v1/listen").toString()).toBe(
      "wss://api.deepgram.com/v1/listen",
    );
  });

  it("appends it after a relay's own path, with or without a trailing slash", () => {
    for (const url of [
      "wss://edge.example.com/relay/deepgram",
      "wss://edge.example.com/relay/deepgram/",
    ]) {
      expect(providerSocketUrl({ ...deepgram, url }, "deepgram", "/v2/listen").toString()).toBe(
        "wss://edge.example.com/relay/deepgram/v2/listen",
      );
    }
  });

  it("refuses a credential minted for another provider", () => {
    expect(() => providerSocketUrl(deepgram, "assemblyai", "/v3/ws")).toThrow(
      expect.objectContaining({ code: "bad_request", retryable: false }),
    );
  });

  it("refuses cleartext ws: except on loopback", () => {
    expect(() =>
      providerSocketUrl({ ...deepgram, url: "ws://api.deepgram.com" }, "deepgram", "/v1/listen"),
    ).toThrow("must use wss:");
    expect(() =>
      providerSocketUrl({ ...deepgram, url: "https://api.deepgram.com" }, "deepgram", "/v1/listen"),
    ).toThrow("must use wss:");
    for (const host of ["localhost:8787", "127.0.0.1:8787", "[::1]:8787"]) {
      expect(
        providerSocketUrl({ ...deepgram, url: `ws://${host}` }, "deepgram", "/v1/listen").pathname,
      ).toBe("/v1/listen");
    }
  });

  it("refuses a url that isn't one, without quoting the credential", () => {
    try {
      providerSocketUrl({ ...deepgram, url: "not a url" }, "deepgram", "/v1/listen");
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(deepgram.credential);
      expect(error).toMatchObject({ code: "bad_request" });
    }
  });
});

describe("one Deepgram credential", () => {
  it("serves both Nova-3 (/v1/listen) and Flux (/v2/listen), as [bearer, jwt]", async () => {
    const server = new FakeSocketServer();
    server.onConnection = (socket) => socket.accept("bearer");
    await createDeepgramNova3Adapter({ socket: server.factory }).connect({
      credential: deepgram,
      keyterms: [],
      baseOffsetMs: 0,
    });
    await createDeepgramFluxAdapter({ socket: server.factory }).connect({
      credential: deepgram,
      keyterms: [],
      baseOffsetMs: 0,
    });
    expect(server.sockets.map((socket) => socket.url.pathname)).toEqual([
      "/v1/listen",
      "/v2/listen",
    ]);
    for (const socket of server.sockets)
      expect(socket.protocols).toEqual(["bearer", deepgram.credential]);
  });
});
