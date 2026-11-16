import { describe, expect, it } from "vitest";
import {
  MIC_CONSTRAINTS,
  type MicrophoneEnvironment,
  openMicrophone,
} from "../src/capture/microphone";

function fakeEnvironment(
  options: { fail?: unknown; permission?: string; queryThrows?: boolean } = {},
) {
  const log: string[] = [];
  const stopped: string[] = [];
  const stream = {
    getTracks: () => [
      { stop: () => stopped.push("audio-1") },
      { stop: () => stopped.push("audio-2") },
    ],
  } as unknown as MediaStream;
  let constraints: MediaStreamConstraints | undefined;
  const audioSession = {
    set type(value: string) {
      log.push(value);
    },
    get type() {
      return log.at(-1) ?? "auto";
    },
  };
  const environment: MicrophoneEnvironment = {
    mediaDevices: {
      getUserMedia: async (requested?: MediaStreamConstraints) => {
        constraints = requested;
        log.push("getUserMedia");
        if (options.fail !== undefined) throw options.fail;
        return stream;
      },
    },
    audioSession,
    permissions: {
      query: async () => {
        if (options.queryThrows) throw new TypeError("unsupported name");
        return { state: options.permission ?? "prompt" } as PermissionStatus;
      },
    },
  };
  return { environment, log, stopped, stream, constraints: () => constraints };
}

describe("openMicrophone", () => {
  it("asks for mono audio with echo cancellation, noise suppression, and gain control", async () => {
    const fake = fakeEnvironment();
    await openMicrophone(fake.environment);
    expect(fake.constraints()).toEqual({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    expect(fake.constraints()).toBe(MIC_CONSTRAINTS);
  });

  it("declares play-and-record before asking, then playback and auto after closing", async () => {
    const fake = fakeEnvironment();
    const mic = await openMicrophone(fake.environment);
    expect(fake.log).toEqual(["play-and-record", "getUserMedia"]);
    mic.close();
    mic.close();
    expect(fake.log).toEqual(["play-and-record", "getUserMedia", "playback", "auto"]);
    expect(fake.stopped).toEqual(["audio-1", "audio-2"]);
    expect(mic.stream).toBe(fake.stream);
  });

  it("works without the Audio Session API (every browser but Safari)", async () => {
    const fake = fakeEnvironment();
    const { audioSession: _, ...withoutSession } = fake.environment;
    const mic = await openMicrophone(withoutSession);
    mic.close();
    expect(fake.stopped).toHaveLength(2);
  });

  it("reports a refusal as permission_denied, and hands the audio session back", async () => {
    const fake = fakeEnvironment({
      fail: new DOMException("denied", "NotAllowedError"),
      permission: "denied",
    });
    await expect(openMicrophone(fake.environment)).rejects.toMatchObject({
      code: "permission_denied",
      retryable: false,
    });
    expect(fake.log.slice(-2)).toEqual(["playback", "auto"]);
  });

  it("reports a refusal with permission granted as permission_stuck (WebKit bug 319706)", async () => {
    const fake = fakeEnvironment({
      fail: new DOMException("No AVAudioSessionCaptureDevice", "NotAllowedError"),
      permission: "granted",
    });
    await expect(openMicrophone(fake.environment)).rejects.toMatchObject({
      code: "permission_stuck",
    });
  });

  it("treats a browser that can't query microphone permission as a plain refusal", async () => {
    const fake = fakeEnvironment({
      fail: new DOMException("denied", "NotAllowedError"),
      queryThrows: true,
    });
    await expect(openMicrophone(fake.environment)).rejects.toMatchObject({
      code: "permission_denied",
    });
  });

  it("reports a missing or busy device as device_unavailable, retryable only when busy", async () => {
    await expect(
      openMicrophone(
        fakeEnvironment({ fail: new DOMException("none", "NotFoundError") }).environment,
      ),
    ).rejects.toMatchObject({ code: "device_unavailable", retryable: false });
    await expect(
      openMicrophone(
        fakeEnvironment({ fail: new DOMException("busy", "NotReadableError") }).environment,
      ),
    ).rejects.toMatchObject({ code: "device_unavailable", retryable: true });
  });

  it("reports an insecure context, with no mediaDevices, as device_unavailable", async () => {
    await expect(openMicrophone({})).rejects.toMatchObject({ code: "device_unavailable" });
  });
});
