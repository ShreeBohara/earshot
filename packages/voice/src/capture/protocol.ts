// Messages between the pcm16-capture worklet and the main thread.

/** The name the worklet registers its processor under. */
export const CAPTURE_PROCESSOR_NAME = "pcm16-capture";

/** From the worklet: a frame of 16 kHz PCM16 (its buffer is transferred) and its RMS level. */
export interface WorkletFrameMessage {
  readonly type: "frame";
  readonly pcm: ArrayBuffer;
  readonly rms: number;
  /** True for the frame that answers `flush`: shorter than 512 samples, possibly empty. */
  readonly flush: boolean;
}

export type WorkletOutbound = WorkletFrameMessage;

/** To the worklet: emit the partial frame now (a push-to-talk release), or stop processing. */
export type WorkletInbound = { readonly type: "flush" } | { readonly type: "stop" };
