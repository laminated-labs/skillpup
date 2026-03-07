import fs from "node:fs/promises";
import path from "node:path";
import {
  getGitCheckIgnoreVerboseLines,
  getGitRoot,
  toGitRelativePath,
} from "./git.js";
import { toPosix } from "./utils.js";

const PROBE_SKILL_NAME = "skillpup-ignore-probe";
const PROBE_FILE_NAME = "SKILL.md";

type GitignoreUpdateResult = {
  gitignorePath: string | null;
  changed: boolean;
};

function normalizeGitRelativePath(input: string) {
  const normalized = toPosix(input)
    .replace(/^\.\/+/, "")
    .replace(/^\/+/, "")
    .replace(/\/+$/, "");

  if (!normalized) {
    throw new Error("Cannot build a .gitignore rule for the repository root.");
  }

  return normalized;
}

function buildCanonicalDirectoryEntry(gitRelativePath: string) {
  return `/${normalizeGitRelativePath(gitRelativePath)}/`;
}

function buildIgnoreProbePaths(gitRelativePath: string) {
  const normalized = normalizeGitRelativePath(gitRelativePath);
  return [
    normalized,
    path.posix.join(normalized, PROBE_SKILL_NAME, PROBE_FILE_NAME),
  ];
}

function parseVerboseSource(line: string) {
  const tabIndex = line.indexOf("\t");
  const metadata = tabIndex >= 0 ? line.slice(0, tabIndex) : line;
  const match = metadata.match(/^(.*):\d+:.+$/);
  return match?.[1] ?? null;
}

function isPathInside(rootDir: string, candidatePath: string) {
  const relative = path.relative(rootDir, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function isRepoGitignoreSource(gitRoot: string, sourcePath: string | null) {
  if (!sourcePath || path.basename(sourcePath) !== ".gitignore") {
    return false;
  }

  const absoluteSourcePath = path.isAbsolute(sourcePath)
    ? sourcePath
    : path.resolve(gitRoot, sourcePath);

  return isPathInside(gitRoot, absoluteSourcePath);
}

function detectLineEnding(contents: string) {
  return contents.includes("\r\n") ? "\r\n" : "\n";
}

async function readFileIfExists(filePath: string) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    const nodeError = error as NodeJS.ErrnoException;
    if (nodeError.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

export async function ensureDirectoryIgnoredInRepo(
  targetDirectory: string,
  cwd: string
): Promise<GitignoreUpdateResult> {
  const gitRoot = await getGitRoot(cwd).catch(() => null);
  if (!gitRoot) {
    return {
      gitignorePath: null,
      changed: false,
    };
  }

  const gitignorePath = path.join(gitRoot, ".gitignore");
  const gitRelativePath = normalizeGitRelativePath(
    await toGitRelativePath(gitRoot, targetDirectory)
  );

  const matchingLines = await getGitCheckIgnoreVerboseLines(
    gitRoot,
    buildIgnoreProbePaths(gitRelativePath)
  );
  if (matchingLines.some((line) => isRepoGitignoreSource(gitRoot, parseVerboseSource(line)))) {
    return {
      gitignorePath,
      changed: false,
    };
  }

  const entry = buildCanonicalDirectoryEntry(gitRelativePath);
  const existingContents = await readFileIfExists(gitignorePath);
  const lineEnding = existingContents ? detectLineEnding(existingContents) : "\n";
  const needsSeparator =
    existingContents && existingContents.length > 0 && !existingContents.endsWith("\n");
  const nextContents = existingContents
    ? `${existingContents}${needsSeparator ? lineEnding : ""}${entry}${lineEnding}`
    : `${entry}\n`;

  await fs.writeFile(gitignorePath, nextContents, "utf8");

  return {
    gitignorePath,
    changed: true,
  };
}
