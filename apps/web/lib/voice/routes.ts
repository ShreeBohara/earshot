// The session and voice-token routes' logic (spec WP3, docs/adr/0023), with every dependency
// passed in, as lib/keys/routes.ts does: app/api/sessions, app/api/sessions/[id]/ticket, and
// app/api/voice/token wire it to the request (lib/voice/deps.ts), and tests pass their own
// database, tenant transaction, environment, logger, provider fetch, and clock. Callers have
// already checked the sign-in (withViewer), so every function here receives the viewer.
//
// The rules:
// - A session's row is written in the viewer's tenant transaction before anything can flush
//   events for it, and a ticket is issued only for an open session that is the viewer's own.
// - A provider key arrives only in the x-earshot-provider-key header, serves one mint request,
//   and goes nowhere else: no response, log line, or table holds it. The credential minted with
//   it goes to the response and nowhere else.
// - Keys, credentials, and tickets join the request logger's secrets as soon as they exist.
// - Every answer is `cache-control: no-store` and quotes nothing from the request.
import {
  containsKeyShape,
  type EntityKind,
  MAX_SESSION_ENTITIES,
  type PolicySnapshot,
  type PolicyVersion,
  type ProviderModel,
  type SessionProviders,
  signPolicySnapshot,
} from "@earshot/core";
import { DEMO_CRM_EXTERNAL_ID_PREFIX, readApprovalPolicy, schema } from "@earshot/db";
import {
  type FetchLike,
  PROVIDER_ID_HEADER,
  PROVIDER_KEY_HEADER,
  type ValidationFailure,
} from "@earshot/keys/server";
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { Mode } from "../auth/config";
import { consumeRateLimit, type RateLimitRule } from "../auth/throttle";
import type { TenantTx, withViewerTenant } from "../auth/viewer";
import type { Viewer } from "../auth/viewer-core";
import type { AppDb } from "../db/types";
import { type Logger, type RequestLogger, requestLogger } from "../log";
import {
  readSessionConfig,
  type SessionConfig,
  SessionConfigError,
  type SessionEnv,
} from "./config";
import { sessionEntities, startEntityBudget } from "./entities";
import { clientIp, noStoreJson, readJsonBody, refusal, refuseCrossSite, serverError } from "./http";
import { accountFamilyCount, type CrmEntity, rankEntities, sessionKeyterms } from "./keyterms";
import { isMintProvider, mintCredential } from "./mint";
import { issueTicket, sessionSocketUrl } from "./tickets";
import type {
  CreateSessionResponse,
  SessionKeyterms,
  SessionTicketResponse,
  VoiceTokenResponse,
} from "./types";

export type VoiceRouteDeps = {
  /** The owner connection, for the rate-limit counters. */
  db: AppDb;
  /** Runs work in a transaction pinned to the viewer's workspace and user, under RLS. */
  withViewerTenant: typeof withViewerTenant;
  /** Where EARSHOT_SESSION_TICKET_SECRET and EDGE_PUBLIC_URL come from: the Worker's environment. */
  env: SessionEnv;
  /** A redacting logger (lib/log.ts). Each request wraps it to redact its own secrets too. */
  log: Logger;
  /** Reaches the providers' mint endpoints; the global `fetch` in the app. */
  fetch: FetchLike;
  now: () => Date;
  /** `development` under `next dev` only. Outside it, the session configuration is required. */
  mode: Mode;
  /** On in production, off under `next dev`, like the key routes' limits (docs/adr/0021). */
  rateLimit: boolean;
};

const TEN_MINUTES = 10 * 60 * 1000;

/**
 * The routes' rate limits (targets), counted in Postgres by `consumeRateLimit`, on counters of
 * their own: minting doesn't share the key checks' budget, and they don't share its.
 */
