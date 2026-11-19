import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";
import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // OpenNext bundles the standalone output; `build:worker` reuses turbo's cached `next build`.
  output: "standalone",
  reactCompiler: true,
  // Cache Components stays off until OpenNext marks it stable (docs/adr/0010).
  transpilePackages: [
    "@earshot/ui",
    "@earshot/core",
    "@earshot/db",
    "@earshot/demo-crm",
    "@earshot/events",
    "@earshot/keys",
    "@earshot/voice",
  ],
  // `next dev` without DATABASE_URL runs PGlite in process (lib/db/dev.ts). Loaded by Node rather
  // than bundled, because it reads its WebAssembly and extension files at run time. Production
  // builds never import it.
  serverExternalPackages: ["@electric-sql/pglite", "@electric-sql/pglite-pgvector"],
  turbopack: {
    rules: {
      // Event logs import as strings (the replay demo bundles its fixture; no filesystem at run time).
      "*.jsonl": { type: "text" },
    },
  },
};

export default nextConfig;

// Gives `next dev` access to the Cloudflare bindings declared in wrangler.jsonc.
initOpenNextCloudflareForDev();
