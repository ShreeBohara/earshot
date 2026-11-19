// Fetch-level cassettes (Phase 3 spec, WP5 step 7, and WP11 step 7). A cassette `fetch` answers
// each request from recorded interactions, keyed by a SHA-256 of the method, the URL path, and
// the canonical JSON body, so CI never reaches a provider: a request with no recorded answer
// throws instead of going to the network. It uses only WebCrypto and the Fetch API, so it runs
// in workerd as well as Node.
import type { LlmProvider } from "@earshot/core";

export const CASSETTE_VERSION = 1;

/** What `fetch` takes as its first argument, in both the web and Node type libraries. */
export type FetchInput = Parameters<typeof fetch>[0];

export interface CassetteRequest {
  readonly method: string;
  /** The URL path. The host isn't part of the key; a gateway URL has its own path, and key. */
  readonly path: string;
  /**
   * The body without the system prompt and the tool schema (`requestExcerpt`): what varies per
   * request, for reading. The key covers the whole body.
   */
  readonly excerpt: unknown;
}

export interface CassetteResponse {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  /** A JSON body, parsed; a string is sent as it is. */
  readonly body: unknown;
  /** Waits this long before answering, abortably: for deadline tests. */
  readonly delayMs?: number;
}

export interface CassetteInteraction {
  readonly key: string;
  readonly request: CassetteRequest;
  readonly response: CassetteResponse;
}

export interface Cassette {
  readonly name: string;
  readonly description: string;
  readonly interactions: readonly CassetteInteraction[];
}

/** One provider's cassettes, as `cassettes/<provider>.json` holds them. */
export interface CassetteFile {
  readonly version: typeof CASSETTE_VERSION;
  readonly provider: LlmProvider;
  readonly model: string;
  /** `hand-made` by scripts/gen-cassettes.ts, or `recorded` from a live run. */
  readonly source: "hand-made" | "recorded";
  readonly cassettes: Readonly<Record<string, Cassette>>;
}

/** JSON with object keys sorted at every level, so key order never changes a cassette key. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function parseBody(text: string): unknown {
  if (text === "") return "";
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** The cassette key: hex SHA-256 of `METHOD\npath\ncanonical-body`. */
export async function cassetteKey(method: string, path: string, body: string): Promise<string> {
  const parsed = parseBody(body);
  const canonical = typeof parsed === "string" ? parsed : canonicalJson(parsed);
  const bytes = new TextEncoder().encode(`${method.toUpperCase()}\n${path}\n${canonical}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * A request body without what's the same in every request of a session: the system prompt (a
 * top-level `system`, or `system` messages) and the `tools`. Those are reviewed in source and
 * covered by the key, and leaving them out keeps a cassette to the transcript, the retry's
 * feedback, and the call options.
 */
export function requestExcerpt(body: unknown): unknown {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return body;
  const { system: _system, tools: _tools, messages, ...rest } = body as Record<string, unknown>;
  if (!Array.isArray(messages)) return rest;
  return {
    ...rest,
    messages: messages.filter(
      (message) => (message as { role?: unknown } | null)?.role !== "system",
    ),
  };
}

/** A request as a cassette sees it: method, path, excerpt, and its key. */
export async function readCassetteRequest(
  input: FetchInput,
  init?: RequestInit,
): Promise<CassetteRequest & { readonly key: string }> {
  const request = new Request(input, init);
  const bodyText = await request.text();
  const path = new URL(request.url).pathname;
  return {
    method: request.method,
    path,
    excerpt: requestExcerpt(parseBody(bodyText)),
    key: await cassetteKey(request.method, path, bodyText),
  };
}

/** Builds the `Response` a cassette answers with. */
export function cassetteResponse(response: CassetteResponse): Response {
  const headers = new Headers(response.headers);
  const isText = typeof response.body === "string";
  if (!headers.has("content-type") && !isText) headers.set("content-type", "application/json");
  const body = isText ? (response.body as string) : JSON.stringify(response.body);
  return new Response(body, { status: response.status, headers });
}

export class CassetteMissError extends Error {
  override readonly name = "CassetteMissError";
  readonly method: string;
  readonly path: string;
  readonly key: string;

  constructor(method: string, path: string, key: string) {
    super(
      `No cassette interaction for ${method} ${path} (key ${key.slice(0, 12)}). The request changed, or the cassette is stale: run \`pnpm --filter @earshot/agent cassettes:gen\`.`,
    );
    this.method = method;
    this.path = path;
    this.key = key;
  }
}

export interface CassetteFetch {
  (input: FetchInput, init?: RequestInit): Promise<Response>;
  /** Requests nothing answered. Each one would have gone to the network. */
  readonly misses: readonly CassetteMissError[];
  /** Requests answered so far. */
  readonly played: number;
  /** Interactions not played yet. */
  remaining(): number;
}

function delay(ms: number, signal: AbortSignal | null | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(signal.reason);
      },
      { once: true },
    );
  });
}

/**
 * A `fetch` that replays a cassette. Interactions with the same key play in recorded order, so a
 * request that's retried (after a 429, say) gets the next recorded answer. A request with no
 * interaction left throws `CassetteMissError` and is listed in `misses`.
 */
export function createCassetteFetch(cassette: Cassette): CassetteFetch {
  const queues = new Map<string, CassetteInteraction[]>();
  for (const interaction of cassette.interactions) {
    const queue = queues.get(interaction.key) ?? [];
    queue.push(interaction);
    queues.set(interaction.key, queue);
  }
  const misses: CassetteMissError[] = [];
  let played = 0;
  const replay = async (input: FetchInput, init?: RequestInit) => {
    const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined);
    if (signal?.aborted) throw signal.reason;
    const request = await readCassetteRequest(input, init);
    const interaction = queues.get(request.key)?.shift();
    if (!interaction) {
      const miss = new CassetteMissError(request.method, request.path, request.key);
      misses.push(miss);
      throw miss;
    }
    if (interaction.response.delayMs) await delay(interaction.response.delayMs, signal);
    played++;
    return cassetteResponse(interaction.response);
  };
  return Object.defineProperties(replay, {
    misses: { value: misses },
    played: { get: () => played },
    remaining: {
      value: () => [...queues.values()].reduce((sum, queue) => sum + queue.length, 0),
    },
  }) as CassetteFetch;
}