export const VOICE_LIMITS = {
  /** New sessions per user. */
  sessionsPerUser: { max: 20, windowMs: TEN_MINUTES },
  /**
   * Fresh tickets per user. Not in the spec: a generous cap, since a client on a flaky network
   * asks for one on every reconnect, but each ticket is a signed credential, so there is one.
   */
  ticketsPerUser: { max: 120, windowMs: TEN_MINUTES },
  /** Provider credentials per user and per client IP, so the route can't test stolen keys. */
  tokensPerUser: { max: 60, windowMs: TEN_MINUTES },
  tokensPerIp: { max: 120, windowMs: TEN_MINUTES },
} as const satisfies Record<string, RateLimitRule>;

/** `{ mode, engine, providers, selectedAccountId }` needs well under this. */
const MAX_SESSION_BODY_BYTES = 2048;
/** `{ "sessionId": … }` needs about 60 bytes. */
const MAX_TOKEN_BODY_BYTES = 256;
/** Real keys are 32 to 200 characters; anything longer is refused before it goes anywhere. */
const MAX_KEY_LENGTH = 512;
/** What a key can hold: printable ASCII and no spaces, as an HTTP header value needs. */
const KEY_CHARACTERS = /^[\x21-\x7e]+$/;
/** Provider ids as the session records them, for example `assemblyai` or `anthropic`. */
const PROVIDER_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** Model ids, for example `universal-streaming-english` or `openai/gpt-oss-20b`. */
const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/@+-]{0,127}$/;
/**
 * 24 or more letters and digits in a row. Model and provider ids are short words joined by
 * separators; a run this long that mixes letters and digits is an opaque token, such as a
 * Deepgram or AssemblyAI key pasted into the wrong field, which no key pattern would recognize.
 */
const LONG_RUN = /[A-Za-z0-9]{24,}/g;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The CRM rows read per kind: as many as `start` can carry in all. */
const CRM_ROWS_PER_KIND = MAX_SESSION_ENTITIES;
/** The selected account's contacts and deals read, at most. */
const ACCOUNT_ROWS = 2 * MAX_SESSION_ENTITIES;
const ENTITY_KINDS: readonly EntityKind[] = ["company", "contact", "deal"];

/**
 * `POST /api/sessions`: starts a debrief. In order: same-site only (403), the session
 * configuration must be usable (500 otherwise, with the reason in the log), the body must be
 * `{ mode: "debrief", engine: "cascaded", providers, selectedAccountId? }` (400), and the user
 * must be under 20 new sessions in 10 minutes (429). Then, in one tenant transaction, it reads the
 * workspace's CRM rows, ranks them (lib/voice/keyterms.ts), inserts the session's row with its
 * focus account (Phase 5 WP3), and signs the first ticket, which carries how and when the viewer
 * signed in. Answers 201 with `CreateSessionResponse`: the selected account, if it's a company
 * among the session's entities, is its `focusEntityId`, and each contact and deal carries its
 * company's id as `parentId` (Phase 4 WP8). From Phase 5 WP11 it also reads the workspace's
 * approval policy in the same transaction and signs it for the new session (`policy`), which the
 * client sends in `start`.
 */
