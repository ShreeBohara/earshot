// Applies migrations to the branch in DATABASE_URL_DIRECT. CI runs this for every preview
// branch and for production; locally, point it at your personal Neon branch.
import { fileURLToPath } from "node:url";
import { migrate } from "drizzle-orm/neon-http/migrator";
import { createHttpDb } from "../src/client";

const url = process.env.DATABASE_URL_DIRECT;
if (!url) {
  console.error("DATABASE_URL_DIRECT is not set");
  process.exit(1);
}

await migrate(createHttpDb(url), {
  migrationsFolder: fileURLToPath(new URL("../migrations", import.meta.url)),
});
console.log("migrations applied");
