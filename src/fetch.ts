import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type {
  ArtifactConfigEntry,
  ArtifactKind,
  ArtifactVersionMetadata,
  FetchResult,
  SkillIndexVersion,
  SkillpupConfig,
} from "./types.js";
import { getDefaultConfigPath, loadProjectConfig, writeProjectConfig } from "./config.js";
import { defaultFetchPrompts, type FetchPrompts, type GenerateMergeStrategy } from "./fetch-prompts.js";
import { loadLockfile, writeLockfile } from "./lockfile.js";
import { computeDirectoryDigest, copyDirectoryStrict, ensureDir, removePath } from "./fs-utils.js";
import {
  commitChanges,
  ensureNoUnrelatedStagedChanges,
  getGitRoot,
  stagePaths,
  toGitRelativePath,
} from "./git.js";
import { openRegistryForRead } from "./git-bundle-backend.js";
import { ensureDirectoryIgnoredInRepo } from "./gitignore.js";
import { resolveSkillsDir } from "./skills-dir.js";
import { buildSubagentBundleFileName } from "./subagents.js";
import {
  DEFAULT_SUBAGENTS_DIR,
  LOCKFILE_BASENAME,
  compareSemverDescending,
  formatArtifactRef,
  formatArtifactSpecifier,
  parseArtifactSpecifier,
  parseSemverLike,
  resolveInside,
} from "./utils.js";

type FetchOptions = {
  skillSpecs?: string[];
  registry?: string;
  commit?: boolean;
  force?: boolean;
  cwd?: string;
  generate?: boolean;
  all?: boolean;
  mergeStrategy?: GenerateMergeStrategy;
  isInteractive?: boolean;
  prompts?: FetchPrompts;
};

type RegistryArtifactSummary = {
  kind: ArtifactKind;
  name: string;
  version: string;
};

type RequestedArtifact = {
  kind?: ArtifactKind;
  name: string;
  version?: string;
};

type ResolvedRequestedArtifact = {
  kind: ArtifactKind;
  name: string;
  version: string;
};

type VersionedEntry = {
  version: string;
  buriedAt: string;
};

function artifactKey(kind: ArtifactKind, name: string) {
  return `${kind}:${name}`;
}

function buildDesiredArtifactOrder<T extends { kind: ArtifactKind; name: string }>(entries: T[]) {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    unique.set(artifactKey(entry.kind, entry.name), entry);
  }
  return Array.from(unique.values());
}

function buildDesiredEntryOrder<T extends { name: string }>(entries: T[]) {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    unique.set(entry.name, entry);
  }
  return Array.from(unique.values());
}

function chooseHighestVersion<T extends VersionedEntry>(versions: T[]) {
  const semverVersions = versions.filter((entry) => parseSemverLike(entry.version));
  if (semverVersions.length > 0) {
    return [...semverVersions].sort((left, right) =>
      compareSemverDescending(left.version, right.version)
    )[0];
  }

  return [...versions].sort((left, right) =>
    right.buriedAt.localeCompare(left.buriedAt)
  )[0];
}

function buildFetchCommitMessage(
  requestedArtifacts: Array<{ kind: ArtifactKind; name: string }>,
  installed: ArtifactVersionMetadata[],
  removed: Array<{ kind: ArtifactKind; name: string }>
) {
  const installedByKey = new Map(
    installed.map((entry) => [artifactKey(entry.kind, entry.name), entry] as const)
  );
  const refs = requestedArtifacts
    .map((entry) => installedByKey.get(artifactKey(entry.kind, entry.name)))
    .filter((entry): entry is ArtifactVersionMetadata => Boolean(entry))
    .map((entry) => formatArtifactRef(entry.name, entry.version, entry.kind));

  if (refs.length > 0) {
    return `chore(skillpup): fetch ${refs.join(", ")}`;
  }

  if (removed.length > 0) {
    return "chore(skillpup): fetch sync";
  }

  return "chore(skillpup): fetch sync";
}

function createMetadataReader(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"]
) {
  const cache = new Map<string, Promise<ArtifactVersionMetadata>>();

  return (kind: ArtifactKind, name: string, version: string) => {
    const cacheKey = `${kind}:${name}@${version}`;
    const existing = cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const next = registryBackend.readVersionMetadataForKind(kind, name, version);
    cache.set(cacheKey, next);
    return next;
  };
}

function createVersionReader(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"]
) {
  const cache = new Map<string, Promise<SkillIndexVersion[]>>();

  return (kind: ArtifactKind, name: string) => {
    const cacheKey = `${kind}:${name}`;
    const existing = cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const next = registryBackend.listVersionsForKind(kind, name);
    cache.set(cacheKey, next);
    return next;
  };
}

