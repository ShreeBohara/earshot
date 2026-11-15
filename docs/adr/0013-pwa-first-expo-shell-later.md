# ADR-0013: PWA first, Expo shell later

## Status

Accepted (2026-11-15)

## Context and problem

The best moment to capture a debrief is right after a meeting: walking out, in the car, between calls. Phones are the main device. But iOS home-screen web apps lose the microphone when backgrounded, so a web app alone can't record with the screen locked.

## Considered options

- **A PWA first, then an Expo shell for background recording.**
- Native Swift only.

## Decision

Build capture as a progressive web app first. It is installable, with an offline audio queue, and handles capture while the app is open. Add an Expo app in Phase 9 that shares the core packages, and use it only where background audio is needed: recording with the screen locked, an Action Button or Shortcuts entry point, a widget, and the share sheet.

On iOS, locked-screen recording needs a Live Activity for the whole recording. On Android it needs a foreground service. CarPlay is a stretch goal that needs Apple's approval.

## Consequences

**Good**

- One codebase covers the web, the PWA, and most of the mobile experience.
- The native shell stays small, and the Expo app can reuse design tokens, which `packages/tokens` emits as a typed copy.
- Distribution via TestFlight or the App Store ($99 a year) is only needed if the maintainers choose it. Development builds are free.

**Bad**

- Two capture paths (PWA and Expo) to keep consistent.
- iOS and Android background-audio limits shape what the shell can do.
- Until Phase 9, locked-screen capture isn't available.

## More information

Phase 1 reserves the name `apps/mobile` in the layout and builds nothing for mobile.
