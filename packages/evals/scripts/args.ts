// Shared by the eval scripts: flags, files, and paths as the person running them meant them.
import { appendFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { EvalReport } from "../src/report";

/**
 * A path as given on the command line. `pnpm --filter @earshot/evals <script>` runs in
 * packages/evals, so relative paths resolve against where pnpm was started (INIT_CWD).
 */
export function userPath(given: string): string {
  return path.resolve(process.env.INIT_CWD ?? process.cwd(), given);
}

export interface Parsed {
  readonly positionals: string[];
  readonly flags: Map<string, string | true>;
}

/** `--name value`, `--name=value`, and `--switch`; everything else is positional. */
export function parseArgs(argv: readonly string[], switches: readonly string[] = []): Parsed {
  const positionals: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s, 2) as [string, string | undefined];
    if (switches.includes(name)) flags.set(name, true);
    else if (inline !== undefined) flags.set(name, inline);
    else {
      const value = argv[++i];
      if (value === undefined) throw new Error(`--${name} needs a value`);
      flags.set(name, value);
    }
  }
  return { positionals, flags };
}

export function flag(parsed: Parsed, name: string): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function readReport(file: string): EvalReport {
  const result = EvalReport.safeParse(JSON.parse(readFileSync(userPath(file), "utf8")));
  if (!result.success) {
    throw new Error(`${file} isn't an eval report: ${result.error.issues[0]?.message ?? "?"}`);
  }
  return result.data;
}

/** Appends to a GitHub job summary (or any file), if one was named. */
export function appendSummary(file: string | undefined, markdown: string): void {
  if (file) appendFileSync(userPath(file), `${markdown}\n`);
}

/** Runs a script's main, printing an error's message (not its stack) and exiting 1 on failure. */
export function run(main: () => void): void {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  }
}