export async function createSessionRoute(
  viewer: Viewer,
  request: Request,
  deps: VoiceRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const config = readConfig(deps, log);
    if (!config) return serverError();
    const body = await readCreateSession(request);
    if (body instanceof Response) return body;
    const limited = await checkLimits(deps, log, "session create", "new sessions", [
      {
        scope: "user",
        key: `session-create|user:${viewer.user.id}`,
        rule: VOICE_LIMITS.sessionsPerUser,
      },
    ]);
    if (limited) return limited;

    const created = await deps.withViewerTenant(async (tx) => {
      const { sessions } = schema;
      // The workspace's approval policy as it stands now (Phase 5 WP11): this session keeps it,
      // and a later change applies from the next session. It rides in `start`, so it counts
      // against the message's bytes before the entities do.
      const policy = sessionPolicy(await readApprovalPolicy(tx), log);
      const rows = await loadCrmEntities(tx, viewer.workspaceId, body.selectedAccountId);
      const ranked = rankEntities(rows, body.selectedAccountId);
      const entities = sessionEntities(ranked.all, startEntityBudget(body.providers, policy));
      const account = ranked.account;
      // `start` refuses a focus outside its entities, so the account counts only if it's there.
      const focusEntityId =
        account && entities.some((entity) => entity.id === account.id) ? account.id : null;
      const [row] = await tx
        .insert(sessions)
        .values({
          workspaceId: viewer.workspaceId,
          userId: viewer.user.id,
          mode: "debrief",
          engine: "cascaded",
          providers: body.providers,
          focusEntityId,
        })
        .returning({ id: sessions.id });
      if (!row) throw new Error("the session row wasn't written");
      // Signed inside the transaction, so a failure here leaves no session behind.
      const ticket = await issueTicket(config.ticketSecret, {
        sessionId: row.id,
        userId: viewer.user.id,
        workspaceId: viewer.workspaceId,
        now: deps.now(),
        signIn: signInOf(viewer),
      });
      log.addSecret(ticket.ticket);
      return {
        sessionId: row.id,
        ticket,
        entities,
        focusEntityId,
        keyterms: sessionKeyterms(ranked.keytermSources, accountFamilyCount(ranked)),
        policy: policy ? await signedPolicy(config.ticketSecret, policy, row.id, log) : null,
      };
    }, viewer);

    log.info("session created", {
      entities: created.entities.length,
      focus: created.focusEntityId !== null,
      keyterms: counts(created.keyterms),
      policyVersion: created.policy?.version ?? null,
    });
    const answer: CreateSessionResponse = {
      sessionId: created.sessionId,
      ticket: created.ticket.ticket,
      ticketExpiresAt: created.ticket.expiresAt.toISOString(),
      edgeUrl: sessionSocketUrl(config.edgeOrigin, created.sessionId),
      entities: created.entities,
      focusEntityId: created.focusEntityId,
      keyterms: created.keyterms,
      policy: created.policy,
    };
    return noStoreJson(201, answer);
  } catch (error) {
    log.error("session create failed", { error });
    return serverError();
  }
}

/**
 * `POST /api/sessions/:id/ticket`: a fresh ticket for reconnecting to a session, since each ticket
 * opens one socket. Same-site only (403); configuration as above (500); at most 120 tickets per
 * user in 10 minutes (429). The session must be the viewer's own (404 otherwise, and the same 404
 * for one that doesn't exist) and must not be sealed (409 `session_ended`). An ended session that
 * isn't sealed still gets one (Phase 5 WP3): SessionDO takes the tray's reviews until it seals, so
 * a socket that drops after `end` can come back for them.
 */
export async function sessionTicketRoute(
  viewer: Viewer,
  request: Request,
  sessionId: string,
  deps: VoiceRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const config = readConfig(deps, log);
    if (!config) return serverError();
    const id = canonicalUuid(sessionId);
    if (!id) return notFound();
    const limited = await checkLimits(deps, log, "session ticket", "reconnects", [
      {
        scope: "user",
        key: `session-ticket|user:${viewer.user.id}`,
        rule: VOICE_LIMITS.ticketsPerUser,
      },
    ]);
    if (limited) return limited;

    const state = await deps.withViewerTenant((tx) => sessionState(tx, viewer, id), viewer);
    if (state === "missing") return notFound();
    if (state === "sealed") return sessionEnded();
    const ticket = await issueTicket(config.ticketSecret, {
      sessionId: id,
      userId: viewer.user.id,
      workspaceId: viewer.workspaceId,
      now: deps.now(),
      signIn: signInOf(viewer),
    });
    log.addSecret(ticket.ticket);
    log.info("session ticket issued");
    const answer: SessionTicketResponse = {
      sessionId: id,
      ticket: ticket.ticket,
      ticketExpiresAt: ticket.expiresAt.toISOString(),
      edgeUrl: sessionSocketUrl(config.edgeOrigin, id),
    };
    return noStoreJson(200, answer);
  } catch (error) {
    log.error("session ticket failed", { error });
    return serverError();
  }
}

