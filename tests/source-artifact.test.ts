import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSkillRepo, makeTempDir } from "./helpers.js";

const cloneState = vi.hoisted(() => ({
  sourceRepoDir: "",
}));

vi.mock("../src/git.js", async () => {
  const actual = await vi.importActual<typeof import("../src/git.js")>("../src/git.js");
  return {
    ...actual,
    cloneRepo: async (_repoUrl: string, destination: string) =>
      actual.cloneRepo(cloneState.sourceRepoDir, destination),
  };
});

import { resolveSourceArtifact } from "../src/source-artifact.js";

describe("resolveSourceArtifact", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir("skillpup-source-artifact-");
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it("builds a GitHub lookup path for remote tree URLs", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      skillPath: "skills/reviewer",
      versions: ["v1.0.0"],
    });
    cloneState.sourceRepoDir = source.repoDir;

    const resolved = await resolveSourceArtifact({
      sourceGitUrl: "https://github.com/openai/Skills/tree/main/skills/reviewer",
      cwd: path.dirname(source.repoDir),
    });

    try {
      expect(resolved.name).toBe("reviewer");
      expect(resolved.sourcePath).toBe("skills/reviewer");
      expect(resolved.githubLookup).toEqual({
        owner: "openai",
        repo: "Skills",
        repoFullName: "openai/Skills",
        skillFilePath: "skills/reviewer/SKILL.md",
      });
    } finally {
      await resolved.cleanup();
    }
  });

  it("reports the missing working-tree source path in the error", async () => {
    const missingRepoPath = path.join(rootDir, "missing-repo");

    await expect(
      resolveSourceArtifact({
        sourceGitUrl: missingRepoPath,
        cwd: rootDir,
        useWorkingTreeIfLocal: true,
      })
    ).rejects.toThrow(`Artifact path does not exist: ${missingRepoPath}`);
  });
});
