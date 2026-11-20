// One turn's audio as a WAV file, for the second witness's upload (Phase 4 spec WP9 step 1): PCM16,
// mono, 16 kHz, behind the canonical 44-byte RIFF header. Groq advises WAV for the lowest latency
// and downsamples anything else to 16 kHz mono itself, so the capture graph's audio goes as it is.
import { TARGET_SAMPLE_RATE } from "../capture/dsp";

/** The RIFF header's size: `RIFF`, `fmt ` (16 bytes of PCM format), and `data` chunk headers. */
export const WAV_HEADER_BYTES = 44;

function writeAscii(view: DataView, offset: number, text: string): void {
  for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i));
}

/** `pcm` as a WAV file: 16-bit little-endian samples, one channel, at `sampleRate`. */
export function encodeWav(
  pcm: Int16Array,
  sampleRate: number = TARGET_SAMPLE_RATE,
): Uint8Array<ArrayBuffer> {
  if (!Number.isInteger(sampleRate) || sampleRate <= 0) {
    throw new RangeError("sampleRate must be a positive integer");
  }
  const dataBytes = pcm.length * 2;
  const buffer = new ArrayBuffer(WAV_HEADER_BYTES + dataBytes);
  const view = new DataView(buffer);
  writeAscii(view, 0, "RIFF");
  view.setUint32(4, 36 + dataBytes, true); // the rest of the file after this field
  writeAscii(view, 8, "WAVE");
  writeAscii(view, 12, "fmt ");
  view.setUint32(16, 16, true); // the fmt chunk's size for PCM
  view.setUint16(20, 1, true); // PCM, uncompressed
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // bytes a second: one 2-byte sample per frame
  view.setUint16(32, 2, true); // bytes a frame
  view.setUint16(34, 16, true); // bits a sample
  writeAscii(view, 36, "data");
  view.setUint32(40, dataBytes, true);
  for (let i = 0; i < pcm.length; i++) {
    view.setInt16(WAV_HEADER_BYTES + i * 2, pcm[i] ?? 0, true);
  }
  return new Uint8Array(buffer);
}

/** How long `samples` of audio at `sampleRate` last, in whole ms (rounded). */
export function audioMsOf(samples: number, sampleRate: number = TARGET_SAMPLE_RATE): number {
  return Math.round((samples * 1000) / sampleRate);
}