/** How each mint failure is answered: 422 for a refused key, the 50x family for the rest. */
const MINT_FAILURES: Record<ValidationFailure, { status: number; message: string }> = {
  rejected: {
    status: 422,
    message: "The provider rejected this key. Check it in Settings → Keys.",
  },
  rate_limited: {
    status: 503,
    message: "The provider is limiting requests right now. Try again in a minute.",
  },
  upstream_error: {
    status: 502,
    message: "The provider couldn't answer just now. Try again in a minute.",
  },
  unreachable: {
    status: 504,
    message: "Earshot couldn't reach the provider. Try again in a minute.",
  },
};

/**
 * `POST /api/voice/token`: mints a speech-to-text provider's temporary credential from the
 * user's own key, for one of the viewer's open sessions. The provider comes in
 * `x-earshot-provider`, the key in `x-earshot-provider-key`, and the body is `{ sessionId }`.
 * In order: same-site only (403); a provider Earshot can mint for (400 `unknown_provider`), a key
 * in the header (400 `missing_key`, also when one was sent in the body or the URL instead), no
 * query string and nothing else in the body (400); at most 60 mints per user and 120 per client
 * IP in 10 minutes (429); an open session of the viewer's (404, 409). Then one request to the
 * provider, with a 10-second timeout. Answers `VoiceTokenResponse`, or the provider's failure as
 * a fixed code. Never anything the provider sent besides the credential.
 */
export async function voiceTokenRoute(
  viewer: Viewer,
  request: Request,
  deps: VoiceRouteDeps,
): Promise<Response> {
  const log = requestLogger(deps.log);
  // Redacted from every line this request writes, from the first.
  const key = request.headers.get(PROVIDER_KEY_HEADER)?.trim() ?? "";
  log.addSecret(key);
  try {
    const refused = refuseCrossSite(request);
    if (refused) return refused;
    const provider = request.headers.get(PROVIDER_ID_HEADER)?.trim() ?? "";
    if (!isMintProvider(provider)) {
      return refusal(
        400,
        "unknown_provider",
        "Name assemblyai or deepgram in the x-earshot-provider header.",
      );
    }
    if (!key) {
      return refusal(400, "missing_key", "Send the key in the x-earshot-provider-key header.");
    }
    if (key.length > MAX_KEY_LENGTH || !KEY_CHARACTERS.test(key)) {
      return refusal(400, "invalid_request", "That key isn't valid.");
    }
    if (new URL(request.url).search) {
      return refusal(
        400,
        "invalid_request",
        "Send nothing in the URL: the session goes in the body.",
      );
    }
    const sessionId = await readTokenBody(request);
    if (sessionId instanceof Response) return sessionId;

    const buckets: LimitBucket[] = [
      {
        scope: "user",
        key: `voice-token|user:${viewer.user.id}`,
        rule: VOICE_LIMITS.tokensPerUser,
      },
    ];
    const ip = clientIp(request);
    if (ip)
      buckets.push({ scope: "ip", key: `voice-token|ip:${ip}`, rule: VOICE_LIMITS.tokensPerIp });
    const limited = await checkLimits(deps, log, "voice token", "voice token requests", buckets);
    if (limited) return limited;

    const state = await deps.withViewerTenant((tx) => sessionState(tx, viewer, sessionId), viewer);
    if (state === "missing") return notFound();
    // No new speech after the end: a credential is for capture, and capture is over.
    if (state !== "open") return sessionEnded();

    const minted = await mintCredential(provider, key, { fetch: deps.fetch, now: deps.now });
    if (!minted.ok) {
      log[minted.code === "rejected" ? "info" : "warn"]("voice token not minted", {
        provider,
        reason: minted.code,
        status: minted.status,
      });
      const { status, message } = MINT_FAILURES[minted.code];
      return refusal(status, minted.code, message);
    }
    log.addSecret(minted.credential);
    log.info("voice token minted", { provider, status: minted.status });
    const answer: VoiceTokenResponse = {
      provider,
      credential: minted.credential,
      expiresAt: minted.expiresAt.toISOString(),
      url: minted.url,
    };
    return noStoreJson(200, answer);
  } catch (error) {
    log.error("voice token failed", { error });
    return serverError();
  }
}

