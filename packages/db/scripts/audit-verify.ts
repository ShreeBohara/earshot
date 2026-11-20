// Checks an account export's audit chains and checkpoints offline (docs/adr/0033): the links, the
// hashes over the canonical texts, that each text says what its row says, and every signature.
//
//   pnpm --filter @earshot/db db:audit-verify <export.json> [--keys <keys.json>]
//
// By default the public keys come from the export itself. For a check that doesn't trust the file
// for its own keys, save `GET /api/audit/keys` (its `{ "keys": [...] }`) and pass it with --keys.
// It reads the files and prints counts, seqs, and ids; it connects to nothing and needs no secret.
// Relative paths are resolved against the directory pnpm was run from.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditPublicKey } from "@earshot/keys/server";
import { type AuditVerification, verifyAuditExport } from "../src/audit-chain";

const USAGE = "Usage: pnpm --filter @earshot/db db:audit-verify <export.json> [--keys <keys.json>]";

export interface AuditVerifyCli {
  readonly argv: readonly string[];
  /** Reads a file the user named, as UTF-8. */
  readonly readText: (path: string) => Promise<string>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/** The export's path and the keys file's, or a reason the arguments don't make sense. */
function parseArgs(argv: readonly string[]): { file: string; keys?: string } | string {
  // pnpm may pass a bare "--" through.
  const args = argv.filter((arg) => arg !== "--");
  let file: string | undefined;
  let keys: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--keys") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) return "--keys needs a file.";
      keys = next;
      i++;
    } else if (arg.startsWith("--")) {
      return "Unknown option.";
    } else if (file === undefined) {
      file = arg;
    } else {
      return "Give one export file.";
    }
  }
  if (!file) return "Give the export file to check.";
  return keys === undefined ? { file } : { file, keys };
}

function parseKeys(text: string): AuditPublicKey[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return "The keys file isn't JSON.";
  }
  const list = Array.isArray(parsed)
    ? parsed
    : typeof parsed === "object" && parsed !== null && "keys" in parsed
      ? (parsed as { keys: unknown }).keys
      : undefined;
  if (!Array.isArray(list)) {
    return 'The keys file must hold { "keys": [...] }, as /api/audit/keys answers, or a list of keys.';
  }
  return list as AuditPublicKey[];
}

function report(result: AuditVerification, out: (line: string) => void): void {
  for (const workspace of result.workspaces) {
    const head = workspace.head ? `head at seq ${workspace.head.seq}` : "no entries";
    const signed =
      workspace.signedThrough === null
        ? "no valid checkpoint"
        : `signed through seq ${workspace.signedThrough}${
            workspace.head && workspace.head.seq > workspace.signedThrough
              ? ` (${count(workspace.head.seq - workspace.signedThrough, "later entry")} not signed yet)`
              : ""
          }`;
    out(
      `Workspace ${workspace.workspaceId}: ${count(workspace.entries, "entry")}, ${head}; ${count(workspace.checkpoints, "checkpoint")}, ${signed}.`,
    );
    if (workspace.developmentSignatures > 0) {
      out(
        `  ${count(workspace.developmentSignatures, "checkpoint")} signed with the development key, which anyone can sign with: they prove nothing.`,
      );
    }
  }
  out(
    result.keySource === "export"
      ? "Keys: from the export itself. For a check that doesn't trust the file, pass --keys with the keys saved from /api/audit/keys."
      : "Keys: from the --keys file.",
  );
}

/** Runs the check and returns the exit code: 0 when everything verifies, 1 otherwise. */
export async function main({ argv, readText, out, err }: AuditVerifyCli): Promise<number> {
  const args = parseArgs(argv);
  if (typeof args === "string") {
    err(`${args}\n${USAGE}`);
    return 1;
  }

  let exported: unknown;
  try {
    exported = JSON.parse(await readText(args.file));
  } catch (error) {
    const reason = error instanceof SyntaxError ? "isn't JSON" : "can't be read";
    err(`The export file ${reason}.`);
    return 1;
  }

  let keys: AuditPublicKey[] | undefined;
  if (args.keys !== undefined) {
    let text: string;
    try {
      text = await readText(args.keys);
    } catch {
      err("The keys file can't be read.");
      return 1;
    }
    const parsed = parseKeys(text);
    if (typeof parsed === "string") {
      err(parsed);
      return 1;
    }
    keys = parsed;
  }

  const result = await verifyAuditExport(exported, keys);
  report(result, out);
  if (result.ok) {
    out("OK: every link, hash, canonical text, and signature checks out.");
    return 0;
  }
  err(`FAILED: ${count(result.problems.length, "problem")}.`);
  for (const problem of result.problems) {
    err(`  ${problem.workspaceId ? `Workspace ${problem.workspaceId}: ` : ""}${problem.message}`);
  }
  return 1;
}

/** True when this file is the process's entry point, not a module a test imported. */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  // pnpm runs package scripts in the package's directory; INIT_CWD is where it was run from.
  const base = process.env.INIT_CWD ?? process.cwd();
  process.exitCode = await main({
    argv: process.argv.slice(2),
    readText: (path) => readFile(resolve(base, path), "utf8"),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
