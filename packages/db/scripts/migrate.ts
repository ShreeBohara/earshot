// Applies migrations to the branch in DATABASE_URL_DIRECT. CI runs this for every preview
// branch and for production; locally, point it at your personal Neon branch.
//
// It uses the WebSocket pool rather than the HTTP driver so that all pending migrations apply in
// one transaction: a run that fails changes nothing (docs/adr/0018).
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/neon-serverless/migrator";
import { createPoolDb } from "../src/client";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set");
  process.exit(1);
}

const db = createPoolDb(url);
try {
  await migrate(db, {
    migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
  });
} finally {
  await db.$client.end();
}
console.log("migrations applied");
