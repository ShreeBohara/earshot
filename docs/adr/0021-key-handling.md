# ADR-0021: Key handling: on-device storage, per-request use, an optional envelope-encrypted vault

## Status

Accepted (2026-11-15). This implements ADR-0009 in `packages/keys`, and the vault's storage in `packages/db`.

## Context and problem

Earshot is bring-your-own-key, and the hosted instance must never hold anyone's AI keys unless the user opts in. Keys still have to reach a provider somehow. A leak can happen through storage, but also through logs, error messages, and API responses.

## Considered options

- **Keys on the device, sent per request, plus an optional server vault (chosen).**
- Keys always stored on the server.
- Keys kept in browser storage in plain text.

## Decision

- **Device storage.** Keys are encrypted in IndexedDB with an AES-256-GCM key created as non-extractable, so JavaScript can use it but never read its bytes.
  - Each ciphertext is bound to its slot (provider and label) through GCM additional data, so a ciphertext moved into another slot doesn't decrypt.
  - Clearing the store also deletes the device key.
- **Per-request use.** A key is decrypted in memory and sent only with the request that needs it, in the `x-earshot-provider-key` header, over TLS. The server holds it in memory for that request or session, and never writes it down.
- **The vault**, which is optional for AI keys and always used for CRM credentials, uses envelope encryption:
  - Each secret gets its own random AES-256-GCM data key.
  - The data key is wrapped by a master key held as the Worker secret `EARSHOT_VAULT_MASTER_KEY`. The master key can only wrap and unwrap; it never encrypts data directly.
  - A context string (workspace, kind, name) is authenticated at both layers, so a sealed secret can't be moved to another row. A credential's context is its workspace and slot (provider and label). A CRM connection's is its workspace, provider, and row id, because a workspace can hold several connections to one CRM; whatever writes those rows generates the id before sealing.
  - Rotating the master key re-wraps the data keys and leaves every ciphertext unchanged. `db:rotate-vault-key` does it in one transaction, and [the runbook](../vault-key-rotation.md) gives the order of operations.
- **Vault on or off.** The vault is on exactly when the deployment sets `EARSHOT_VAULT_MASTER_KEY`. Otherwise `loadVaultMasterKey(env)` returns null, and callers must refuse to store or reveal vault secrets: `putCredential` and `revealCredential` throw `VaultOffError` when given null, before touching the database. A key that is set but malformed throws instead of turning the vault off. Even with the vault on, an AI key is stored only when its user saves it there.
- **Vault storage** (`packages/db/src/vault.ts`) runs only in a transaction from `withTenant`, and refuses any other, so RLS confines it to one workspace. It returns metadata (provider, label, last four characters, validated and created times), and listing never selects an envelope column. Only `revealCredential` returns plaintext, for server-side provider calls. Storing, replacing, and deleting a key each write an audit entry in the acting user's name, with the provider, label, and last four characters. A label can't hold anything shaped like a key, since labels are shown and audited in plain text.
- **Validation** is a cheap authenticated GET to each provider, behind `handleValidateKey(request, { fetch, logger })`, a fetch-style handler that any route can call. The key comes only from the `x-earshot-provider-key` header, never the body or the URL. The response is `{ ok, provider, last4, reason }`, with a fixed reason code and `cache-control: no-store`. It never forwards the provider's response body, headers, or messages, because some providers quote part of the key in their errors. The handler has no database access, so validating stores nothing. The UI only ever shows the last four characters.
- **Redaction.** Every server log line goes through a redacting logger. It removes known secrets and anything shaped like a provider key (`sk-…`, `sk-ant-…`, `gsk_…`, `AIza…`). A canary key in the tests proves keys never reach logs, errors, or validation results.

## Consequences

**Good**

- The hosted instance stores no AI keys by default, which is a simple trust story to explain.
- A stolen database dump without the master key reveals nothing.
- Rotating the master key is cheap.

**Bad**

- Keys are per device: a second device needs the key entered again, unless the user turns on the vault.
- Background jobs can't use a key that lives only on a device. Features that need one will require the vault.
- Clearing site data deletes the keys. That's by design, but it can surprise people.
- The Worker holds one master key at a time, so a rotation turns the vault off for a few minutes. Stored AI keys and CRM tokens are unavailable, though intact, until the new key is in place.

## More information

- [Rotating the vault master key](../vault-key-rotation.md): the runbook.
- `packages/keys/src/vault.ts` holds the envelope encryption and `loadVaultMasterKey`, and `packages/keys/src/validate-handler.ts` the validation handler; server code imports both from `@earshot/keys/server`.
- `packages/db/src/vault.ts` holds vault storage, `packages/db/src/vault-rotation.ts` the rotation, and `packages/db/scripts/rotate-vault-key.ts` the script.
