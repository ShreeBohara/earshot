import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const wrangler = { configPath: "./wrangler.jsonc" };

export default defineConfig({
  test: {
    projects: [
      {
        // The Worker's routes, config, and Queue consumer, inside workerd with the bindings from
        // wrangler.jsonc. Each file gets its own storage.
        extends: true,
        plugins: [cloudflareTest({ wrangler })],
        test: { name: "worker", include: ["test/*.test.ts"] },
      },
      {
        // SessionDO over real WebSockets. WebSockets to Durable Objects don't work with per-file
        // storage isolation, so these files share one runtime, one at a time (each test uses its
        // own session). The entry wires cassette extraction and a recording flush sink.
        extends: true,
        plugins: [cloudflareTest({ main: "./test/sessions/worker.ts", wrangler })],
        test: {
          name: "sessions",
          include: ["test/sessions/**/*.test.ts"],
          isolate: false,
          maxWorkers: 1,
          fileParallelism: false,
          // Runs after the other projects, which share group 0, since its worker count differs.
          sequence: { groupOrder: 1 },
        },
      },
      {
        // The flush consumer against Postgres compiled to WebAssembly, with every migration: the
        // same flushBatch code path the Worker runs, minus workerd.
        extends: true,
        test: { name: "node", include: ["test/node/**/*.test.ts"], environment: "node" },
      },
    ],
  },
});
