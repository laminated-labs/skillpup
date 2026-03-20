import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { ArtifactKind } from "./types.js";
import {
  checkoutRef,
  cloneRepo,
  ensureEmptyDir,
  getCurrentBranch,
  getGitRoot,
  getHeadCommit,
  getRemoteUrl,
  gitRefExists,
  listTags,
  toGitRelativePath,
} from "./git.js";
import { pathExists } from "./fs-utils.js";
import {
  buildSubagentBundleFileName,
  isSubagentFilePath,
  readSubagentManifest,
} from "./subagents.js";
import {
  normalizeStoredSourceUrl,
  parseGitHubRepoUrl,
  parseGitHubTreeUrl,
  splitGitHubTreeRefAndPath,
  type GitHubRepoRef,
} from "./source-spec.js";
import {
  compareSemverDescending,
  normalizeSkillSourcePath,
  parseSemverLike,
  resolveInside,
  toPosix,
  validateArtifactName,
} from "./utils.js";

export type GitHubSkillLookup = GitHubRepoRef & {
  skillFilePath: string;
};

export type ResolvedSourceArtifact = {
  kind: ArtifactKind;
  name: string;
  sourceDir: string;
  sourcePath: string;
  sourceRef: string;
  sourceCommit: string;
  storedSourceUrl: string;
  selectedTag?: string;
  githubLookup: GitHubSkillLookup | null;
  cleanup: () => Promise<void>;
};

type ResolveSourceArtifactOptions = {
  sourceGitUrl: string;
  path?: string;
  ref?: string;
  name?: string;
  cwd?: string;
  useWorkingTreeIfLocal?: boolean;
};

type SelectedSourceArtifact = {
  kind: ArtifactKind;
  name: string;
  sourceDir: string;
};

function deriveDefaultSkillName(sourceGitUrl: string, skillPath?: string) {
  if (skillPath) {
    const normalizedPath = skillPath.replace(/\\/g, "/").replace(/\/+$/, "");
    return path.posix.basename(normalizedPath);
  }

  const normalizedSource = sourceGitUrl
    .replace(/\\/g, "/")
    .replace(/\/+$/, "")
    .replace(/\.git$/, "");
  return path.posix.basename(normalizedSource);
}

function buildSkillFilePath(sourcePath: string) {
  const normalizedPath = normalizeSkillSourcePath(sourcePath);
  return normalizedPath === "." ? "SKILL.md" : `${normalizedPath}/SKILL.md`;
}

function buildGitHubLookup(repo: GitHubRepoRef, sourcePath: string): GitHubSkillLookup {
  return {
    ...repo,
    skillFilePath: buildSkillFilePath(sourcePath),
  };
}

function resolveSelectedArtifactName(
  selectedArtifact: SelectedSourceArtifact,
  sourceGitUrl: string,
  skillPath: string | undefined,
  explicitName?: string
) {
  if (selectedArtifact.kind !== "skill") {
    validateArtifactName(selectedArtifact.name);
    return selectedArtifact.name;
  }

  const derivedName = explicitName ?? deriveDefaultSkillName(sourceGitUrl, skillPath);
  try {
    validateArtifactName(derivedName);
    return derivedName;
  } catch {
    validateArtifactName(selectedArtifact.name);
    return selectedArtifact.name;
  }
}

async function selectSourceArtifact(
  cloneDir: string,
  selectedPath: string,
  tempRoot: string,
  explicitName?: string
): Promise<SelectedSourceArtifact> {
  const sourceLstat = await fs.lstat(selectedPath);
  if (sourceLstat.isSymbolicLink()) {
    throw new Error(`Symlinked artifact paths are not supported: ${selectedPath}`);
  }

  const sourceStats = await fs.stat(selectedPath);
  if (sourceStats.isDirectory()) {
    const skillMarkerPath = path.join(selectedPath, "SKILL.md");
    if (!(await pathExists(skillMarkerPath))) {
      throw new Error(
        "Selected path must be a skill directory containing SKILL.md or a subagent TOML file. Pass --path to a subagent TOML file."
      );
    }

    const skillName =
      explicitName ??
      path.posix.basename(toPosix(path.relative(cloneDir, selectedPath) || path.basename(selectedPath)));
    return {
      kind: "skill",
      name: skillName,
      sourceDir: selectedPath,
    };
  }

  if (!sourceStats.isFile() || !isSubagentFilePath(selectedPath)) {
    throw new Error(
      "Selected path must be a skill directory containing SKILL.md or a subagent TOML file. Pass --path to a subagent TOML file."
    );
  }

  const manifest = await readSubagentManifest(selectedPath);
  if (explicitName && explicitName !== manifest.name) {
    throw new Error(
      `Subagent name override "${explicitName}" must match the manifest name "${manifest.name}".`
    );
  }

  const bundleSourceDir = path.join(tempRoot, "subagent-bundle");
  await fs.mkdir(bundleSourceDir, { recursive: true });
  await fs.copyFile(
    selectedPath,
    path.join(bundleSourceDir, buildSubagentBundleFileName(manifest.name))
  );

  return {
    kind: "subagent",
    name: manifest.name,
    sourceDir: bundleSourceDir,
  };
}

async function resolveLocalGitHubLookup(
  localSourceRoot: string,
  sourcePath: string
): Promise<GitHubSkillLookup | null> {
  const gitRoot = await getGitRoot(localSourceRoot).catch(() => null);
  if (!gitRoot) {
    return null;
  }

  const remoteUrl = await getRemoteUrl(gitRoot).catch(() => null);
  if (!remoteUrl) {
    return null;
  }

  const parsedRepo = parseGitHubRepoUrl(remoteUrl);
  if (!parsedRepo) {
    return null;
  }

  const selectedSourceRoot =
    sourcePath === "."
      ? localSourceRoot
      : resolveInside(localSourceRoot, sourcePath);
  const repoRelativeSourcePath = toPosix(
    (await toGitRelativePath(gitRoot, selectedSourceRoot)) || "."
  );

  return buildGitHubLookup(parsedRepo, repoRelativeSourcePath);
}

