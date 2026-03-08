import fs from "node:fs/promises";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fetchSkills } from "../src/fetch.js";
import {
  buildRegistrySkillChoiceValue,
  type FetchPrompts,
} from "../src/fetch-prompts.js";
import type { SkillpupConfig } from "../src/types.js";
import {
  createSkillRepo,
  fileExists,
  initTestRepo,
  makeTempDir,
  readYamlFile,
  runCli,
} from "./helpers.js";

const TEST_TIMEOUT = 120_000;

describe("skillpup generate mode", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir("skillpup-generate-");
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it(
    "bootstraps config and fetches all registry skills with --generate --all",
    async () => {
      const registryDir = path.join(rootDir, "registry-generate-all");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const reviewer = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0", "v1.2.0"],
      });
      const writer = await createSkillRepo({
        skillName: "writer",
        versions: ["v2.0.0"],
      });

      await runCli(rootDir, ["bury", reviewer.repoDir, "--registry", registryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-all");
      await initTestRepo(consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "--generate",
        "--all",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Fetched reviewer@v1.2.0, writer@v2.0.0");

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skills).toEqual([
        { name: "reviewer", version: "v1.2.0" },
        { name: "writer", version: "v2.0.0" },
      ]);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/writer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "fails in non-interactive mode when generate needs a selection",
    async () => {
      const registryDir = path.join(rootDir, "registry-generate-noninteractive");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-noninteractive");
      await initTestRepo(consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "--generate",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Cannot prompt for registry skills");
    },
    TEST_TIMEOUT
  );

  it(
    "does not rewrite an existing config registry when generate uses an override",
    async () => {
      const primaryRegistryDir = path.join(rootDir, "registry-generate-primary");
      await runCli(rootDir, ["bury", "init", primaryRegistryDir]);
      await initTestRepo(primaryRegistryDir);

      const secondaryRegistryDir = path.join(rootDir, "registry-generate-secondary");
      await runCli(rootDir, ["bury", "init", secondaryRegistryDir]);
      await initTestRepo(secondaryRegistryDir);

      const reviewer = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const writer = await createSkillRepo({
        skillName: "writer",
        versions: ["v1.0.0"],
      });

      await runCli(rootDir, ["bury", reviewer.repoDir, "--registry", primaryRegistryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", primaryRegistryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", secondaryRegistryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-registry-override");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "reviewer", "--registry", primaryRegistryDir]);

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--generate",
        "--replace",
        "--registry",
        secondaryRegistryDir,
      ]);

      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.registry.url).toBe(primaryRegistryDir);
      expect(config.skills).toEqual([{ name: "writer", version: "v1.0.0" }]);
    },
    TEST_TIMEOUT
  );

  it(
    "merges explicit generated skills into an existing config",
    async () => {
      const registryDir = path.join(rootDir, "registry-generate-merge");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const reviewer = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const writer = await createSkillRepo({
        skillName: "writer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", reviewer.repoDir, "--registry", registryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-merge");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "reviewer", "--registry", registryDir]);

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--generate",
        "--merge",
      ]);

      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skills).toEqual([
        { name: "reviewer", version: "v1.0.0" },
        { name: "writer", version: "v1.0.0" },
      ]);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/writer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "replaces an existing config selection when --replace is used",
    async () => {
      const registryDir = path.join(rootDir, "registry-generate-replace");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const reviewer = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const writer = await createSkillRepo({
        skillName: "writer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", reviewer.repoDir, "--registry", registryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-replace");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "reviewer", "--registry", registryDir]);

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--generate",
        "--replace",
      ]);

      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skills).toEqual([{ name: "writer", version: "v1.0.0" }]);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(false);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/writer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "preserves pinned configured versions in default replace selections",
    async () => {
      expect(
        buildRegistrySkillChoiceValue(
          {
            name: "reviewer",
            version: "v2.0.0",
            configured: true,
            configuredVersion: "v1.0.0",
          },
          "replace"
        )
      ).toBe("reviewer@v1.0.0");
      expect(
        buildRegistrySkillChoiceValue(
          {
            name: "writer",
            version: "v1.0.0",
            configured: false,
          },
          "replace"
        )
      ).toBe("writer");
    },
    TEST_TIMEOUT
  );

  it(
    "uses injected prompts to drive interactive generate mode",
    async () => {
      const registryDir = path.join(rootDir, "registry-generate-prompts");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const reviewer = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const writer = await createSkillRepo({
        skillName: "writer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", reviewer.repoDir, "--registry", registryDir]);
      await runCli(rootDir, ["bury", writer.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-generate-prompts");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, ["fetch", "reviewer", "--registry", registryDir]);

      const prompts: FetchPrompts = {
        selectSkillsToGenerate: vi.fn().mockResolvedValue(["writer"]),
        chooseGenerateMergeStrategy: vi.fn().mockResolvedValue("merge"),
      };

      await fetchSkills({
        cwd: consumerDir,
        generate: true,
        isInteractive: true,
        prompts,
      });

      expect(prompts.chooseGenerateMergeStrategy).toHaveBeenCalledTimes(1);
      expect(prompts.selectSkillsToGenerate).toHaveBeenCalledTimes(1);
      expect(prompts.selectSkillsToGenerate).toHaveBeenCalledWith({
        availableSkills: expect.arrayContaining([
          expect.objectContaining({
            name: "reviewer",
            configured: true,
            configuredVersion: "v1.0.0",
          }),
        ]),
        mergeStrategy: "merge",
      });

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skills).toEqual([
        { name: "reviewer", version: "v1.0.0" },
        { name: "writer", version: "v1.0.0" },
      ]);
    },
    TEST_TIMEOUT
  );
});
