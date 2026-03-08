import path from "node:path";
import type {
  FetchResult,
  ResolvedSkillConfigEntry,
  SkillConfigEntry,
  SkillVersionMetadata,
} from "./types.js";
import { getDefaultConfigPath, loadProjectConfig, writeProjectConfig } from "./config.js";
import { defaultFetchPrompts, type FetchPrompts, type GenerateMergeStrategy } from "./fetch-prompts.js";
import { loadLockfile, writeLockfile } from "./lockfile.js";
import { copyDirectoryStrict, ensureDir, removePath, computeDirectoryDigest } from "./fs-utils.js";
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
import {
  LOCKFILE_BASENAME,
  compareSemverDescending,
  formatSkillRef,
  parseSemverLike,
  parseSkillSpecifier,
  resolveInside,
} from "./utils.js";

type FetchOptions = {
  skillSpecs?: string[];
  registry?: string;
  commit?: boolean;
  cwd?: string;
  generate?: boolean;
  all?: boolean;
  mergeStrategy?: GenerateMergeStrategy;
  isInteractive?: boolean;
  prompts?: FetchPrompts;
};

type RegistrySkillSummary = {
  name: string;
  version: string;
};

type VersionedEntry = {
  version: string;
  buriedAt: string;
};

function buildDesiredOrder<T extends { name: string }>(entries: T[]) {
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
  requestedNames: string[],
  installed: SkillVersionMetadata[],
  removed: string[]
) {
  const installedByName = new Map(installed.map((entry) => [entry.name, entry]));
  const refs = requestedNames
    .map((name) => installedByName.get(name))
    .filter((entry): entry is SkillVersionMetadata => Boolean(entry))
    .map((entry) => formatSkillRef(entry.name, entry.version));

  if (refs.length > 0) {
    return `chore(skillpup): fetch ${refs.join(", ")}`;
  }

  return "chore(skillpup): fetch sync";
}

function createMetadataReader(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"]
) {
  const cache = new Map<string, Promise<SkillVersionMetadata>>();

  return (name: string, version: string) => {
    const cacheKey = `${name}@${version}`;
    const existing = cache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const next = registryBackend.readVersionMetadata(name, version);
    cache.set(cacheKey, next);
    return next;
  };
}

async function resolveRequestedEntries(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"],
  requestedMap: Map<string, string | undefined>,
  readVersionMetadata: (name: string, version: string) => Promise<SkillVersionMetadata>
) {
  const resolvedEntries: ResolvedSkillConfigEntry[] = [];
  for (const [name, configuredVersion] of requestedMap.entries()) {
    const availableVersions = await registryBackend.listVersions(name);
    if (availableVersions.length === 0) {
      throw new Error(`Skill "${name}" was not found in the registry.`);
    }

    let resolvedVersion = configuredVersion;
    if (resolvedVersion) {
      await readVersionMetadata(name, resolvedVersion);
    } else {
      resolvedVersion = chooseHighestVersion(availableVersions).version;
    }

    resolvedEntries.push({ name, version: resolvedVersion });
  }

  return resolvedEntries;
}

async function listRegistrySkills(
  registryBackend: Awaited<ReturnType<typeof openRegistryForRead>>["backend"]
) {
  const names = await registryBackend.listSkills();
  const skills: RegistrySkillSummary[] = [];

  for (const name of names) {
    const availableVersions = await registryBackend.listVersions(name);
    if (availableVersions.length === 0) {
      continue;
    }

    skills.push({
      name,
      version: chooseHighestVersion(availableVersions).version,
    });
  }

  return skills.sort((left, right) => left.name.localeCompare(right.name));
}

