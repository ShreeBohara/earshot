/** UUIDv7-shaped ids from a counter, for deterministic tests. */
export function counterIds(): () => string {
  let next = 0;
  return () => {
    next += 1;
    return `00000000-0000-7000-8000-${next.toString(16).padStart(12, "0")}`;
  };
}
