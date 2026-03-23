import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createSkillRepo, makeTempDir, runGit } from "./helpers.js";

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

  it("builds a hosted lookup path for remote GitHub tree URLs", async () => {
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
      expect(resolved.hostedLookup).toEqual({
        forge: "github",
        owner: "openai",
        repo: "Skills",
        repoFullName: "openai/Skills",
        skillFilePath: "skills/reviewer/SKILL.md",
      });
    } finally {
      await resolved.cleanup();
    }
  });

  it("builds a hosted lookup path for remote Bitbucket source-view URLs", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      skillPath: "skills/reviewer",
      versions: ["v1.0.0"],
    });
    cloneState.sourceRepoDir = source.repoDir;

    const resolved = await resolveSourceArtifact({
      sourceGitUrl: "https://bitbucket.org/openai/Skills/src/main/skills/reviewer",
      cwd: path.dirname(source.repoDir),
    });

    try {
      expect(resolved.name).toBe("reviewer");
      expect(resolved.sourcePath).toBe("skills/reviewer");
      expect(resolved.hostedLookup).toEqual({
        forge: "bitbucket-cloud",
        owner: "openai",
        repo: "Skills",
        repoFullName: "openai/Skills",
        skillFilePath: "skills/reviewer/SKILL.md",
      });
    } finally {
      await resolved.cleanup();
    }
  });

  it("derives repo-root GitHub tree URL names from the repo slug", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      versions: ["v1.0.0"],
    });
    cloneState.sourceRepoDir = source.repoDir;

    const resolved = await resolveSourceArtifact({
      sourceGitUrl: "https://github.com/openai/reviewer/tree/main",
      cwd: path.dirname(source.repoDir),
    });

    try {
      expect(resolved.name).toBe("reviewer");
      expect(resolved.sourcePath).toBe(".");
      expect(resolved.hostedLookup?.skillFilePath).toBe("SKILL.md");
    } finally {
      await resolved.cleanup();
    }
  });

  it("derives repo-root Bitbucket source-view URL names from the repo slug", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      versions: ["v1.0.0"],
    });
    cloneState.sourceRepoDir = source.repoDir;

    const resolved = await resolveSourceArtifact({
      sourceGitUrl: "https://bitbucket.org/openai/reviewer/src/main",
      cwd: path.dirname(source.repoDir),
    });

    try {
      expect(resolved.name).toBe("reviewer");
      expect(resolved.sourcePath).toBe(".");
      expect(resolved.hostedLookup).toEqual({
        forge: "bitbucket-cloud",
        owner: "openai",
        repo: "reviewer",
        repoFullName: "openai/reviewer",
        skillFilePath: "SKILL.md",
      });
    } finally {
      await resolved.cleanup();
    }
  });

  it("builds a hosted lookup from a local repo with a Bitbucket Cloud origin", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      versions: ["v1.0.0"],
    });
    await runGit(
      ["remote", "add", "origin", "git@bitbucket.org:example/reviewer.git"],
      source.repoDir
    );

    const resolved = await resolveSourceArtifact({
      sourceGitUrl: source.repoDir,
      cwd: path.dirname(source.repoDir),
      useWorkingTreeIfLocal: true,
    });

    try {
      expect(resolved.name).toBe("reviewer");
      expect(resolved.hostedLookup).toEqual({
        forge: "bitbucket-cloud",
        owner: "example",
        repo: "reviewer",
        repoFullName: "example/reviewer",
        skillFilePath: "SKILL.md",
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

  it("treats Windows absolute paths as local working-tree sources", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      versions: ["v1.0.0"],
    });
    cloneState.sourceRepoDir = source.repoDir;

    await expect(
      resolveSourceArtifact({
        sourceGitUrl: "C:\\missing-repo",
        cwd: rootDir,
        useWorkingTreeIfLocal: true,
      })
    ).rejects.toThrow("Artifact path does not exist: C:\\missing-repo");
  });
});
