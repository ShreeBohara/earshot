// Shapes of provider keys, so a key that turns up where none belongs can be refused.
//
// `KEY_SHAPES` is a dependency-free copy of `SECRET_PATTERNS` in `@earshot/keys` (src/redact.ts),
// which masks the same shapes in logs. Core stays a leaf package, with Zod as its only
// dependency, so every other package, the browser, both Workers, and the lab's codegen can build
// on it without a cycle. `packages/keys/test/key-shapes.test.ts` fails if the two lists drift.

/**
 * Well-known provider key and short-lived credential shapes: the same sources as
 * `SECRET_PATTERNS` in `@earshot/keys`, in the same order, so add a shape in both places. Not
 * global, so `test()` keeps no state.
 */
export const KEY_SHAPES: readonly RegExp[] = [
  /sk-ant-[A-Za-z0-9_-]{20,}/, // Anthropic
  /sk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}/, // OpenAI
  /gsk_[A-Za-z0-9]{20,}/, // Groq
  /AIza[0-9A-Za-z_-]{35}/, // Google
  /ek_[A-Za-z0-9]{20,}/, // OpenAI ephemeral keys (Realtime client secrets)
  /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/, // JWT-shaped, such as a Deepgram grant
];

// Here a shape must also start a word: no letter or digit right before it. Redaction can afford
// to mask "Risk-Management-Partners", which holds `sk-` and 20 more key characters, but a
// protocol that refused that company name would stop its session from starting.
const matchers = KEY_SHAPES.map((shape) => new RegExp(`(?<![A-Za-z0-9])(?:${shape.source})`));

/** True if `text` holds anything shaped like a provider key, starting a word. */
export function containsKeyShape(text: string): boolean {
  return matchers.some((matcher) => matcher.test(text));
}
