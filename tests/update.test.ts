import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listRemoteRefs } from "../src/git.js";
import type { SkillpupConfig, SkillpupLockfile } from "../src/types.js";
import {
  commitAll,
  createSkillRepo,
  fileExists,
  initTestRepo,
  makeTempDir,
  readYamlFile,
  runCli,
  runGitCapture,
} from "./helpers.js";

const TEST_TIMEOUT = 120_000;

async function setupConsumerUpdateScenario(rootDir: string, name: string) {
  const registryDir = path.join(rootDir, `${name}-registry`);
  await runCli(rootDir, ["bury", "init", registryDir]);
  await initTestRepo(registryDir);

  const source = await createSkillRepo({
    skillName: "reviewer",
    versions: ["v1.0.0", "v1.1.0"],
  });

  await runCli(rootDir, [
    "bury",
    source.repoDir,
    "--ref",
    "v1.0.0",
    "--version",
    "v1.0.0",
    "--registry",
    registryDir,
  ]);

  const consumerDir = path.join(rootDir, `${name}-consumer`);
  await initTestRepo(consumerDir);
  await runCli(consumerDir, ["fetch", "reviewer", "--registry", registryDir]);

  await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

  return { registryDir, consumerDir, source };
}

describe("skillpup update flows", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir("skillpup-update-");
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it(
    "lists remote heads and tags for a local git source",
    async () => {
      const source = await createSkillRepo({
        skillName: "remote-probe",
        versions: ["v1.0.0"],
      });

      const refs = await listRemoteRefs(source.repoDir);
      expect(refs.some((entry) => entry.ref === "refs/heads/main")).toBe(true);
      expect(refs.some((entry) => entry.ref === "refs/tags/v1.0.0")).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "reports newer registry versions for configured project artifacts",
    async () => {
      const { consumerDir } = await setupConsumerUpdateScenario(rootDir, "project-check");

      const result = await runCli(consumerDir, ["update"]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Project updates available:");
      expect(result.stdout).toContain("reviewer@v1.1.0 from v1.0.0");
    },
    TEST_TIMEOUT
  );

  it(
    "applies selected project updates through fetch",
    async () => {
      const { registryDir, consumerDir } = await setupConsumerUpdateScenario(
        rootDir,
        "project-apply"
      );

      const result = await runCli(consumerDir, [
        "update",
        "reviewer",
        "--apply",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Updated reviewer@v1.1.0");

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      const lockfile = await readYamlFile<SkillpupLockfile>(
        path.join(consumerDir, "skillpup.lock.yaml")
      );
      expect(config.skills).toEqual([{ name: "reviewer", version: "v1.1.0" }]);
      expect(lockfile.skills[0]?.version).toBe("v1.1.0");
      expect(
        await fs.readFile(
          path.join(consumerDir, ".agents/skills/reviewer/template.txt"),
          "utf8"
        )
      ).toBe("template-v1.1.0\n");
    },
    TEST_TIMEOUT
  );

  it(
    "surfaces and applies same-version digest refreshes for project artifacts",
    async () => {
      const registryDir = path.join(rootDir, "project-refresh-registry");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "guardian",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "project-refresh-consumer");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "guardian", "--registry", registryDir]);

      const lockfilePath = path.join(consumerDir, "skillpup.lock.yaml");
      const previousLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      const bundledFilePath = path.join(
        registryDir,
        "skills/guardian/versions/v1.0.0/skill/template.txt"
      );
      await fs.writeFile(bundledFilePath, "template-v1.0.0-refreshed\n", "utf8");
      await runCli(rootDir, ["bury", "refresh", bundledFilePath]);

      let result = await runCli(consumerDir, ["update"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("registry digest changed");

      result = await runCli(consumerDir, ["update", "guardian", "--apply"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Updated guardian@v1.0.0");

      const updatedLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      expect(updatedLockfile.skills[0]?.digest).not.toBe(previousLockfile.skills[0]?.digest);
      expect(
        await fs.readFile(
          path.join(consumerDir, ".agents/skills/guardian/template.txt"),
          "utf8"
        )
      ).toBe("template-v1.0.0-refreshed\n");
    },
    TEST_TIMEOUT
  );

  it(
    "fails non-interactive project apply without explicit selectors or --all",
    async () => {
      const { consumerDir } = await setupConsumerUpdateScenario(
        rootDir,
        "project-noninteractive"
      );

      const result = await runCli(consumerDir, ["update", "--apply"]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot prompt for project updates");
    },
    TEST_TIMEOUT
  );

  it(
    "checks and publishes newer semver tags into a registry",
    async () => {
      const registryDir = path.join(rootDir, "registry-semver");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "curator",
        versions: ["v1.0.0", "v1.1.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--ref",
        "v1.0.0",
        "--version",
        "v1.0.0",
        "--registry",
        registryDir,
      ]);

      let result = await runCli(rootDir, ["bury", "update", "--registry", registryDir]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Registry updates available:");
      expect(result.stdout).toContain("curator@v1.1.0 from v1.0.0");

      result = await runCli(rootDir, [
        "bury",
        "update",
        "curator",
        "--apply",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Published curator@v1.1.0");
      expect(
        await fileExists(
          path.join(registryDir, "skills/curator/versions/v1.1.0/skill/SKILL.md")
        )
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "publishes new commits for branch-tracked registry artifacts",
    async () => {
      const registryDir = path.join(rootDir, "registry-branch");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const sourceDir = path.join(rootDir, "branch-source");
      await initTestRepo(sourceDir);
      await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# brancher\n\nVersion 1\n", "utf8");
      await fs.writeFile(path.join(sourceDir, "template.txt"), "template-1\n", "utf8");
      await commitAll(sourceDir, "initial");
      const initialCommit = await runGitCapture(["rev-parse", "HEAD"], sourceDir);

      await runCli(rootDir, [
        "bury",
        sourceDir,
        "--ref",
        "main",
        "--registry",
        registryDir,
      ]);

      await fs.writeFile(path.join(sourceDir, "SKILL.md"), "# brancher\n\nVersion 2\n", "utf8");
      await fs.writeFile(path.join(sourceDir, "template.txt"), "template-2\n", "utf8");
      await commitAll(sourceDir, "second");
      const updatedCommit = await runGitCapture(["rev-parse", "HEAD"], sourceDir);

      let result = await runCli(rootDir, [
        "bury",
        "update",
        "branch-source",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(updatedCommit);
      expect(result.stdout).toContain(`from ${initialCommit}`);

      result = await runCli(rootDir, [
        "bury",
        "update",
        "branch-source",
        "--apply",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain(`Published branch-source@${updatedCommit}`);
      expect(
        await fileExists(
          path.join(registryDir, "skills/branch-source/versions", updatedCommit, "skill/SKILL.md")
        )
      ).toBe(true);
    },
    TEST_TIMEOUT
  );
});
