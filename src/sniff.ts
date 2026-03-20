import path from "node:path";
import {
  loadProjectConfig,
  resolveConfiguredRegistryUrl,
} from "./config.js";
import type { ArtifactVersionMetadata } from "./types.js";
import { openRegistryForRead } from "./git-bundle-backend.js";
import { loadLockfile } from "./lockfile.js";
import {
  artifactKey,
  buildConfiguredKindPreference,
  chooseHighestVersion,
  createMetadataReader,
  createVersionReader,
  getConfiguredArtifacts,
  listRegistryArtifacts,
  resolveRequestedKind,
} from "./registry-artifacts.js";
import { resolveSourceArtifact, type GitHubSkillLookup } from "./source-artifact.js";
import {
  createTegoClient,
  normalizeAssessmentPayload,
  type NormalizedCapability,
  type NormalizedFinding,
  type NormalizedPermission,
  type TegoSkillSummary,
} from "./tego.js";
import {
  formatArtifactRef,
  formatArtifactSpecifier,
  LOCKFILE_BASENAME,
  normalizeSkillSourcePath,
  parseArtifactSpecifier,
} from "./utils.js";
import { parseGitHubRepoUrl } from "./source-spec.js";

export type SniffStatus =
  | "matched"
  | "not-indexed"
  | "unsupported-kind"
  | "unsupported-source";

export type SniffEntry = {
  status: SniffStatus;
  targetLabel: string;
  detail?: string;
  overallRisk?: string;
  repoFullName?: string;
  skillFilePath?: string;
  githubUrl?: string;
  assessmentSha?: string;
  assessmentScanDate?: string;
  assessmentFreshness?: "exact-commit" | "different-commit" | "unknown";
  findings: NormalizedFinding[];
  permissions: NormalizedPermission[];
  capabilities: NormalizedCapability[];
};

type SniffOptions = {
  artifactSpecs?: string[];
  registry?: string;
  sourceGitUrl?: string;
  path?: string;
  ref?: string;
  cwd?: string;
  apiKey?: string;
  baseUrl?: string;
};

type MatchedAssessment = {
  entry: SniffEntry;
};

function buildSkillFilePath(sourcePath: string) {
  const normalizedPath = normalizeSkillSourcePath(sourcePath);
  return normalizedPath === "." ? "SKILL.md" : `${normalizedPath}/SKILL.md`;
}

function matchesGitHubSkillPath(
  githubHtmlUrl: string | undefined,
  expectedRepoFullName: string,
  expectedSkillFilePath: string
) {
  if (!githubHtmlUrl) {
    return false;
  }

  try {
    const parsedUrl = new URL(githubHtmlUrl);
    const pathPrefix = `/${expectedRepoFullName}/blob/`.toLowerCase();
    const normalizedPathname = parsedUrl.pathname.toLowerCase();
    return (
      parsedUrl.hostname.toLowerCase() === "github.com" &&
      normalizedPathname.startsWith(pathPrefix) &&
      parsedUrl.pathname.endsWith(`/${expectedSkillFilePath}`)
    );
  } catch {
    return false;
  }
}

function sortMatchedSkills(skills: TegoSkillSummary[], skillName: string) {
  return [...skills].sort((left, right) => {
    const leftNameMatch = left.skill_name === skillName ? 0 : 1;
    const rightNameMatch = right.skill_name === skillName ? 0 : 1;
    if (leftNameMatch !== rightNameMatch) {
      return leftNameMatch - rightNameMatch;
    }

    return (right.analysis_timestamp ?? "").localeCompare(left.analysis_timestamp ?? "");
  });
}

