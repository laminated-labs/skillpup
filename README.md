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
- look up [Tego](https://tego.ai) security assessments for skills with `skillpup sniff`
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

## Quick Start

The shortest useful flow is: initialize a registry, publish a skill into it, and fetch that skill into a consumer repository.

### 1. Initialize A Registry

```bash
mkdir skill-registry
cd skill-registry
skillpup bury init .
git add .
git commit -m "Initialize skill registry"
```

### 2. Publish A Skill Or Subagent

```bash
skillpup bury ../reviewer-skill --registry ../skill-registry --commit
```

### 3. Fetch Into A Consumer Repository

```bash
mkdir consumer-app
cd consumer-app
git init
skillpup fetch reviewer --registry ../skill-registry
```

After the initial fetch, future syncs can rely on the saved config:

```bash
skillpup fetch
```

For read-side flows such as `fetch` and `update`, registry URLs can be local paths or hosted git
remotes such as `git@bitbucket.org:workspace/skill-registry.git`.

To check whether the project is pinned behind newer registry versions without changing files:

```bash
skillpup update
```

To apply every available project update in one run:

```bash
skillpup update --apply --all
```

To look up an existing assessment from the [Tego Skills Security Index](https://index.tego.security/skills/) for a local GitHub-backed skill before burying it:

```bash
export TEGO_API_KEY=tsk_...
skillpup sniff ../reviewer-skill
```

Bitbucket Cloud-backed skills can be buried, updated, and fetched normally, but `sniff`
currently reports `unsupported-source` because Tego matching is GitHub-oriented.

To sniff every configured skill in a consumer repository:

```bash
export TEGO_API_KEY=tsk_...
skillpup sniff
```

For the full onboarding flow and deeper examples, read [Getting Started](./documentation/getting-started.md).

## Command Summary

| Command | Purpose |
| --- | --- |
| `skillpup bury init` | Create a new registry repository scaffold |
| `skillpup bury` | Publish a skill or subagent into a local registry |
| `skillpup sniff` | Look up Tego security assessments for skills |
| `skillpup fetch` | Install configured artifacts into a consumer repository |
| `skillpup update` | Check or apply project updates from the configured registry |
| `skillpup bury update` | Check or publish registry updates from upstream sources |
| `skillpup bury refresh` | Refresh digest metadata after an intentional in-place registry edit |

For flags, behavior details, config fields, and integrity rules, read [Reference](./documentation/reference.md).

## Documentation

Maintained docs for this repo live under `documentation/`:

- [Documentation Index](./documentation/README.md)
- [Getting Started](./documentation/getting-started.md)
- [Reference](./documentation/reference.md)
- [Contributing](./documentation/contributing.md)
- [Troubleshooting](./documentation/troubleshooting.md)

Generated external docs remain under `documentation/external/`.

## Contributing

If you are working on `skillpup` itself, start with [Contributing](./documentation/contributing.md) for the devcontainer/bootstrap notes, local helper commands, and development workflow.

Built with love by [Laminated Labs](https://laminatedlabs.com).
