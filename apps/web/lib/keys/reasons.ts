// Human copy for every way a key check or store can go wrong. The routes answer with fixed codes
// (lib/keys/types.ts); this turns each into one sentence for the page. Pure, so tests can check
// that every code has copy.
import type { StatePillState } from "@earshot/ui/components/state-pill";
import type { KeyProblem } from "./types";

export type ProblemCopy = {
  /** A word or two for a key's status pill. */
  pill: string;
  /** One sentence saying what happened and what to do. */
  message: string;
  /** Red when the key or the request is wrong; amber when trying again later should work. */
  state: Extract<StatePillState, "failed" | "conflict">;
};

function waitFor(seconds: number | undefined): string {
  if (!seconds || seconds <= 60) return "a minute";
  const minutes = Math.ceil(seconds / 60);
  return `${minutes} minutes`;
}

/** The copy for a problem with a key, naming its provider where that helps. */
export function describeProblem(
  problem: KeyProblem,
  {
    provider = "The provider",
    retryAfterSeconds,
  }: { provider?: string; retryAfterSeconds?: number } = {},
): ProblemCopy {
  switch (problem) {
    case "rejected":
      return {
        pill: "Rejected",
        message: `${provider} rejected this key. Check that you copied all of it and that it hasn't been revoked.`,
        state: "failed",
      };
    case "rate_limited":
      return {
        pill: "Not checked",
        message: `${provider} is limiting requests right now. Wait a minute, then check again.`,
        state: "conflict",
      };
    case "upstream_error":
      return {
        pill: "Not checked",
        message: `${provider} couldn't answer just now. Try again in a minute.`,
        state: "conflict",
      };
    case "unreachable":
      return {
        pill: "Not checked",
        message: `Earshot couldn't reach ${provider === "The provider" ? "the provider" : provider}. Try again in a minute.`,
        state: "conflict",
      };
    case "too_many_requests":
      return {
        pill: "Not checked",
        message: `That's a lot of key checks in a short time. Try again in ${waitFor(retryAfterSeconds)}.`,
        state: "conflict",
      };
    case "network":
      return {
        pill: "Not checked",
        message: "Couldn't reach Earshot. Check your connection, then try again.",
        state: "conflict",
      };
    case "storage":
      return {
        pill: "Not saved",
        message:
          "This browser couldn't save the key. Its storage may be full or turned off, as in some private windows.",
        state: "failed",
      };
    case "reauth_required":
      return {
        pill: "Sign in again",
        message: "Storing a key on the server needs a sign-in from the last hour.",
        state: "conflict",
      };
    case "vault_off":
      return {
        pill: "Vault off",
        message: "The vault is off on this server, so keys can't be stored there.",
        state: "conflict",
      };
    case "unauthorized":
      return {
        pill: "Signed out",
        message: "Your session has ended. Sign in again to manage your keys.",
        state: "failed",
      };
    case "forbidden":
      return {
        pill: "Refused",
        message: "That request was refused. Reload this page, then try again.",
        state: "failed",
      };
    case "missing_key":
      return { pill: "No key", message: "Paste a key first.", state: "failed" };
    case "invalid_label":
      return {
        pill: "Bad label",
        message: "Use 1 to 64 characters for the label, and don't put a key in it.",
        state: "failed",
      };
    case "unknown_provider":
      return {
        pill: "Unknown provider",
        message: "Pick a provider from the list.",
        state: "failed",
      };
    case "invalid_request":
    case "method_not_allowed":
      return {
        pill: "Not checked",
        message: "Something about that request wasn't right. Reload this page, then try again.",
        state: "failed",
      };
    case "server_error":
      return {
        pill: "Not checked",
        message: "Something went wrong on Earshot's side. Try again later.",
        state: "failed",
      };
  }
}