async function listRegistryArtifacts(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"],
  readVersions: (kind: ArtifactKind, name: string) => Promise<SkillIndexVersion[]>
) {
  const artifacts: RegistryArtifactSummary[] = [];

  for (const kind of ["skill", "subagent"] as const) {
    const names = await registryBackend.listArtifacts(kind);
    for (const name of names) {
      const availableVersions = await readVersions(kind, name);
      if (availableVersions.length === 0) {
        continue;
      }

      artifacts.push({
        kind,
        name,
        version: chooseHighestVersion(availableVersions).version,
      });
    }
  }

  return artifacts.sort((left, right) => {
    const nameComparison = left.name.localeCompare(right.name);
    if (nameComparison !== 0) {
      return nameComparison;
    }
    return left.kind.localeCompare(right.kind);
  });
}

function buildConfiguredKindPreference(config: SkillpupConfig) {
  const configuredKinds = new Map<string, ArtifactKind | "ambiguous">();

  for (const skill of config.skills) {
    configuredKinds.set(skill.name, "skill");
  }
  for (const subagent of config.subagents) {
    const existing = configuredKinds.get(subagent.name);
    configuredKinds.set(
      subagent.name,
      existing && existing !== "subagent" ? "ambiguous" : "subagent"
    );
  }

  return configuredKinds;
}

async function resolveRequestedKind(
  requested: RequestedArtifact,
  configuredKindsByName: Map<string, ArtifactKind | "ambiguous">,
  readVersions: (kind: ArtifactKind, name: string) => Promise<SkillIndexVersion[]>
) {
  if (requested.kind) {
    const versions = await readVersions(requested.kind, requested.name);
    if (versions.length === 0) {
      throw new Error(
        `${requested.kind === "skill" ? "Skill" : "Subagent"} "${requested.name}" was not found in the registry.`
      );
    }
    return requested.kind;
  }

  const configuredKind = configuredKindsByName.get(requested.name);
  if (configuredKind === "ambiguous") {
    throw new Error(
      `Artifact "${requested.name}" is configured as both a skill and a subagent. Use skill:${requested.name} or subagent:${requested.name}.`
    );
  }

  const availableKinds: ArtifactKind[] = [];
  for (const kind of ["skill", "subagent"] as const) {
    const versions = await readVersions(kind, requested.name);
    if (versions.length > 0) {
      availableKinds.push(kind);
    }
  }

  if (configuredKind && availableKinds.includes(configuredKind)) {
    return configuredKind;
  }

  if (availableKinds.length === 1) {
    return availableKinds[0]!;
  }

  if (availableKinds.length === 0) {
    throw new Error(`Artifact "${requested.name}" was not found in the registry.`);
  }

  throw new Error(
    `Artifact "${requested.name}" exists as both a skill and a subagent. Use skill:${requested.name} or subagent:${requested.name}.`
  );
}

async function resolveRequestedEntries(
  requestedEntries: RequestedArtifact[],
  configuredKindsByName: Map<string, ArtifactKind | "ambiguous">,
  readVersions: (kind: ArtifactKind, name: string) => Promise<SkillIndexVersion[]>,
  readVersionMetadata: (
    kind: ArtifactKind,
    name: string,
    version: string
  ) => Promise<ArtifactVersionMetadata>
) {
  const resolvedEntries: ResolvedRequestedArtifact[] = [];

  for (const requested of requestedEntries) {
    const kind = await resolveRequestedKind(
      requested,
      configuredKindsByName,
      readVersions
    );
    const availableVersions = await readVersions(kind, requested.name);
    if (availableVersions.length === 0) {
      throw new Error(
        `${kind === "skill" ? "Skill" : "Subagent"} "${requested.name}" was not found in the registry.`
      );
    }

    let resolvedVersion = requested.version;
    if (resolvedVersion) {
      await readVersionMetadata(kind, requested.name, resolvedVersion);
    } else {
      resolvedVersion = chooseHighestVersion(availableVersions).version;
    }

    resolvedEntries.push({
      kind,
      name: requested.name,
      version: resolvedVersion,
    });
  }

  return buildDesiredArtifactOrder(resolvedEntries);
}

