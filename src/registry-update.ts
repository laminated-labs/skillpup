import fs from "node:fs/promises";
import path from "node:path";
import { burySkill } from "./bury.js";
import { openRegistryForWrite } from "./git-bundle-backend.js";
import {
  commitChanges,
  ensureNoUnrelatedStagedChanges,
  getGitRoot,
  listRemoteRefs,
  stagePaths,
  toGitRelativePath,
  type RemoteGitRef,
} from "./git.js";
import {
  artifactKey,
  createMetadataReader,
  createVersionReader,
  listRegistryArtifacts,
  resolveRequestedEntries,
} from "./registry-artifacts.js";
import { findContainingRegistryRoot } from "./registry-root.js";
import {
  isAbsoluteLocalSourcePath,
  isScpLikeGitUrl,
  isWindowsAbsolutePath,
  resolveHostedRepoUrls,
  parseHostedSourceViewUrl,
} from "./source-spec.js";
import {
  defaultUpdatePrompts,
  type UpdatePrompts,
  type UpdateSelectionChoice,
} from "./update-prompts.js";
import type { ArtifactKind, BuryAddResult } from "./types.js";
import {
  compareSemverDescending,
  formatArtifactRef,
  formatArtifactSpecifier,
  parseArtifactSpecifier,
  parseSemverLike,
} from "./utils.js";

type RegistryUpdateStatus =
  | "up-to-date"
  | "version-bump"
  | "unsupported"
  | "error";

export type RegistryUpdateEntry = {
  kind: ArtifactKind;
  name: string;
  currentVersion: string;
  targetVersion: string;
  status: RegistryUpdateStatus;
  detail?: string;
  sourceUrl: string;
  sourcePath: string;
  targetRef?: string;
};

type RegistryUpdateOptions = {
  artifactSpecs?: string[];
  registry?: string;
  apply?: boolean;
  all?: boolean;
  commit?: boolean;
  cwd?: string;
  isInteractive?: boolean;
  prompts?: UpdatePrompts;
};

export type UpdateRegistryResult = {
  registryRoot: string;
  entries: RegistryUpdateEntry[];
  appliedEntries: RegistryUpdateEntry[];
  published: BuryAddResult[];
};

function validateUpdateOptions(options: RegistryUpdateOptions) {
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
      `Update selectors do not accept versions: "${input}". Use bury to publish an exact version.`
    );
  }
  return parsed;
}

function buildSelectionChoices(entries: RegistryUpdateEntry[]): UpdateSelectionChoice[] {
  return entries
    .filter(
      (entry): entry is RegistryUpdateEntry & {
        status: "version-bump";
        targetRef: string;
      } => entry.status === "version-bump" && Boolean(entry.targetRef)
    )
    .map((entry) => ({
      kind: entry.kind,
      name: entry.name,
      currentVersion: entry.currentVersion,
      targetVersion: entry.targetVersion,
      status: "version-bump",
      detail: entry.detail,
    }));
}

function buildEntrySortKey(entry: { kind: ArtifactKind; name: string }) {
  return `${entry.name}\0${entry.kind}`;
}

function buildRegistryUpdateCommitMessage(results: BuryAddResult[]) {
  const refs = results.map((entry) =>
    formatArtifactRef(entry.metadata.name, entry.metadata.version, entry.metadata.kind)
  );

  if (refs.length > 0) {
    return `chore(skillpup-registry): update ${refs.join(", ")}`;
  }

  return "chore(skillpup-registry): update sync";
}

function isHexCommitish(value: string) {
  return /^[0-9a-f]{7,40}$/i.test(value);
}

function resolveRemoteNamedRef(remoteRefs: RemoteGitRef[], sourceRef: string) {
  const candidates = sourceRef.startsWith("refs/")
    ? [sourceRef]
    : [`refs/heads/${sourceRef}`, `refs/tags/${sourceRef}`, sourceRef];

  for (const candidate of candidates) {
    const match = remoteRefs.find((entry) => entry.ref === candidate);
    if (match) {
      return match;
    }
  }

  return null;
}