async function buildMatchedAssessment(args: {
  targetLabel: string;
  skillName: string;
  sourceCommit: string;
  lookup: GitHubSkillLookup;
  tego: ReturnType<typeof createTegoClient>;
}): Promise<MatchedAssessment | null> {
  const candidates = await args.tego.searchSkillsByOwner(args.lookup.owner);
  const matchingSkills = candidates.filter((candidate) => {
    if (!candidate.repo_full_name) {
      return false;
    }

    return (
      candidate.repo_full_name.toLowerCase() === args.lookup.repoFullName.toLowerCase() &&
      matchesGitHubSkillPath(
        candidate.github_html_url,
        args.lookup.repoFullName,
        args.lookup.skillFilePath
      )
    );
  });
  if (matchingSkills.length === 0) {
    return null;
  }

  const matchedSkill = sortMatchedSkills(matchingSkills, args.skillName)[0]!;
  const assessment = await args.tego.getSkillAssessment(matchedSkill.id);
  const normalizedAssessment = normalizeAssessmentPayload(assessment.assessment);
  const highRiskCapabilities = normalizedAssessment.capabilities.filter((capability) =>
    ["medium", "high", "critical"].includes((capability.riskLevel ?? "").toLowerCase())
  );

  let assessmentFreshness: SniffEntry["assessmentFreshness"] = "unknown";
  if (assessment.sha) {
    assessmentFreshness =
      assessment.sha === args.sourceCommit ? "exact-commit" : "different-commit";
  }

  return {
    entry: {
      status: "matched",
      targetLabel: args.targetLabel,
      overallRisk: matchedSkill.overall_risk,
      repoFullName: matchedSkill.repo_full_name,
      skillFilePath: args.lookup.skillFilePath,
      githubUrl: matchedSkill.github_html_url,
      assessmentSha: assessment.sha,
      assessmentScanDate: assessment.scan_date,
      assessmentFreshness,
      findings: normalizedAssessment.findings,
      permissions: normalizedAssessment.permissions,
      capabilities: highRiskCapabilities,
    },
  };
}

function buildUnsupportedSourceEntry(
  targetLabel: string,
  detail: string
): SniffEntry {
  return {
    status: "unsupported-source",
    targetLabel,
    detail,
    findings: [],
    permissions: [],
    capabilities: [],
  };
}

function buildNotIndexedEntry(
  targetLabel: string,
  lookup: GitHubSkillLookup
): SniffEntry {
  return {
    status: "not-indexed",
    targetLabel,
    detail: `No Tego match for ${lookup.repoFullName}:${lookup.skillFilePath}`,
    repoFullName: lookup.repoFullName,
    skillFilePath: lookup.skillFilePath,
    findings: [],
    permissions: [],
    capabilities: [],
  };
}

async function sniffSourceArtifact(
  options: SniffOptions,
  tego: ReturnType<typeof createTegoClient>
) {
  const resolvedSource = await resolveSourceArtifact({
    sourceGitUrl: options.sourceGitUrl!,
    path: options.path,
    ref: options.ref,
    cwd: options.cwd,
    useWorkingTreeIfLocal: true,
  });

  try {
    const targetLabel = `skill:${resolvedSource.name}`;
    if (resolvedSource.kind !== "skill") {
      return [
        {
          status: "unsupported-kind",
          targetLabel,
          detail: "Tego skill lookups only support skills.",
          findings: [],
          permissions: [],
          capabilities: [],
        } satisfies SniffEntry,
      ];
    }

    if (!resolvedSource.githubLookup) {
      return [
        buildUnsupportedSourceEntry(
          targetLabel,
          "Source is not a GitHub-backed repository with an origin remote."
        ),
      ];
    }

    const matchedAssessment = await buildMatchedAssessment({
      targetLabel,
      skillName: resolvedSource.name,
      sourceCommit: resolvedSource.sourceCommit,
      lookup: resolvedSource.githubLookup,
      tego,
    });

    return [matchedAssessment?.entry ?? buildNotIndexedEntry(targetLabel, resolvedSource.githubLookup)];
  } finally {
    await resolvedSource.cleanup();
  }
}

