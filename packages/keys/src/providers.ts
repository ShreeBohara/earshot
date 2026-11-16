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
  readonly validate: {
    readonly url: string;
    readonly headers: (key: string) => Readonly<Record<string, string>>;
  };
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

/** Why a key didn't validate: a fixed code, never anything the provider sent back. */
export type ValidationFailure = "rejected" | "rate_limited" | "upstream_error" | "unreachable";

export type ValidationResult =
  | { readonly ok: true; readonly status: number }
  | {
      readonly ok: false;
      readonly status?: number;
      readonly code: ValidationFailure;
      /** A sentence for the UI, written here; never the provider's own message. */
      readonly reason: string;
    };

/** The part of `fetch` that validation uses. The global `fetch` fits it. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * Checks a key against its provider. Runs wherever `fetchImpl` does: in a Worker route that
 * forwards the key for this one request, or in tests with a fake fetch. Never echoes the key,
 * and never reads the provider's response body: some providers quote part of the key in their
 * error text.
 */
export async function validateKey(
  provider: ProviderId,
  secret: string,
  fetchImpl: FetchLike = fetch,
): Promise<ValidationResult> {
  const { url, headers } = PROVIDERS[provider].validate;
  let response: Response;
  try {
    response = await fetchImpl(url, { method: "GET", headers: headers(secret.trim()) });
  } catch {
    return {
      ok: false,
      code: "unreachable",
      reason: "Couldn't reach the provider. Check your connection and retry.",
    };
  }
  // Release the connection without reading what the provider wrote.
  response.body?.cancel().catch(() => {});
  const { status } = response;
  if (response.ok) return { ok: true, status };
  if (status === 401 || status === 403) {
    return { ok: false, status, code: "rejected", reason: "The provider rejected this key." };
  }
  if (status === 429) {
    return {
      ok: false,
      status,
      code: "rate_limited",
      reason: "The provider is limiting requests. Wait a minute and retry.",
    };
  }
  return { ok: false, status, code: "upstream_error", reason: `The provider answered ${status}.` };
}
