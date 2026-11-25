// The id of the proposal a correction makes (Phase 5 WP13; docs/adr/0038). Both writers, SessionDO
// before the seal and the web Worker after it, derive it from the session and the client's
// `correctionId`, so a correction is idempotent by its id with no table of its own (a resend finds
// its proposal in the log), and the client can tell which card replaced the one it corrected. The
// client never picks a proposal id itself: one derived this way can't collide with, or name, a
// proposal in another session.

/**
 * A UUID (version 8, RFC 9562's custom version) from SHA-256 of `earshot.correction.v1`, the
 * session's id, and the correction's id, both lowercased: the same for every resend of one
 * correction, and different in every other session. Web Crypto only, so it runs in Workers,
 * browsers, and Node.
 */
export async function correctionProposalId(
  sessionId: string,
  correctionId: string,
): Promise<string> {
  const input = `earshot.correction.v1:${sessionId.toLowerCase()}:${correctionId.toLowerCase()}`;
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)),
  );
  const bytes = digest.slice(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x80; // version 8
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // the RFC variant
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
