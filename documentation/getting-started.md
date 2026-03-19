# Getting Started

This guide is a deeper look at how to get started with `skillpup`.

## Workflow At A Glance

The normal workflow involves:

1. a skill source repository containing a `SKILL.md`
2. optionally, a repository containing Codex custom subagent TOML files
3. a registry repository that stores immutable bundled versions
4. a consumer repository that fetches and installs artifacts

## 1. Initialize A Registry

```bash
mkdir skill-registry
cd skill-registry
skillpup bury init .
git add .
git commit -m "Initialize skill registry"
```

This creates the registry scaffold, including:

- `skillpup-registry.yaml`
- `skills/`
- a registry `README.md`

## 2. Publish A Skill Or Subagent Into The Registry

Assume you have a git repository at `../reviewer-skill` whose skill root contains `SKILL.md`.

```bash
skillpup bury ../reviewer-skill --registry ../skill-registry --commit
```

By default, `skillpup bury`:

- clones the source repository before reading from it
- uses the highest semver-like tag as the stored version when available
- falls back to the selected ref or source commit when no semver tag is available
- derives the skill name from the repository name unless `--name` is provided
- accepts GitHub tree URLs and automatically infers `--ref` and `--path`

If the skill lives in a nested directory, point at it explicitly:

```bash
skillpup bury ../team-skills \
  --path skills/reviewer \
  --registry ../skill-registry \
  --commit
```

To publish a project-scoped Codex subagent, point `--path` at the TOML file inside the source repository:

```bash
skillpup bury ../team-subagents \
  --path .codex/agents/reviewer.toml \
  --registry ../skill-registry \
  --commit
```

## 3. Fetch Into A Consumer Repository

```bash
mkdir consumer-app
cd consumer-app
git init
skillpup fetch reviewer --registry ../skill-registry
```

That first fetch bootstraps the consumer repository by creating:

- `skillpup.config.yaml`
- `skillpup.lock.yaml`
- `.agents/skills/reviewer/`

After the initial fetch, future syncs can rely on the saved config:

```bash
skillpup fetch
```

If you want to check whether the project is pinned behind newer registry versions without changing files:

```bash
skillpup update
```

To apply every available project update in one run:

```bash
skillpup update --apply --all
```

If you want to bootstrap a consumer config from everything currently buried in the registry, generate it directly from the registry:

```bash
skillpup fetch --generate --all --registry ../skill-registry
```

If the config lives in a parent directory, `skillpup` will discover it when run from nested subdirectories.

## What Gets Installed

Fetched skill files are installed into `.agents/skills` by default:

```text
.agents/
  skills/
    reviewer/
      SKILL.md
      ...
```

Fetched subagent files are installed into `.codex/agents` by default:

```text
.codex/
  agents/
    courier-reviewer.toml
```

When running inside a git repository, `skillpup fetch` ensures the effective install directories are ignored by the repo `.gitignore`. If any repo `.gitignore` already covers that path, no new rule is added.

## Next Reading

- For the config format, command flags, and integrity rules, read [Reference](./reference.md)
- For debugging and recovery paths, read [Troubleshooting](./troubleshooting.md)
- For contributor setup in this repo, read [Contributing](./contributing.md)
