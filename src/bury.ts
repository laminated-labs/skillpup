import fs from "node:fs/promises";
import path from "node:path";
import type { ArtifactKind, BuryAddResult, RefreshResult } from "./types.js";
import { openRegistryForWrite, GitBundleRegistryBackend } from "./git-bundle-backend.js";
import {
  commitChanges,
  ensureNoUnrelatedStagedChanges,
  getGitRoot,
  initGitRepo,
  stagePaths,
  toGitRelativePath,
} from "./git.js";
import { pathExists } from "./fs-utils.js";
import {
  canonicalRegistryPath,
  formatArtifactRef,
  resolveInside,
  toPosix,
} from "./utils.js";
import { resolveSourceArtifact } from "./source-artifact.js";
import { findContainingRegistryRoot } from "./registry-root.js";

function inferBuriedVersionFromTarget(targetPath: string, registryRoot: string) {
  let currentPath = path.resolve(targetPath);

  while (true) {
    const relativePath = toPosix(path.relative(registryRoot, currentPath));
    const match = relativePath.match(
      /^(skills|subagents)\/([^/]+)\/versions\/([^/]+)(?:\/(skill|subagent)(?:\/.*)?)?$/
    );
    if (match) {
      const [, kindDirectoryName, skillName, version] = match;
      const kind: ArtifactKind =
        kindDirectoryName === "subagents" ? "subagent" : "skill";
      return {
        kind,
        skillName,
        version,
        versionPath: resolveInside(
          registryRoot,
          canonicalRegistryPath(skillName, version, kind)
        ),
      };
    }

    if (currentPath === registryRoot) {
      break;
    }
    currentPath = path.dirname(currentPath);
  }

  throw new Error(
    `Target is not inside a buried artifact version: ${targetPath}`
  );
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
  const resolvedSource = await resolveSourceArtifact({
    sourceGitUrl: options.sourceGitUrl,
    path: options.path,
    ref: options.ref,
    name: options.name,
    cwd,
  });

  try {
    const version = options.version ?? resolvedSource.selectedTag ?? resolvedSource.sourceCommit;

    const result = await backend.publishVersion({
      kind: resolvedSource.kind,
      name: resolvedSource.name,
      version,
      sourceDir: resolvedSource.sourceDir,
      sourceUrl: resolvedSource.storedSourceUrl,
      sourcePath: resolvedSource.sourcePath,
      sourceRef: resolvedSource.sourceRef,
      sourceCommit: resolvedSource.sourceCommit,
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
        `chore(skillpup-registry): bury ${formatArtifactRef(
          resolvedSource.name,
          version,
          resolvedSource.kind
        )}`
      );
    }

    return result;
  } finally {
    await resolvedSource.cleanup();
  }
}

export async function refreshBuriedSkill(options: {
  targetPath: string;
  registry?: string;
  commit?: boolean;
  cwd?: string;
}): Promise<RefreshResult> {
  const cwd = options.cwd ?? process.cwd();
  const absoluteTargetPath = path.resolve(cwd, options.targetPath);
  if (!(await pathExists(absoluteTargetPath))) {
    throw new Error(`Target path does not exist: ${options.targetPath}`);
  }

  const registryRoot = options.registry
    ? path.resolve(cwd, options.registry)
    : await findContainingRegistryRoot(absoluteTargetPath);
  if (!registryRoot) {
    throw new Error(
      `Unable to find a skillpup registry for ${options.targetPath}. Pass --registry explicitly.`
    );
  }

  const backend = await openRegistryForWrite(registryRoot);
  const target = inferBuriedVersionFromTarget(absoluteTargetPath, registryRoot);
  const result = await backend.refreshVersion(
    target.kind,
    target.skillName,
    target.version
  );

  if (options.commit && result.digestChanged) {
    const gitRoot = await getGitRoot(registryRoot);
    const allowedPaths = [
      await toGitRelativePath(gitRoot, result.indexPath),
      await toGitRelativePath(gitRoot, result.versionPath),
    ];
    await ensureNoUnrelatedStagedChanges(gitRoot, allowedPaths);
    await stagePaths(gitRoot, allowedPaths);
    await commitChanges(
      gitRoot,
      `chore(skillpup-registry): refresh ${formatArtifactRef(
        result.metadata.name,
        result.metadata.version,
        result.metadata.kind
      )}`
    );
  }

  return result;
}
