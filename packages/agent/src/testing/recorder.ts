// Recording cassettes from live calls. Off by default: `recordingAllowed` needs the
// EARSHOT_RECORD_CASSETTES flag set to "1" and the provider's key, and only
// scripts/record-cassettes.ts calls it. A recorded interaction keeps the request's method, path,
// and excerpt (never its headers, where the key travels) and the response's status, a few
// headers, and body, and it's refused if any run of 8 characters of a key shows up in it.
import type { LlmProvider } from "@earshot/core";
import {
  type CassetteInteraction,
  type CassetteResponse,
  canonicalJson,
  type FetchInput,
  readCassetteRequest,
} from "./cassette";

/** The environment flag that turns recording on. */
export const RECORD_FLAG = "EARSHOT_RECORD_CASSETTES";

/** Where the live eval keeps each provider's key (spec §2.2). */
export const RECORD_KEY_VARIABLES: Readonly<Record<LlmProvider, string>> = {
  anthropic: "EVAL_ANTHROPIC_KEY",
  groq: "EVAL_GROQ_KEY",
};

/** True only with the flag set to "1" and a non-empty key for the provider. */
export function recordingAllowed(
  env: Readonly<Record<string, string | undefined>>,
  provider: LlmProvider,
): boolean {
  return env[RECORD_FLAG] === "1" && (env[RECORD_KEY_VARIABLES[provider]]?.trim() ?? "") !== "";
}

/** Response headers worth keeping: the ones extraction reads. Request ids and cookies aren't. */
const KEPT_HEADERS = ["content-type", "retry-after", "retry-after-ms"];

export class RecordingLeakError extends Error {
  override readonly name = "RecordingLeakError";
  constructor() {
    super("A recorded interaction contains part of a key; it was not kept.");
  }
}

/** True if any `width`-character run of a secret appears in the text. */
function containsFragment(text: string, secret: string, width = 8): boolean {
  const value = secret.trim();
  const size = Math.min(width, value.length);
  if (size === 0) return false;
  for (let start = 0; start + size <= value.length; start++) {
    if (text.includes(value.slice(start, start + size))) return true;
  }
  return false;
}

export interface RecordingFetch {
  readonly fetch: typeof fetch;
  /** What's been recorded so far, in order. */
  interactions(): readonly CassetteInteraction[];
}

/**
 * Wraps a real `fetch`, recording each request and its response. `secrets` are the keys in use;
 * an interaction containing any part of one throws `RecordingLeakError` and isn't kept.
 */
export function createRecordingFetch(
  upstream: typeof fetch,
  secrets: readonly string[],
): RecordingFetch {
  const recorded: CassetteInteraction[] = [];
  const record = async (input: FetchInput, init?: RequestInit) => {
    const request = new Request(input, init);
    const read = await readCassetteRequest(request.clone());
    const response = await upstream(request);
    const text = await response.clone().text();
    let body: unknown = text;
    try {
      body = JSON.parse(text);
    } catch {
      // keep the text
    }
    const headers: Record<string, string> = {};
    for (const name of KEPT_HEADERS) {
      const value = response.headers.get(name);
      if (value !== null) headers[name] = value;
    }
    const kept: CassetteResponse = { status: response.status, headers, body };
    const interaction: CassetteInteraction = {
      key: read.key,
      request: { method: read.method, path: read.path, excerpt: read.excerpt },
      response: kept,
    };
    const serialized = canonicalJson(interaction);
    if (secrets.some((secret) => containsFragment(serialized, secret))) {
      throw new RecordingLeakError();
    }
    recorded.push(interaction);
    return response;
  };
  return { fetch: record as typeof fetch, interactions: () => [...recorded] };
}
