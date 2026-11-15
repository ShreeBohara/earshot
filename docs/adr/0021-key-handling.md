# ADR-0021: Key handling: on-device storage, per-request use, an optional envelope-encrypted vault

## Status

Accepted (2026-11-15). This implements ADR-0009 in `packages/keys`.

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
  - The data key is wrapped by a master key held as the Worker secret `VAULT_MASTER_KEY`. The master key can only wrap and unwrap; it never encrypts data directly.
  - A context string (workspace, kind, name) is authenticated at both layers, so a sealed secret can't be moved to another row.
  - Rotating the master key re-wraps the data keys and leaves every ciphertext unchanged.
- **Validation** is a cheap authenticated GET to each provider. The result never echoes the key, and the UI only ever shows the last four characters.
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
