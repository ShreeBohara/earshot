import { existsSync } from "node:fs";
import path from "node:path";

/**
 * Finds a path inside the monorepo by walking up from `from`, for files read from disk at build
 * time or in development: fixtures and migrations. Resolved from the working directory rather than
 * `import.meta.url`, which bundlers rewrite: `next dev` and `next build` run in apps/web, and
 * tests run there or at the repo root.
 */
export function findInRepo(relativePath: string, from: string = process.cwd()): string {
  let dir = path.resolve(from);
  for (;;) {
    const candidate = path.join(dir, relativePath);
    if (existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`Could not find ${relativePath} above ${from}`);
    dir = parent;
  }
}
