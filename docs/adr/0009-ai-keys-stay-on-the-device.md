# ADR-0009: AI keys stay on the device by default; an envelope-encrypted vault is optional

## Status

Accepted (2026-11-15)

## Context and problem

Earshot is bring-your-own-key (BYOK), with no hosted key, ever. v1 showed the risk of the alternative: its two API routes had no auth and billed the maintainer's key. The design should let the hosted instance avoid storing anyone's AI keys, while still supporting multiple devices and background jobs.

## Considered options

- **Keys encrypted on the device by default, with an optional server vault.**
- Always storing keys on the server.
- Vercel AI Gateway BYOK, which falls back to the host's own keys, billed to the host.

## Decision

By default, AI provider keys are encrypted with WebCrypto in IndexedDB on the user's device. They are sent per request over TLS and held in memory only for the length of a session. The server never writes them down. Cloudflare AI Gateway forwards per-request keys and logs cost.

An optional vault covers multi-device use and background jobs. It, and CRM credentials, use envelope encryption: AES-256-GCM data keys per user, wrapped by a master key stored as a Worker secret and decrypted only inside the Worker. CRM credentials are stored server-side.

## Consequences

**Good**

- The hosted instance never holds AI keys unless a user turns the vault on, which is a strong trust story.
- No shared key to abuse or pay for.

**Bad**

- Keys on a single device are lost with it, unless the user opts into the vault.
- Background jobs can't use device-only keys.
- Phase 2 must prove, with tests, that no response or log contains a key and that the server stores none unless the vault is on.

## More information

The v1 demo was taken offline for this reason: it ran on a key the maintainer paid for.