function buildRegistryLookup(metadata: ArtifactVersionMetadata): GitHubSkillLookup | null {
  const parsedRepo = parseGitHubRepoUrl(metadata.sourceUrl);
  if (!parsedRepo) {
    return null;
  }

  return {
    ...parsedRepo,
    skillFilePath: buildSkillFilePath(metadata.sourcePath),
  };
}

async function sniffRegistryArtifacts(
  options: SniffOptions,
  tego: ReturnType<typeof createTegoClient>
) {
  const registryHandle = await openRegistryForRead(options.registry!);

  try {
    const readVersions = createVersionReader(registryHandle.backend);
    const readVersionMetadata = createMetadataReader(registryHandle.backend);
    const entries: SniffEntry[] = [];

    const requestedVersions =
      options.artifactSpecs && options.artifactSpecs.length > 0
        ? await (async () => {
            const resolved: ArtifactVersionMetadata[] = [];

            for (const spec of options.artifactSpecs) {
              const parsedSpec = parseArtifactSpecifier(spec);
              if (parsedSpec.kind === "subagent") {
                entries.push({
                  status: "unsupported-kind",
                  targetLabel: formatArtifactSpecifier(
                    parsedSpec.name,
                    "subagent",
                    parsedSpec.version
                  ),
                  detail: "Tego skill lookups only support skills.",
                  findings: [],
                  permissions: [],
                  capabilities: [],
                });
                continue;
              }

              const kind = await resolveRequestedKind(
                parsedSpec,
                new Map(),
                readVersions
              );
              if (kind !== "skill") {
                entries.push({
                  status: "unsupported-kind",
                  targetLabel: formatArtifactSpecifier(
                    parsedSpec.name,
                    kind,
                    parsedSpec.version
                  ),
                  detail: "Tego skill lookups only support skills.",
                  findings: [],
                  permissions: [],
                  capabilities: [],
                });
                continue;
              }

              const availableVersions = await readVersions(kind, parsedSpec.name);
              if (availableVersions.length === 0) {
                throw new Error(`Skill "${parsedSpec.name}" was not found in the registry.`);
              }

              const version =
                parsedSpec.version ?? chooseHighestVersion(availableVersions).version;
              resolved.push(
                await readVersionMetadata(kind, parsedSpec.name, version)
              );
            }

            return resolved;
          })()
        : await (async () => {
            const artifacts = await listRegistryArtifacts(
              registryHandle.backend,
              readVersions
            );
            const skills = artifacts.filter((artifact) => artifact.kind === "skill");
            return Promise.all(
              skills.map((artifact) =>
                readVersionMetadata(artifact.kind, artifact.name, artifact.version)
              )
            );
          })();

    for (const metadata of requestedVersions) {
      const targetLabel = formatArtifactRef(
        metadata.name,
        metadata.version,
        metadata.kind
      );
      const lookup = buildRegistryLookup(metadata);
      if (!lookup) {
        entries.push(
          buildUnsupportedSourceEntry(
            targetLabel,
            "Buried sourceUrl is not a GitHub repository URL."
          )
        );
        continue;
      }

      const matchedAssessment = await buildMatchedAssessment({
        targetLabel,
        skillName: metadata.name,
        sourceCommit: metadata.sourceCommit,
        lookup,
        tego,
      });
      entries.push(matchedAssessment?.entry ?? buildNotIndexedEntry(targetLabel, lookup));
    }

    return entries;
  } finally {
    await registryHandle.cleanup();
  }
}