function getTagName(ref: string) {
  return ref.startsWith("refs/tags/") ? ref.slice("refs/tags/".length) : null;
}

export { isScpLikeGitUrl, isWindowsAbsolutePath };

async function resolveSourceLookupTargets(
  sourceUrl: string,
  registryRoot: string,
  cwd: string
) {
  if (isAbsoluteLocalSourcePath(sourceUrl)) {
    return [sourceUrl];
  }

  const parsedHostedSourceViewUrl = parseHostedSourceViewUrl(sourceUrl);
  if (parsedHostedSourceViewUrl) {
    return parsedHostedSourceViewUrl.repoUrls;
  }

  const hostedRepoUrls = resolveHostedRepoUrls(sourceUrl);
  if (hostedRepoUrls) {
    return hostedRepoUrls;
  }

  let parsedUrl: URL | null = null;
  try {
    parsedUrl = new URL(sourceUrl);
  } catch {
    parsedUrl = null;
  }
  if (parsedUrl && parsedUrl.protocol) {
    return [sourceUrl];
  }

  if (isScpLikeGitUrl(sourceUrl)) {
    return [sourceUrl];
  }

  const candidates = [
    path.resolve(registryRoot, sourceUrl),
    path.resolve(cwd, sourceUrl),
  ];
  for (const candidate of candidates) {
    try {
      await fs.access(candidate);
      return [candidate];
    } catch {
      continue;
    }
  }

  throw new Error(`Unable to resolve local source path "${sourceUrl}" from this registry.`);
}

