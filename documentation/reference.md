# Reference

This is the detailed product reference for `skillpup`.

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
    sourceUrl: /absolute/path/to/reviewer-skill
    sourcePath: .
    sourceRef: v1.10.0
    sourceCommit: 0123456789abcdef
subagents:
  - name: courier-reviewer
    version: v1.0.0
    registryPath: subagents/courier-reviewer/versions/v1.0.0
    digest: sha256:...
    buriedAt: 2026-03-07T00:00:00.000Z
    sourceUrl: /absolute/path/to/team-subagents
    sourcePath: .codex/agents/courier-reviewer.toml
    sourceRef: v1.0.0
    sourceCommit: fedcba9876543210
```

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

## Environment

| Variable | Purpose |
| --- | --- |
| `TEGO_API_KEY` | Required for `skillpup sniff`. Provide your own Tego API key as an environment variable. |
| `SKILLPUP_TEGO_BASE_URL` | Optional override for the Tego API base URL used by `skillpup sniff`. Useful for staging or test environments. |

To create a Tego API key:

1. Open the [Tego Skills Security Index](https://index.tego.security/skills/) and sign in with Google or GitHub SSO.
2. Generate an API key from the Tego account API-key flow.
3. Save the plaintext `tsk_...` value immediately; Tego only returns it once on create or rotate.
4. Export it before running `skillpup sniff`.

`skillpup` does not store this key in `skillpup.config.yaml` or `skillpup.lock.yaml`.

## Command Reference

### `skillpup sniff [targets...]`

Looks up skill security assessments from [Tego](https://tego.ai) and the [Tego Skills Security Index](https://index.tego.security/skills/).

Options:

- `--registry <path-or-git-url>`: switch to registry mode and treat `targets...` as buried artifact selectors
- `--path <artifact-path>`: source mode only; path to the skill root within the source repository
- `--ref <git-ref>`: source mode only; git ref to inspect before matching

Project mode:

- run `skillpup sniff` in a consumer repo to inspect every configured skill in `skillpup.config.yaml`
- run `skillpup sniff gh-address-comments pr-writer` to inspect a subset of configured skills
- project mode uses `skillpup.lock.yaml` when available so installed skills resolve back to their recorded source metadata instead of the untracked files under `.agents/skills`
- configured subagents report `unsupported-kind`

Source mode:

- run `skillpup sniff <source-git-url-or-local-path>` to inspect a source repository before burying it
- source mode mirrors `skillpup bury` path and ref resolution, but it never publishes anything
- local source mode requires the repo to have a GitHub or Bitbucket Cloud `origin` remote so `skillpup` can resolve the selected `SKILL.md` back to hosted source metadata
- if the source cannot be mapped to hosted source metadata, `sniff` reports `unsupported-source`
- Bitbucket Cloud-backed sources also report `unsupported-source` after resolution because Tego matching currently requires GitHub-backed source metadata

Registry mode:

- run `skillpup sniff reviewer --registry ../skill-registry` to inspect a buried skill
- selectors accept `name`, `skill:name`, `name@version`, or `skill:name@version`
- `skillpup sniff --registry ../skill-registry` scans the latest buried version of every skill in the registry
- subagents are outside Tego's current scope; explicit `subagent:...` selectors report `unsupported-kind`, and registry-wide scans ignore subagents
- buried skills whose recorded `sourceUrl` is not a GitHub or Bitbucket Cloud repository URL report `unsupported-source`
- buried Bitbucket Cloud-backed skills also report `unsupported-source` because Tego matching currently requires GitHub-backed source metadata

Behavior:

- `sniff` is report-only in v1; it does not fail on matched risk levels, `not-indexed`, `unsupported-kind`, or `unsupported-source`
- `sniff` fails only for invalid usage, missing `TEGO_API_KEY`, or Tego auth and transport errors
- matched results report the Tego risk level, repo path, assessment freshness (`exact-commit`, `different-commit`, or `unknown`), and best-effort findings, permissions, and capability summaries
- `sniff` does not upload unpublished skills to Tego; it only matches against skills that Tego has already indexed
- `sniff` is currently GitHub-oriented because it matches against Tego's GitHub-backed skill index

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
- `source-git-url` may be a local path, a hosted clone URL, a GitHub tree URL, or a Bitbucket Cloud source-view URL
- Bitbucket Cloud registry remotes work anywhere `--registry <path-or-git-url>` is accepted, for example `git@bitbucket.org:workspace/skill-registry.git`
- subagents are stored in the registry as canonical one-file bundles and install into `.codex/agents/<name>.toml`

### `skillpup bury refresh <target-folder>`

Refreshes the digest metadata for an already-buried artifact version after editing the registry bundle in place.

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

## Integrity And Git Behavior

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

## Additional Notes

### Codex `[agents]` Settings

`skillpup` manages project-scoped subagent files in `.codex/agents`, but it does not yet manage `.codex/config.toml` or global `[agents]` settings such as `max_threads` or `max_depth`.

### Skills Directory Detection

When `skillsDir` is not set in config, `skillpup` walks upward from the current config directory or bootstrap working directory to the git root and resolves the first match it finds in this order:

- an existing `.agents/skills`
- an existing `.github/skills`
- an existing `.opencode/skills`
- an existing `.claude/skills`
- an existing `.agent/skills`
- otherwise `.agents/skills`

Repo markers such as `AGENTS.md`, `.github/copilot-instructions.md`, `.github/instructions/`, `.github/agents/`, `CLAUDE.md`, `.claude/CLAUDE.md`, `.claude/settings.json`, `.claude/settings.local.json`, `.claude/agents/`, and `.opencode/` are treated as hints that the repository uses agent tooling, but they still resolve to `.agents/skills` unless one of the supported skills directories already exists.

### Miscellaneous

- skill names may contain letters, numbers, `.`, `_`, and `-`
- registry installs are git-backed and suited to private team workflows
- `fetch` can read from a local registry path or a git URL
- `bury --registry` currently expects a local registry path
