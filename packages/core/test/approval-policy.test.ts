import { describe, expect, it } from "vitest";
import {
  ApprovalPolicyRules,
  canonicalJson,
  checkPolicyRules,
  containsKeyShape,
  importTicketKey,
  POLICY_SIGNATURE_CHARS,
  POLICY_SIGNATURE_PREFIX,
  type PolicySnapshot,
  type PolicyVersion,
  PROPOSAL_TYPE_FIELDS,
  ProposalTypeV2,
  parseClientMessage,
  policySigningInput,
  signPolicySnapshot,
  signTicket,
  ticketClaims,
  verifyPolicySnapshot,
} from "../src";

// Approval policies (Phase 5 spec §4.6, WP11): the rules a schema can't express, the canonical
// JSON the snapshot's signature covers, and the signature itself, which SessionDO checks before
// it applies a policy, so a client can neither forge a snapshot nor carry one into another session.

const SECRET = "test-only-ticket-secret-0123456789abcdef";
const OTHER_SECRET = "another-test-ticket-secret-0123456789abcdef";
const SESSION = "01a1c6e2-9320-7deb-a57a-ba62dc02df02";
const OTHER_SESSION = "01a1c6e2-9320-7deb-a57a-ba62dc02df99";

/** "Auto-approve notes; always review amounts and stages" (spec §4.6). */
const RULES: ApprovalPolicyRules = {
  v: 1,
  autoApprove: [
    { id: "notes", type: "note", alwaysReview: [] },
    { id: "deal-updates", type: "deal_update", alwaysReview: ["amount", "stage"] },
  ],
};
const POLICY: PolicyVersion = {
  id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0d",
  version: 3,
  rules: RULES,
};

const rule = (overrides: Partial<ApprovalPolicyRules["autoApprove"][number]> = {}) => ({
  id: "notes",
  type: "note" as const,
  alwaysReview: [] as string[],
  ...overrides,
});
const rules = (...autoApprove: ApprovalPolicyRules["autoApprove"]): ApprovalPolicyRules => ({
  v: 1,
  autoApprove,
});

describe("checkPolicyRules", () => {
  it("accepts a rule per type, each holding back only its own type's fields", () => {
    expect(checkPolicyRules(RULES)).toEqual({ ok: true });
    expect(checkPolicyRules(rules())).toEqual({ ok: true });
    const every = rules(
      ...ProposalTypeV2.options.map((type) =>
        rule({ id: type.replace("_", "-"), type, alwaysReview: [...PROPOSAL_TYPE_FIELDS[type]] }),
      ),
    );
    expect(ApprovalPolicyRules.safeParse(every).success).toBe(true);
    expect(checkPolicyRules(every)).toEqual({ ok: true });
  });

  it("refuses what the schema can't: a repeated id, a second rule for a type, another type's field, a field twice", () => {
    const refused = (value: ApprovalPolicyRules) => {
      const check = checkPolicyRules(value);
      expect(check.ok).toBe(false);
      return check.ok ? "" : check.problem;
    };
    expect(refused(rules(rule(), rule({ type: "task" })))).toBe("rule 2 repeats another rule's id");
    expect(refused(rules(rule(), rule({ id: "more-notes" })))).toBe(
      "rule 2 is a second rule for its proposal type",
    );
    expect(refused(rules(rule({ alwaysReview: ["amount"] })))).toBe(
      "rule 1 lists a field its proposal type doesn't have",
    );
    expect(
      refused(rules(rule({ id: "deals", type: "deal_update", alwaysReview: ["stage", "stage"] }))),
    ).toBe("rule 1 lists a field twice");
  });

  it("refuses an id shaped like a key, which would stop every session's start, without quoting it", () => {
    const shaped = `sk-${"a".repeat(24)}`;
    expect(containsKeyShape(shaped)).toBe(true);
    const value = rules(rule({ id: shaped }));
    expect(ApprovalPolicyRules.safeParse(value).success).toBe(true);
    const check = checkPolicyRules(value);
    expect(check).toEqual({ ok: false, problem: "rule 1 has an id shaped like a key" });
    expect(JSON.stringify(check)).not.toContain(shaped);
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every level, keeps arrays in order, and writes no whitespace", () => {
    expect(canonicalJson({ b: 1, a: [3, { d: "x", c: null }, true], "": "empty" })).toBe(
      '{"":"empty","a":[3,{"c":null,"d":"x"},true],"b":1}',
    );
    // The same data in any key order gives the same text, which parses back to it.
    const shuffled = { version: 3, sid: SESSION, rules: { autoApprove: [], v: 1 }, id: POLICY.id };
    const text = canonicalJson(shuffled);
    expect(text).toBe(
      `{"id":"${POLICY.id}","rules":{"autoApprove":[],"v":1},"sid":"${SESSION}","version":3}`,
    );
    expect(JSON.parse(text)).toEqual(shuffled);
  });

  it("escapes as JSON.stringify does, sorts by code unit, and leaves undefined values out", () => {
    expect(canonicalJson({ é: " ", Z: 'a"b\\c', a: undefined })).toBe(
      `{"Z":${JSON.stringify('a"b\\c')},"é":${JSON.stringify(" ")}}`,
    );
    expect(canonicalJson([undefined, 1])).toBe("[null,1]");
    expect(canonicalJson("x")).toBe('"x"');
  });

  it("handles deep nesting without overflowing the stack", () => {
    let deep: unknown = 0;
    for (let i = 0; i < 20_000; i++) deep = [deep];
    expect(canonicalJson(deep)).toHaveLength(40_001);
  });
});

