# ADR-0001: Two voice engines, cascaded by default

## Status

Accepted (2026-11-15)

## Context and problem

v1 used a speech-to-speech model only. That path costs about $0.073 per 2-minute session on gpt-realtime-2.1, and no speech-to-speech API accepts a vocabulary list (keyterms). Earshot needs to bias transcription toward the CRM's own names, and a debrief is a monologue with long pauses rather than a conversation.

## Considered options

- **Two engines: cascaded by default, speech-to-speech for conversation.**
- Speech-to-speech only, as in v1.
- A managed voice platform with per-minute fees.

## Decision

Build one `VoiceEngine` interface that emits the same events whatever sits behind it: partial text, final utterances with word timings and confidence, agent audio, tool calls, and errors. Ship two engines at first.

- **Debrief engine (default):** streaming speech-to-text with CRM keyterms, then an LLM tool-calling agent. Cost is about $0.008–0.014 per 2-minute session.
- **Conversation engine:** speech-to-speech, for back-and-forth such as "brief me on Acme". Text-only replies by default, at about $0.05 per session.

A local engine (WebGPU) comes later. Ship two speech-to-text adapters and two LLM adapters from the start, and let the benchmark pick the defaults.

## Consequences

**Good**

- About 6 times cheaper per session than speech-to-speech.
- Keyterm biasing is possible, which the two-witnesses design needs.
- Providers can be swapped without touching the rest of the system.

**Bad**

- Two engines, and multiple provider adapters, to build and test.
- A cascaded pipeline adds a step between speech and action.
- Prices and models change every few months, so the price table lives in config and the benchmark re-evaluates choices.

## More information

Phase 1 makes no model calls. The engines arrive in Phase 3.
