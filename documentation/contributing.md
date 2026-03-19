# Contributing

This page is the repo-specific contributor guide for `skillpup`.

## Contributor Bootstrap

This repo ships a small contributor bootstrap inspired by the setup Laminated Labs uses across many projects:

- `.devcontainer/` provides a single-container Node 24 environment with `gh`, `jq`, `just`, `ripgrep`, `bubblewrap`, `docpup`, and `codex`
- `.devcontainer/dotfiles/` stores the committed Codex config and rules, symlinked into `~/.codex/` during bootstrap with GNU Stow
- `skillpup.config.yaml` dogfoods the Laminated Labs skills registry for repo support skills
- `docpup.config.yaml` builds a compact local docs cache for the CLI surface this repo touches most often
- `AGENTS.md` documents the expected workflow for agents

## Useful Repo Commands

Useful commands from the repo root:

```bash
just skills
just docs
just context
```

Behavior:

- `just skills` fetches the pinned support skills into `.agents/skills/`
- `just docs` refreshes the local docs cache into `documentation/external/`
- `just context` runs both
- the devcontainer enables permissive container security options so `bubblewrap` can run inside it

Fetched artifacts, generated docs, and generated indices are intentionally gitignored.
`docpup-lock.json` is tracked so repo-backed doc sources keep a stable freshness lock.

## Development

This repository uses `pnpm`.

```bash
pnpm install
pnpm build
pnpm test
```

If you use `just`, equivalent helpers are available:

```bash
just install
just build
just test
```

## Documentation Layout

Maintained product docs live in:

- `README.md`
- `documentation/README.md`
- `documentation/getting-started.md`
- `documentation/reference.md`
- `documentation/contributing.md`
- `documentation/troubleshooting.md`

Generated external docs remain under `documentation/external/`.
