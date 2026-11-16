import { defineConfig } from "drizzle-kit";

// Migrations always use the direct (non-pooled) connection string.
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/schema/index.ts",
  out: "./migrations",
  strict: true,
  verbose: true,
  dbCredentials: {
    url: process.env.DATABASE_URL_DIRECT ?? "postgresql://localhost:5432/earshot",
  },
});
