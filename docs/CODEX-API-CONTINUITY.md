# Codex API continuity lane

This repository has an on-demand Codex worker that authenticates with the protected
`OPENAI_API_KEY` GitHub Actions secret. Its model calls are billed to the OpenAI API
organization and therefore draw from available API grant credits before purchased credits.
They do not draw from the ChatGPT or Codex subscription allowance.

## Operating boundary

- Default model: `gpt-5.6-terra`
- Default reasoning effort: `medium`
- One task per run, 5 to 60 minute hard cap
- The ephemeral GitHub-hosted VM is the external execution sandbox
- The API key is removed from the worker environment immediately after Codex login
- Repository-local write access only
- Any changes are pushed to a `claude/*` branch and opened as a draft pull request
- No automatic credit purchase or fallback provider
- Every run uploads a content-safe receipt, authentication status, and Codex JSONL log
- A run fails unless it proves that an API-backed model turn completed

## What this does and does not cover

This lane provides API-funded continuity for bounded work in this repository. It does not
convert API grant credits into ChatGPT subscription usage, and it does not make Codex cloud
tasks API-funded. Local Codex clients can also use API-key authentication, but changing the
desktop login changes which OpenAI billing and data-policy boundary applies.

Workflow: `.github/workflows/codex-run.yml`

