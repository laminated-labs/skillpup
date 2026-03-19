import path from "node:path";
import { loadProjectConfig } from "./config.js";
import { fetchSkills } from "./fetch.js";
import { openRegistryForRead } from "./git-bundle-backend.js";
import { loadLockfile } from "./lockfile.js";
import {
  artifactKey,
  buildConfiguredKindPreference,
  buildDesiredArtifactOrder,
  createMetadataReader,
  createVersionReader,
  getConfiguredArtifacts,
  chooseHighestVersion,
} from "./registry-artifacts.js";
import {
  type UpdatePrompts,
  defaultUpdatePrompts,
  type UpdateSelectionChoice,
} from "./update-prompts.js";
import type { ArtifactKind, FetchResult } from "./types.js";
import { formatArtifactRef, formatArtifactSpecifier, parseArtifactSpecifier } from "./utils.js";

type ProjectUpdateStatus =
  | "up-to-date"
  | "version-bump"
  | "digest-refresh"
  | "error";

export type ProjectUpdateEntry = {
  kind: ArtifactKind;
  name: string;
  currentVersion: string;
  targetVersion: string;
  status: ProjectUpdateStatus;
  detail?: string;
};

type UpdateOptions = {
  artifactSpecs?: string[];
  registry?: string;
  apply?: boolean;
  all?: boolean;
  commit?: boolean;
  cwd?: string;
  isInteractive?: boolean;
  prompts?: UpdatePrompts;
};

export type UpdateProjectResult = {
  entries: ProjectUpdateEntry[];
  appliedEntries: ProjectUpdateEntry[];
  fetchResult?: FetchResult;
};

function validateUpdateOptions(options: UpdateOptions) {
  if (options.all && !options.apply) {
    throw new Error("The --all option can only be used with --apply.");
  }

  if (options.commit && !options.apply) {
    throw new Error("The --commit option can only be used with --apply.");
  }
}

function parseUpdateSelector(input: string) {
  const parsed = parseArtifactSpecifier(input);
  if (parsed.version) {
    throw new Error(
      `Update selectors do not accept versions: "${input}". Use fetch to install an exact version.`
    );
  }
  return parsed;
}

function buildSelectionChoices(entries: ProjectUpdateEntry[]): UpdateSelectionChoice[] {
  return entries
    .filter(
      (entry): entry is ProjectUpdateEntry & {
        status: "version-bump" | "digest-refresh";
      } => entry.status === "version-bump" || entry.status === "digest-refresh"
    )
    .map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      currentVersion: entry.currentVersion,
      targetVersion: entry.targetVersion,
      status: entry.status,
      detail: entry.detail,
    }));
}

function buildUpdateEntrySortKey(entry: { kind: ArtifactKind; name: string }) {
  return `${entry.name}\0${entry.kind}`;
}

function resolveRequestedArtifacts(
  artifactSpecs: string[] | undefined,
  configuredArtifacts: ReturnType<typeof getConfiguredArtifacts>,
  configuredKinds: Map<string, ArtifactKind | "ambiguous">
) {
  if (!artifactSpecs || artifactSpecs.length === 0) {
    return configuredArtifacts;
  }

  const configuredByKey = new Map(
    configuredArtifacts.map((entry) => [artifactKey(entry.kind!, entry.name), entry] as const)
  );

  const resolvedArtifacts = artifactSpecs.map((spec) => {
    const parsed = parseUpdateSelector(spec);
    if (parsed.kind) {
      const configured = configuredByKey.get(artifactKey(parsed.kind, parsed.name));
      if (!configured) {
        throw new Error(
          `${parsed.kind === "skill" ? "Skill" : "Subagent"} "${parsed.name}" is not configured for this project.`
        );
      }
      return configured;
    }

    const configuredKind = configuredKinds.get(parsed.name);
    if (configuredKind === "ambiguous") {
      throw new Error(
        `Artifact "${parsed.name}" is configured as both a skill and a subagent. Use skill:${parsed.name} or subagent:${parsed.name}.`
      );
    }
    if (!configuredKind) {
      throw new Error(`Artifact "${parsed.name}" is not configured for this project.`);
    }

    return configuredByKey.get(artifactKey(configuredKind, parsed.name))!;
  });

  return buildDesiredArtifactOrder(
    resolvedArtifacts.map((entry) => ({
      kind: entry.kind!,
      name: entry.name,
      version: entry.version,
    }))
  );
}

