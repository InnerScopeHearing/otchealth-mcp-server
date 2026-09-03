---
name: otchealth-security-compliance
description: Security and compliance rails for OTCHealth/InnerScope repositories. Use when reviewing any pull request that touches secrets, credentials, environment variables, logging, error handling, PHI/health data, INND financial or investor content, or Azure/GCP references.
---

# OTCHealth security and compliance review rails

Apply these checks on every pull request in this repository, in addition to
normal code review. Treat a violation as a blocking finding, not a style
preference.

## Secrets

- A pull request must never commit a secret **value** (API key, token,
  password, connection string, private key material). Secret **names** and
  references (env var names, Secret Manager / SSM parameter names) are fine.
- If a diff appears to leak a live credential, for example inside a log
  line, an error message, a test fixture, or a committed `.env` file, flag
  it as a blocking finding and say exactly where.
- **Redact at the point of output.** A helper that shells out (for example
  Node's `execFileSync`/`execFile`) embeds the *entire* command line,
  including any `-H 'Authorization: Bearer <token>'` argument, in
  `Error.message` on failure. If a diff logs, prints, or persists a raw
  `error.message` (or similar) from a subprocess or HTTP client without
  redacting known secret patterns first, flag it, even when no literal
  secret appears in the diff itself, because the leak happens at runtime.
- **Rotation freeze.** If a review turns up a credential that looks
  exposed (in code, logs, or a build artifact), the correct move in a PR is
  to **state the exposure clearly** (which secret, where, why it looks
  live) so a human can decide whether and how to rotate it. Do not propose
  or accept a change that silently rotates, regenerates, or revokes a
  credential as a side effect of an unrelated change; rotating a live
  credential without coordinating every system that depends on it can
  break a production integration.

## PHI and MNPI

- This is a non-BAA runtime. Code, tests, fixtures, prompts, or logging
  that would send real PHI (protected health information) through this
  repo's services is a blocking finding. MedReview's PHI workloads run
  under a separate GCP BAA; nothing here should assume PHI can flow through
  a non-BAA path.
- InnerScope (OTC: INND) material non-public information, financial
  results, deal terms, or investor-facing figures not yet disclosed, must
  never be routed to an external or non-privileged destination (web
  search, a public API, a non-privileged log sink, a shared non-privileged
  data store). Flag any change that would send INND financial or investor
  content somewhere it was not already authorized to go.

## Cloud provider references

- Azure and GCP are retired for this fleet, with one legal-wall exception:
  MedReview's PHI workloads stay on the GCP BAA. AWS SSM Parameter Store
  (`/otchealth/*`) is the secret store of record. A new or reintroduced
  reference to an Azure resource (Key Vault, Blob, Azure AI Search or
  Foundry, Container Apps) or a GCP Secret Manager call outside the
  MedReview PHI path is very likely a regression pointing at a dead
  dependency; flag it and ask whether it was intentional.

## Published or customer-visible copy

- No em dashes or en dashes in any string a customer, tester, or the
  public would see (app copy, store metadata, marketing copy, outbound
  communications). Use commas, periods, or line breaks instead. This does
  not apply to internal code comments or internal documentation.
