import fs from "node:fs/promises";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execa } from "execa";
import { parse } from "yaml";

export async function makeTempDir(prefix: string) {
  return mkdtemp(path.join(tmpdir(), prefix));
}

export async function fileExists(targetPath: string) {
  try {
    await stat(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function readYamlFile<T>(filePath: string): Promise<T> {
  const contents = await fs.readFile(filePath, "utf8");
  return parse(contents) as T;
}

export async function runGit(args: string[], cwd: string) {
  await execa("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
}

export async function runGitCapture(args: string[], cwd: string) {
  const result = await execa("git", args, {
    cwd,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  return result.stdout.trim();
}

export async function initTestRepo(repoDir: string) {
  await fs.mkdir(repoDir, { recursive: true });
  await runGit(["init", "-b", "main"], repoDir).catch(async () => {
    await runGit(["init"], repoDir);
    await runGit(["branch", "-M", "main"], repoDir);
  });
  await runGit(["config", "user.name", "Skillpup Tests"], repoDir);
  await runGit(["config", "user.email", "skillpup@example.com"], repoDir);
}

export async function commitAll(repoDir: string, message: string) {
  await runGit(["add", "."], repoDir);
  await runGit(["commit", "--no-gpg-sign", "-m", message], repoDir);
}

export async function createSkillRepo(options: {
  skillName: string;
  skillPath?: string;
  versions: string[];
}) {
  const parentDir = await makeTempDir("skillpup-skill-repo-");
  const repoDir = path.join(parentDir, options.skillName);
  await initTestRepo(repoDir);

  const skillPath = options.skillPath ?? ".";
  const absoluteSkillPath =
    skillPath === "."
      ? repoDir
      : path.join(repoDir, skillPath);

  for (const version of options.versions) {
    await fs.mkdir(absoluteSkillPath, { recursive: true });
    await fs.writeFile(
      path.join(absoluteSkillPath, "SKILL.md"),
      `# ${options.skillName}\n\nVersion ${version}\n`,
      "utf8"
    );
    await fs.writeFile(
      path.join(absoluteSkillPath, "template.txt"),
      `template-${version}\n`,
      "utf8"
    );
    await commitAll(repoDir, `release ${version}`);
    await runGit(["tag", version], repoDir);
  }

  return {
    repoDir,
    skillPath,
  };
}

export async function runCli(cwd: string, args: string[]) {
  const cliPath = path.resolve(process.cwd(), "dist/cli.js");
  try {
    const result = await execa("node", [cliPath, ...args], {
      cwd,
      env: {
        ...process.env,
        FORCE_COLOR: "0",
      },
    });
    return {
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: 0,
    };
  } catch (error) {
    const failure = error as {
      stdout?: string;
      stderr?: string;
      exitCode?: number;
    };
    return {
      stdout: failure.stdout ?? "",
      stderr: failure.stderr ?? "",
      exitCode: failure.exitCode ?? 1,
    };
  }
}
