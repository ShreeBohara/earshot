// Opening the microphone (spec WP4 step 1). One stream serves the whole armed session; pressing
// push-to-talk gates sending, not capture (spec decision 11).
import { VoiceError } from "../errors";

/** The same constraints as vad-web's defaults, so hands-free's VAD hears what the provider hears. */
export const MIC_CONSTRAINTS = {
  audio: {
    channelCount: 1,
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  },
} as const satisfies MediaStreamConstraints;

/** Safari's Audio Session API, which TypeScript's DOM lib doesn't have yet. */
export interface AudioSessionLike {
  type: string;
}

/** What `openMicrophone` touches, so tests can pass fakes. */
export interface MicrophoneEnvironment {
  readonly mediaDevices?: Pick<MediaDevices, "getUserMedia">;
  readonly audioSession?: AudioSessionLike;
  readonly permissions?: Pick<Permissions, "query">;
}

export interface Microphone {
  readonly stream: MediaStream;
  /** Stops every track, then hands iOS's audio session back for playback. Idempotent. */
  close(): void;
}

/** The page's own environment. */
export function browserMicrophoneEnvironment(): MicrophoneEnvironment {
  const nav = globalThis.navigator as
    | (Navigator & { readonly audioSession?: AudioSessionLike })
    | undefined;
  return {
    mediaDevices: nav?.mediaDevices,
    audioSession: nav?.audioSession,
    permissions: nav?.permissions,
  };
}

/**
 * Asks for the microphone. On Safari it first declares a play-and-record audio session, as the
 * Audio Session API asks. Failures come back as a `VoiceError`; a refusal while permission reads
 * as granted is `permission_stuck` (WebKit bug 319706).
 */
export async function openMicrophone(
  environment: MicrophoneEnvironment = browserMicrophoneEnvironment(),
): Promise<Microphone> {
  const { mediaDevices, audioSession } = environment;
  if (!mediaDevices) {
    throw new VoiceError(
      "device_unavailable",
      "getUserMedia is unavailable (not a secure context?)",
    );
  }
  if (audioSession) audioSession.type = "play-and-record";
  let stream: MediaStream;
  try {
    stream = await mediaDevices.getUserMedia(MIC_CONSTRAINTS);
  } catch (error) {
    releaseAudioSession(audioSession);
    throw await microphoneError(error, environment);
  }
  let closed = false;
  return {
    stream,
    close() {
      if (closed) return;
      closed = true;
      for (const track of stream.getTracks()) track.stop();
      releaseAudioSession(audioSession);
    },
  };
}

/** After the mic closes, "playback" then "auto": the WebKit report's workaround for a session stuck in play-and-record. */
function releaseAudioSession(audioSession: AudioSessionLike | undefined): void {
  if (!audioSession) return;
  audioSession.type = "playback";
  audioSession.type = "auto";
}

async function microphoneError(error: unknown, environment: MicrophoneEnvironment) {
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    const state = await permissionState(environment);
    return state === "granted"
      ? new VoiceError("permission_stuck", "the microphone failed with permission granted", {
          cause: error,
        })
      : new VoiceError("permission_denied", "microphone permission was refused", { cause: error });
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return new VoiceError("device_unavailable", "no usable microphone", { cause: error });
  }
  // NotReadableError (in use, or a hardware fault), AbortError, and anything else.
  return new VoiceError("device_unavailable", "the microphone couldn't start", {
    retryable: true,
    cause: error,
  });
}

async function permissionState(environment: MicrophoneEnvironment): Promise<string | undefined> {
  try {
    const status = await environment.permissions?.query({ name: "microphone" as PermissionName });
    return status?.state;
  } catch {
    return undefined; // Firefox and older Safari reject the "microphone" name
  }
}
