import type {
  ArtifactConfigEntry,
  ArtifactKind,
  ArtifactVersionMetadata,
  SkillIndexVersion,
  SkillpupConfig,
} from "./types.js";
import { openRegistryForRead } from "./git-bundle-backend.js";
import {
  compareSemverDescending,
  formatArtifactKindLabel,
  parseSemverLike,
} from "./utils.js";

export type FetchRequestedArtifact = {
  kind?: ArtifactKind;
  name: string;
  version?: string;
};

export type ResolvedRequestedArtifact = {
  kind: ArtifactKind;
  name: string;
  version: string;
};

export type RegistryArtifactSummary = {
  kind: ArtifactKind;
  name: string;
  version: string;
};

type VersionedEntry = {
  version: string;
  buriedAt: string;
};

export function artifactKey(kind: ArtifactKind, name: string) {
  return `${kind}:${name}`;
}

export function buildDesiredArtifactOrder<T extends { kind: ArtifactKind; name: string }>(
  entries: T[]
) {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    unique.set(artifactKey(entry.kind, entry.name), entry);
  }
  return Array.from(unique.values());
}

export function buildDesiredEntryOrder<T extends { name: string }>(entries: T[]) {
  const unique = new Map<string, T>();
  for (const entry of entries) {
    unique.set(entry.name, entry);
  }
  return Array.from(unique.values());
}

export function chooseHighestVersion<T extends VersionedEntry>(versions: T[]) {
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

export function createMetadataReader(
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

export function createVersionReader(
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

export async function listRegistryArtifacts(
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

export function buildConfiguredKindPreference(config: SkillpupConfig) {
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

export function getConfiguredArtifacts(config: SkillpupConfig): FetchRequestedArtifact[] {
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

export async function resolveRequestedKind(
  requested: FetchRequestedArtifact,
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

  if (configuredKind) {
    const kindLabel = formatArtifactKindLabel(configuredKind);
    throw new Error(
      `${kindLabel[0]!.toUpperCase()}${kindLabel.slice(1)} "${requested.name}" is configured for this project but was not found in the registry.`
    );
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

export async function resolveRequestedEntries(
  requestedEntries: FetchRequestedArtifact[],
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

export function mergeGeneratedEntries(
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
