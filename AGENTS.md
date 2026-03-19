# skillpup Agent Guide

## Purpose

`skillpup` is a Node.js CLI for publishing and fetching git-backed agent artifacts:
- skills installed into `.agents/skills`
- Codex subagents installed into `.codex/agents`

## Commands

- `pnpm install`
- `pnpm build`
- `pnpm test`
- `just build`
- `just test`
- `just skills`
- `just docs`
- `just context`

## Repo Workflow

- Read the relevant code in `src/` and tests in `tests/` before changing behavior.
- Do not edit `dist/` manually. It is generated output.
- Preserve config, lockfile, and registry backward compatibility unless the task explicitly changes them.
- Update `README.md` when CLI behavior, configuration semantics, or contributor workflow changes.
- Prefer integration coverage for end-to-end CLI behavior. Use focused config or generate tests for parsing and prompt behavior.
- Keep digests, lockfiles, and registry metadata aligned with the installed artifact behavior.

## Local Context

Refresh local support files before doing unfamiliar work:
- `just skills` fetches the repo support skills from `skillpup.config.yaml`
- `just docs` refreshes the local doc cache under `documentation/external`

The generated indices live under `documentation/external/indices/`.

Use those local indices and official docs before relying on memory for Codex skills, subagents, and related config behavior.
