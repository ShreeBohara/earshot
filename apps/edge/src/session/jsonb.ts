// Postgres's jsonb refuses two things JSON allows in a string: U+0000 and unpaired surrogates.
// `appendEvents` in `@earshot/db` refuses such events, so one of them in SessionDO's log would
// fail every flush of the session from then on. Client messages carrying them are refused at the
// socket; text SessionDO didn't get from the client (model output) is cleaned instead.

const NUL = "\u0000";
const LONE_SURROGATE = /\p{Cs}/u;
const LONE_SURROGATES = /\p{Cs}/gu;

function unstorable(text: string): boolean {
  return text.includes(NUL) || LONE_SURROGATE.test(text);
}

/** True if any string in `value`, key or value, couldn't be stored in a jsonb column. */
export function hasUnstorableString(value: unknown): boolean {
  const stack: unknown[] = [value];
  for (let item = stack.pop(); item !== undefined || stack.length > 0; item = stack.pop()) {
    if (typeof item === "string") {
      if (unstorable(item)) return true;
    } else if (Array.isArray(item)) {
      stack.push(...item);
    } else if (typeof item === "object" && item !== null) {
      for (const [key, child] of Object.entries(item)) {
        if (unstorable(key)) return true;
        stack.push(child);
      }
    }
  }
  return false;
}

/** A copy of `value` with U+0000 and unpaired surrogates replaced by U+FFFD, length kept. */
export function toStorable<T>(value: T): T {
  if (!hasUnstorableString(value)) return value;
  const replacement = "\ufffd";
  return JSON.parse(JSON.stringify(value), (_key, item: unknown) =>
    typeof item === "string"
      ? item.replaceAll(NUL, replacement).replace(LONE_SURROGATES, replacement)
      : item,
  ) as T;
}