function resolveConfiguredArtifactsForSniff(
  artifactSpecs: string[] | undefined,
  configuredArtifacts: ReturnType<typeof getConfiguredArtifacts>,
  configuredKinds: Map<string, "skill" | "subagent" | "ambiguous">
) {
  if (!artifactSpecs || artifactSpecs.length === 0) {
    return configuredArtifacts;
  }

  const configuredByKey = new Map(
    configuredArtifacts.map((entry) => [artifactKey(entry.kind!, entry.name), entry] as const)
  );

  const resolvedArtifacts = artifactSpecs.map((spec) => {
    const parsed = parseArtifactSpecifier(spec);
    if (parsed.version) {
      throw new Error(
        `Project sniff selectors do not accept versions: "${spec}". Use --registry when you need an exact buried version.`
      );
    }

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

  return resolvedArtifacts;
}

async function sniffProjectArtifacts(
  options: SniffOptions,
  tego: ReturnType<typeof createTegoClient>
) {
  const cwd = options.cwd ?? process.cwd();
  const loadedConfig = await loadProjectConfig(cwd);
  if (!loadedConfig) {
    throw new Error("No skillpup config found. Pass a source path or use --registry.");
  }

  const effectiveRegistry = resolveConfiguredRegistryUrl(
    loadedConfig.config.registry.url,
    loadedConfig.path
  );
  const configuredKinds = buildConfiguredKindPreference(loadedConfig.config);
  const configuredArtifacts = getConfiguredArtifacts(loadedConfig.config);
  const requestedArtifacts = resolveConfiguredArtifactsForSniff(
    options.artifactSpecs,
    configuredArtifacts,
    configuredKinds
  );
  const lockfile = await loadLockfile(
    path.join(path.dirname(loadedConfig.path), LOCKFILE_BASENAME)
  );
  const lockByKey = new Map([
    ...lockfile.skills.map((entry) => [artifactKey("skill", entry.name), entry] as const),
    ...lockfile.subagents.map((entry) => [artifactKey("subagent", entry.name), entry] as const),
  ]);
  let registryHandle: Awaited<ReturnType<typeof openRegistryForRead>> | null = null;
  let readVersions: ReturnType<typeof createVersionReader> | null = null;
  let readVersionMetadata: ReturnType<typeof createMetadataReader> | null = null;

  async function ensureRegistryReaders() {
    if (!registryHandle) {
      registryHandle = await openRegistryForRead(effectiveRegistry);
      readVersions = createVersionReader(registryHandle.backend);
      readVersionMetadata = createMetadataReader(registryHandle.backend);
    }

    return {
      readVersions: readVersions!,
      readVersionMetadata: readVersionMetadata!,
    };
  }

  try {
    const entries: SniffEntry[] = [];

    for (const requested of requestedArtifacts) {
      const kind = requested.kind!;
      const key = artifactKey(kind, requested.name);
      if (kind !== "skill") {
        entries.push({
          status: "unsupported-kind",
          targetLabel: formatArtifactSpecifier(requested.name, kind),
          detail: "Tego skill lookups only support skills.",
          findings: [],
          permissions: [],
          capabilities: [],
        });
        continue;
      }

      const locked = lockByKey.get(key);
      const resolvedMetadata = locked
        ? { ...locked, kind } satisfies ArtifactVersionMetadata
        : await (async () => {
            const { readVersions, readVersionMetadata } = await ensureRegistryReaders();
            const availableVersions = await readVersions(kind, requested.name);
            if (availableVersions.length === 0) {
              throw new Error(`Skill "${requested.name}" was not found in the registry.`);
            }
            const version =
              requested.version ?? chooseHighestVersion(availableVersions).version;
            return readVersionMetadata(kind, requested.name, version);
          })();

      const targetLabel = formatArtifactRef(
        resolvedMetadata.name,
        resolvedMetadata.version,
        resolvedMetadata.kind
      );
      const lookup = buildRegistryLookup(resolvedMetadata);
      if (!lookup) {
        entries.push(
          buildUnsupportedSourceEntry(
            targetLabel,
            "Recorded sourceUrl is not a GitHub repository URL."
          )
        );
        continue;
      }

      const matchedAssessment = await buildMatchedAssessment({
        targetLabel,
        skillName: resolvedMetadata.name,
        sourceCommit: resolvedMetadata.sourceCommit,
        lookup,
        tego,
      });
      entries.push(matchedAssessment?.entry ?? buildNotIndexedEntry(targetLabel, lookup));
    }

    return entries;
  } finally {
    await registryHandle?.cleanup();
  }
}

export async function sniffSkills(options: SniffOptions = {}) {
  const apiKey = options.apiKey ?? process.env.TEGO_API_KEY;
  if (!apiKey) {
    throw new Error("TEGO_API_KEY is required to run skillpup sniff.");
  }

  const tego = createTegoClient({
    apiKey,
    baseUrl: options.baseUrl,
  });

  if (options.registry) {
    return {
      entries: await sniffRegistryArtifacts(options, tego),
    };
  }

  if (!options.sourceGitUrl) {
    return {
      entries: await sniffProjectArtifacts(options, tego),
    };
  }

  return {
    entries: await sniffSourceArtifact(options, tego),
  };
}

export function formatSniffReport(entries: SniffEntry[]) {
  if (entries.length === 0) {
    return ["No targets were sniffed."];
  }

  const lines: string[] = [];
  for (const entry of entries) {
    const statusLabel = entry.status.toUpperCase().replace(/-/g, " ");
    const riskSuffix = entry.overallRisk ? ` [${entry.overallRisk}]` : "";
    lines.push(`${statusLabel}: ${entry.targetLabel}${riskSuffix}`);

    if (entry.repoFullName && entry.skillFilePath) {
      lines.push(`  source: ${entry.repoFullName}:${entry.skillFilePath}`);
    }

    if (entry.githubUrl) {
      lines.push(`  tego: ${entry.githubUrl}`);
    }

    if (entry.assessmentFreshness) {
      const freshnessLine = [`  freshness: ${entry.assessmentFreshness}`];
      if (entry.assessmentSha) {
        freshnessLine.push(entry.assessmentSha);
      }
      if (entry.assessmentScanDate) {
        freshnessLine.push(entry.assessmentScanDate);
      }
      lines.push(freshnessLine.join(" | "));
    }

    if (entry.findings.length > 0) {
      lines.push(
        `  findings: ${entry.findings
          .slice(0, 3)
          .map((finding) => `${finding.severity}:${finding.title}`)
          .join("; ")}`
      );
    }

    if (entry.permissions.length > 0) {
      lines.push(
        `  permissions: ${entry.permissions
          .slice(0, 4)
          .map((permission) =>
            permission.necessity
              ? `${permission.permission} (${permission.necessity})`
              : permission.permission
          )
          .join(", ")}`
      );
    }

    if (entry.capabilities.length > 0) {
      lines.push(
        `  capabilities: ${entry.capabilities
          .map((capability) =>
            capability.riskLevel
              ? `${capability.name} (${capability.riskLevel})`
              : capability.name
          )
          .join(", ")}`
      );
    }

    if (entry.detail) {
      lines.push(`  detail: ${entry.detail}`);
    }
  }

  return lines;
}

export function formatSniffSummary(entries: SniffEntry[]) {
  const counts = {
    matched: 0,
    notIndexed: 0,
    unsupportedKind: 0,
    unsupportedSource: 0,
  };

  for (const entry of entries) {
    if (entry.status === "matched") {
      counts.matched += 1;
    } else if (entry.status === "not-indexed") {
      counts.notIndexed += 1;
    } else if (entry.status === "unsupported-kind") {
      counts.unsupportedKind += 1;
    } else if (entry.status === "unsupported-source") {
      counts.unsupportedSource += 1;
    }
  }

  return `Sniffed ${entries.length} target${entries.length === 1 ? "" : "s"}: ${counts.matched} matched, ${counts.notIndexed} not indexed, ${counts.unsupportedSource} unsupported source, ${counts.unsupportedKind} unsupported kind`;
}
