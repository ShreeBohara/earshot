# ADR-0008: CRM reads come from a local mirror, with optional read-only MCP

## Status

Accepted (2026-11-15). Amended for Phase 4 (2026-11-20): the mirror's phonetic keys are filled, and the embedding stays empty. See "Amendment: Phase 4" below.

## Context and problem

Linking a spoken name to a CRM record needs fast access to the user's companies, contacts, and deals, including aliases and phonetic keys. Live questions during a voice session, such as "what stage is Acme in?", need current data. Querying the CRM for every lookup would be slow and rate-limited.

## Considered options

- **A local mirror of CRM entities, plus an optional read-only MCP connection during voice sessions.**
- MCP for everything.

## Decision

Keep a mirror of companies, contacts, and deals in `crm_entities`: external ID, name, aliases, phonetic keys, a 512-dimension half-precision embedding, and properties. Entity linking runs against the mirror. Phase 6 syncs it incrementally, using webhooks where the CRM offers them and polling otherwise.

An optional read-only CRM MCP connection can be attached to speech-to-speech sessions for live questions. This stays experimental: it only ships if the CRM token can stay on the server, and OpenAI's docs don't say whether MCP authorization can be set when the ephemeral key is minted.

## Consequences

**Good**

- Fast entity linking.
- Linking can use phonetic and embedding signals the CRM's own search lacks.
- Writes remain separate and approved (ADR-0007).

**Bad**

- The mirror can be stale, and sync adds work and failure modes.
- Mirrored CRM data needs the same tenant isolation as everything else.
- The MCP read path depends on provider behavior that isn't yet confirmed.

## Amendment: Phase 4 (2026-11-20)

- **Phonetic keys are filled.** `crm_entities.phonetic_keys` holds the Double Metaphone codes of each row's name and aliases. The name toolkit in `@earshot/understanding/names` is the one place they're computed, and the demo CRM's loader writes them (Phase 4 WP2).
- **The linker runs in `SessionDO`, on the records the session starts with.** The web app reads the mirror and sends the session's records in its `start` message: at most 250, each with its name, up to 20 aliases, and its parent company. `SessionDO` builds the entity linker's index (ADR-0028) from them, computing the keys with the same toolkit, so no turn waits on Postgres.
- **No embeddings yet.** Embeddings through Workers AI and Postgres search (spec WP13) were cut from Phase 4 by its cut lines. The `embedding` column stays empty, and Phase 6 builds search with the mirror's sync. The linker v1 ablations measure what sound, trigrams, and context each add without them (ADR-0028).

## More information

Phase 1 has no CRM mirror. It arrives with the adapters in Phase 6.
