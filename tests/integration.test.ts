import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SkillpupConfig, SkillpupLockfile } from "../src/types.js";
import {
  commitAll,
  createSkillRepo,
  fileExists,
  initTestRepo,
  makeTempDir,
  readYamlFile,
  runCli,
  runGit,
  runGitCapture,
} from "./helpers.js";

const TEST_TIMEOUT = 120_000;

describe("skillpup integration", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir("skillpup-integration-");
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it(
    "initializes a registry scaffold",
    async () => {
      const registryDir = path.join(rootDir, "registry-init");
      const result = await runCli(rootDir, ["bury", "init", registryDir]);

      expect(result.exitCode).toBe(0);
      expect(await fileExists(path.join(registryDir, "skillpup-registry.yaml"))).toBe(
        true
      );
      expect(await fileExists(path.join(registryDir, "README.md"))).toBe(true);
      expect(await fileExists(path.join(registryDir, "skills"))).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "buries a root skill and fetches the highest semver version into a consumer repo",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.2.0", "v1.10.0"],
      });

      let result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--ref",
        "v1.2.0",
        "--version",
        "v1.2.0",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const consumerDir = path.join(rootDir, "consumer-fetch");
      await initTestRepo(consumerDir);

      result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      const lockfile = await readYamlFile<SkillpupLockfile>(
        path.join(consumerDir, "skillpup.lock.yaml")
      );

      expect(config.skills[0]).toEqual({
        name: "reviewer",
        version: "v1.10.0",
      });
      expect(lockfile.skills[0]?.version).toBe("v1.10.0");
      expect(
        await fileExists(path.join(consumerDir, ".agent/skills/reviewer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "supports burying a nested skill via --path",
    async () => {
      const registryDir = path.join(rootDir, "registry-nested");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        skillPath: "skills/reviewer",
        versions: ["v2.0.0"],
      });

      const result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--path",
        "skills/reviewer",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(
          path.join(
            registryDir,
            "skills/reviewer/versions/v2.0.0/skill/SKILL.md"
          )
        )
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "reconstructs the install directory on repeated fetches",
    async () => {
      const registryDir = path.join(rootDir, "registry-reconstruct");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "formatter",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-reconstruct");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "formatter", "--registry", registryDir]);

      await fs.rm(path.join(consumerDir, ".agent/skills"), {
        recursive: true,
        force: true,
      });
      const result = await runCli(consumerDir, ["fetch"]);

      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(path.join(consumerDir, ".agent/skills/formatter/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "commits only config and lockfile on fetch --commit",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-commit");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "writer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-fetch-commit");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, ".gitignore"), ".agent/\n", "utf8");
      await commitAll(consumerDir, "initial");

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--registry",
        registryDir,
        "--commit",
      ]);
      expect(result.exitCode).toBe(0);

      const subject = await runGitCapture(["log", "-1", "--pretty=%s"], consumerDir);
      const files = await runGitCapture(
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        consumerDir
      );

      expect(subject).toBe("chore(skillpup): fetch writer@v1.0.0");
      expect(files.split("\n").filter(Boolean)).toEqual([
        "skillpup.config.yaml",
        "skillpup.lock.yaml",
      ]);
      expect(
        await fileExists(path.join(consumerDir, ".agent/skills/writer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "commits registry files on bury --commit",
    async () => {
      const registryDir = path.join(rootDir, "registry-bury-commit");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);
      await fs.writeFile(path.join(registryDir, ".gitignore"), "\n", "utf8");
      await commitAll(registryDir, "initial");

      const source = await createSkillRepo({
        skillName: "critic",
        versions: ["v1.0.0"],
      });

      const result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
        "--commit",
      ]);
      expect(result.exitCode).toBe(0);

      const subject = await runGitCapture(["log", "-1", "--pretty=%s"], registryDir);
      expect(subject).toBe("chore(skillpup-registry): bury critic@v1.0.0");
    },
    TEST_TIMEOUT
  );

  it(
    "fails fetch --commit when unrelated staged changes exist",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-fail");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "auditor",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-fetch-fail");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, "notes.txt"), "staged\n", "utf8");
      await runGit(["add", "notes.txt"], consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "auditor",
        "--registry",
        registryDir,
        "--commit",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("unrelated staged changes");
    },
    TEST_TIMEOUT
  );

  it(
    "fails on digest mismatch when the registry mutates after locking",
    async () => {
      const registryDir = path.join(rootDir, "registry-digest");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "guardian",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-digest");
      await initTestRepo(consumerDir);
      let result = await runCli(consumerDir, [
        "fetch",
        "guardian",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const metadataPath = path.join(
        registryDir,
        "skills/guardian/versions/v1.0.0/metadata.yaml"
      );
      const metadataContents = await fs.readFile(metadataPath, "utf8");
      await fs.writeFile(
        metadataPath,
        metadataContents.replace("sha256:", "sha256:tampered-"),
        "utf8"
      );

      result = await runCli(consumerDir, ["fetch"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Digest mismatch");
    },
    TEST_TIMEOUT
  );

  it(
    "fails on digest mismatch when bundled file permissions change after locking",
    async () => {
      const registryDir = path.join(rootDir, "registry-digest-mode");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "warden",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-digest-mode");
      await initTestRepo(consumerDir);
      let result = await runCli(consumerDir, [
        "fetch",
        "warden",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const bundledFilePath = path.join(
        registryDir,
        "skills/warden/versions/v1.0.0/skill/template.txt"
      );
      await fs.chmod(bundledFilePath, 0o600);

      result = await runCli(consumerDir, ["fetch"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toMatch(/digest mismatch/i);
    },
    TEST_TIMEOUT
  );
});
