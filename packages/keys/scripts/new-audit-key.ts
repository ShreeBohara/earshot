// Makes a new audit signing key (docs/adr/0033): prints the value for the Worker secret
// EARSHOT_AUDIT_SIGNING_KEY and its public JWK, and writes no file.
//
//   pnpm --filter @earshot/keys audit-key:new
//
// Set the secret on both Workers (earshot-web and earshot-edge) for the environment, and keep the
// public JWK: when this key is rotated out, it goes into EARSHOT_AUDIT_RETIRED_KEYS, so
// checkpoints it signed still verify. Run it in your own terminal; the secret is printed once.
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AUDIT_RETIRED_KEYS_ENV,
  AUDIT_SIGNING_KEY_ENV,
  generateAuditSigningKey,
} from "../src/audit-signing";

const USAGE = "Usage: pnpm --filter @earshot/keys audit-key:new";

export interface NewAuditKeyCli {
  readonly argv: readonly string[];
  readonly now: () => Date;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

/** Prints a new key and returns the exit code. Takes no arguments, and never echoes one back. */
export async function main({ argv, now, out, err }: NewAuditKeyCli): Promise<number> {
  // pnpm may pass a bare "--" through.
  if (argv.some((arg) => arg !== "--")) {
    err(`This script takes no arguments.\n${USAGE}`);
    return 1;
  }
  const key = await generateAuditSigningKey(now());
  out(
    `${AUDIT_SIGNING_KEY_ENV} (secret: set it on earshot-web and earshot-edge, then clear your scrollback):`,
  );
  out(key.secret);
  out("");
  out(
    `Public key ${key.kid} (keep it: when you rotate this key out, add it to ${AUDIT_RETIRED_KEYS_ENV}):`,
  );
  out(key.publicJwk);
  return 0;
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
    now: () => new Date(),
    out: (line) => console.log(line),
    err: (line) => console.error(line),
  });
}
