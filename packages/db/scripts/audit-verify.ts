// Checks an account export's audit chains and checkpoints offline (docs/adr/0033): the links, the
// hashes over the canonical texts, that each text says what its row says, every signature, and
// that every entry is signed.
//
//   pnpm --filter @earshot/db db:audit-verify <export.json> [--keys <keys.json>]
//     [--allow-unsigned-tail] [--allow-development-key]
//
// Exit codes: 0 when everything verifies and every entry is signed (it prints "OK" then, and only
// then); 2 when --allow-unsigned-tail accepts entries after the last signed checkpoint and the
// chain is otherwise intact; 1 for anything else.
//
// By default the public keys come from the export itself. For a check that doesn't trust the file
// for its own keys, save `GET /api/audit/keys` (its `{ "keys": [...] }`) and pass it with --keys.
// Checkpoints signed with the development key don't count unless --allow-development-key says
// so: anyone can make them. It reads the files and prints counts, seqs, UUIDs, and key ids, with
// every string from a file escaped; it connects to nothing and needs no secret. Relative paths are
// resolved against the directory pnpm was run from.
import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type AuditPublicKey, isAuditPublicKey } from "@earshot/keys/server";
import { type AuditVerification, escapeControls, verifyAuditExport } from "../src/audit-chain";

const USAGE =
  "Usage: pnpm --filter @earshot/db db:audit-verify <export.json> [--keys <keys.json>] [--allow-unsigned-tail] [--allow-development-key]";

export interface AuditVerifyCli {
  readonly argv: readonly string[];
  /** Reads a file the user named, as UTF-8. */
  readonly readText: (path: string) => Promise<string>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

type Args = {
  file: string;
  keys?: string;
  allowUnsignedTail: boolean;
  allowDevelopmentKey: boolean;
};

function count(n: number, noun: string, plural = `${noun}s`): string {
  return `${n} ${n === 1 ? noun : plural}`;
}

/** The arguments, or a reason they don't make sense. Arguments are never echoed. */
function parseArgs(argv: readonly string[]): Args | string {
  // pnpm may pass a bare "--" through.
  const args = argv.filter((arg) => arg !== "--");
  let file: string | undefined;
  let keys: string | undefined;
  let allowUnsignedTail = false;
  let allowDevelopmentKey = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] ?? "";
    if (arg === "--keys") {
      const next = args[i + 1];
      if (!next || next.startsWith("--")) return "--keys needs a file.";
      keys = next;
      i++;
    } else if (arg === "--allow-unsigned-tail") {
      allowUnsignedTail = true;
    } else if (arg === "--allow-development-key") {
      allowDevelopmentKey = true;
    } else if (arg.startsWith("--")) {
      return "Unknown option.";
    } else if (file === undefined) {
      file = arg;
    } else {
      return "Give one export file.";
    }
  }
  if (!file) return "Give the export file to check.";
  return {
    file,
    ...(keys === undefined ? {} : { keys }),
    allowUnsignedTail,
    allowDevelopmentKey,
  };
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
  if (!list.every(isAuditPublicKey)) {
    return "The keys file holds something other than well-formed public keys.";
  }
  return list;
}

/** One line per workspace. Every string from the file goes through escapeControls. */
function report(result: AuditVerification, args: Args, out: (line: string) => void): void {
  for (const workspace of result.workspaces) {
    const id = escapeControls(workspace.workspaceId);
    const head = workspace.head ? `head at seq ${workspace.head.seq}` : "no entries";
    const signed =
      workspace.head === null
        ? "nothing to sign"
        : workspace.signedThrough === null
          ? `no checkpoint signs it (${count(workspace.unsignedTail, "entry", "entries")} unsigned)`
          : workspace.unsignedTail > 0
            ? `signed through seq ${workspace.signedThrough} (${count(workspace.unsignedTail, "later entry", "later entries")} unsigned)`
            : "signed through its head";
    out(
      `Workspace ${id}: ${count(workspace.entries, "entry", "entries")}, ${head}; ${count(workspace.checkpoints, "checkpoint")}, ${signed}.`,
    );
    if (workspace.developmentSignatures > 0) {
      out(
        args.allowDevelopmentKey
          ? `  ${count(workspace.developmentSignatures, "checkpoint")} signed with the development key counted, as --allow-development-key asked; anyone can make them, so they prove nothing.`
          : `  ${count(workspace.developmentSignatures, "checkpoint")} signed with the development key didn't count: anyone can make them. --allow-development-key counts them, for a development export.`,
      );
    }
  }
  out(
    result.keySource === "export"
      ? "Keys: from the export itself. For a check that doesn't trust the file, pass --keys with the keys saved from /api/audit/keys."
      : "Keys: from the --keys file.",
  );
}

/**
 * Runs the check and returns the exit code: 0 only when the result is ok (every link, hash, and
 * signature holds and every entry is signed), 2 for an intact chain whose unsigned tail
 * --allow-unsigned-tail accepted, 1 otherwise.
 */
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
    err(`The export file ${error instanceof SyntaxError ? "isn't JSON" : "can't be read"}.`);
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

  const result = await verifyAuditExport(exported, {
    ...(keys ? { keys } : {}),
    allowUnsignedTail: args.allowUnsignedTail,
    allowDevelopmentKey: args.allowDevelopmentKey,
  });
  report(result, args, out);
  if (result.ok) {
    out(
      "OK: every link, hash, canonical text, and signature checks out, and every entry is signed.",
    );
    return 0;
  }
  if (result.problems.length === 0) {
    // Only --allow-unsigned-tail gets here: intact, with entries no checkpoint signs.
    out(
      `Chain intact, ${count(result.unsignedEntries, "entry", "entries")} unsigned: every link, hash, canonical text, and signature checks out, but no checkpoint signs the newest entries, so anyone with the database could have changed or dropped them.`,
    );
    return 2;
  }
  err(`FAILED: ${count(result.problems.length, "problem")}.`);
  for (const problem of result.problems) {
    const where = problem.workspaceId ? `Workspace ${escapeControls(problem.workspaceId)}: ` : "";
    err(`  ${where}${escapeControls(problem.message)}`);
  }
  if (result.intact && result.problems.every((problem) => problem.kind === "unsigned_tail")) {
    err(
      "The chain is otherwise intact. For an export taken between checkpoints, --allow-unsigned-tail reports it as intact with unsigned entries instead.",
    );
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
