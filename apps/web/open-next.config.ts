import { defineCloudflareConfig } from "@opennextjs/cloudflare";
import staticAssetsIncrementalCache from "@opennextjs/cloudflare/overrides/incremental-cache/static-assets-incremental-cache";

// Phase 1 has no ISR and no `use cache`, so prerendered pages are served read-only from
// static assets: no R2 bucket, tag cache, or queue, which keeps per-PR copies simple.
export default defineCloudflareConfig({
  incrementalCache: staticAssetsIncrementalCache,
});
