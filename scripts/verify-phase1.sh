#!/usr/bin/env bash
# Phase 1 gate checks for one PR's preview (build spec, section 5).
#
#   CF_WORKERS_SUBDOMAIN=<subdomain> scripts/verify-phase1.sh <pr-number>
#   CF_WORKERS_SUBDOMAIN=<subdomain> scripts/verify-phase1.sh <pr-number> --after-close
set -euo pipefail

PR="${1:?usage: verify-phase1.sh <pr-number> [--after-close]}"
SUBDOMAIN="${CF_WORKERS_SUBDOMAIN:?set CF_WORKERS_SUBDOMAIN to your workers.dev subdomain}"
WEB="https://earshot-web-pr-${PR}.${SUBDOMAIN}.workers.dev"
EDGE="https://earshot-edge-pr-${PR}.${SUBDOMAIN}.workers.dev"

if [[ "${2:-}" == "--after-close" ]]; then
  for url in "$WEB/" "$EDGE/health"; do
    code=$(curl -s -o /dev/null -w "%{http_code}" "$url" || true)
    if [[ "$code" == "200" ]]; then
      echo "FAIL: $url still answers 200"
      exit 1
    fi
    echo "ok: $url is gone (HTTP $code)"
  done
  echo "Also confirm preview/pr-${PR} no longer exists in the Neon console."
  exit 0
fi

echo "== Health chain: web -> edge -> Durable Object, and web -> Postgres"
curl -fsS "$WEB/api/health" |
  jq -e --arg branch "preview/pr-${PR}" \
    '.status == "ok" and .edge.durableObject == "ok" and .db.branch == $branch'

echo "== Required checks"
gh pr checks "$PR" --required

echo "Preview checks passed for PR ${PR}."
echo "Close the PR, wait about two minutes, then run: $0 ${PR} --after-close"
