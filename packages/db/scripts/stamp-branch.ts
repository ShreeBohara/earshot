// Usage: DATABASE_URL_DIRECT=… pnpm --filter @earshot/db db:stamp preview/pr-12
import { createHttpDb } from "../src/client";
import { stampBranch } from "../src/health";

const [name] = process.argv.slice(2);
const url = process.env.DATABASE_URL_DIRECT;
if (!name || !url) {
  console.error("usage: DATABASE_URL_DIRECT=… pnpm --filter @earshot/db db:stamp <branch-name>");
  process.exit(1);
}

await stampBranch(createHttpDb(url), name);
console.log(`stamped branch ${name}`);
