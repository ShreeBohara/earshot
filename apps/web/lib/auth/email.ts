// Magic-link delivery. A magic link is a credential: whoever holds it signs in as the user. So it
// goes to exactly one place, the user's inbox, and never into a log line, an error message, or a
// response. The one exception is `next dev` without an email provider, where it's printed to the
// developer's own terminal, marked as development-only.

import type { Logger } from "../log";
import type { AuthConfig, Mode } from "./config";

export type MagicLinkMessage = { email: string; url: string };
export type SendMagicLink = (message: MagicLinkMessage) => Promise<void>;

/** Production has no email provider configured. Signing in by email is unavailable. */
export class EmailUnavailableError extends Error {
  override name = "EmailUnavailableError";
}

/** The provider refused or couldn't be reached. Carries the HTTP status, never the request. */
export class EmailDeliveryError extends Error {
  override name = "EmailDeliveryError";
}

export const RESEND_ENDPOINT = "https://api.resend.com/emails";

type SenderOptions = {
  mode: Mode;
  email: AuthConfig["email"];
  log: Logger;
  /** How long the link stays valid, for the email's wording. */
  ttlMinutes: number;
  fetch?: typeof fetch;
  /** Where `next dev` prints links. Tests replace it. */
  devConsole?: (text: string) => void;
};

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

/** The message itself: plain text plus a minimal, image-free HTML part. */
export function magicLinkEmail(url: string, ttlMinutes: number) {
  const subject = "Your Earshot sign-in link";
  const text = [
    "Sign in to Earshot with this link:",
    "",
    url,
    "",
    `It works once and expires in ${ttlMinutes} minutes.`,
    "If you didn't ask to sign in, you can ignore this email.",
  ].join("\n");
  const html = `<!doctype html>
<html lang="en">
  <body style="margin:0;padding:24px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;color:#1c1917;background:#faf9f7">
    <p style="font-size:16px;margin:0 0 16px">Sign in to Earshot with this link:</p>
    <p style="margin:0 0 24px"><a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;border-radius:8px;background:#1c1917;color:#faf9f7;text-decoration:none;font-weight:600">Sign in to Earshot</a></p>
    <p style="font-size:14px;color:#57534e;margin:0 0 8px">It works once and expires in ${ttlMinutes} minutes.</p>
    <p style="font-size:14px;color:#57534e;margin:0">If you didn't ask to sign in, you can ignore this email.</p>
  </body>
</html>`;
  return { subject, text, html };
}

function defaultDevConsole(text: string) {
  console.info(text);
}

/**
 * Picks how magic links leave the server:
 * - Resend's HTTP API when RESEND_API_KEY and EMAIL_FROM are set, in any mode;
 * - otherwise, in development, the server console, clearly marked development-only;
 * - otherwise (production), nowhere: sending throws EmailUnavailableError, so the sign-in request
 *   fails closed with a clear error and the link is never written anywhere.
 */
export function createMagicLinkSender({
  mode,
  email,
  log,
  ttlMinutes,
  fetch: fetchImpl = globalThis.fetch,
  devConsole = defaultDevConsole,
}: SenderOptions): SendMagicLink {
  if (email) {
    return async ({ email: to, url }) => {
      const message = magicLinkEmail(url, ttlMinutes);
      let response: Response;
      try {
        response = await fetchImpl(RESEND_ENDPOINT, {
          method: "POST",
          headers: {
            authorization: `Bearer ${email.resendApiKey}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({ from: email.from, to: [to], ...message }),
        });
      } catch {
        // The error could quote the request; report only that the provider was unreachable.
        throw new EmailDeliveryError("The email provider could not be reached");
      }
      if (!response.ok) {
        // Read and drop the body: it can echo the recipient.
        await response.body?.cancel();
        throw new EmailDeliveryError(
          `The email provider refused the message (HTTP ${response.status})`,
        );
      }
    };
  }

  if (mode === "development") {
    return async ({ url }) => {
      devConsole(
        [
          "",
          "──── DEVELOPMENT ONLY · no email provider configured ────",
          "Magic link (it signs in whoever opens it; never share or log this outside local dev):",
          url,
          `It works once and expires in ${ttlMinutes} minutes.`,
          "Set RESEND_API_KEY and EMAIL_FROM in .dev.vars to send real email instead.",
          "──────────────────────────────────────────────────────────",
          "",
        ].join("\n"),
      );
    };
  }

  return async () => {
    log.error("magic link not sent: RESEND_API_KEY and EMAIL_FROM are not set");
    throw new EmailUnavailableError(
      "Email sign-in isn't configured on this server: set RESEND_API_KEY and EMAIL_FROM.",
    );
  };
}
