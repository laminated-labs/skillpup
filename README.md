# skillpup

![skillpup logo](./skillpup_logo.png)

`skillpup` is a CLI for publishing agent skills into a private git-backed registry and fetching them into consuming repositories with a config file, lockfile, and integrity checks.

As agentic development gets more common, skills are becoming a powerful way to share workflows and expertise, but the ecosystem is still a bit of a dog park mess. Supply chain risk, competing standards, and weak versioning make it hard to trust the skills you build yourself, let alone the ones you pick up from third parties. `skillpup` exists to help teams bury, track, and fetch skills with a little more discipline.

Inspired by our great friends at [Ambush Capital](https://www.ambush.capital) and their project [docpup](https://github.com/Ambush-Capital/docpup).

## What It Does

`skillpup` gives you a simple workflow for managing reusable agent skills across repositories:

- initialize a registry repository with `skillpup bury init`
- publish versioned skill bundles into that registry with `skillpup bury`
- fetch those skills into a consumer repository with `skillpup fetch`
- record the chosen versions in `skillpup.config.yaml`
- pin fetched contents and source metadata in `skillpup.lock.yaml`
- install the bundle contents into `.agent/skills/<skill-name>`

The CLI is designed for private, git-native workflows where teams want reproducible skill installs without maintaining a separate package registry.

## Installation

`skillpup` requires Node.js 24 or newer.

### Global Install

```bash
npm install -g skillpup
```

Or with `pnpm`:

```bash
pnpm add -g skillpup
```

### Local Development Install

```bash
git clone <your-skillpup-repo>
cd skillpup
pnpm install
pnpm build
node dist/cli.js --help
```

## Quick Start

The normal workflow involves three repositories or directories:

1. a skill source repository containing a `SKILL.md`
2. a registry repository that stores immutable bundled versions
3. a consumer repository that fetches and installs skills

### 1. Initialize a Registry

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

### 2. Publish a Skill into the Registry

Assume you have a git repository at `../reviewer-skill` whose skill root contains `SKILL.md`.

```bash
skillpup bury ../reviewer-skill --registry ../skill-registry --commit
```

By default, `skillpup bury`:

- clones the source repository before reading from it
- uses the highest semver-like tag as the stored version when available
- falls back to the selected ref or source commit when no semver tag is available
- derives the skill name from the repository name unless `--name` is provided

If the skill lives in a nested directory, point at it explicitly:

```bash
skillpup bury ../team-skills \
  --path skills/reviewer \
  --registry ../skill-registry \
  --commit
```

### 3. Fetch the Skill into a Consumer Repository

```bash
mkdir consumer-app
cd consumer-app
git init
skillpup fetch reviewer --registry ../skill-registry
```

That first fetch bootstraps the consumer repository by creating:

- `skillpup.config.yaml`
- `skillpup.lock.yaml`
- `.agent/skills/reviewer/`

After the initial fetch, future syncs can rely on the saved config:

```bash
skillpup fetch
```

If the config lives in a parent directory, `skillpup` will discover it when run from nested subdirectories.

## Core Concepts

### Registry Repository

The registry is a git repository that stores versioned skill bundles and metadata. `skillpup bury init` creates the expected registry marker file, and `skillpup bury` writes new bundle versions into the registry.

### Skill Bundle

A skill bundle is the copied contents of a skill root directory. The selected directory must contain `SKILL.md`, and the copied bundle is stored as an immutable version in the registry.

### Consumer Config

`skillpup.config.yaml` declares which skills a consuming repository wants and where installed skill files should live.

Canonical example:

```yaml
registry:
  type: git
  url: ../skill-registry

skillsDir: .agent/skills

skills:
  - name: reviewer
    version: v1.10.0
  - name: writer
```

Supported config discovery locations include:

- `skillpup.config.yaml`
- `skillpup.config.yml`
- `.skillpuprc`
- `.skillpuprc.json`
- `.skillpuprc.yaml`
- `.skillpuprc.yml`

### Lockfile

`skillpup.lock.yaml` records the resolved version, registry path, digest, and source metadata for each installed skill.

Example excerpt:

```yaml
skills:
  - name: reviewer
    version: v1.10.0
    registryPath: skills/reviewer/versions/v1.10.0
    digest: sha256:...
    buriedAt: 2026-03-07T00:00:00.000Z
    sourceUrl: ../reviewer-skill
    sourcePath: .
    sourceRef: v1.10.0
    sourceCommit: 0123456789abcdef
```

### Installed Skills Directory

Fetched skill files are installed into `.agent/skills` by default:

```text
.agent/
  skills/
    reviewer/
      SKILL.md
      ...
```

You can override the install root with `skillsDir` in config.

## Configuration Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `registry.type` | string | `"git"` | Registry backend type. Current supported value is `git`. |
| `registry.url` | string | none | Path or git URL used for fetching skills. |
| `skillsDir` | string | `.agent/skills` | Destination directory for installed skill bundles. |
| `skills[].name` | string | none | Skill name to fetch. |
| `skills[].version` | string | highest available semver-like version | Optional explicit version to pin in config. |

Notes:

- if `skills[].version` is omitted, `fetch` picks the highest available semver-like version
- when no semver-like versions exist, the newest buried entry wins
- `skillpup fetch reviewer@v1.2.3` updates config and lockfile to that exact version

## Command Reference

### `skillpup fetch [skills...]`

Fetches and installs the configured skills into the current repository.

Arguments:

- `skills`: optional list of `name` or `name@version` specifiers

Options:

- `--registry <path-or-git-url>`: override the configured registry for the current run
- `--commit`: commit config and lockfile changes

Behavior:

- bootstraps config if no config file exists and `--registry` is provided
- rewrites the installed skill directory from registry contents on each fetch
- removes skills that are no longer declared in config
- verifies installed contents against the registry digest before completing

### `skillpup bury init [directory]`

Initializes a directory as a registry repository. If no directory is provided, the current working directory is used.

### `skillpup bury <source-git-url>`

Publishes a skill from a git repository into a local registry.

Options:

- `--path <skill-dir>`: path to the skill root within the source repository
- `--ref <git-ref>`: branch, tag, or commit to import
- `--version <stored-version>`: version string to store in the registry
- `--name <skill-name>`: override the derived skill name
- `--registry <local-path>`: local path to the registry repository
- `--commit`: commit registry changes

Behavior:

- the selected skill directory must contain `SKILL.md`
- if `--ref` is omitted, the highest semver-like tag is preferred
- if no semver-like tag exists, the source branch or commit is used
- if `--version` is omitted, the selected tag or commit becomes the stored version

## Integrity and Git Behavior

`skillpup` is designed to keep fetched skills reproducible and auditable.

- lockfile entries include the resolved version, digest, registry path, and source metadata
- fetch detects registry mutations after locking and fails on digest mismatches
- digest checks include file contents and permission-sensitive filesystem metadata
- repeated fetches reconstruct the installed skill directory from the registry bundle

Commit behavior:

- `skillpup fetch --commit` commits only `skillpup.config.yaml` and `skillpup.lock.yaml`
- `skillpup bury --commit` commits the registry files for the newly buried version
- both commit modes refuse to proceed when unrelated staged changes are present

## Troubleshooting

### `No skillpup config found`

Pass `--registry` on the first fetch to bootstrap a new consumer repository:

```bash
skillpup fetch reviewer --registry ../skill-registry
```

### `Selected skill directory does not contain SKILL.md`

The directory you publish with `bury` must contain a `SKILL.md` at its root. Use `--path` if the skill is nested inside a larger repository.

### Skill version resolution is not what you expected

- use `name@version` with `fetch` to force an exact version
- use `--version` with `bury` to record a specific version explicitly
- when versions are omitted, semver-like versions take precedence

### Running from a nested directory

`fetch` searches parent directories for `skillpup` config files, so you can run it from subdirectories inside a consumer repository as long as the config exists higher up the tree.

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

## Notes

- skill names may contain letters, numbers, `.`, `_`, and `-`
- registry installs are git-backed and suited to private team workflows
- `fetch` can read from a local registry path or a git URL
- `bury --registry` currently expects a local registry path

Built with love by [Laminated Labs](https://laminatedlabs.com).
