// Redaction (Phase 6 spec §4.2, decision 14): what `redact` masks, and how `holdsSecret` finds a
// credential anywhere in what an adapter throws or previews, which the conformance suite relies on.
import { describe, expect, it } from "vitest";
import { CREDENTIAL_PREVIEW, holdsSecret, REDACTED, redact, redactCause } from "../src";

/** A token with no fixed shape, as HubSpot's OAuth access tokens and Attio's keys are. Made up. */
const OPAQUE = "opaqueFAKEtokenForRedactionTests0nly-xYz7";

/**
 * A made-up token in the shape of a HubSpot private app or service key (`pat-na1-` and a UUID),
 * assembled at runtime so the source holds no literal a secret scanner reads as a HubSpot key.
 */
const HUBSPOT_SHAPED = ["pat", "na1", "1a2b3c4d-1a2b-1a2b-1a2b-1a2b3c4d5e6f"].join("-");

describe("redact", () => {
  it.each([
    ["Authorization: Bearer abcdefghijkl", `Authorization: ${REDACTED}`],
    ['{"authorization":"Basic dXNlcjpwYXNz"}', `{"authorization":"${REDACTED}"}`],
    ["proxy-authorization=Token secret123", `proxy-authorization=${REDACTED}`],
    ["sent Bearer abcdefghijkl to the CRM", `sent Bearer ${REDACTED} to the CRM`],
    [
      "GET /crm/v3/objects?hapikey=abc123def&limit=10",
      `GET /crm/v3/objects?hapikey=${REDACTED}&limit=10`,
    ],
    ["/oauth?code=xyz987&state=1", `/oauth?code=${REDACTED}&state=1`],
    [
      '{"access_token": "abc", "expires_in": 1800}',
      `{"access_token": "${REDACTED}", "expires_in": 1800}`,
    ],
    [`key ${HUBSPOT_SHAPED} refused`, `key ${REDACTED} refused`],
    ["a JWT eyJhbGciOiJI.eyJzdWIiOiIx.c2lnbmF0dXJl here", `a JWT ${REDACTED} here`],
    ["sk-ant-api03-aaaaaaaaaaaaaaaaaaaaaaaa", REDACTED],
  ])("masks %j", (text, expected) => {
    expect(redact(text)).toBe(expected);
  });

  it("masks each exact secret, raw and JSON-escaped, but not a short one", () => {
    const quoted = 'abc"defghij';
    expect(redact(`token ${OPAQUE} again ${OPAQUE}`, [OPAQUE])).toBe(
      `token ${REDACTED} again ${REDACTED}`,
    );
    expect(redact(JSON.stringify({ t: quoted }), [quoted])).toBe(`{"t":"${REDACTED}"}`);
    expect(redact("the word secret", ["secret"])).toBe("the word secret");
  });

  it("leaves ordinary words, ids, markers, and the preview's mask alone", () => {
    for (const text of [
      "HubSpot refused a value",
      "es_oxmttwqjbgqfzongy4te",
      "adec44cb187ee88bb8157d6d32261ab33c47321718fdefe59f991dd2b9535513",
      `Authorization header shown as ${CREDENTIAL_PREVIEW.slice("Bearer ".length)}`,
      "Bearer •••",
      "the deal went to the bearer of bad news",
    ]) {
      expect(redact(text)).toBe(text);
    }
  });
});

describe("redactCause", () => {
  it("keeps undefined, redacts a string, and replaces a non-error", () => {
    expect(redactCause(undefined)).toBeUndefined();
    expect(redactCause(`Bearer ${OPAQUE}`)).toBe(`Bearer ${REDACTED}`);
    expect((redactCause(42) as Error).message).toBe("a number value was thrown");
    expect((redactCause(null) as Error).message).toBe("a null value was thrown");
  });
});

describe("holdsSecret", () => {
  it("finds 8 characters of the secret in a string, an error, its cause, and nested values", () => {
    const fragment = OPAQUE.slice(10, 18);
    expect(holdsSecret(`…${fragment}…`, OPAQUE)).toBe(true);
    expect(holdsSecret(new Error("x", { cause: new Error(OPAQUE) }), OPAQUE)).toBe(true);
    expect(holdsSecret({ a: [{ b: `x${OPAQUE}` }] }, OPAQUE)).toBe(true);
    expect(holdsSecret(new Headers({ authorization: `Bearer ${OPAQUE}` }), OPAQUE)).toBe(true);
    const custom = Object.assign(new Error("fine"), { body: OPAQUE });
    expect(holdsSecret(custom, OPAQUE)).toBe(true);
  });

  it("finds nothing in what doesn't hold it, follows cycles once, and ignores an empty secret", () => {
    const cycle: Record<string, unknown> = { a: "fine" };
    cycle.self = cycle;
    expect(holdsSecret(cycle, OPAQUE)).toBe(false);
    expect(holdsSecret([1, null, true, undefined, "x"], OPAQUE)).toBe(false);
    expect(holdsSecret("anything", "  ")).toBe(false);
    expect(holdsSecret("abc", "abc")).toBe(true);
  });
});
