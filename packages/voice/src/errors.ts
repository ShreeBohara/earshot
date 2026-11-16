import type { VoiceErrorCode } from "./codes";

export interface VoiceErrorOptions {
  readonly retryable?: boolean;
  readonly cause?: unknown;
}

/**
 * A voice failure with a fixed code. The message is for logs; the UI shows copy keyed on `code`.
 * Never put a key or a credential in the message.
 */
export class VoiceError extends Error {
  readonly code: VoiceErrorCode;
  readonly retryable: boolean;

  constructor(code: VoiceErrorCode, message: string, options: VoiceErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "VoiceError";
    this.code = code;
    this.retryable = options.retryable ?? false;
  }
}

export function isVoiceError(error: unknown): error is VoiceError {
  return error instanceof VoiceError;
}
