// Turning a temporary credential into a provider socket URL. The token route answers with a base
// URL (`wss://streaming.assemblyai.com`, `wss://api.deepgram.com`, or a relay's), and each
// adapter appends its own path, so one Deepgram credential serves both /v1/listen and /v2/listen.
import { SttConnectError, type TempCredential, type TempCredentialProvider } from "./adapter";

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The socket URL for `path` under the credential's base URL. Refuses a credential minted for
 * another provider, and a cleartext `ws:` URL anywhere but loopback, so a token never crosses the
 * network unencrypted. Errors never quote the credential.
 */
export function providerSocketUrl(
  credential: TempCredential,
  provider: TempCredentialProvider,
  path: string,
): URL {
  if (credential.provider !== provider) {
    throw new SttConnectError(
      "bad_request",
      `the credential was minted for ${String(credential.provider)}, not ${provider}`,
      { retryable: false },
    );
  }
  let url: URL;
  try {
    url = new URL(credential.url);
  } catch (error) {
    throw new SttConnectError("bad_request", "the credential's url isn't a URL", {
      retryable: false,
      cause: error,
    });
  }
  if (!(url.protocol === "wss:" || (url.protocol === "ws:" && LOOPBACK.has(url.hostname)))) {
    throw new SttConnectError("bad_request", "the credential's url must use wss:", {
      retryable: false,
    });
  }
  // Trim trailing slashes by scanning back once: a regex like /\/+$/ backtracks on long runs of "/".
  const base = url.pathname;
  let end = base.length;
  while (end > 0 && base.charCodeAt(end - 1) === 0x2f) end -= 1;
  url.pathname = `${base.slice(0, end)}${path}`;
  url.hash = "";
  return url;
}
