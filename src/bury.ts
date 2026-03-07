import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { BuryAddResult } from "./types.js";
import { openRegistryForWrite, GitBundleRegistryBackend } from "./git-bundle-backend.js";
import {
  checkoutRef,
  cloneRepo,
  commitChanges,
  ensureEmptyDir,
  ensureNoUnrelatedStagedChanges,
  gitRefExists,
  getCurrentBranch,
  getGitRoot,
  getHeadCommit,
  initGitRepo,
  listTags,
  stagePaths,
  toGitRelativePath,
} from "./git.js";
import { pathExists } from "./fs-utils.js";
import {
  compareSemverDescending,
  formatSkillRef,
  parseSemverLike,
  resolveInside,
  validateSkillName,
} from "./utils.js";
import {
  parseGitHubTreeUrl,
  splitGitHubTreeRefAndPath,
} from "./source-spec.js";

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

export async function buryInit(options?: { directory?: string; cwd?: string }) {
  const cwd = options?.cwd ?? process.cwd();
  const registryDir = options?.directory
    ? path.resolve(cwd, options.directory)
    : cwd;

  await fs.mkdir(registryDir, { recursive: true });
  await initGitRepo(registryDir);
  await GitBundleRegistryBackend.init(registryDir);

  return {
    registryDir,
  };
}

export async function burySkill(options: {
  sourceGitUrl: string;
  registry?: string;
  path?: string;
  ref?: string;
  version?: string;
  name?: string;
  commit?: boolean;
  cwd?: string;
}): Promise<BuryAddResult> {
  const cwd = options.cwd ?? process.cwd();
  const registryRoot = path.resolve(cwd, options.registry ?? ".");
  const backend = await openRegistryForWrite(registryRoot);
  const parsedGitHubTreeUrl = parseGitHubTreeUrl(options.sourceGitUrl);
  const cloneSourceUrl = parsedGitHubTreeUrl?.repoUrl ?? options.sourceGitUrl;

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

    const sourceRef = inferredRef ?? selectedTag ?? selectedRef ?? (await getCurrentBranch(cloneDir));
    const sourceCommit = await getHeadCommit(cloneDir);
    const sourceSkillRoot = inferredPath
      ? resolveInside(cloneDir, inferredPath)
      : cloneDir;

    if (!(await pathExists(sourceSkillRoot))) {
      throw new Error(`Skill path does not exist: ${inferredPath}`);
    }

    const skillMarkerPath = path.join(sourceSkillRoot, "SKILL.md");
    if (!(await pathExists(skillMarkerPath))) {
      throw new Error(`Selected skill directory does not contain SKILL.md`);
    }

    const skillName =
      options.name ?? deriveDefaultSkillName(options.sourceGitUrl, inferredPath);
    validateSkillName(skillName);
    const version = options.version ?? selectedTag ?? sourceCommit;
    const sourcePath = inferredPath ?? ".";

    const result = await backend.publishVersion({
      skillName,
      version,
      sourceDir: sourceSkillRoot,
      sourceUrl: options.sourceGitUrl,
      sourcePath,
      sourceRef,
      sourceCommit,
    });

    if (options.commit) {
      const gitRoot = await getGitRoot(registryRoot);
      const allowedPaths = [
        await toGitRelativePath(gitRoot, result.indexPath),
        await toGitRelativePath(gitRoot, result.versionPath),
      ];
      await ensureNoUnrelatedStagedChanges(gitRoot, allowedPaths);
      await stagePaths(gitRoot, allowedPaths);
      await commitChanges(
        gitRoot,
        `chore(skillpup-registry): bury ${formatSkillRef(skillName, version)}`
      );
    }

    return result;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}
