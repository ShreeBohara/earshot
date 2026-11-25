// The approval policy's snapshot (Phase 5 spec §4.6, WP11; ADR-0034): `POST /api/sessions` signs
// the workspace's current policy for one session, the client carries it in `start.policy`, and
// SessionDO verifies it before applying it to the session's proposals. SessionDO reads no database
// on the turn path, and a client mustn't be able to claim a policy it doesn't have, or one from
// another session, so the snapshot is signed:
//
//   sig = base64url(HMAC-SHA256(EARSHOT_SESSION_TICKET_SECRET,
//                               "earshot.policy.v1." + canonical({ id, version, rules, sid })))
//
// with the session ticket's secret, which both Workers already hold, and `sid` the session it's
// for. The prefix keeps the two uses apart: a ticket's HMAC covers base64url text, which never
// holds a ".", so no ticket signature can pass for a policy's, nor the reverse. Only WebCrypto and
// plain JavaScript are used, so this runs unchanged in Workers, Node, and browsers.
import { base64urlDecode, base64urlEncode } from "./base64url";
import type { ApprovalPolicyRules } from "./contracts/approval-policy";
import type { PolicySnapshot } from "./contracts/session-protocol";
import { keyFor, type TicketSecret } from "./session-ticket";

/** What every policy signature's input starts with: the form and its version. */
export const POLICY_SIGNATURE_PREFIX = "earshot.policy.v1.";

const SIGNATURE_BYTES = 32; // HMAC-SHA256

/** A version of a workspace's policy, as the snapshot carries it and SessionDO keeps it. */
export interface PolicyVersion {
  /** The policy's id: the same for every version of a workspace's policy. */
  readonly id: string;
  /** 1 for the first version, and one more for each change. */
  readonly version: number;
  readonly rules: ApprovalPolicyRules;
}

/**
 * Canonical JSON: object keys sorted at every level by UTF-16 code unit, no whitespace, arrays in
 * order, and every scalar as `JSON.stringify` writes it, so the same data always gives the same
 * text. For the JSON values policies hold (strings, integers, arrays, and objects with ASCII keys)
 * it's also RFC 8785's form. A key whose value is `undefined` is left out, as `JSON.stringify`
 * leaves it out. Iterative, so depth can't overflow the stack.
 */
export function canonicalJson(value: unknown): string {
  let out = "";
  // The work left, last first: `{ value }` to write, or literal text (a separator or a closer).
  const stack: ({ readonly value: unknown } | string)[] = [{ value }];
  for (let item = stack.pop(); item !== undefined; item = stack.pop()) {
    if (typeof item === "string") {
      out += item;
      continue;
    }
    const current = item.value;
    if (Array.isArray(current)) {
      stack.push("]");
      for (let index = current.length - 1; index >= 0; index--) {
        // `JSON.stringify` writes a hole or `undefined` in an array as null.
        stack.push({ value: current[index] === undefined ? null : current[index] });
        if (index > 0) stack.push(",");
      }
      out += "[";
    } else if (current !== null && typeof current === "object") {
      const entries = Object.entries(current)
        .filter(([, entry]) => entry !== undefined)
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
      stack.push("}");
      for (let index = entries.length - 1; index >= 0; index--) {
        const [key, entry] = entries[index] as [string, unknown];
        stack.push({ value: entry });
        stack.push(`${JSON.stringify(key)}:`);
        if (index > 0) stack.push(",");
      }
      out += "{";
    } else {
      out += JSON.stringify(current) ?? "null";
    }
  }
  return out;
}

/** The bytes a policy's signature covers: the prefix, then the snapshot bound to `sid`. */
export function policySigningInput(policy: PolicyVersion, sid: string): string {
  return (
    POLICY_SIGNATURE_PREFIX +
    canonicalJson({ id: policy.id, version: policy.version, rules: policy.rules, sid })
  );
}

const utf8 = new TextEncoder();

/**
 * Signs `policy` for session `sid` with the ticket secret: the snapshot `start.policy` carries.
 * The caller has read the policy as the workspace's latest version, in the session's own tenant
 * transaction.
 */
export async function signPolicySnapshot(
  secret: TicketSecret,
  policy: PolicyVersion,
  sid: string,
): Promise<PolicySnapshot> {
  const key = await keyFor(secret);
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8.encode(policySigningInput(policy, sid)),
  );
  return {
    id: policy.id,
    version: policy.version,
    rules: policy.rules,
    sig: base64urlEncode(new Uint8Array(signature)),
  };
}

/**
 * Whether `snapshot` was signed with the ticket secret for session `sid`, exactly as it reads now:
 * any change to its id, version, or rules, a snapshot made for another session, or a signature
 * made with another secret fails. The signature must be the canonical base64url of 32 bytes, and
 * WebCrypto's `verify` compares it in constant time. Throws only for a bad secret, which is a
 * configuration error, not a bad snapshot.
 */
export async function verifyPolicySnapshot(
  secret: TicketSecret,
  snapshot: Pick<PolicySnapshot, "id" | "version" | "rules" | "sig">,
  sid: string,
): Promise<boolean> {
  const signature = base64urlDecode(snapshot.sig);
  if (signature?.byteLength !== SIGNATURE_BYTES) return false;
  const key = await keyFor(secret);
  return crypto.subtle.verify(
    "HMAC",
    key,
    signature,
    utf8.encode(policySigningInput(snapshot, sid)),
  );
}
