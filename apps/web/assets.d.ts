// Module types that next.config.ts's Turbopack rules load as text.
declare module "*.jsonl" {
  const text: string;
  export default text;
}

declare module "*.md" {
  const text: string;
  export default text;
}
