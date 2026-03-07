import fs from "node:fs/promises";
import path from "node:path";
import { execa } from "execa";

const gitEnv = {
  ...process.env,
  GIT_TERMINAL_PROMPT: "0",
};

export async function runGit(
  args: string[],
  cwd: string,
  options?: { env?: NodeJS.ProcessEnv }
) {
  await execa("git", args, {
    cwd,
    env: { ...gitEnv, ...options?.env },
    stdin: "ignore",
  });
}

export async function runGitCapture(
  args: string[],
  cwd: string,
  options?: { env?: NodeJS.ProcessEnv }
) {
  const result = await execa("git", args, {
    cwd,
    env: { ...gitEnv, ...options?.env },
    stdin: "ignore",
  });
  return result.stdout.trim();
}

export async function initGitRepo(cwd: string) {
  try {
    await runGit(["init", "-b", "main"], cwd);
  } catch {
    await runGit(["init"], cwd);
    await runGit(["branch", "-M", "main"], cwd);
  }
}

export async function cloneRepo(repoUrl: string, destination: string) {
  await runGit(["clone", "--quiet", repoUrl, destination], process.cwd());
}

export async function checkoutRef(cwd: string, ref: string) {
  await runGit(["checkout", "--quiet", ref], cwd);
}

export async function listTags(cwd: string) {
  const output = await runGitCapture(["tag", "--list"], cwd);
  if (!output) {
    return [];
  }
  return output
    .split("\n")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

export async function getHeadCommit(cwd: string) {
  return runGitCapture(["rev-parse", "HEAD"], cwd);
}

export async function getCurrentBranch(cwd: string) {
  const branch = await runGitCapture(["branch", "--show-current"], cwd);
  return branch || "HEAD";
}

export async function gitRefExists(cwd: string, ref: string) {
  const candidates = [
    ref,
    `origin/${ref}`,
    `refs/tags/${ref}`,
    `refs/remotes/origin/${ref}`,
  ];

  for (const candidate of candidates) {
    try {
      await runGit(["rev-parse", "--verify", "--quiet", `${candidate}^{commit}`], cwd);
      return true;
    } catch {
      continue;
    }
  }

  return false;
}

export async function getGitRoot(cwd: string) {
  return runGitCapture(["rev-parse", "--show-toplevel"], cwd);
}

export async function getStagedPaths(cwd: string) {
  const output = await runGitCapture(["diff", "--cached", "--name-only"], cwd);
  return output
    ? output
        .split("\n")
        .map((entry) => entry.trim())
        .filter(Boolean)
    : [];
}

export async function stagePaths(cwd: string, paths: string[]) {
  if (paths.length === 0) {
    return;
  }
  await runGit(["add", "--", ...paths], cwd);
}

export async function toGitRelativePath(gitRoot: string, absolutePath: string) {
  const canonicalGitRoot = await fs.realpath(gitRoot).catch(() => gitRoot);
  const canonicalAbsolutePath = await fs
    .realpath(absolutePath)
    .catch(() => absolutePath);
  return path.relative(canonicalGitRoot, canonicalAbsolutePath);
}

export async function commitChanges(cwd: string, message: string) {
  await runGit(["commit", "--no-gpg-sign", "-m", message], cwd);
}

export async function ensureNoUnrelatedStagedChanges(
  cwd: string,
  allowedPaths: string[]
) {
  const stagedPaths = await getStagedPaths(cwd);
  const allowed = new Set(allowedPaths);
  const unrelated = stagedPaths.filter((entry) => !allowed.has(entry));
  if (unrelated.length > 0) {
    throw new Error(
      `Refusing to commit with unrelated staged changes: ${unrelated.join(", ")}`
    );
  }
}

export async function hasStagedChanges(cwd: string) {
  const output = await runGitCapture(["diff", "--cached", "--quiet"], cwd).catch(
    () => "changes"
  );
  return output === "changes";
}

export async function writeLocalGitIdentity(cwd: string) {
  await runGit(["config", "user.name", "Skillpup Tests"], cwd);
  await runGit(["config", "user.email", "skillpup@example.com"], cwd);
}

export async function ensureEmptyDir(targetPath: string) {
  await fs.rm(targetPath, { recursive: true, force: true });
  await fs.mkdir(targetPath, { recursive: true });
}
