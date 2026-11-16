# Rotating the vault master key

The vault's master key, `EARSHOT_VAULT_MASTER_KEY` (a secret on the web Worker), wraps the data key of every secret in `credentials` (AI keys) and `crm_connections` (CRM tokens). Rotating it re-wraps those data keys under a new master key. Ciphertexts don't change and are never decrypted. [ADR-0021](adr/0021-key-handling.md) has the design.

Rotate when the key may have been exposed or someone who held it leaves, and once as a drill before launch.

## What you need

- `DATABASE_URL_DIRECT`: the environment's direct (non-pooled) connection string, for the owner role that runs migrations.
- The current master key, and access to the web Worker's secrets and the environment's GitHub secrets.
- A few minutes in which the vault can be off. Stored keys stay intact; they're only unavailable.

Keep keys out of your shell history: read each value in instead of typing it on the command line.

```sh
read -rs DATABASE_URL_DIRECT && export DATABASE_URL_DIRECT
read -rs EARSHOT_VAULT_MASTER_KEY_OLD && export EARSHOT_VAULT_MASTER_KEY_OLD
```

## Steps

1. **Generate the new key, and save it before anything else.** `openssl rand -base64 32` prints 32 random bytes, base64-encoded. Put it in the password manager entry for this environment now: once the rotation commits, nothing opens without it. Then read it in: `read -rs EARSHOT_VAULT_MASTER_KEY_NEW && export EARSHOT_VAULT_MASTER_KEY_NEW`.
2. **Dry run.** `pnpm --filter @earshot/db db:rotate-vault-key --dry-run` unwraps every data key with the old key, in a read-only transaction, and prints counts. It changes nothing. If it reports rows that don't open, stop: either `EARSHOT_VAULT_MASTER_KEY_OLD` isn't the key the Worker uses, or those rows were moved or damaged.
3. **Turn the vault off.** `wrangler secret delete EARSHOT_VAULT_MASTER_KEY --name earshot-web` (`earshot-web-pr-<n>` for a preview). With no master key, `loadVaultMasterKey` returns null and the app refuses vault writes and reveals, so nothing new is sealed with the old key and nothing tries the old key on a re-wrapped row. Wait a minute for requests on the previous Worker version to finish.
4. **Rotate.** `pnpm --filter @earshot/db db:rotate-vault-key`. It runs as one transaction: every row is re-wrapped, or, if any row doesn't open with the old key, none is. Writers wait on a table lock until it commits. Each workspace it touched gets a `credential.rotated` audit entry with counts.
5. **Turn the vault back on with the new key.** `wrangler secret put EARSHOT_VAULT_MASTER_KEY --name earshot-web`, and paste the new key. Set the environment's GitHub secret to the new key as well, so the next deploy doesn't restore the old one.
6. **Verify.** Run the dry run again with `EARSHOT_VAULT_MASTER_KEY_OLD` set to the new key and `EARSHOT_VAULT_MASTER_KEY_NEW` to any freshly generated key. It should open every row and report the same counts. Then reveal one key through the app.
7. **Retire the old key.** Delete it from the password manager once step 6 passes. Until then it's your way back.

## Why this order

The Worker holds one master key. The database is entirely old-key until the rotation's transaction commits, and entirely new-key after it. A Worker that kept the old key across the commit couldn't open a re-wrapped row, and anything it sealed in that window would carry the old key into a database that had moved on, so those rows wouldn't open after the swap. With the vault off from step 3 to step 5, no request ever holds a key that doesn't match the database. The cost is a few minutes in which stored AI keys and CRM tokens can't be used; requests that need them fail and can be retried.

## If something goes wrong

- **Rows don't open with the old key**, in the dry run or the real run: nothing changed. If you already removed the Worker secret, put the old key back.
- **The rotation fails for another reason**, such as a dropped connection: Postgres rolled it back unless it failed during the commit itself. Run the dry run with the old key. If every row opens, nothing changed. If none do, the rotation committed: confirm with a dry run that uses the new key as the old one, then continue at step 5.
- **To undo a finished rotation**, rotate again with the two keys swapped.
- **The new key is lost after the rotation committed:** the vault can't be opened again. That's why step 1 saves it first.

## Environments

Each Neon branch has its own rows, so rotate production and `dev` separately, each with its own key. Preview branches fork from `dev` and carry its wrapped keys, so preview Workers need `dev`'s key; a preview created before a `dev` rotation keeps the old one until it expires.