/** The session configuration, or undefined after logging why it can't be used. */
function readConfig(deps: VoiceRouteDeps, log: Logger): SessionConfig | undefined {
  try {
    return readSessionConfig(deps.env, deps.mode);
  } catch (error) {
    if (!(error instanceof SessionConfigError)) throw error;
    // Fixed text that names the variable and the fix, and never quotes a value.
    log.error(`session routes unavailable: ${error.message}`);
    return undefined;
  }
}

type CreateSessionBody = { providers: SessionProviders; selectedAccountId: string | undefined };

/**
 * The body of `POST /api/sessions`, checked strictly: no other fields, and provider and model
 * ids of a plain shape with nothing in them shaped like a key, since the session's row stores
 * them. Nothing from the body is ever quoted back.
 */
async function readCreateSession(request: Request): Promise<CreateSessionBody | Response> {
  const invalid = () =>
    refusal(
      400,
      "invalid_request",
      'Send { "mode": "debrief", "engine": "cascaded", "providers": { "speechToText", "llm" } } as JSON.',
    );
  const body = await readJsonBody(request, MAX_SESSION_BODY_BYTES);
  if (!isRecord(body) || !hasOnlyKeys(body, ["mode", "engine", "providers", "selectedAccountId"])) {
    return invalid();
  }
  if (body.mode !== "debrief" || body.engine !== "cascaded") return invalid();
  const providers = readProviders(body.providers);
  if (!providers) return invalid();
  const { selectedAccountId } = body;
  if (selectedAccountId === undefined || selectedAccountId === null) {
    return { providers, selectedAccountId: undefined };
  }
  const account = typeof selectedAccountId === "string" ? canonicalUuid(selectedAccountId) : null;
  return account ? { providers, selectedAccountId: account } : invalid();
}

/** A cascaded debrief's providers: a speech-to-text model and an LLM, and nothing else. */
function readProviders(value: unknown): SessionProviders | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["speechToText", "llm"])) return undefined;
  const speechToText = readProviderModel(value.speechToText);
  const llm = readProviderModel(value.llm);
  return speechToText && llm ? { speechToText, llm } : undefined;
}

function readProviderModel(value: unknown): ProviderModel | undefined {
  if (!isRecord(value) || !hasOnlyKeys(value, ["provider", "model"])) return undefined;
  const { provider, model } = value;
  if (typeof provider !== "string" || !PROVIDER_NAME.test(provider)) return undefined;
  if (typeof model !== "string" || !MODEL_NAME.test(model)) return undefined;
  for (const id of [provider, model]) {
    if (containsKeyShape(id) || looksLikeToken(id)) return undefined;
  }
  return { provider, model };
}

function looksLikeToken(id: string): boolean {
  return (id.match(LONG_RUN) ?? []).some((run) => /[0-9]/.test(run) && /[A-Za-z]/.test(run));
}

/** The `sessionId` in `POST /api/voice/token`'s body, or the 400 to answer. */
async function readTokenBody(request: Request): Promise<string | Response> {
  const body = await readJsonBody(request, MAX_TOKEN_BODY_BYTES);
  const sessionId =
    isRecord(body) && hasOnlyKeys(body, ["sessionId"]) && typeof body.sessionId === "string"
      ? canonicalUuid(body.sessionId)
      : null;
  return (
    sessionId ??
    refusal(
      400,
      "invalid_request",
      'Send { "sessionId": … } as JSON, and the key only in the x-earshot-provider-key header.',
    )
  );
}

