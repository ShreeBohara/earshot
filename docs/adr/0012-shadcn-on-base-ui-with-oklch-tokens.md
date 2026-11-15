# ADR-0012: shadcn/ui on Base UI, with OKLCH tokens

## Status

Accepted (2026-11-15)

## Context and problem

Earshot's interface depends on state color (proposed, conflict, synced, failed), keyboard-first review, and WCAG 2.2 AA accessibility. It needs a component base that can be themed, and a way to prove the theme meets contrast rules. v1 forced dark mode.

## Considered options

- **shadcn/ui on Base UI, with OKLCH design tokens.**
- Heavy glass or translucency effects, which Apple's Liquid Glass showed can hurt legibility.

## Decision

Use shadcn/ui on Base UI (shadcn's default), Tailwind v4, Motion, and View Transitions. Tokens live in their own package, `packages/tokens`, in W3C (DTCG) format, so the web app, the docs site, and the later Expo app can share them. A generator takes three inputs (base, accent, contrast) and produces light and dark themes in OKLCH with contrast tests in Vitest. Style Dictionary builds the CSS and TypeScript outputs, with Terrazzo as the fallback.

Both themes are first-class. The default accent is ink rather than a color, so color is reserved for state meaning. The shadcn `style` can't be changed after init, so it is chosen deliberately in Phase 1.

## Consequences

**Good**

- Themable, and contrast is tested rather than assumed.
- Stock shadcn components work through alias variables.
- Components are built to meet 24 px targets, visible focus rings, and reduced-motion variants.

**Bad**

- Base UI uses a `render` prop where Radix used `asChild`, which differs from older examples.
- Style Dictionary's DTCG 2025.10 support is incomplete.
- Restraint means fewer visual effects.

## More information

Phase 1 ships ten components with Storybook and Chromatic.