function mergeGeneratedSkills(
  existingSkills: SkillConfigEntry[],
  selectedSkills: ResolvedSkillConfigEntry[]
) {
  const selectedByName = new Map(selectedSkills.map((entry) => [entry.name, entry]));
  const merged: SkillConfigEntry[] = [];

  for (const entry of existingSkills) {
    const selectedEntry = selectedByName.get(entry.name);
    if (selectedEntry) {
      merged.push(selectedEntry);
      selectedByName.delete(entry.name);
      continue;
    }

    merged.push(entry);
  }

  merged.push(...selectedByName.values());
  return buildDesiredOrder(merged);
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
      "Cannot combine explicit skill names with --all when using --generate."
    );
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
  const config = loadedConfig?.config ?? {
    registry: {
      type: "git" as const,
      url: options.registry!,
    },
    skillsDir: await resolveSkillsDir(configDir),
    skills: [],
  };

  const effectiveRegistry = options.registry ?? config.registry.url;
  const lockfilePath = path.join(configDir, LOCKFILE_BASENAME);
  const lockfile = await loadLockfile(lockfilePath);
  const previousLockByName = new Map(lockfile.skills.map((entry) => [entry.name, entry]));
  const requestedSpecs = options.skillSpecs ?? [];
  const prompts = options.prompts ?? defaultFetchPrompts;
  const isInteractive =
    options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
  let commitRequestedNames = requestedSpecs.map((spec) => parseSkillSpecifier(spec).name);

  const registryHandle = await openRegistryForRead(effectiveRegistry);
  try {
    const readVersionMetadata = createMetadataReader(registryHandle.backend);

    if (options.generate) {
      let mergeStrategy = options.mergeStrategy;
      const hasConfiguredSkills = config.skills.length > 0;

      if (hasConfiguredSkills && !mergeStrategy) {
        if (!isInteractive) {
          throw new Error(
            "Cannot choose between merging and replacing in non-interactive mode. Pass --merge or --replace with --generate."
          );
        }

        mergeStrategy = await prompts.chooseGenerateMergeStrategy({
          configPath,
          configuredSkillCount: config.skills.length,
        });
      }

      let selectedSpecs: string[];
      if (requestedSpecs.length > 0) {
        selectedSpecs = requestedSpecs;
      } else {
        const availableSkills = await listRegistrySkills(registryHandle.backend);
        if (availableSkills.length === 0) {
          throw new Error("No skills were found in the registry.");
        }

        if (options.all) {
          selectedSpecs = availableSkills.map((skill) => skill.name);
        } else {
          if (!isInteractive) {
            throw new Error(
              "Cannot prompt for registry skills in non-interactive mode. Pass skill names or use --all with --generate."
            );
          }

          const configuredSkillsByName = new Map(
            config.skills.map((entry) => [entry.name, entry.version] as const)
          );
          selectedSpecs = await prompts.selectSkillsToGenerate({
            availableSkills: availableSkills.map((skill) => ({
              ...skill,
              configured: configuredSkillsByName.has(skill.name),
              configuredVersion: configuredSkillsByName.get(skill.name),
            })),
            mergeStrategy: mergeStrategy ?? "replace",
          });
        }
      }

      const selectedEntries = await resolveRequestedEntries(
        registryHandle.backend,
        new Map(selectedSpecs.map((skillSpec) => {
          const parsed = parseSkillSpecifier(skillSpec);
          return [parsed.name, parsed.version];
        })),
        readVersionMetadata
      );

      config.skills =
        mergeStrategy === "merge"
          ? mergeGeneratedSkills(config.skills, selectedEntries)
          : buildDesiredOrder(selectedEntries);

      commitRequestedNames = selectedEntries.map((entry) => entry.name);
    }

    const requestedMap = new Map(config.skills.map((entry) => [entry.name, entry.version]));
    if (!options.generate) {
      for (const skillSpec of requestedSpecs) {
        const parsed = parseSkillSpecifier(skillSpec);
        requestedMap.set(parsed.name, parsed.version);
      }
    }

    const resolvedEntries = await resolveRequestedEntries(
      registryHandle.backend,
      requestedMap,
      readVersionMetadata
    );
    const desiredSkills = buildDesiredOrder(resolvedEntries);
    config.skills = desiredSkills;

    const skillsDir = resolveInside(configDir, config.skillsDir);
    await ensureDir(skillsDir);

    const installed: SkillVersionMetadata[] = [];
    for (const skill of desiredSkills) {
      const metadata = await readVersionMetadata(skill.name, skill.version);
      const previous = previousLockByName.get(skill.name);
      if (
        previous &&
        previous.version === metadata.version &&
        previous.digest !== metadata.digest
      ) {
        throw new Error(
          `Digest mismatch for ${skill.name}@${skill.version}. The registry contents changed after locking.`
        );
      }

      const bundlePath = await registryHandle.backend.readBundlePath(
        skill.name,
        skill.version
      );
      const destinationPath = resolveInside(skillsDir, skill.name);
      await removePath(destinationPath);
      await copyDirectoryStrict(bundlePath, destinationPath);

      const installedDigest = await computeDirectoryDigest(destinationPath);
      if (installedDigest !== metadata.digest) {
        throw new Error(`Installed digest mismatch for ${skill.name}@${skill.version}.`);
      }

      installed.push(metadata);
    }

    const desiredNames = new Set(desiredSkills.map((entry) => entry.name));
    const removed = lockfile.skills
      .filter((entry) => !desiredNames.has(entry.name))
      .map((entry) => entry.name);
    for (const removedSkill of removed) {
      const destinationPath = resolveInside(skillsDir, removedSkill);
      await removePath(destinationPath);
    }

    lockfile.skills = [...installed].sort((left, right) =>
      left.name.localeCompare(right.name)
    );

    await writeProjectConfig(configPath, config);
    await writeLockfile(lockfilePath, lockfile);
    const gitignoreUpdate = await ensureDirectoryIgnoredInRepo(skillsDir, configDir);

    if (options.commit) {
      const gitRoot = await getGitRoot(configDir);
      const allowedPaths = [
        await toGitRelativePath(gitRoot, configPath),
        await toGitRelativePath(gitRoot, lockfilePath),
      ];
      if (gitignoreUpdate.gitignorePath && gitignoreUpdate.changed) {
        allowedPaths.push(await toGitRelativePath(gitRoot, gitignoreUpdate.gitignorePath));
      }
      await ensureNoUnrelatedStagedChanges(gitRoot, allowedPaths);
      await stagePaths(gitRoot, allowedPaths);
      await commitChanges(
        gitRoot,
        buildFetchCommitMessage(commitRequestedNames, installed, removed)
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