async function resolveWorkingTreeArtifact(
  localSourceRoot: string,
  options: ResolveSourceArtifactOptions,
  storedSourceUrl: string
): Promise<ResolvedSourceArtifact> {
  const selectedSourcePath = options.path
    ? resolveInside(localSourceRoot, options.path)
    : localSourceRoot;

  if (!(await pathExists(selectedSourcePath))) {
    throw new Error(
      `Artifact path does not exist: ${options.path ?? selectedSourcePath}`
    );
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillpup-source-"));
  const selectedArtifact = await selectSourceArtifact(
    localSourceRoot,
    selectedSourcePath,
    tempRoot,
    options.name
  );

  const sourceRef = await getCurrentBranch(localSourceRoot);
  const sourceCommit = await getHeadCommit(localSourceRoot);
  const sourcePath = options.path ?? ".";
  const name = resolveSelectedArtifactName(
    selectedArtifact,
    options.sourceGitUrl,
    options.path,
    options.name
  );

  const directRepo =
    parseGitHubRepoUrl(options.sourceGitUrl) ?? parseGitHubRepoUrl(storedSourceUrl);
  const githubLookup =
    selectedArtifact.kind !== "skill"
      ? null
      : (directRepo ? buildGitHubLookup(directRepo, sourcePath) : null) ??
        (await resolveLocalGitHubLookup(localSourceRoot, sourcePath));

  return {
    kind: selectedArtifact.kind,
    name,
    sourceDir: selectedArtifact.sourceDir,
    sourcePath,
    sourceRef,
    sourceCommit,
    storedSourceUrl,
    githubLookup,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function resolveSourceArtifact(
  options: ResolveSourceArtifactOptions
): Promise<ResolvedSourceArtifact> {
  const cwd = options.cwd ?? process.cwd();
  const storedSourceUrl = normalizeStoredSourceUrl(options.sourceGitUrl, cwd);
  const parsedGitHubTreeUrl = parseGitHubTreeUrl(options.sourceGitUrl);
  const cloneSourceUrl = parsedGitHubTreeUrl?.repoUrl ?? storedSourceUrl;
  const localSourceRoot = path.isAbsolute(storedSourceUrl) ? storedSourceUrl : null;

  if (options.useWorkingTreeIfLocal && localSourceRoot && !options.ref && !parsedGitHubTreeUrl) {
    return resolveWorkingTreeArtifact(localSourceRoot, options, storedSourceUrl);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillpup-source-"));
  const cloneDir = path.join(tempRoot, "source");

  try {
    await ensureEmptyDir(tempRoot);
    await cloneRepo(cloneSourceUrl, cloneDir);

    let inferredRef = options.ref?.trim();
    let inferredPath = options.path;
    if (parsedGitHubTreeUrl && (!inferredRef || !inferredPath)) {
      const resolved = await splitGitHubTreeRefAndPath(
        parsedGitHubTreeUrl.refAndPathSegments,
        (candidate) => gitRefExists(cloneDir, candidate)
      );
      if (!resolved) {
        throw new Error(
          `Unable to resolve GitHub tree URL ref/path: ${options.sourceGitUrl}`
        );
      }
      inferredRef ??= resolved.ref;
      inferredPath ??= resolved.path;
    }

    let selectedRef = inferredRef;
    let selectedTag: string | undefined;

    if (selectedRef) {
      await checkoutRef(cloneDir, selectedRef);
    } else {
      const tags = await listTags(cloneDir);
      const semverTags = tags
        .filter((tag) => parseSemverLike(tag))
        .sort(compareSemverDescending);

      selectedTag = semverTags[0];
      if (selectedTag) {
        await checkoutRef(cloneDir, selectedTag);
      } else {
        selectedRef = await getCurrentBranch(cloneDir);
      }
    }

    const sourceRef =
      inferredRef ?? selectedTag ?? selectedRef ?? (await getCurrentBranch(cloneDir));
    const sourceCommit = await getHeadCommit(cloneDir);
    const sourcePath = inferredPath ?? ".";
    const selectedSourcePath = inferredPath ? resolveInside(cloneDir, inferredPath) : cloneDir;

    if (!(await pathExists(selectedSourcePath))) {
      throw new Error(`Artifact path does not exist: ${inferredPath}`);
    }

    const selectedArtifact = await selectSourceArtifact(
      cloneDir,
      selectedSourcePath,
      tempRoot,
      options.name
    );

    const name = resolveSelectedArtifactName(
      selectedArtifact,
      options.sourceGitUrl,
      inferredPath,
      options.name
    );

    const directRepo =
      parseGitHubRepoUrl(options.sourceGitUrl) ?? parseGitHubRepoUrl(storedSourceUrl);
    const githubLookup =
      selectedArtifact.kind !== "skill"
        ? null
        : (directRepo ? buildGitHubLookup(directRepo, sourcePath) : null) ??
          (localSourceRoot
            ? await resolveLocalGitHubLookup(localSourceRoot, sourcePath)
            : null);

    return {
      kind: selectedArtifact.kind,
      name,
      sourceDir: selectedArtifact.sourceDir,
      sourcePath,
      sourceRef,
      sourceCommit,
      storedSourceUrl,
      selectedTag,
      githubLookup,
      cleanup: async () => {
        await fs.rm(tempRoot, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await fs.rm(tempRoot, { recursive: true, force: true });
    throw error;
  }
}
