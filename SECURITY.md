# Security policy

## Reporting a vulnerability

Report vulnerabilities through GitHub's private vulnerability reporting:

1. Open the **Security** tab of this repository.
2. Choose **Report a vulnerability**.
3. Describe what you found, how to reproduce it, and what it affects.

**Don't report vulnerabilities in public issues, pull requests, or discussions.** Please don't include real credentials or personal data in a report. If you found a leaked secret, say where it is without pasting it.

We acknowledge reports within 72 hours.

## Supported versions

Until v2.0 is released, only the `main` branch is supported. Fixes go to `main`.

v1 is frozen at tag `v1.0-hackathon` and on branch `v1`. It is not supported, and its hosted demo is offline.

## Scope

In scope:

- The code in this repository, including the contracts, packages, and apps.
- The build and deploy pipeline: GitHub Actions workflows and how they handle secrets.
- Earshot's deployed Workers, such as `earshot-web` and `earshot-edge`, and their database.

Out of scope:

- Vulnerabilities in third-party services and dependencies themselves, such as Cloudflare, Neon, or HubSpot. Report those to the vendor. If Earshot uses one unsafely, that is in scope.
- v1, which is frozen.

## What to expect

Earshot is at Phase 1. It has no user accounts, no voice capture, and no CRM connections yet, so the attack surface today is mostly the repository and its pipeline. The [threat model](docs/threat-model.md) lists what is covered now and what Phase 10 adds.
