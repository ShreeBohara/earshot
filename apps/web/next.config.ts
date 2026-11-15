import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenNext bundles the standalone output; `build:worker` reuses turbo's cached `next build`.
  output: "standalone",
  reactCompiler: true,
  // Cache Components stays off until OpenNext marks it stable (docs/adr/0010).
  transpilePackages: ["@earshot/ui", "@earshot/core", "@earshot/db"],
};

export default nextConfig;

// Gives `next dev` access to the Cloudflare bindings declared in wrangler.jsonc.
initOpenNextCloudflareForDev();