function mergeGeneratedEntries(
  existingEntries: ArtifactConfigEntry[],
  selectedEntries: ResolvedRequestedArtifact[],
  kind: ArtifactKind
) {
  const selectedByName = new Map(
    selectedEntries
      .filter((entry) => entry.kind === kind)
      .map((entry) => [entry.name, { name: entry.name, version: entry.version }] as const)
  );
  const merged: ArtifactConfigEntry[] = [];

  for (const entry of existingEntries) {
    const selectedEntry = selectedByName.get(entry.name);
    if (selectedEntry) {
      merged.push(selectedEntry);
      selectedByName.delete(entry.name);
      continue;
    }

    merged.push(entry);
  }

  merged.push(...selectedByName.values());
  return buildDesiredEntryOrder(merged);
}

function applyResolvedEntriesToConfig(
  config: SkillpupConfig,
  resolvedEntries: ResolvedRequestedArtifact[],
  mergeStrategy: GenerateMergeStrategy | undefined
) {
  if (mergeStrategy === "merge") {
    config.skills = mergeGeneratedEntries(config.skills, resolvedEntries, "skill");
    config.subagents = mergeGeneratedEntries(config.subagents, resolvedEntries, "subagent");
    return;
  }

  config.skills = buildDesiredEntryOrder(
    resolvedEntries
      .filter((entry) => entry.kind === "skill")
      .map((entry) => ({ name: entry.name, version: entry.version }))
  );
  config.subagents = buildDesiredEntryOrder(
    resolvedEntries
      .filter((entry) => entry.kind === "subagent")
      .map((entry) => ({ name: entry.name, version: entry.version }))
  );
}

function getConfiguredArtifacts(config: SkillpupConfig): RequestedArtifact[] {
  return [
    ...config.skills.map((entry) => ({
      kind: "skill" as const,
      name: entry.name,
      version: entry.version,
    })),
    ...config.subagents.map((entry) => ({
      kind: "subagent" as const,
      name: entry.name,
      version: entry.version,
    })),
  ];
}

function validateFetchOptions(options: FetchOptions) {
  if (options.all && !options.generate) {
    throw new Error("The --all option can only be used with --generate.");
  }

  if (options.mergeStrategy && !options.generate) {
    throw new Error("The --merge and --replace options can only be used with --generate.");
  }

  if (options.generate && options.all && (options.skillSpecs?.length ?? 0) > 0) {
    throw new Error(
      "Cannot combine explicit artifact names with --all when using --generate."
    );
  }
}

async function installSubagent(
  bundlePath: string,
  destinationPath: string,
  name: string
) {
  const sourceFilePath = resolveInside(bundlePath, buildSubagentBundleFileName(name));
  const sourceStats = await fs.stat(sourceFilePath);
  await removePath(destinationPath);
  await ensureDir(path.dirname(destinationPath));
  await fs.copyFile(sourceFilePath, destinationPath);
  await fs.chmod(destinationPath, sourceStats.mode & 0o7777);

  const verifyRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillpup-subagent-verify-"));
  try {
    const verifyFilePath = path.join(verifyRoot, buildSubagentBundleFileName(name));
    await fs.copyFile(destinationPath, verifyFilePath);
    await fs.chmod(verifyFilePath, sourceStats.mode & 0o7777);
    return await computeDirectoryDigest(verifyRoot);
  } finally {
    await fs.rm(verifyRoot, { recursive: true, force: true });
  }
}

