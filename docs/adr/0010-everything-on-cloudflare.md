# ADR-0010: Everything on Cloudflare: OpenNext for the web app, with vinext watched and Vercel for the web app as the fallback

## Status

Accepted (2026-11-15); revisit if the OpenNext deploy spike fails or when vinext leaves beta

## Context and problem

Earshot wants one platform, about $6 a month in hosting, and infrastructure that can be written as code. The web app is Next.js 16, and realtime sessions already need Cloudflare (ADR-0003). Since 2026-11-05, Cloudflare's own Next.js guide recommends vinext, still in beta, over OpenNext for new apps.

## Considered options

- **Everything on Cloudflare Workers, with the web app on OpenNext.**
- vinext on Cloudflare, which is in beta.
- The web app on Vercel, with everything else on Cloudflare.

## Decision

Run the web app on Cloudflare Workers through OpenNext (1.20.17 shipped 2026-11-12), plus Durable Objects, Queues, Workflows, R2, and AI Gateway. OpenNext is maintained and runs real Next.js.

Phase 1 enables the React Compiler and leaves Cache Components off, because OpenNext calls `use cache` experimental. Auth checks live in the data layer, since OpenNext's `proxy.ts` support is experimental.

The deploy spike (WP3) has a fallback ladder: pin Next.js within OpenNext's range, turn off the React Compiler, give vinext one hour, then move the web app to Vercel. The spike's outcome will be added here.

## Consequences

**Good**

- About $5 total, on one platform, with no reliance on Vercel Hobby's undefined "non-commercial" terms or its 300 s WebSocket cap.
- Since September 2026, Workers can be up to 64 MiB on every plan, so Phase 1 fits the free plan.

**Bad**

- OpenNext friction is a real risk, and the recommended path has moved to vinext.
- Vercel Pro's $20 seat would use the whole budget, so the fallback has a cost.

## More information

Revisit when vinext leaves beta.
