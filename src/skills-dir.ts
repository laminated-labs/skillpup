import path from "node:path";
import { pathExists } from "./fs-utils.js";
import { getGitRoot } from "./git.js";
import { DEFAULT_SKILLS_DIR } from "./utils.js";

const existingSkillsDirCandidates = [
  ".agents/skills",
  ".github/skills",
  ".opencode/skills",
  ".claude/skills",
  ".agent/skills",
] as const;

const repoMarkerCandidates = [
  "AGENTS.md",
  ".github/copilot-instructions.md",
  ".github/instructions",
  ".github/agents",
  "CLAUDE.md",
  ".claude/CLAUDE.md",
  ".claude/settings.json",
  ".claude/settings.local.json",
  ".claude/agents",
  ".opencode",
] as const;

async function resolveWalkBounds(baseDir: string) {
  const startDir = path.resolve(baseDir);
  const gitRoot = await getGitRoot(baseDir).catch(() => null);
  return {
    startDir,
    stopDir: gitRoot ? path.resolve(gitRoot) : path.parse(startDir).root,
  };
}

function* walkUp(startDir: string, stopDir: string) {
  let currentDir = startDir;
  const normalizedStopDir = path.resolve(stopDir);

  for (;;) {
    yield currentDir;
    if (currentDir === normalizedStopDir) {
      return;
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return;
    }
    currentDir = parentDir;
  }
}

export async function resolveSkillsDir(baseDir: string) {
  const { startDir, stopDir } = await resolveWalkBounds(baseDir);

  for (const currentDir of walkUp(startDir, stopDir)) {
    for (const candidate of existingSkillsDirCandidates) {
      if (await pathExists(path.join(currentDir, candidate))) {
        return candidate;
      }
    }

    for (const candidate of repoMarkerCandidates) {
      if (await pathExists(path.join(currentDir, candidate))) {
        return DEFAULT_SKILLS_DIR;
      }
    }
  }

  return DEFAULT_SKILLS_DIR;
}