describe("the policy snapshot's signature", () => {
  it("covers the prefix and the canonical snapshot bound to its session", () => {
    expect(policySigningInput(POLICY, SESSION)).toBe(
      `${POLICY_SIGNATURE_PREFIX}${canonicalJson({ ...POLICY, sid: SESSION })}`,
    );
    expect(policySigningInput(POLICY, SESSION).startsWith("earshot.policy.v1.{")).toBe(true);
  });

  it("verifies for the session it was signed for, with the secret as a string or a key", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    expect(snapshot).toMatchObject({ id: POLICY.id, version: 3, rules: RULES });
    expect(snapshot.sig).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(snapshot.sig).toHaveLength(POLICY_SIGNATURE_CHARS);
    expect(await verifyPolicySnapshot(SECRET, snapshot, SESSION)).toBe(true);
    const key = await importTicketKey(SECRET);
    expect(await verifyPolicySnapshot(key, snapshot, SESSION)).toBe(true);
    expect((await signPolicySnapshot(key, POLICY, SESSION)).sig).toBe(snapshot.sig);
  });

  it("refuses a snapshot replayed into another session", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    expect(await verifyPolicySnapshot(SECRET, snapshot, OTHER_SESSION)).toBe(false);
    // Signed for the other session, it verifies only there.
    const other = await signPolicySnapshot(SECRET, POLICY, OTHER_SESSION);
    expect(other.sig).not.toBe(snapshot.sig);
    expect(await verifyPolicySnapshot(SECRET, other, SESSION)).toBe(false);
  });

  it("refuses a forged snapshot: any change to the id, the version, or the rules, or another secret", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    const forgeries: PolicySnapshot[] = [
      { ...snapshot, id: "01a1c6f2-7d10-7a3b-9c4d-5e6f7a8b9c0e" },
      { ...snapshot, version: 4 },
      { ...snapshot, version: 2 },
      // A field taken off the review list widens the policy.
      {
        ...snapshot,
        rules: rules(
          rule(),
          rule({ id: "deal-updates", type: "deal_update", alwaysReview: ["stage"] }),
        ),
      },
      // A rule added.
      { ...snapshot, rules: rules(...RULES.autoApprove, rule({ id: "tasks", type: "task" })) },
      // The rules in another order.
      { ...snapshot, rules: rules(...[...RULES.autoApprove].reverse()) },
    ];
    for (const forged of forgeries) {
      expect(await verifyPolicySnapshot(SECRET, forged, SESSION)).toBe(false);
    }
    const otherSecret = await signPolicySnapshot(OTHER_SECRET, POLICY, SESSION);
    expect(await verifyPolicySnapshot(SECRET, otherSecret, SESSION)).toBe(false);
  });

  it("verifies whatever order a client writes the rules' keys in: the signature covers the data", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    const reordered = JSON.parse(
      JSON.stringify({
        sig: snapshot.sig,
        rules: {
          autoApprove: RULES.autoApprove.map(({ alwaysReview, type, id }) => ({
            alwaysReview,
            type,
            id,
          })),
          v: 1,
        },
        version: snapshot.version,
        id: snapshot.id,
      }),
    ) as PolicySnapshot;
    expect(await verifyPolicySnapshot(SECRET, reordered, SESSION)).toBe(true);
  });

  it("refuses a signature that isn't the canonical base64url of 32 bytes", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    const { sig } = snapshot;
    // 43 characters hold 258 bits: the last character's two low bits are unused, and must be 0.
    const last = sig.at(-1) ?? "A";
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    const twin = alphabet[alphabet.indexOf(last) ^ 1] ?? "A";
    for (const bad of [
      `${sig.slice(0, -1)}${twin}`,
      sig.slice(0, -1),
      `${sig}A`,
      "",
      "!".repeat(43),
    ]) {
      expect(await verifyPolicySnapshot(SECRET, { ...snapshot, sig: bad }, SESSION)).toBe(false);
    }
  });

  it("can't be stood in for by a session ticket's signature under the same secret", async () => {
    // A ticket's HMAC covers base64url text, which never holds the prefix's dots.
    const ticket = await signTicket(
      SECRET,
      ticketClaims({
        sid: SESSION,
        uid: "u_1",
        wid: "0f1e2d3c-4b5a-4968-8776-655443322110",
        now: new Date(),
      }),
    );
    const [payload = "", ticketSig = ""] = ticket.split(".");
    expect(payload).not.toContain(".");
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    expect(await verifyPolicySnapshot(SECRET, { ...snapshot, sig: ticketSig }, SESSION)).toBe(
      false,
    );
  });
});

