# Corporate CLO publication runtime adapter, 2026-09-13

## Scope

This change makes the existing relationship full-backfill runtime compose the closed corporate CLO profile. It accepts exactly one of two configurations:

- CFO: `cfo_project_config`, CFO host v1, `cfo` and `finance`.
- Corporate CLO: `clo_project_config`, CLO host v2, `clo` and `legal_company`.

The CLO credential provider reads only `CLO/.codex/config.toml`. It rejects the CFO project and a `CLO Personal` path before reading a file. No token values are recorded.

The adapter carries that fixed seat through broker construction, artifact authorization, prepared-source binding, publication outbox, history authorization, publication listing, historical artifact read, and deterministic replay. Mixed CFO and CLO readers are rejected. Existing CFO defaults remain in place for callers that do not supply a profile.

## Source and test evidence

- Gateway HTTPS base: `42daf7debd672fbff41ac18f39ffa5a21559e102`.
- CTO synthetic adapter checkout used for cross-repository composition: `033a2d86cf0885b80b8266494ad8b2cf0bbd792b`.
- Focused command, with only synthetic placeholder environment values and local module paths: `node --import ./tools/relationship-artifacts/typescript-test-loader.mjs --test ...`.
- Result: 38 pass, 0 fail, 2 pre-existing environment-gated skips.
- The executable corporate test runs a synthetic CLO history through actual gateway artifact, publication, list, historical-read, and replay routes. It asserts `legal_company`, then uses a synthetic `clo-personal` caller and asserts no grant is written.
- The full-backfill CLI test runs `--check` using actual CTO v2 host modules and a synthetic `CLO/.codex/config.toml`, then rejects `clo-personal` host configuration.

## Boundaries

No AWS call, deployment, source-record read, personal-legal acceptance, model invocation, or production credential was used. The test fixtures contain synthetic metadata only.