async function listRemoteRefsWithFallback(repoUrls: string[]) {
  const uniqueRepoUrls = [...new Set(repoUrls.filter(Boolean))];
  let lastError: unknown;

  for (const repoUrl of uniqueRepoUrls) {
    try {
      return await listRemoteRefs(repoUrl);
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError ?? new Error("Unable to list remote refs.");
}

export async function resolveSourceLookupTarget(
  sourceUrl: string,
  registryRoot: string,
  cwd: string
) {
  return (await resolveSourceLookupTargets(sourceUrl, registryRoot, cwd))[0]!;
}

async function buildRegistryUpdateEntry(args: {
  kind: ArtifactKind;
  name: string;
  version: string;
  sourceUrl: string;
  sourcePath: string;
  sourceRef: string;
  sourceCommit: string;
  registryRoot: string;
  cwd: string;
  remoteRefsBySource: Map<string, Promise<RemoteGitRef[]>>;
}): Promise<RegistryUpdateEntry> {
  const {
    kind,
    name,
    version,
    sourceUrl,
    sourcePath,
    sourceRef,
    sourceCommit,
    registryRoot,
    cwd,
    remoteRefsBySource,
  } = args;

  const currentVersion = version;

  try {
    const lookupTargets = await resolveSourceLookupTargets(sourceUrl, registryRoot, cwd);
    const lookupCacheKey = lookupTargets.join("\0");
    let remoteRefsPromise = remoteRefsBySource.get(lookupCacheKey);
    if (!remoteRefsPromise) {
      remoteRefsPromise = listRemoteRefsWithFallback(lookupTargets);
      remoteRefsBySource.set(lookupCacheKey, remoteRefsPromise);
    }
    const remoteRefs = await remoteRefsPromise;

    const currentSourceSemver = parseSemverLike(sourceRef);
    if (currentSourceSemver) {
      const newerTags = remoteRefs
        .flatMap((entry) => {
          const tagName = getTagName(entry.ref);
          return tagName && parseSemverLike(tagName) ? [{ entry, tagName }] : [];
        })
        .filter((entry) => parseSemverLike(entry.tagName)!.compare(currentSourceSemver) > 0)
        .sort((left, right) => compareSemverDescending(left.tagName, right.tagName));

      if (newerTags.length > 0) {
        return {
          kind,
          name,
          currentVersion,
          targetVersion: newerTags[0]!.tagName,
          status: "version-bump",
          detail: `new tag ${newerTags[0]!.tagName}`,
          sourceUrl,
          sourcePath,
          targetRef: newerTags[0]!.tagName,
        };
      }

      return {
        kind,
        name,
        currentVersion,
        targetVersion: currentVersion,
        status: "up-to-date",
        sourceUrl,
        sourcePath,
      };
    }

    const remoteRef = resolveRemoteNamedRef(remoteRefs, sourceRef);
    if (!remoteRef) {
      const unsupported = sourceRef === sourceCommit || isHexCommitish(sourceRef);
      return {
        kind,
        name,
        currentVersion,
        targetVersion: currentVersion,
        status: unsupported ? "unsupported" : "error",
        detail: unsupported ? "commit-pinned source" : `source ref "${sourceRef}" not found upstream`,
        sourceUrl,
        sourcePath,
      };
    }

    if (remoteRef.ref.startsWith("refs/tags/")) {
      return {
        kind,
        name,
        currentVersion,
        targetVersion: currentVersion,
        status: "unsupported",
        detail: "non-semver tags are not auto-updated",
        sourceUrl,
        sourcePath,
      };
    }

    if (remoteRef.commit !== sourceCommit) {
      return {
        kind,
        name,
        currentVersion,
        targetVersion: remoteRef.commit,
        status: "version-bump",
        detail: `new commit on ${sourceRef}`,
        sourceUrl,
        sourcePath,
        targetRef: sourceRef,
      };
    }

    return {
      kind,
      name,
      currentVersion,
      targetVersion: currentVersion,
      status: "up-to-date",
      sourceUrl,
      sourcePath,
    };
  } catch (error) {
    return {
      kind,
      name,
      currentVersion,
      targetVersion: currentVersion,
      status: "error",
      detail: error instanceof Error ? error.message : String(error),
      sourceUrl,
      sourcePath,
    };
  }
}

export async function updateRegistryArtifacts(
  options: RegistryUpdateOptions = {}
): Promise<UpdateRegistryResult> {
  validateUpdateOptions(options);

  const cwd = options.cwd ?? process.cwd();
  const registryRoot = options.registry
    ? path.resolve(cwd, options.registry)
    : await findContainingRegistryRoot(cwd);
  if (!registryRoot) {
    throw new Error("No skillpup registry found. Pass --registry or run inside a registry.");
  }

  const backend = await openRegistryForWrite(registryRoot);
  const readVersions = createVersionReader(backend);
  const readVersionMetadata = createMetadataReader(backend);

  const requestedEntries =
    options.artifactSpecs && options.artifactSpecs.length > 0
      ? await resolveRequestedEntries(
          options.artifactSpecs.map((spec) => parseUpdateSelector(spec)),
          new Map<string, ArtifactKind | "ambiguous">(),
          readVersions,
          readVersionMetadata
        )
      : await listRegistryArtifacts(backend, readVersions);

  const requestedKeys = new Set(
    requestedEntries.map((entry) => artifactKey(entry.kind, entry.name))
  );
  const remoteRefsBySource = new Map<string, Promise<RemoteGitRef[]>>();
  const entries: RegistryUpdateEntry[] = [];

  for (const requested of requestedEntries) {
    const metadata = await readVersionMetadata(requested.kind, requested.name, requested.version);
    entries.push(
      await buildRegistryUpdateEntry({
        kind: metadata.kind,
        name: metadata.name,
        version: metadata.version,
        sourceUrl: metadata.sourceUrl,
        sourcePath: metadata.sourcePath,
        sourceRef: metadata.sourceRef,
        sourceCommit: metadata.sourceCommit,
        registryRoot,
        cwd,
        remoteRefsBySource,
      })
    );
  }

  entries.sort((left, right) => buildEntrySortKey(left).localeCompare(buildEntrySortKey(right)));

  if (!options.apply) {
    return {
      registryRoot,
      entries,
      appliedEntries: [],
      published: [],
    };
  }

  const candidateChoices = buildSelectionChoices(entries);
  const explicitFailures =
    options.artifactSpecs && options.artifactSpecs.length > 0
      ? entries.filter(
          (entry) =>
            requestedKeys.has(artifactKey(entry.kind, entry.name)) &&
            (entry.status === "error" || entry.status === "unsupported")
        )
      : [];
  if (explicitFailures.length > 0) {
    throw new Error(
      explicitFailures
        .map((entry) => `${entry.name}: ${entry.detail ?? "unsupported"}`)
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
        "Cannot prompt for registry updates in non-interactive mode. Pass artifact names or use --all with --apply."
      );
    }

    const prompts = options.prompts ?? defaultUpdatePrompts;
    const selectedValues = new Set(
      await prompts.selectUpdates({
        availableUpdates: candidateChoices,
        message: "Select registry updates to publish",
      })
    );
    selectedChoices = candidateChoices.filter((entry) =>
      selectedValues.has(formatArtifactSpecifier(entry.name, entry.kind))
    );
  }

  if (selectedChoices.length === 0) {
    return {
      registryRoot,
      entries,
      appliedEntries: [],
      published: [],
    };
  }

  const selectedKeys = new Set(
    selectedChoices.map((entry) => artifactKey(entry.kind, entry.name))
  );
  const selectedEntries = entries.filter((entry) => selectedKeys.has(artifactKey(entry.kind, entry.name)));
  const published: BuryAddResult[] = [];
  for (const entry of selectedEntries) {
    if (entry.status !== "version-bump" || !entry.targetRef) {
      continue;
    }

    published.push(
      await burySkill({
        sourceGitUrl: entry.sourceUrl,
        path: entry.sourcePath === "." ? undefined : entry.sourcePath,
        ref: entry.targetRef,
        version: entry.targetVersion,
        name: entry.name,
        registry: registryRoot,
        cwd,
      })
    );
  }

  if (options.commit && published.length > 0) {
    const gitRoot = await getGitRoot(registryRoot);
    const allowedPaths = new Set<string>();
    for (const result of published) {
      allowedPaths.add(await toGitRelativePath(gitRoot, result.indexPath));
      allowedPaths.add(await toGitRelativePath(gitRoot, result.versionPath));
    }
    await ensureNoUnrelatedStagedChanges(gitRoot, Array.from(allowedPaths));
    await stagePaths(gitRoot, Array.from(allowedPaths));
    await commitChanges(gitRoot, buildRegistryUpdateCommitMessage(published));
  }

  return {
    registryRoot,
    entries,
    appliedEntries: selectedEntries,
    published,
  };
}

export function formatRegistryUpdateSummary(entries: RegistryUpdateEntry[]) {
  const available = entries.filter((entry) => entry.status === "version-bump");
  const errors = entries.filter((entry) => entry.status === "error");
  const unsupported = entries.filter((entry) => entry.status === "unsupported");

  if (available.length === 0 && errors.length === 0 && unsupported.length === 0) {
    return ["All latest buried artifacts are up to date"];
  }

  const lines: string[] = [];
  if (available.length > 0) {
    lines.push("Registry updates available:");
    for (const entry of available) {
      const ref = formatArtifactRef(entry.name, entry.targetVersion, entry.kind);
      const detail = entry.detail ? ` (${entry.detail})` : "";
      lines.push(`- ${ref} from ${entry.currentVersion}${detail}`);
    }
  }

  if (unsupported.length > 0) {
    lines.push("Registry artifacts not updateable in v1:");
    for (const entry of unsupported) {
      lines.push(`- ${entry.name}: ${entry.detail ?? "unsupported"}`);
    }
  }

  if (errors.length > 0) {
    lines.push("Unable to check some registry artifacts:");
    for (const entry of errors) {
      lines.push(`- ${entry.name}: ${entry.detail ?? "unknown error"}`);
    }
  }

  return lines;
}