/**
 * Whether the session is the viewer's, and open, ended (not sealed yet), or sealed. Another
 * member's session in the same workspace is as missing as another workspace's, which row-level
 * security already hides.
 */
async function sessionState(
  tx: TenantTx,
  viewer: Viewer,
  sessionId: string,
): Promise<"open" | "ended" | "sealed" | "missing"> {
  const { sessions } = schema;
  const [row] = await tx
    .select({ userId: sessions.userId, endedAt: sessions.endedAt, sealedAt: sessions.sealedAt })
    .from(sessions)
    .where(and(eq(sessions.workspaceId, viewer.workspaceId), eq(sessions.id, sessionId)))
    .limit(1);
  if (!row || row.userId !== viewer.user.id) return "missing";
  if (row.sealedAt !== null) return "sealed";
  return row.endedAt === null ? "open" : "ended";
}

/** How and when the viewer's web session signed in, for the ticket's `am` and `sat` claims. */
function signInOf(viewer: Viewer): { method: Viewer["session"]["signInMethod"]; at: Date } {
  return { method: viewer.session.signInMethod, at: viewer.session.createdAt };
}

/**
 * The policy a new session takes (Phase 5 WP11): the workspace's latest version, or none when it
 * has none, when that version approves nothing, or when its stored rules no longer parse, which
 * is logged. No policy is the safe side: every proposal waits for the rep.
 */
function sessionPolicy(
  stored: Awaited<ReturnType<typeof readApprovalPolicy>>,
  log: Logger,
): PolicyVersion | null {
  if (stored === null) return null;
  if (stored === "invalid") {
    log.error("approval policy unreadable: its rules don't parse, so this session applies none");
    return null;
  }
  if (stored.rules.autoApprove.length === 0) return null;
  return { id: stored.id, version: stored.version, rules: stored.rules };
}

/**
 * The policy signed for session `sessionId` with the ticket secret (`signPolicySnapshot`), for the
 * client to carry in `start`. The socket refuses a `start` holding anything shaped like a key, and
 * a signature is random base64url, so about one in 100,000 could happen to look like one: that
 * session gets no policy instead of failing to start, and every proposal waits for the rep.
 */
async function signedPolicy(
  ticketSecret: string,
  policy: PolicyVersion,
  sessionId: string,
  log: Logger,
): Promise<PolicySnapshot | null> {
  const snapshot = await signPolicySnapshot(ticketSecret, policy, sessionId);
  if (containsKeyShape(snapshot.sig)) {
    log.warn("approval policy left out of a session: its signature is shaped like a key");
    return null;
  }
  return snapshot;
}

/**
 * The workspace's CRM rows a session can draw on: the most recently updated 250 of each kind,
 * plus the selected account and up to 500 of its contacts and deals, whatever their age. Only
 * the columns ranking needs: never the embedding, and of the properties only `companyId`.
 */
