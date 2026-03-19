# skillpup

<img src="./skillpup_logo.png" alt="skillpup logo" width="240" />

`skillpup` is a CLI for publishing agent skills and Codex subagents into a private git-backed registry and fetching them into consuming repositories with a config file, lockfile, and integrity checks.

As agentic development gets more common, skills are becoming a powerful way to share workflows and expertise, but the ecosystem is still a bit of a dog park mess. Supply chain risk, competing standards, and weak versioning make it hard to trust the skills you build yourself, let alone the ones you pick up from third parties. `skillpup` exists to help teams bury, track, and fetch skills with a little more discipline.

Inspired by our great friends at [Ambush Capital](https://www.ambush.capital) and their project [docpup](https://github.com/Ambush-Capital/docpup).

## What It Does

`skillpup` gives you a simple workflow for managing reusable agent artifacts across repositories:

- initialize a registry repository with `skillpup bury init`
- publish versioned skill bundles and subagent bundles into that registry with `skillpup bury`
- fetch those artifacts into a consumer repository with `skillpup fetch`
- check for project updates from the configured registry with `skillpup update`
- check for registry updates from upstream sources with `skillpup bury update`
- record the chosen versions in `skillpup.config.yaml`
- pin fetched contents and source metadata in `skillpup.lock.yaml`
- install skill bundles into `.agents/skills/<skill-name>`
- install subagent bundles into `.codex/agents/<subagent-name>.toml`

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

Check the installed CLI version with `skillpup --version`.

### Local Development Install

```bash
git clone <your-skillpup-repo>
cd skillpup
pnpm install
pnpm build
node dist/cli.js --help
```

## Contributor Bootstrap

This repo ships a small contributor bootstrap inspired by the setup Laminated Labs uses across many projects:

- `.devcontainer/` provides a single-container Node 24 environment with `gh`, `jq`, `just`, `ripgrep`, `bubblewrap`, `docpup`, and `codex`
- `.devcontainer/dotfiles/` stores the committed Codex config and rules, symlinked into `~/.codex/` during bootstrap with GNU Stow
- `skillpup.config.yaml` dogfoods the Laminated Labs skills registry for repo support skills (currently closed source, but hopefully not for long!)
- `docpup.config.yaml` builds a compact local docs cache for the CLI surface this repo touches most often
- `AGENTS.md` documents the expected workflow for agents

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

## Quick Start

The normal workflow involves three repositories or directories:

1. a skill source repository containing a `SKILL.md`
2. optionally, a repository containing Codex custom subagent TOML files
3. a registry repository that stores immutable bundled versions
4. a consumer repository that fetches and installs artifacts

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

### 2. Publish a Skill or Subagent into the Registry

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
- `.agents/skills/reviewer/`

After the initial fetch, future syncs can rely on the saved config:

```bash
skillpup fetch
```

To check whether the project is pinned behind newer registry versions without changing files:

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

## Core Concepts

### Registry Repository

The registry is a git repository that stores versioned skill bundles and metadata. `skillpup bury init` creates the expected registry marker file, and `skillpup bury` writes new bundle versions into the registry.

### Skill Bundle

A skill bundle is the copied contents of a skill root directory. The selected directory must contain `SKILL.md`, and the copied bundle is stored as an immutable version in the registry.

### Consumer Config

`skillpup.config.yaml` declares which skills and subagents a consuming repository wants and where installed files should live.

Canonical example:

```yaml
registry:
  type: git
  url: ../skill-registry

skillsDir: .agents/skills
subagentsDir: .codex/agents

skills:
  - name: reviewer
    version: v1.10.0
  - name: writer

subagents:
  - name: courier-reviewer
    version: v1.0.0
```

Supported config discovery locations include:

- `skillpup.config.yaml`
- `skillpup.config.yml`
- `.skillpuprc`
- `.skillpuprc.json`
- `.skillpuprc.yaml`
- `.skillpuprc.yml`

### Lockfile

`skillpup.lock.yaml` records the resolved version, registry path, digest, and source metadata for each installed skill and subagent.

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
subagents:
  - name: courier-reviewer
    version: v1.0.0
    registryPath: subagents/courier-reviewer/versions/v1.0.0
    digest: sha256:...
    buriedAt: 2026-03-07T00:00:00.000Z
    sourceUrl: ../team-subagents
    sourcePath: .codex/agents/courier-reviewer.toml
    sourceRef: v1.0.0
    sourceCommit: fedcba9876543210
```

### Installed Artifact Directories

Fetched skill files are installed into `.agents/skills` by default:

```text
.agents/
  skills/
    reviewer/
      SKILL.md
      ...
```

If `skillsDir` is omitted, `skillpup` reuses an existing supported skills directory when it finds one and otherwise falls back to `.agents/skills`. `skillpup fetch --registry ...` writes the resolved path into the generated config.

Fetched subagent files are installed into `.codex/agents` by default:

```text
.codex/
  agents/
    courier-reviewer.toml
```

If `subagentsDir` is omitted, `skillpup` falls back to `.codex/agents`.

When running inside a git repository, `skillpup fetch` ensures the effective install directories are ignored by the repo `.gitignore`. If any repo `.gitignore` already covers that path, no new rule is added.

## Configuration Reference

| Option | Type | Default | Description |
| --- | --- | --- | --- |
| `registry.type` | string | `"git"` | Registry backend type. Current supported value is `git`. |
| `registry.url` | string | none | Path or git URL used for fetching skills. |
| `skillsDir` | string | detected, fallback `.agents/skills` | Destination directory for installed skill bundles. |
| `subagentsDir` | string | `.codex/agents` | Destination directory for installed project-scoped subagent TOML files. |
| `skills[].name` | string | none | Skill name to fetch. |
| `skills[].version` | string | highest available semver-like version | Optional explicit version to pin in config. |
| `subagents[].name` | string | none | Subagent name to fetch. |
| `subagents[].version` | string | highest available semver-like version | Optional explicit version to pin in config. |

Notes:

- if `skills[].version` is omitted, `fetch` picks the highest available semver-like version
- when no semver-like versions exist, the newest buried entry wins
- `skillpup fetch reviewer@v1.2.3` updates config and lockfile to that exact skill version
- `skillpup fetch subagent:courier-reviewer@v1.0.0` updates config and lockfile to that exact subagent version

## Command Reference

### `skillpup fetch [artifacts...]`

Fetches and installs the configured skills and subagents into the current repository.

Arguments:

- `artifacts`: optional list of `name`, `name@version`, `skill:name`, or `subagent:name@version` specifiers

Options:

- `--registry <path-or-git-url>`: override the configured registry for the current run
- `--generate`: build or update config entries from the registry before fetching
- `--all`: when used with `--generate`, select every available artifact in the registry
- `--merge`: when used with `--generate`, merge the generated selection into the existing config
- `--replace`: when used with `--generate`, replace the existing config artifact lists
- `--force`: accept digest changes for explicitly requested artifacts and rewrite their lockfile entries
- `--commit`: commit config and lockfile changes

Behavior:

- bootstraps config if no config file exists and `--registry` is provided
- when `artifacts...` are passed, only those named artifacts are fetched for that run
- named fetches update config and lockfile entries for the requested artifacts without reinstalling unrelated configured artifacts
- `fetch --generate --registry ...` can create a config by selecting from the registry instead of naming artifacts up front
- `fetch --generate --all` selects every skill and subagent in the registry without prompting
- `fetch --generate` prompts before changing an existing config unless `--merge` or `--replace` is passed
- `fetch --generate` requires a TTY unless you pass explicit artifact names or `--all`
- writes the resolved `skillsDir` and `subagentsDir` into bootstrapped config files
- ensures the effective install directories are ignored in the git-root `.gitignore` when needed
- rewrites installed artifact contents from registry contents on each fetch
- removes artifacts that are no longer declared in config
- verifies installed contents against the registry digest before completing
- bare fetch names prefer the configured kind when the same name exists as both a skill and a subagent; otherwise use `skill:<name>` or `subagent:<name>` to disambiguate

### `skillpup update [artifacts...]`

Checks the configured project artifacts against the registry and optionally applies selected updates.

Arguments:

- `artifacts`: optional list of configured `name`, `skill:name`, or `subagent:name` selectors

Options:

- `--registry <path-or-git-url>`: override the configured registry for the current run
- `--apply`: apply selected available updates
- `--all`: when used with `--apply`, apply every available update without prompting
- `--commit`: commit config and lockfile changes when applying

Behavior:

- defaults to check-only output and does not mutate files
- compares configured project artifacts to the registry and reports newer versions or same-version digest refreshes
- when applying, reuses the existing `fetch` workflow to rewrite config pins, lockfile entries, and installed contents for the selected artifacts
- refuses to prompt in non-interactive mode unless you pass explicit artifact selectors or `--all`
- rejects `name@version` selectors; use `fetch` when you want to install an exact version directly

### `skillpup bury init [directory]`

Initializes a directory as a registry repository. If no directory is provided, the current working directory is used.

### `skillpup bury <source-git-url>`

Publishes a skill or subagent from a git repository into a local registry.

Options:

- `--path <artifact-path>`: path to the skill root or subagent TOML file within the source repository
- `--ref <git-ref>`: branch, tag, or commit to import
- `--version <stored-version>`: version string to store in the registry
- `--name <artifact-name>`: override the derived artifact name
- `--registry <local-path>`: local path to the registry repository
- `--commit`: commit registry changes

Behavior:

- a skill target must be a directory containing `SKILL.md`
- a subagent target must be a TOML file containing `name`, `description`, and `developer_instructions`
- top-level source repo metadata such as `.git` is stripped from the stored bundle
- if `--ref` is omitted, the highest semver-like tag is preferred
- if no semver-like tag exists, the source branch or commit is used
- if `--version` is omitted, the selected tag or commit becomes the stored version
- subagents are stored in the registry as canonical one-file bundles and install into `.codex/agents/<name>.toml`

### `skillpup bury refresh <target-folder>`

Refreshes the digest metadata for an already-buried artifact version after editing the
registry bundle in place.

Options:

- `--registry <local-path>`: local path to the registry repository; inferred from the target when omitted
- `--commit`: commit the refreshed bundle metadata and edited version contents

Behavior:

- `target-folder` may point at the buried version directory, its `skill/` directory, or any file inside that tree
- recomputes the digest from the existing bundled files under `.../skill`
- rewrites `metadata.yaml` and the matching `index.yaml` entry when the digest changes
- leaves metadata untouched when the bundle digest is unchanged

### `skillpup bury update [artifacts...]`

Checks the latest buried version of each registry artifact against its recorded upstream source metadata and optionally publishes selected updates.

Arguments:

- `artifacts`: optional list of `name`, `skill:name`, or `subagent:name` selectors

Options:

- `--registry <local-path>`: local path to the registry repository; inferred from the current directory when omitted
- `--apply`: publish selected available updates into the registry
- `--all`: when used with `--apply`, publish every available update without prompting
- `--commit`: commit the published registry changes

Behavior:

- defaults to check-only output and does not mutate the registry
- scans only the latest buried version for each selected artifact
- supports newer semver tags for tag-tracked artifacts and newer commits on the recorded branch or named ref for branch-tracked artifacts
- republishes selected updates as new immutable registry versions; it does not rewrite old versions in place
- rejects `name@version` selectors; use `bury` when you want to publish an exact version directly

## Integrity and Git Behavior

`skillpup` is designed to keep fetched skills reproducible and auditable.

- lockfile entries include the resolved version, digest, registry path, and source metadata
- fetch detects registry mutations after locking and fails on digest mismatches
- digest checks include file contents and permission-sensitive filesystem metadata
- repeated fetches reconstruct installed artifact contents from the registry bundle
- `bury` strips top-level `.git` metadata from published repo-root skills so consumers do not receive nested git repositories
- `bury refresh` intentionally mutates an existing buried version in place; consumers locked to the older digest will keep failing until their lockfile is updated
- `fetch <artifact-name> --force` accepts a refreshed digest for that explicitly requested artifact and rewrites its lockfile entry
- `update` surfaces same-version digest refreshes as selectable project updates, and applying them reuses the same explicit-fetch `--force` path

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

### Invalid subagent TOML

Subagents must be buried from a TOML file path and must declare `name`, `description`, and `developer_instructions`.

### Skill version resolution is not what you expected

- use `name@version` with `fetch` to force an exact version
- use `--version` with `bury` to record a specific version explicitly
- when versions are omitted, semver-like versions take precedence

### Ambiguous artifact names

If the same name exists as both a skill and a subagent, use `skill:<name>` or `subagent:<name>` when fetching it for the first time.

### Running from a nested directory

`fetch` searches parent directories for `skillpup` config files, so you can run it from subdirectories inside a consumer repository as long as the config exists higher up the tree.

### `Installed digest mismatch`

The bundled files in the registry no longer match the digest recorded in `metadata.yaml`.

- republish the artifact as a new version if the bundle changed
- or run `skillpup bury refresh <path>` if you intentionally edited the existing buried bundle in place

### Codex `[agents]` settings

`skillpup` manages project-scoped subagent files in `.codex/agents`, but it does yet not manage `.codex/config.toml` or global `[agents]` settings such as `max_threads` or `max_depth`.

### Skills directory detection

When `skillsDir` is not set in config, `skillpup` walks upward from the current config directory or bootstrap working directory to the git root and resolves the first match it finds in this order:

- an existing `.agents/skills`
- an existing `.github/skills`
- an existing `.opencode/skills`
- an existing `.claude/skills`
- an existing `.agent/skills`
- otherwise `.agents/skills`

Repo markers such as `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/agents/`, and `.opencode/` are treated as hints that the repository uses agent tooling, but they still resolve to `.agents/skills` unless one of the supported skills directories already exists.

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