export async function updateProjectArtifacts(
  options: UpdateOptions = {}
): Promise<UpdateProjectResult> {
  validateUpdateOptions(options);

  const cwd = options.cwd ?? process.cwd();
  const loadedConfig = await loadProjectConfig(cwd);
  if (!loadedConfig) {
    throw new Error("No skillpup config found. Create skillpup.config.yaml before updating.");
  }

  const effectiveRegistry = options.registry ?? loadedConfig.config.registry.url;
  const registryHandle = await openRegistryForRead(effectiveRegistry);
  try {
    const readVersionMetadata = createMetadataReader(registryHandle.backend);
    const readVersions = createVersionReader(registryHandle.backend);
    const configuredKinds = buildConfiguredKindPreference(loadedConfig.config);
    const configuredArtifacts = getConfiguredArtifacts(loadedConfig.config);
    const requestedArtifacts = resolveRequestedArtifacts(
      options.artifactSpecs,
      configuredArtifacts,
      configuredKinds
    );
    const requestedKeys = new Set(
      requestedArtifacts.map((entry) => artifactKey(entry.kind!, entry.name))
    );
    const lockfile = await loadLockfile(
      path.join(path.dirname(loadedConfig.path), "skillpup.lock.yaml")
    );
    const lockByKey = new Map([
      ...lockfile.skills.map((entry) => [artifactKey("skill", entry.name), entry] as const),
      ...lockfile.subagents.map(
        (entry) => [artifactKey("subagent", entry.name), entry] as const
      ),
    ]);

    const entries: ProjectUpdateEntry[] = [];
    for (const requested of requestedArtifacts) {
      const kind = requested.kind!;
      const key = artifactKey(kind, requested.name);
      const currentVersion = requested.version ?? lockByKey.get(key)?.version ?? "none";

      try {
        const availableVersions = await readVersions(kind, requested.name);
        if (availableVersions.length === 0) {
          entries.push({
            kind,
            name: requested.name,
            currentVersion,
            targetVersion: currentVersion,
            status: "error",
            detail: "not found in registry",
          });
          continue;
        }

        const latestVersion = chooseHighestVersion(availableVersions).version;
        const locked = lockByKey.get(key);

        if (currentVersion === "none") {
          entries.push({
            kind,
            name: requested.name,
            currentVersion,
            targetVersion: latestVersion,
            status: "version-bump",
            detail: "not yet pinned",
          });
          continue;
        }

        if (latestVersion !== currentVersion) {
          entries.push({
            kind,
            name: requested.name,
            currentVersion,
            targetVersion: latestVersion,
            status: "version-bump",
          });
          continue;
        }

        const currentMetadata = await readVersionMetadata(kind, requested.name, currentVersion);
        if (locked && locked.version === currentVersion && locked.digest !== currentMetadata.digest) {
          entries.push({
            kind,
            name: requested.name,
            currentVersion,
            targetVersion: currentVersion,
            status: "digest-refresh",
            detail: "registry digest changed",
          });
          continue;
        }

        entries.push({
          kind,
          name: requested.name,
          currentVersion,
          targetVersion: currentVersion,
          status: "up-to-date",
        });
      } catch (error) {
        entries.push({
          kind,
          name: requested.name,
          currentVersion,
          targetVersion: currentVersion,
          status: "error",
          detail: error instanceof Error ? error.message : String(error),
        });
      }
    }

    entries.sort((left, right) =>
      buildUpdateEntrySortKey(left).localeCompare(buildUpdateEntrySortKey(right))
    );

    if (!options.apply) {
      return { entries, appliedEntries: [] };
    }

    const candidateChoices = buildSelectionChoices(entries);
    const explicitErrors =
      options.artifactSpecs && options.artifactSpecs.length > 0
        ? entries.filter(
            (entry) =>
              requestedKeys.has(artifactKey(entry.kind, entry.name)) && entry.status === "error"
          )
        : [];
    if (explicitErrors.length > 0) {
      throw new Error(
        explicitErrors
          .map((entry) => `${entry.name}: ${entry.detail ?? "unknown error"}`)
          .join("\n")
      );
    }

    let selectedChoices: UpdateSelectionChoice[] = [];
    if (options.artifactSpecs && options.artifactSpecs.length > 0) {
      selectedChoices = candidateChoices.filter((entry) =>
        requestedKeys.has(artifactKey(entry.kind, entry.name))
      );
    } else if (options.all) {
      selectedChoices = candidateChoices;
    } else if (candidateChoices.length > 0) {
      const isInteractive =
        options.isInteractive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
      if (!isInteractive) {
        throw new Error(
          "Cannot prompt for project updates in non-interactive mode. Pass artifact names or use --all with --apply."
        );
      }

      const prompts = options.prompts ?? defaultUpdatePrompts;
      const selectedValues = new Set(
        await prompts.selectUpdates({
          availableUpdates: candidateChoices,
          message: "Select project updates to apply",
        })
      );
      selectedChoices = candidateChoices.filter((entry) =>
        selectedValues.has(formatArtifactSpecifier(entry.name, entry.kind))
      );
    }

    if (selectedChoices.length === 0) {
      return { entries, appliedEntries: [] };
    }

    const fetchSpecs = selectedChoices.map((entry) =>
      formatArtifactSpecifier(entry.name, entry.kind, entry.targetVersion)
    );
    const fetchResult = await fetchSkills({
      skillSpecs: fetchSpecs,
      registry: options.registry,
      commit: options.commit,
      force: selectedChoices.some((entry) => entry.status === "digest-refresh"),
      cwd,
    });

    const appliedKeys = new Set(
      selectedChoices.map((entry) => artifactKey(entry.kind, entry.name))
    );
    return {
      entries,
      appliedEntries: entries.filter((entry) => appliedKeys.has(artifactKey(entry.kind, entry.name))),
      fetchResult,
    };
  } finally {
    await registryHandle.cleanup();
  }
}

export function formatProjectUpdateSummary(entries: ProjectUpdateEntry[]) {
  const available = entries.filter(
    (entry) => entry.status === "version-bump" || entry.status === "digest-refresh"
  );
  const errors = entries.filter((entry) => entry.status === "error");

  if (available.length === 0 && errors.length === 0) {
    return ["All configured skills and subagents are up to date"];
  }

  const lines: string[] = [];
  if (available.length > 0) {
    lines.push("Project updates available:");
    for (const entry of available) {
      const ref = formatArtifactRef(entry.name, entry.targetVersion, entry.kind);
      const detail = entry.detail ? ` (${entry.detail})` : "";
      lines.push(`- ${ref} from ${entry.currentVersion}${detail}`);
    }
  }

  if (errors.length > 0) {
    lines.push("Unable to check some configured artifacts:");
    for (const entry of errors) {
      lines.push(`- ${entry.name}: ${entry.detail ?? "unknown error"}`);
    }
  }

  return lines;
}