async function loadCrmEntities(
  tx: TenantTx,
  workspaceId: string,
  selectedAccountId: string | undefined,
): Promise<CrmEntity[]> {
  const { crmEntities } = schema;
  const companyId = sql<string | null>`${crmEntities.properties} ->> 'companyId'`;
  const columns = {
    id: crmEntities.id,
    kind: crmEntities.kind,
    name: crmEntities.name,
    aliases: crmEntities.aliases,
    connectionId: crmEntities.connectionId,
    externalId: crmEntities.externalId,
    companyId,
    updatedAt: crmEntities.updatedAt,
  };
  // Row-level security already confines the reads to the workspace; the filter keeps them explicit.
  const inWorkspace = eq(crmEntities.workspaceId, workspaceId);
  const byRecency = [desc(crmEntities.updatedAt), asc(crmEntities.id)] as const;

  const rows: CrmEntityRow[] = [];
  for (const kind of ENTITY_KINDS) {
    rows.push(
      ...(await tx
        .select(columns)
        .from(crmEntities)
        .where(and(inWorkspace, eq(crmEntities.kind, kind)))
        .orderBy(...byRecency)
        .limit(CRM_ROWS_PER_KIND)),
    );
  }
  if (selectedAccountId) {
    const [account] = await tx
      .select(columns)
      .from(crmEntities)
      .where(
        and(inWorkspace, eq(crmEntities.id, selectedAccountId), eq(crmEntities.kind, "company")),
      )
      .limit(1);
    if (account) {
      rows.push(account);
      rows.push(
        ...(await tx
          .select(columns)
          .from(crmEntities)
          .where(
            and(
              inWorkspace,
              inArray(crmEntities.kind, ["contact", "deal"]),
              account.connectionId === null
                ? isNull(crmEntities.connectionId)
                : eq(crmEntities.connectionId, account.connectionId),
              sql`${companyId} = ${sourceIdOf(account)}`,
            ),
          )
          .orderBy(...byRecency)
          .limit(ACCOUNT_ROWS)),
      );
    }
  }
  return rows.flatMap(({ kind, externalId, ...row }): CrmEntity[] =>
    isEntityKind(kind)
      ? [{ ...row, kind, sourceId: sourceIdOf({ connectionId: row.connectionId, externalId }) }]
      : [],
  );
}

type CrmEntityRow = Omit<CrmEntity, "kind" | "sourceId"> & { kind: string; externalId: string };

/**
 * A row's id in its source CRM, which its contacts and deals name as `companyId`. The demo CRM's
 * rows carry their dataset ids behind a `demo:` prefix (packages/db/src/demo-crm.ts).
 */
function sourceIdOf(row: { connectionId: string | null; externalId: string }): string {
  return row.connectionId === null && row.externalId.startsWith(DEMO_CRM_EXTERNAL_ID_PREFIX)
    ? row.externalId.slice(DEMO_CRM_EXTERNAL_ID_PREFIX.length)
    : row.externalId;
}

function isEntityKind(kind: string): kind is EntityKind {
  return (ENTITY_KINDS as readonly string[]).includes(kind);
}

type LimitBucket = { scope: "user" | "ip"; key: string; rule: RateLimitRule };

/**
 * Counts this request against each bucket in turn, and answers 429, with Retry-After, at the
 * first that's full. Off under `next dev`. The counters' keys hold a user id or an address, never
 * a key or an email.
 */
async function checkLimits(
  deps: VoiceRouteDeps,
  log: RequestLogger,
  label: string,
  what: string,
  buckets: readonly LimitBucket[],
): Promise<Response | null> {
  if (!deps.rateLimit) return null;
  const now = deps.now().getTime();
  for (const { scope, key, rule } of buckets) {
    const decision = await consumeRateLimit(deps.db, key, rule, now);
    if (decision.allowed) continue;
    log.warn(`${label} refused: too many requests`, { scope });
    const minutes = Math.ceil(decision.retryAfterSeconds / 60);
    return refusal(
      429,
      "too_many_requests",
      `Too many ${what}. Try again in ${minutes} minute${minutes === 1 ? "" : "s"}.`,
      { retryAfterSeconds: decision.retryAfterSeconds },
      { "retry-after": String(decision.retryAfterSeconds) },
    );
  }
  return null;
}

function notFound(): Response {
  return refusal(404, "not_found", "That session doesn't exist, or it isn't yours.");
}

function sessionEnded(): Response {
  return refusal(409, "session_ended", "That session has ended. Start a new one.");
}

function counts(keyterms: SessionKeyterms): Record<keyof SessionKeyterms, number> {
  return { assemblyai: keyterms.assemblyai.length, deepgram: keyterms.deepgram.length };
}

/** A UUID in the lowercase form Postgres returns, or null. */
function canonicalUuid(value: string): string | null {
  return UUID.test(value) ? value.toLowerCase() : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(record: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(record).every((key) => allowed.includes(key));
}