export async function fetchSkills(options: FetchOptions = {}): Promise<FetchResult> {
  validateFetchOptions(options);

  const cwd = options.cwd ?? process.cwd();
  const loadedConfig = await loadProjectConfig(cwd);

  if (!loadedConfig && !options.registry) {
    throw new Error(
      "No skillpup config found. Create skillpup.config.yaml or pass --registry to bootstrap one."
    );
  }

  const configPath = loadedConfig?.path ?? getDefaultConfigPath(cwd);
  const configDir = path.dirname(configPath);
  const config: SkillpupConfig = loadedConfig?.config ?? {
    registry: {
      type: "git" as const,
      url: options.registry!,
    },
    skillsDir: await resolveSkillsDir(configDir),
    skills: [],
    subagentsDir: DEFAULT_SUBAGENTS_DIR,
    subagents: [],
  };

  const effectiveRegistry = options.registry ?? config.registry.url;
  const lockfilePath = path.join(configDir, LOCKFILE_BASENAME);
  const lockfile = await loadLockfile(lockfilePath);
  const previousLockByKey = new Map([
    ...lockfile.skills.map((entry) => [artifactKey("skill", entry.name), entry] as const),
    ...lockfile.subagents.map((entry) => [artifactKey("subagent", entry.name), entry] as const),
  ]);
  const requestedSpecs = options.skillSpecs ?? [];
  const requestedArtifacts = requestedSpecs.map((spec) => parseArtifactSpecifier(spec));
  const isPartialFetch = !options.generate && requestedArtifacts.length > 0;
  const prompts = options.prompts ?? defaultFetchPrompts;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let commitRequestedArtifacts: Array<{ kind: ArtifactKind; name: string }> = [];

  const registryHandle = await openRegistryForRead(effectiveRegistry);
  try {
    const readVersionMetadata = createMetadataReader(registryHandle.backend);
    const readVersions = createVersionReader(registryHandle.backend);

    if (options.generate) {
      let mergeStrategy = options.mergeStrategy;
      const configuredArtifactCount = config.skills.length + config.subagents.length;

      if (configuredArtifactCount > 0 && !mergeStrategy) {
        if (!isInteractive) {
          throw new Error(
            "Cannot choose between merging and replacing in non-interactive mode. Pass --merge or --replace with --generate."
          );
        }

        mergeStrategy = await prompts.chooseGenerateMergeStrategy({
          configPath,
          configuredSkillCount: configuredArtifactCount,
        });
      }

      let selectedSpecs: string[];
      if (requestedSpecs.length > 0) {
        selectedSpecs = requestedSpecs;
      } else {
        const availableArtifacts = await listRegistryArtifacts(
          registryHandle.backend,
          readVersions
        );
        if (availableArtifacts.length === 0) {
          throw new Error("No skills or subagents were found in the registry.");
        }

        if (options.all) {
          selectedSpecs = availableArtifacts.map((artifact) =>
            formatArtifactSpecifier(artifact.name, artifact.kind)
          );
        } else {
          if (!isInteractive) {
            throw new Error(
              "Cannot prompt for registry artifacts in non-interactive mode. Pass artifact names or use --all with --generate."
            );
          }

          const configuredByKey = new Map([
            ...config.skills.map((entry) => [artifactKey("skill", entry.name), entry.version] as const),
            ...config.subagents.map((entry) => [artifactKey("subagent", entry.name), entry.version] as const),
          ]);
          selectedSpecs = await prompts.selectSkillsToGenerate({
            availableSkills: availableArtifacts.map((artifact) => ({
              ...artifact,
              configured: configuredByKey.has(artifactKey(artifact.kind, artifact.name)),
              configuredVersion: configuredByKey.get(
                artifactKey(artifact.kind, artifact.name)
              ),
            })),
            mergeStrategy: mergeStrategy ?? "replace",
          });
        }
      }

      const selectedEntries = await resolveRequestedEntries(
        selectedSpecs.map((spec) => parseArtifactSpecifier(spec)),
        buildConfiguredKindPreference(config),
        readVersions,
        readVersionMetadata
      );

      applyResolvedEntriesToConfig(config, selectedEntries, mergeStrategy);
      commitRequestedArtifacts = selectedEntries.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
      }));
    }

    const desiredEntries = await resolveRequestedEntries(
      isPartialFetch ? requestedArtifacts : getConfiguredArtifacts(config),
      buildConfiguredKindPreference(config),
      readVersions,
      readVersionMetadata
    );

    applyResolvedEntriesToConfig(config, desiredEntries, isPartialFetch ? "merge" : undefined);
    if (!options.generate && isPartialFetch) {
      commitRequestedArtifacts = desiredEntries.map((entry) => ({
        kind: entry.kind,
        name: entry.name,
      }));
    }

    const explicitForceEntries = requestedArtifacts.length
      ? await resolveRequestedEntries(
          requestedArtifacts,
          buildConfiguredKindPreference(config),
          readVersions,
          readVersionMetadata
        )
      : [];
    const explicitForceKeys = new Set(
      explicitForceEntries.map((entry) => artifactKey(entry.kind, entry.name))
    );

    const skillsDir = resolveInside(configDir, config.skillsDir);
    const subagentsDir = resolveInside(configDir, config.subagentsDir);
    if (desiredEntries.some((entry) => entry.kind === "skill")) {
      await ensureDir(skillsDir);
    }
    if (desiredEntries.some((entry) => entry.kind === "subagent")) {
      await ensureDir(subagentsDir);
    }

    const installed: ArtifactVersionMetadata[] = [];
    for (const artifact of desiredEntries) {
      const metadata = await readVersionMetadata(
        artifact.kind,
        artifact.name,
        artifact.version
      );
      const previous = previousLockByKey.get(artifactKey(artifact.kind, artifact.name));
      if (
        previous &&
        previous.version === metadata.version &&
        previous.digest !== metadata.digest &&
        !(options.force && explicitForceKeys.has(artifactKey(artifact.kind, artifact.name)))
      ) {
        throw new Error(
          `Digest mismatch for ${formatArtifactRef(
            artifact.name,
            artifact.version,
            artifact.kind
          )}. The registry contents changed after locking.`
        );
      }

      const bundlePath = await registryHandle.backend.readBundlePathForKind(
        artifact.kind,
        artifact.name,
        artifact.version
      );

      let installedDigest: string;
      if (artifact.kind === "skill") {
        const destinationPath = resolveInside(skillsDir, artifact.name);
        await removePath(destinationPath);
        await copyDirectoryStrict(bundlePath, destinationPath);
        installedDigest = await computeDirectoryDigest(destinationPath);
      } else {
        const destinationPath = resolveInside(
          subagentsDir,
          buildSubagentBundleFileName(artifact.name)
        );
        installedDigest = await installSubagent(bundlePath, destinationPath, artifact.name);
      }

      if (installedDigest !== metadata.digest) {
        throw new Error(
          `Installed digest mismatch for ${formatArtifactRef(
            artifact.name,
            artifact.version,
            artifact.kind
          )}. The buried bundle no longer matches its recorded digest, likely because the registry files were edited after publish. Republish this artifact as a new version, or run "skillpup bury refresh <path>" if the in-place registry edit was intentional.`
        );
      }

      installed.push(metadata);
    }

    const desiredSkillNames = new Set(
      desiredEntries.filter((entry) => entry.kind === "skill").map((entry) => entry.name)
    );
    const desiredSubagentNames = new Set(
      desiredEntries
        .filter((entry) => entry.kind === "subagent")
        .map((entry) => entry.name)
    );

    const removed: Array<{ kind: ArtifactKind; name: string }> = [];
    if (!isPartialFetch) {
      for (const entry of lockfile.skills) {
        if (desiredSkillNames.has(entry.name)) {
          continue;
        }
        removed.push({ kind: "skill", name: entry.name });
        await removePath(resolveInside(skillsDir, entry.name));
      }
      for (const entry of lockfile.subagents) {
        if (desiredSubagentNames.has(entry.name)) {
          continue;
        }
        removed.push({ kind: "subagent", name: entry.name });
        await removePath(
          resolveInside(subagentsDir, buildSubagentBundleFileName(entry.name))
        );
      }
    }

    const installedSkills = installed
      .filter((entry) => entry.kind === "skill")
      .map(({ kind: _kind, ...entry }) => entry)
      .sort((left, right) => left.name.localeCompare(right.name));
    const installedSubagents = installed
      .filter((entry) => entry.kind === "subagent")
      .map(({ kind: _kind, ...entry }) => entry)
      .sort((left, right) => left.name.localeCompare(right.name));

    lockfile.skills = isPartialFetch
      ? buildDesiredEntryOrder([...lockfile.skills, ...installedSkills]).sort((left, right) =>
          left.name.localeCompare(right.name)
        )
      : installedSkills;
    lockfile.subagents = isPartialFetch
      ? buildDesiredEntryOrder([...lockfile.subagents, ...installedSubagents]).sort(
          (left, right) => left.name.localeCompare(right.name)
        )
      : installedSubagents;

    await writeProjectConfig(configPath, config);
    await writeLockfile(lockfilePath, lockfile);

    const gitignoreUpdates = [];
    if (config.skills.length > 0) {
      gitignoreUpdates.push(await ensureDirectoryIgnoredInRepo(skillsDir, configDir));
    }
    if (config.subagents.length > 0) {
      gitignoreUpdates.push(await ensureDirectoryIgnoredInRepo(subagentsDir, configDir));
    }

    if (options.commit) {
      const gitRoot = await getGitRoot(configDir);
      const allowedPaths = new Set<string>([
        await toGitRelativePath(gitRoot, configPath),
        await toGitRelativePath(gitRoot, lockfilePath),
      ]);
      for (const gitignoreUpdate of gitignoreUpdates) {
        if (gitignoreUpdate.gitignorePath && gitignoreUpdate.changed) {
          allowedPaths.add(
            await toGitRelativePath(gitRoot, gitignoreUpdate.gitignorePath)
          );
        }
      }
      await ensureNoUnrelatedStagedChanges(gitRoot, Array.from(allowedPaths));
      await stagePaths(gitRoot, Array.from(allowedPaths));
      await commitChanges(
        gitRoot,
        buildFetchCommitMessage(commitRequestedArtifacts, installed, removed)
      );
    }

    return {
      configPath,
      lockfilePath,
      installed,
      removed,
    };
  } finally {
    await registryHandle.cleanup();
  }
}