describe("start.policy in the session protocol", () => {
  const start = (policy?: unknown) =>
    JSON.stringify({
      t: "start",
      msgId: "01a1c6e2-9320-7deb-a57a-ba62dc02df01",
      mode: "debrief",
      engine: "cascaded",
      providers: {
        speechToText: { provider: "assemblyai", model: "universal-streaming-english" },
        llm: { provider: "anthropic", model: "claude-haiku-5-5" },
      },
      startedAt: "2026-11-15T19:15:00.000Z",
      entities: [],
      ...(policy === undefined ? {} : { policy }),
    });

  it("is optional, and takes a signed snapshot", async () => {
    expect(parseClientMessage(start()).ok).toBe(true);
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    const parsed = parseClientMessage(start(snapshot));
    expect(parsed.ok).toBe(true);
    if (parsed.ok && parsed.message.t === "start") expect(parsed.message.policy).toEqual(snapshot);
  });

  it("refuses a malformed snapshot", async () => {
    const snapshot = await signPolicySnapshot(SECRET, POLICY, SESSION);
    for (const bad of [
      { ...snapshot, sig: snapshot.sig.slice(1) },
      { ...snapshot, sig: `${snapshot.sig.slice(0, 42)}=` },
      { ...snapshot, sig: `${snapshot.sig.slice(0, 42)}+` },
      { ...snapshot, version: 0 },
      { ...snapshot, id: "not-a-uuid" },
      { ...snapshot, rules: { v: 2, autoApprove: [] } },
      { ...snapshot, sid: SESSION },
      { id: snapshot.id, version: snapshot.version, rules: snapshot.rules },
    ]) {
      expect(parseClientMessage(start(bad))).toMatchObject({ ok: false, reason: "invalid" });
    }
  });

  it("refuses a snapshot holding a key-shaped rule id, as anywhere outside the key slots", async () => {
    const shaped = `sk-${"a".repeat(24)}`;
    const snapshot = await signPolicySnapshot(
      SECRET,
      { ...POLICY, rules: rules(rule({ id: shaped })) },
      SESSION,
    );
    expect(parseClientMessage(start(snapshot))).toMatchObject({ ok: false, reason: "stray_key" });
  });
});
