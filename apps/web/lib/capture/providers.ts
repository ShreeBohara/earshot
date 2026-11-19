// The speech-to-text and LLM choices the capture screen offers, from the keys on this device.
// Keys never pass through here: only their metadata (provider, label, last four characters).
import type { LlmProvider } from "@earshot/core";
import type { StoredKeyMeta } from "@earshot/keys";
import { ASSEMBLYAI_MODEL, DEEPGRAM_FLUX_MODEL, DEEPGRAM_NOVA3_MODEL } from "@earshot/voice";

export type SttOptionId = "assemblyai" | "deepgram-nova3" | "deepgram-flux";

export interface SttOption {
  readonly id: SttOptionId;
  readonly name: string;
  /** The key it needs, and the provider `POST /api/voice/token` mints for. */
  readonly keyProvider: "assemblyai" | "deepgram";
  readonly model: string;
}

export interface LlmOption {
  readonly id: LlmProvider;
  readonly name: string;
  readonly keyProvider: LlmProvider;
  readonly model: string;
}

/** AssemblyAI first: the spec's default (WP1 may change it). One Deepgram key serves both. */
export const STT_OPTIONS: readonly SttOption[] = [
  { id: "assemblyai", name: "AssemblyAI", keyProvider: "assemblyai", model: ASSEMBLYAI_MODEL },
  {
    id: "deepgram-nova3",
    name: "Deepgram Nova-3",
    keyProvider: "deepgram",
    model: DEEPGRAM_NOVA3_MODEL,
  },
  {
    id: "deepgram-flux",
    name: "Deepgram Flux",
    keyProvider: "deepgram",
    model: DEEPGRAM_FLUX_MODEL,
  },
];

/** The extraction models `@earshot/agent` has adapters and prices for. */
export const LLM_OPTIONS: readonly LlmOption[] = [
  { id: "groq", name: "Groq · gpt-oss-20b", keyProvider: "groq", model: "openai/gpt-oss-20b" },
  {
    id: "anthropic",
    name: "Anthropic · Claude Haiku 5.5",
    keyProvider: "anthropic",
    model: "claude-haiku-5-5",
  },
];

/** One way to run a provider: the option, and which of the device's keys pays for it. */
export interface Choice<O> {
  /** `<option id>:<key label>`, for a select's value. */
  readonly value: string;
  readonly option: O;
  readonly keyLabel: string;
  readonly last4: string;
}

export interface ProviderChoices {
  readonly stt: readonly Choice<SttOption>[];
  readonly llm: readonly Choice<LlmOption>[];
}

function choicesFor<O extends { id: string; keyProvider: string }>(
  options: readonly O[],
  keys: readonly StoredKeyMeta[],
): Choice<O>[] {
  return options.flatMap((option) =>
    keys
      .filter((key) => key.provider === option.keyProvider)
      .map((key) => ({
        value: `${option.id}:${key.label}`,
        option,
        keyLabel: key.label,
        last4: key.last4,
      })),
  );
}

/** Every option this device has a key for, one entry per key. */
export function providerChoices(keys: readonly StoredKeyMeta[]): ProviderChoices {
  return { stt: choicesFor(STT_OPTIONS, keys), llm: choicesFor(LLM_OPTIONS, keys) };
}

/** What the rep picked: one speech-to-text choice and one LLM choice. */
export interface ProviderSelection {
  readonly stt: string;
  readonly llm: string;
}

/** The first choice of each kind, or null when the device lacks a key for one. */
export function defaultSelection(choices: ProviderChoices): ProviderSelection | null {
  const stt = choices.stt[0];
  const llm = choices.llm[0];
  return stt && llm ? { stt: stt.value, llm: llm.value } : null;
}

/** The label a picker shows: the provider, and which key, by label and last four characters. */
export function choiceLabel(choice: Choice<SttOption | LlmOption>): string {
  const key =
    choice.keyLabel === "default"
      ? `key …${choice.last4}`
      : `key “${choice.keyLabel}” …${choice.last4}`;
  return `${choice.option.name} (${key})`;
}
