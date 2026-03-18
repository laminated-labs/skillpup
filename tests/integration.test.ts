import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SkillpupConfig, SkillpupLockfile } from "../src/types.js";
import {
  commitAll,
  createSkillRepo,
  createSubagentRepo,
  fileExists,
  initTestRepo,
  makeTempDir,
  readYamlFile,
  runCli,
  runGit,
  runGitCapture,
} from "./helpers.js";

const TEST_TIMEOUT = 120_000;
const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version: string };

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
      expect(await fileExists(path.join(registryDir, "subagents"))).toBe(true);
    },
    TEST_TIMEOUT
  );

  it("prints the CLI version with --version", async () => {
    const result = await runCli(rootDir, ["--version"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(packageJson.version);
  });

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
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "strips top-level .git metadata when burying a repo-root skill",
    async () => {
      const registryDir = path.join(rootDir, "registry-strip-git");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "courier-skills",
        versions: ["v1.0.0"],
      });

      const result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(
          path.join(
            registryDir,
            "skills/courier-skills/versions/v1.0.0/skill/.git"
          )
        )
      ).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    "does not install nested git metadata when fetching a repo-root skill",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-no-nested-git");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "courier-skills",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-fetch-no-nested-git");
      await initTestRepo(consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "courier-skills",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(
          path.join(consumerDir, ".agents/skills/courier-skills/.git")
        )
      ).toBe(false);
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
    "buries a subagent from an explicit TOML file path",
    async () => {
      const registryDir = path.join(rootDir, "registry-subagent-bury");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
        extraToml: `model = "gpt-5.4"\n[mcp_servers.docs]\ncommand = "echo"`,
      });

      const result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--path",
        source.subagentPath,
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(0);
      const bundledPath = path.join(
        registryDir,
        "subagents/reviewer/versions/v1.0.0/subagent/reviewer.toml"
      );
      expect(await fileExists(bundledPath)).toBe(true);
      const bundledContents = await fs.readFile(bundledPath, "utf8");
      expect(bundledContents).toContain('model = "gpt-5.4"');
      expect(bundledContents).toContain("[mcp_servers.docs]");
    },
    TEST_TIMEOUT
  );

  it(
    "rejects burying a repo root that is not a skill root or direct subagent file target",
    async () => {
      const registryDir = path.join(rootDir, "registry-subagent-root-error");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });

      const result = await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        "Selected path must be a skill directory containing SKILL.md or a subagent TOML file"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "rejects burying a symlinked subagent manifest",
    async () => {
      const registryDir = path.join(rootDir, "registry-subagent-symlink-error");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const repoDir = path.join(rootDir, "subagent-symlink-source");
      await initTestRepo(repoDir);
      await fs.mkdir(path.join(repoDir, ".codex", "agents"), { recursive: true });
      await fs.writeFile(
        path.join(repoDir, "reviewer-source.toml"),
        `name = "reviewer"
description = "Version v1.0.0"
developer_instructions = "Follow reviewer v1.0.0"
`,
        "utf8"
      );
      await fs.symlink(
        "../../reviewer-source.toml",
        path.join(repoDir, ".codex", "agents", "reviewer.toml")
      );
      await commitAll(repoDir, "release v1.0.0");
      await runGit(["tag", "v1.0.0"], repoDir);

      const result = await runCli(rootDir, [
        "bury",
        repoDir,
        "--path",
        ".codex/agents/reviewer.toml",
        "--registry",
        registryDir,
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Symlinked subagent files are not supported");
    },
    TEST_TIMEOUT
  );

  it(
    "adds the effective skillsDir to the repo .gitignore on fetch",
    async () => {
      const registryDir = path.join(rootDir, "registry-gitignore-bootstrap");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-gitignore-bootstrap");
      await initTestRepo(consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/.agents/skills/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "fetches a subagent into .codex/agents and tracks it in config and lockfile",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-subagent");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--path",
        source.subagentPath,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-fetch-subagent");
      await initTestRepo(consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("subagent:reviewer@v1.0.0");

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      const lockfile = await readYamlFile<SkillpupLockfile>(
        path.join(consumerDir, "skillpup.lock.yaml")
      );

      expect(config.subagentsDir).toBe(".codex/agents");
      expect(config.subagents).toEqual([{ name: "reviewer", version: "v1.0.0" }]);
      expect(lockfile.subagents[0]?.name).toBe("reviewer");
      expect(lockfile.subagents[0]?.version).toBe("v1.0.0");
      expect(
        await fileExists(path.join(consumerDir, ".codex/agents/reviewer.toml"))
      ).toBe(true);
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toContain(
        "/.codex/agents/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "prefers the configured kind when the same name exists as both a skill and a subagent",
    async () => {
      const registryDir = path.join(rootDir, "registry-name-collision");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const skill = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const subagent = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", skill.repoDir, "--registry", registryDir]);
      await runCli(rootDir, [
        "bury",
        subagent.repoDir,
        "--path",
        subagent.subagentPath,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-name-collision");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("exists as both a skill and a subagent");

      result = await runCli(consumerDir, [
        "fetch",
        "subagent:reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      result = await runCli(consumerDir, ["fetch", "reviewer"]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("subagent:reviewer@v1.0.0");
      expect(await fileExists(path.join(consumerDir, ".codex/agents/reviewer.toml"))).toBe(
        true
      );
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    "fails instead of switching kinds when a configured artifact kind is missing from the registry",
    async () => {
      const registryDir = path.join(rootDir, "registry-configured-kind-missing");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const skill = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const subagent = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", skill.repoDir, "--registry", registryDir]);
      await runCli(rootDir, [
        "bury",
        subagent.repoDir,
        "--path",
        subagent.subagentPath,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-configured-kind-missing");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "skill:reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);

      await fs.rm(path.join(registryDir, "skills", "reviewer"), {
        recursive: true,
        force: true,
      });

      result = await runCli(consumerDir, ["fetch", "reviewer"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain(
        'Skill "reviewer" is configured for this project but was not found in the registry.'
      );
      expect(
        await fileExists(path.join(consumerDir, ".codex/agents/reviewer.toml"))
      ).toBe(false);
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

      await fs.rm(path.join(consumerDir, ".agents/skills"), {
        recursive: true,
        force: true,
      });
      const result = await runCli(consumerDir, ["fetch"]);

      expect(result.exitCode).toBe(0);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/formatter/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "fetches only explicitly named skills when config contains others",
    async () => {
      const registryDir = path.join(rootDir, "registry-partial-fetch");
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

      const consumerDir = path.join(rootDir, "consumer-partial-fetch");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "writer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const writerBundlePath = path.join(
        registryDir,
        "skills/writer/versions/v1.0.0/skill/template.txt"
      );
      await fs.writeFile(writerBundlePath, "template-v1.0.0-refreshed\n", "utf8");
      result = await runCli(rootDir, ["bury", "refresh", writerBundlePath]);
      expect(result.exitCode).toBe(0);

      result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Fetched reviewer@v1.0.0");
      expect(result.stdout).not.toContain("writer@v1.0.0");

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skills).toEqual([
        { name: "reviewer", version: "v1.0.0" },
        { name: "writer", version: "v1.0.0" },
      ]);

      const lockfile = await readYamlFile<SkillpupLockfile>(
        path.join(consumerDir, "skillpup.lock.yaml")
      );
      expect(lockfile.skills.map((entry) => entry.name).sort()).toEqual([
        "reviewer",
        "writer",
      ]);
      expect(
        await fs.readFile(
          path.join(consumerDir, ".agents/skills/writer/template.txt"),
          "utf8"
        )
      ).toBe("template-v1.0.0\n");
    },
    TEST_TIMEOUT
  );

  it(
    "commits .gitignore on fetch --commit when skillpup adds the ignore rule",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-commit-gitignore");
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

      const consumerDir = path.join(rootDir, "consumer-fetch-commit-gitignore");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, "README.md"), "# consumer\n", "utf8");
      await commitAll(consumerDir, "initial");

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--registry",
        registryDir,
        "--commit",
      ]);
      expect(result.exitCode).toBe(0);

      const files = await runGitCapture(
        ["show", "--name-only", "--pretty=format:", "HEAD"],
        consumerDir
      );

      expect(files.split("\n").filter(Boolean).sort()).toEqual(
        [".gitignore", "skillpup.config.yaml", "skillpup.lock.yaml"].sort()
      );
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
      await fs.writeFile(path.join(consumerDir, ".gitignore"), ".agents/\n", "utf8");
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
        await fileExists(path.join(consumerDir, ".agents/skills/writer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "honors repo commit signing config on fetch --commit",
    async () => {
      const registryDir = path.join(rootDir, "registry-fetch-commit-signing");
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

      const consumerDir = path.join(rootDir, "consumer-fetch-commit-signing");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, ".gitignore"), ".agents/\n", "utf8");
      await commitAll(consumerDir, "initial");

      await runGit(["config", "commit.gpgsign", "true"], consumerDir);
      await runGit(["config", "gpg.format", "openpgp"], consumerDir);
      await runGit(["config", "gpg.program", "/usr/bin/false"], consumerDir);

      const result = await runCli(consumerDir, [
        "fetch",
        "writer",
        "--registry",
        registryDir,
        "--commit",
      ]);

      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("failed to sign the data");
    },
    TEST_TIMEOUT
  );

  it(
    "preserves a legacy .agent/skills directory when bootstrapping a consumer repo",
    async () => {
      const registryDir = path.join(rootDir, "registry-legacy-dir");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-legacy-dir");
      await initTestRepo(consumerDir);
      await fs.mkdir(path.join(consumerDir, ".agent/skills"), { recursive: true });

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".agent/skills");
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/.agent/skills/\n"
      );
      expect(
        await fileExists(path.join(consumerDir, ".agent/skills/reviewer/SKILL.md"))
      ).toBe(true);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    "reuses an existing .opencode/skills directory when bootstrapping a consumer repo",
    async () => {
      const registryDir = path.join(rootDir, "registry-opencode-dir");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-opencode-dir");
      await initTestRepo(consumerDir);
      await fs.mkdir(path.join(consumerDir, ".opencode/skills"), { recursive: true });

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".opencode/skills");
      expect(
        await fileExists(path.join(consumerDir, ".opencode/skills/reviewer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "reuses an existing .github/skills directory when bootstrapping a consumer repo",
    async () => {
      const registryDir = path.join(rootDir, "registry-github-skills-dir");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-github-skills-dir");
      await initTestRepo(consumerDir);
      await fs.mkdir(path.join(consumerDir, ".github/skills"), { recursive: true });

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".github/skills");
      expect(
        await fileExists(path.join(consumerDir, ".github/skills/reviewer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "writes repo-root gitignore entries relative to nested consumer configs",
    async () => {
      const registryDir = path.join(rootDir, "registry-nested-gitignore");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-nested-gitignore");
      await initTestRepo(consumerDir);
      const packageDir = path.join(consumerDir, "packages", "app");
      await fs.mkdir(packageDir, { recursive: true });

      const result = await runCli(packageDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/packages/app/.agents/skills/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "does not duplicate the root .gitignore when a broader repo rule already ignores the skills dir",
    async () => {
      const registryDir = path.join(rootDir, "registry-broader-ignore");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-broader-ignore");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, ".gitignore"), "/.agents/\n", "utf8");

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/.agents/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "skips writing the repo root .gitignore when a nested repo .gitignore already ignores the skills dir",
    async () => {
      const registryDir = path.join(rootDir, "registry-nested-ignore");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-nested-ignore");
      await initTestRepo(consumerDir);
      const packageDir = path.join(consumerDir, "packages", "app");
      await fs.mkdir(packageDir, { recursive: true });
      await fs.writeFile(path.join(packageDir, ".gitignore"), ".agents/\n", "utf8");

      const result = await runCli(packageDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(await fileExists(path.join(consumerDir, ".gitignore"))).toBe(false);
      expect(await fs.readFile(path.join(packageDir, ".gitignore"), "utf8")).toBe(
        ".agents/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "adds a repo .gitignore entry when only .git/info/exclude ignores the skills dir",
    async () => {
      const registryDir = path.join(rootDir, "registry-info-exclude");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-info-exclude");
      await initTestRepo(consumerDir);
      await fs.writeFile(
        path.join(consumerDir, ".git", "info", "exclude"),
        ".agents/\n",
        "utf8"
      );

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/.agents/skills/\n"
      );
    },
    TEST_TIMEOUT
  );

  it(
    "keeps an explicit skillsDir even when repo markers suggest a different default",
    async () => {
      const registryDir = path.join(rootDir, "registry-explicit-skills-dir");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-explicit-skills-dir");
      await initTestRepo(consumerDir);
      await fs.writeFile(path.join(consumerDir, "AGENTS.md"), "# Repo instructions\n", "utf8");
      await fs.writeFile(
        path.join(consumerDir, "skillpup.config.yaml"),
        `registry:
  type: git
  url: ${registryDir}
skillsDir: .agent/skills
skills:
  - name: reviewer
`,
        "utf8"
      );

      const result = await runCli(consumerDir, ["fetch"]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".agent/skills");
      expect(await fs.readFile(path.join(consumerDir, ".gitignore"), "utf8")).toBe(
        "/.agent/skills/\n"
      );
      expect(
        await fileExists(path.join(consumerDir, ".agent/skills/reviewer/SKILL.md"))
      ).toBe(true);
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(false);
    },
    TEST_TIMEOUT
  );

  it(
    "uses .agents/skills when repo markers are present but no skills directory exists",
    async () => {
      const registryDir = path.join(rootDir, "registry-marker-default");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-marker-default");
      await initTestRepo(consumerDir);
      await fs.mkdir(path.join(consumerDir, ".github"), { recursive: true });
      await fs.writeFile(
        path.join(consumerDir, ".github", "copilot-instructions.md"),
        "# Copilot instructions\n",
        "utf8"
      );

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".agents/skills");
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);
    },
    TEST_TIMEOUT
  );

  it(
    "prefers .agents/skills when multiple existing skills directories are present",
    async () => {
      const registryDir = path.join(rootDir, "registry-multiple-skills-dirs");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);

      const consumerDir = path.join(rootDir, "consumer-multiple-skills-dirs");
      await initTestRepo(consumerDir);
      await fs.mkdir(path.join(consumerDir, ".agents/skills"), { recursive: true });
      await fs.mkdir(path.join(consumerDir, ".opencode/skills"), { recursive: true });

      const result = await runCli(consumerDir, [
        "fetch",
        "reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const config = await readYamlFile<SkillpupConfig>(
        path.join(consumerDir, "skillpup.config.yaml")
      );
      expect(config.skillsDir).toBe(".agents/skills");
      expect(
        await fileExists(path.join(consumerDir, ".agents/skills/reviewer/SKILL.md"))
      ).toBe(true);
      expect(
        await fileExists(path.join(consumerDir, ".opencode/skills/reviewer/SKILL.md"))
      ).toBe(false);
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
    "refreshes buried digests after editing a registry bundle in place",
    async () => {
      const registryDir = path.join(rootDir, "registry-refresh");
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

      const metadataPath = path.join(
        registryDir,
        "skills/guardian/versions/v1.0.0/metadata.yaml"
      );
      const indexPath = path.join(registryDir, "skills/guardian/index.yaml");
      const bundledFilePath = path.join(
        registryDir,
        "skills/guardian/versions/v1.0.0/skill/template.txt"
      );

      const previousMetadata = await readYamlFile<{ digest: string }>(metadataPath);
      await fs.writeFile(bundledFilePath, "template-v1.0.0-local-edit\n", "utf8");

      const result = await runCli(rootDir, ["bury", "refresh", bundledFilePath]);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("Refreshed guardian@v1.0.0");

      const refreshedMetadata = await readYamlFile<{
        digest: string;
        buriedAt: string;
      }>(metadataPath);
      const refreshedIndex = await readYamlFile<{
        versions: Array<{ version: string; digest: string; buriedAt: string }>;
      }>(indexPath);

      expect(refreshedMetadata.digest).not.toBe(previousMetadata.digest);
      expect(
        refreshedIndex.versions.find((entry) => entry.version === "v1.0.0")?.digest
      ).toBe(refreshedMetadata.digest);
      expect(
        refreshedIndex.versions.find((entry) => entry.version === "v1.0.0")?.buriedAt
      ).toBe(refreshedMetadata.buriedAt);

      const consumerDir = path.join(rootDir, "consumer-refresh");
      await initTestRepo(consumerDir);
      const fetchResult = await runCli(consumerDir, [
        "fetch",
        "guardian",
        "--registry",
        registryDir,
      ]);
      expect(fetchResult.exitCode).toBe(0);
      expect(
        await fs.readFile(
          path.join(consumerDir, ".agents/skills/guardian/template.txt"),
          "utf8"
        )
      ).toBe("template-v1.0.0-local-edit\n");
    },
    TEST_TIMEOUT
  );

  it(
    "commits refreshed registry files on bury refresh --commit",
    async () => {
      const registryDir = path.join(rootDir, "registry-refresh-commit");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);
      await fs.writeFile(path.join(registryDir, ".gitignore"), "\n", "utf8");
      await commitAll(registryDir, "initial");

      const source = await createSkillRepo({
        skillName: "critic",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
        "--commit",
      ]);

      const bundledFilePath = path.join(
        registryDir,
        "skills/critic/versions/v1.0.0/skill/template.txt"
      );
      await fs.writeFile(bundledFilePath, "template-v1.0.0-refreshed\n", "utf8");

      const result = await runCli(rootDir, [
        "bury",
        "refresh",
        bundledFilePath,
        "--commit",
      ]);
      expect(result.exitCode).toBe(0);

      const subject = await runGitCapture(["log", "-1", "--pretty=%s"], registryDir);
      expect(subject).toBe("chore(skillpup-registry): refresh critic@v1.0.0");
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
    "explains recovery when bundled files change after publish",
    async () => {
      const registryDir = path.join(rootDir, "registry-installed-digest-mismatch");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "courier-skills",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
      ]);

      const consumerDir = path.join(rootDir, "consumer-installed-digest-mismatch");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "courier-skills",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const bundledFilePath = path.join(
        registryDir,
        "skills/courier-skills/versions/v1.0.0/skill/template.txt"
      );
      await fs.writeFile(bundledFilePath, "template-v1.0.0-mutated\n", "utf8");

      result = await runCli(consumerDir, ["fetch"]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("The buried bundle no longer matches its recorded digest");
      expect(result.stderr).toContain("Republish this artifact as a new version");
      expect(result.stderr).toContain('skillpup bury refresh <path>');
    },
    TEST_TIMEOUT
  );

  it(
    "requires --force to accept a refreshed digest for an explicitly requested skill",
    async () => {
      const registryDir = path.join(rootDir, "registry-refresh-fetch");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "django-ninja-best-practices",
        versions: ["latest"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--registry",
        registryDir,
        "--version",
        "latest",
      ]);

      const consumerDir = path.join(rootDir, "consumer-refresh-fetch");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "django-ninja-best-practices",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const lockfilePath = path.join(consumerDir, "skillpup.lock.yaml");
      const previousLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      const bundledFilePath = path.join(
        registryDir,
        "skills/django-ninja-best-practices/versions/latest/skill/template.txt"
      );

      await fs.writeFile(bundledFilePath, "template-latest-refreshed\n", "utf8");
      result = await runCli(rootDir, ["bury", "refresh", bundledFilePath]);
      expect(result.exitCode).toBe(0);

      result = await runCli(consumerDir, [
        "fetch",
        "django-ninja-best-practices",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Digest mismatch");

      result = await runCli(consumerDir, [
        "fetch",
        "django-ninja-best-practices",
        "--registry",
        registryDir,
        "--force",
      ]);
      expect(result.exitCode).toBe(0);

      const updatedLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      expect(updatedLockfile.skills[0]?.version).toBe("latest");
      expect(updatedLockfile.skills[0]?.digest).not.toBe(
        previousLockfile.skills[0]?.digest
      );
      expect(
        await fs.readFile(
          path.join(
            consumerDir,
            ".agents/skills/django-ninja-best-practices/template.txt"
          ),
          "utf8"
        )
      ).toBe("template-latest-refreshed\n");
    },
    TEST_TIMEOUT
  );

  it(
    "requires --force to accept a refreshed digest for an explicitly requested subagent",
    async () => {
      const registryDir = path.join(rootDir, "registry-refresh-fetch-subagent");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["latest"],
        extraToml: 'model = "gpt-5.4"',
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--path",
        source.subagentPath,
        "--registry",
        registryDir,
        "--version",
        "latest",
      ]);

      const consumerDir = path.join(rootDir, "consumer-refresh-fetch-subagent");
      await initTestRepo(consumerDir);

      let result = await runCli(consumerDir, [
        "fetch",
        "subagent:reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(0);

      const lockfilePath = path.join(consumerDir, "skillpup.lock.yaml");
      const previousLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      const bundledFilePath = path.join(
        registryDir,
        "subagents/reviewer/versions/latest/subagent/reviewer.toml"
      );

      await fs.writeFile(
        bundledFilePath,
        `name = "reviewer"
description = "Version latest"
developer_instructions = "Follow reviewer latest refreshed"
model = "gpt-5.4"
`,
        "utf8"
      );
      result = await runCli(rootDir, ["bury", "refresh", bundledFilePath]);
      expect(result.exitCode).toBe(0);

      result = await runCli(consumerDir, [
        "fetch",
        "subagent:reviewer",
        "--registry",
        registryDir,
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.stderr).toContain("Digest mismatch");

      result = await runCli(consumerDir, [
        "fetch",
        "subagent:reviewer",
        "--registry",
        registryDir,
        "--force",
      ]);
      expect(result.exitCode).toBe(0);

      const updatedLockfile = await readYamlFile<SkillpupLockfile>(lockfilePath);
      expect(updatedLockfile.subagents[0]?.version).toBe("latest");
      expect(updatedLockfile.subagents[0]?.digest).not.toBe(
        previousLockfile.subagents[0]?.digest
      );
      expect(
        await fs.readFile(path.join(consumerDir, ".codex/agents/reviewer.toml"), "utf8")
      ).toContain("refreshed");
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
