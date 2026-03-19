# Troubleshooting

Use this page when `skillpup` fails in a way that is not obvious from the command help.

## `No skillpup config found`

Pass `--registry` on the first fetch to bootstrap a new consumer repository:

```bash
skillpup fetch reviewer --registry ../skill-registry
```

## `Selected skill directory does not contain SKILL.md`

The directory you publish with `bury` must contain a `SKILL.md` at its root. Use `--path` if the skill is nested inside a larger repository.

## Invalid Subagent TOML

Subagents must be buried from a TOML file path and must declare `name`, `description`, and `developer_instructions`.

## Skill Version Resolution Is Not What You Expected

- use `name@version` with `fetch` to force an exact version
- use `--version` with `bury` to record a specific version explicitly
- when versions are omitted, semver-like versions take precedence

## Ambiguous Artifact Names

If the same name exists as both a skill and a subagent, use `skill:<name>` or `subagent:<name>` when fetching it for the first time.

## Running From A Nested Directory

`fetch` searches parent directories for `skillpup` config files, so you can run it from subdirectories inside a consumer repository as long as the config exists higher up the tree. Relative `registry.url` values from that config are resolved from the config file directory.

## `Installed digest mismatch`

The bundled files in the registry no longer match the digest recorded in `metadata.yaml`.

- republish the artifact as a new version if the bundle changed
- or run `skillpup bury refresh <path>` if you intentionally edited the existing buried bundle in place

## Next Reading

- For the exact config shape and command flags, read [Reference](./reference.md)
- For the end-to-end happy path, read [Getting Started](./getting-started.md)
