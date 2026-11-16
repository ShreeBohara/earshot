import { withViewer } from "@/lib/auth/viewer";
import { voiceRouteDeps } from "@/lib/voice/deps";
import { voiceTokenRoute } from "@/lib/voice/routes";

export const dynamic = "force-dynamic";

/**
 * Mints a speech-to-text provider's temporary credential from the user's own key, for one of
 * their open sessions. The provider goes in `x-earshot-provider` (`assemblyai` or `deepgram`),
 * the key in `x-earshot-provider-key`, and `{ "sessionId": … }` in the body. Answers
 * `{ provider, credential, expiresAt, url }`, and never the key or anything else the provider
 * sent. Rate-limited per user and per IP (lib/voice/routes.ts, docs/adr/0023).
 */
export const POST = withViewer(async (viewer, request) =>
  voiceTokenRoute(viewer, request, await voiceRouteDeps()),
);
