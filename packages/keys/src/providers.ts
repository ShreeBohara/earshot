// The AI providers a user can bring a key for, and how to check that a key works.

export const PROVIDER_IDS = [
  "openai",
  "anthropic",
  "gemini",
  "groq",
  "deepgram",
  "assemblyai",
  "speechmatics",
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

export interface Provider {
  readonly id: ProviderId;
  readonly name: string;
  /** What the key unlocks, for the Settings → Keys screen. */
  readonly use: "llm" | "stt" | "llm+speech";
  /** A cheap authenticated GET that succeeds only with a valid key. */
  readonly validate: { readonly url: string; readonly headers: (key: string) => HeadersInit };
}

export const PROVIDERS: Readonly<Record<ProviderId, Provider>> = {
  openai: {
    id: "openai",
    name: "OpenAI",
    use: "llm+speech",
    validate: {
      url: "https://api.openai.com/v1/models",
      headers: (key) => ({ authorization: `Bearer ${key}` }),
    },
  },
  anthropic: {
    id: "anthropic",
    name: "Anthropic",
    use: "llm",
    validate: {
      url: "https://api.anthropic.com/v1/models",
      headers: (key) => ({ "x-api-key": key, "anthropic-version": "2023-06-01" }),
    },
  },
  gemini: {
    id: "gemini",
    name: "Google Gemini",
    use: "llm+speech",
    validate: {
      url: "https://generativelanguage.googleapis.com/v1beta/models",
      headers: (key) => ({ "x-goog-api-key": key }),
    },
  },
  groq: {
    id: "groq",
    name: "Groq",
    use: "llm",
    validate: {
      url: "https://api.groq.com/openai/v1/models",
      headers: (key) => ({ authorization: `Bearer ${key}` }),
    },
  },
  deepgram: {
    id: "deepgram",
    name: "Deepgram",
    use: "stt",
    validate: {
      url: "https://api.deepgram.com/v1/projects",
      headers: (key) => ({ authorization: `Token ${key}` }),
    },
  },
  assemblyai: {
    id: "assemblyai",
    name: "AssemblyAI",
    use: "stt",
    validate: {
      url: "https://api.assemblyai.com/v2/transcript?limit=1",
      headers: (key) => ({ authorization: key }),
    },
  },
  speechmatics: {
    id: "speechmatics",
    name: "Speechmatics",
    use: "stt",
    validate: {
      url: "https://asr.api.speechmatics.com/v2/jobs?limit=1",
      headers: (key) => ({ authorization: `Bearer ${key}` }),
    },
  },
};

export function isProviderId(value: string): value is ProviderId {
  return (PROVIDER_IDS as readonly string[]).includes(value);
}

/** The only part of a key Earshot ever shows: its last four characters. */
export function last4(secret: string): string {
  const trimmed = secret.trim();
  return trimmed.length <= 4 ? "••••" : trimmed.slice(-4);
}

export type ValidationResult =
  | { readonly ok: true; readonly status: number }
  | { readonly ok: false; readonly status?: number; readonly reason: string };

/**
 * Checks a key against its provider. Runs wherever `fetchImpl` does: in a Worker route that
 * forwards the key for this one request, or in tests with a fake fetch. Never echoes the key.
 */
export async function validateKey(
  provider: ProviderId,
  secret: string,
  fetchImpl: typeof fetch = fetch,
): Promise<ValidationResult> {
  const { url, headers } = PROVIDERS[provider].validate;
  try {
    const response = await fetchImpl(url, { method: "GET", headers: headers(secret.trim()) });
    if (response.ok) return { ok: true, status: response.status };
    const reason =
      response.status === 401 || response.status === 403
        ? "The provider rejected this key."
        : `The provider answered ${response.status}.`;
    return { ok: false, status: response.status, reason };
  } catch {
    return { ok: false, reason: "Couldn't reach the provider. Check your connection and retry." };
  }
}
