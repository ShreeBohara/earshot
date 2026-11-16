// Re-wraps every vault data key under a new master key. Follow docs/vault-key-rotation.md:
// the order of operations matters.
//
//   DATABASE_URL_DIRECT=… EARSHOT_VAULT_MASTER_KEY_OLD=… EARSHOT_VAULT_MASTER_KEY_NEW=… \
//     pnpm --filter @earshot/db db:rotate-vault-key [--dry-run]
//
// It prints counts only, never keys or the connection string. It refuses when the two keys are
// the same, and changes nothing unless every row's data key unwraps with the old key.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { importMasterKey, redact, sameMasterKey } from "@earshot/keys/server";
import { createPoolDb } from "../src/client";
import { type RotationReport, rotateVaultKey, VaultRotationError } from "../src/vault-rotation";

const URL_ENV = "DATABASE_URL_DIRECT";
const OLD_ENV = "EARSHOT_VAULT_MASTER_KEY_OLD";
const NEW_ENV = "EARSHOT_VAULT_MASTER_KEY_NEW";
const USAGE = `Usage: ${URL_ENV}=… ${OLD_ENV}=… ${NEW_ENV}=… pnpm --filter @earshot/db db:rotate-vault-key [--dry-run]`;

export interface RotateVaultKeyCli {
  readonly argv: readonly string[];
  readonly env: Readonly<Record<string, string | undefined>>;
  /** Connects to `url` as the owner and runs rotateVaultKey. Tests pass PGlite. */
  readonly rotate: (
    url: string,
    oldMaster: CryptoKey,
    newMaster: CryptoKey,
    options: { readonly dryRun: boolean },
  ) => Promise<RotationReport>;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Runs the rotation and returns the exit code. Every line it prints is redacted first. */
export async function main({ argv, env, rotate, out, err }: RotateVaultKeyCli): Promise<number> {
  const url = env[URL_ENV]?.trim() ?? "";
  const oldValue = env[OLD_ENV]?.trim() ?? "";
  const newValue = env[NEW_ENV]?.trim() ?? "";
  const secrets = [oldValue, newValue, url, passwordOf(url)];
  const fail = (line: string) => {
    err(redact(line, secrets));
    return 1;
  };

  // pnpm may pass a bare "--" through. Arguments are never echoed: one could be a pasted key.
  const args = argv.filter((arg) => arg !== "--");
  if (args.some((arg) => arg !== "--dry-run")) return fail(`Unknown argument.\n${USAGE}`);
  const dryRun = args.includes("--dry-run");

  const missing = [URL_ENV, OLD_ENV, NEW_ENV].filter((name) => !env[name]?.trim());
  if (missing.length > 0) return fail(`Missing ${missing.join(", ")}.\n${USAGE}`);

  const oldMaster = await importMasterKey(oldValue).catch(() => null);
  if (!oldMaster) {
    return fail(`${OLD_ENV} isn't a master key: it must be 32 bytes, base64-encoded.`);
  }
  const newMaster = await importMasterKey(newValue).catch(() => null);
  if (!newMaster) {
    return fail(`${NEW_ENV} isn't a master key: it must be 32 bytes, base64-encoded.`);
  }
  if (await sameMasterKey(oldMaster, newMaster)) {
    return fail(`${OLD_ENV} and ${NEW_ENV} are the same key. Nothing was changed.`);
  }

  let report: RotationReport;
  try {
    report = await rotate(url, oldMaster, newMaster, { dryRun });
  } catch (error) {
    if (error instanceof VaultRotationError) {
      return fail(
        `${count(error.credentials, "credential")} and ${count(error.crmConnections, "CRM connection")} don't open with ${OLD_ENV}, so nothing was changed. Check that it is the key the Worker uses now.`,
      );
    }
    return fail(
      `The rotation failed: ${describe(error)}. Run it with --dry-run to check the vault before trying again.`,
    );
  }

  const rows = `${count(report.credentials, "credential")} and ${count(report.crmConnections, "CRM connection")} in ${count(report.workspaces, "workspace")}`;
  out(
    redact(
      report.dryRun
        ? `Dry run: ${rows} open with the old key and can be re-wrapped. Nothing was changed.`
        : `Re-wrapped ${rows} under the new key; ciphertexts are unchanged. Now set EARSHOT_VAULT_MASTER_KEY on the Worker to the new key.`,
      secrets,
    ),
  );
  return 0;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

function passwordOf(url: string): string {
  try {
    return decodeURIComponent(new URL(url).password);
  } catch {
    return "";
  }
}

/**
 * The innermost error's message, shortened. Drizzle's own query errors quote the query's
 * parameters, which here are wrapped data keys, so their message is never printed; the driver
 * error underneath carries Postgres's message.
 */
function describe(error: unknown): string {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error && current.cause; depth++) {
    current = current.cause;
  }
  if (!(current instanceof Error)) return "unknown error";
  const message = current.name === "DrizzleQueryError" ? "query failed" : current.message;
  return `${current.name}: ${message}`.slice(0, 300);
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
  process.exitCode = await main({
    argv: process.argv.slice(2),
    env: process.env,
    rotate: async (url, oldMaster, newMaster, options) => {
      const db = createPoolDb(url);
      try {
        return await rotateVaultKey(db, oldMaster, newMaster, options);
      } finally {
        await db.$client.end();
      }
    },
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
