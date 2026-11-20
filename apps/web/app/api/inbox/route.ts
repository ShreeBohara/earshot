import { log } from "@/lib/auth";
import { withViewer } from "@/lib/auth/viewer";
import { readInbox } from "@/lib/inbox/read";
import { isCrossSite, noStoreJson } from "@/lib/keys/http";

export const dynamic = "force-dynamic";

/**
 * The viewer's inbox as JSON (Phase 5 spec WP5): what the page polls every 10 s while a debrief is
 * finishing (each read runs the repair path), and "Load older" (`?before=<cursor>`). Same-site only,
 * and never cached.
 */
export const GET = withViewer(async (viewer, request) => {
  if (isCrossSite(request)) {
    return noStoreJson(403, { error: "forbidden", message: "Open the inbox in Earshot." });
  }
  try {
    const before = new URL(request.url).searchParams.get("before");
    return noStoreJson(200, await readInbox(viewer, { before }));
  } catch (error) {
    log.error("inbox load failed", { error });
    return noStoreJson(500, {
      error: "server_error",
      message: "Something went wrong on our side. Try again later.",
    });
  }
});
