import path from "node:path";
import type {
  FetchResult,
  ResolvedSkillConfigEntry,
  SkillVersionMetadata,
} from "./types.js";
import { getDefaultConfigPath, loadProjectConfig, writeProjectConfig } from "./config.js";
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
import { resolveSkillsDir } from "./skills-dir.js";
import {
  LOCKFILE_BASENAME,
  compareSemverDescending,
  formatSkillRef,
  parseSemverLike,
  parseSkillSpecifier,
  resolveInside,
} from "./utils.js";

function buildDesiredOrder(entries: ResolvedSkillConfigEntry[]) {
  const unique = new Map<string, ResolvedSkillConfigEntry>();
  for (const entry of entries) {
    unique.set(entry.name, entry);
  }
  return Array.from(unique.values());
}

function chooseHighestVersion(versions: SkillVersionMetadata[]) {
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

  if (removed.length > 0) {
    return "chore(skillpup): fetch sync";
  }

  return "chore(skillpup): fetch sync";
}

export async function fetchSkills(options: {
  skillSpecs?: string[];
  registry?: string;
  commit?: boolean;
  cwd?: string;
}): Promise<FetchResult> {
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
  const requestedMap = new Map(config.skills.map((entry) => [entry.name, entry.version]));
  for (const skillSpec of requestedSpecs) {
    const parsed = parseSkillSpecifier(skillSpec);
    requestedMap.set(parsed.name, parsed.version);
  }

  const registryHandle = await openRegistryForRead(effectiveRegistry);
  try {
    const resolvedEntries: ResolvedSkillConfigEntry[] = [];
    for (const [name, configuredVersion] of requestedMap.entries()) {
      const availableVersions = await registryHandle.backend.listVersions(name);
      if (availableVersions.length === 0) {
        throw new Error(`Skill "${name}" was not found in the registry.`);
      }

      let resolvedVersion = configuredVersion;
      if (resolvedVersion) {
        await registryHandle.backend.readVersionMetadata(name, resolvedVersion);
      } else {
        const availableMetadata = await Promise.all(
          availableVersions.map((entry) =>
            registryHandle.backend.readVersionMetadata(name, entry.version)
          )
        );
        resolvedVersion = chooseHighestVersion(availableMetadata).version;
      }

      resolvedEntries.push({ name, version: resolvedVersion });
    }

    const desiredSkills = buildDesiredOrder(resolvedEntries);
    config.skills = desiredSkills;

    const skillsDir = resolveInside(configDir, config.skillsDir);
    await ensureDir(skillsDir);

    const installed: SkillVersionMetadata[] = [];
    for (const skill of desiredSkills) {
      const metadata = await registryHandle.backend.readVersionMetadata(
        skill.name,
        skill.version
      );
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

    if (options.commit) {
      const gitRoot = await getGitRoot(cwd);
      const allowedPaths = [
        await toGitRelativePath(gitRoot, configPath),
        await toGitRelativePath(gitRoot, lockfilePath),
      ];
      await ensureNoUnrelatedStagedChanges(gitRoot, allowedPaths);
      await stagePaths(gitRoot, allowedPaths);
      await commitChanges(
        gitRoot,
        buildFetchCommitMessage(
          requestedSpecs.map((spec) => parseSkillSpecifier(spec).name),
          installed,
          removed
        )
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
