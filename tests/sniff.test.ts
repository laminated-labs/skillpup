import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { stringify } from "yaml";
import {
  createSkillRepo,
  createSubagentRepo,
  initTestRepo,
  makeTempDir,
  readYamlFile,
  runCli,
  runGit,
  runGitCapture,
} from "./helpers.js";

const TEST_TIMEOUT = 120_000;

type MockSkill = {
  id: string;
  skill_name: string;
  overall_risk?: string;
  analysis_timestamp?: string;
  repo_full_name?: string;
  github_html_url: string;
};

async function startTegoServer(options: {
  expectedApiKey: string;
  skills: MockSkill[];
  assessments: Record<string, unknown>;
}) {
  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (request.headers.authorization !== `Bearer ${options.expectedApiKey}`) {
      response.writeHead(401, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: "Unauthorized. Use Authorization: Bearer tsk_..." }));
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/skills/search") {
      const owner = url.searchParams.get("owner");
      const skills = owner
        ? options.skills.filter(
            (skill) => skill.repo_full_name?.split("/", 1)[0] === owner
          )
        : options.skills;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ skills, count: skills.length, cursor: null }));
      return;
    }

    const assessmentMatch = url.pathname.match(/^\/api\/skills\/([^/]+)\/assessment$/);
    if (request.method === "GET" && assessmentMatch) {
      const assessment = options.assessments[assessmentMatch[1] ?? ""];
      if (!assessment) {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "Not found" }));
        return;
      }

      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(assessment));
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

async function rewriteBuriedSourceUrl(
  registryDir: string,
  artifactName: string,
  version: string,
  sourceUrl: string
) {
  const metadataPath = path.join(
    registryDir,
    "skills",
    artifactName,
    "versions",
    version,
    "metadata.yaml"
  );
  const metadata = await readYamlFile<Record<string, unknown>>(metadataPath);
  metadata.sourceUrl = sourceUrl;
  await fs.writeFile(metadataPath, stringify(metadata), "utf8");
}

async function rewriteBuriedSourceRef(
  registryDir: string,
  artifactName: string,
  version: string,
  sourceRef: string
) {
  const metadataPath = path.join(
    registryDir,
    "skills",
    artifactName,
    "versions",
    version,
    "metadata.yaml"
  );
  const metadata = await readYamlFile<Record<string, unknown>>(metadataPath);
  metadata.sourceRef = sourceRef;
  await fs.writeFile(metadataPath, stringify(metadata), "utf8");
}

async function rewriteBuriedSourcePath(
  registryDir: string,
  artifactName: string,
  version: string,
  sourcePath: string
) {
  const metadataPath = path.join(
    registryDir,
    "skills",
    artifactName,
    "versions",
    version,
    "metadata.yaml"
  );
  const metadata = await readYamlFile<Record<string, unknown>>(metadataPath);
  metadata.sourcePath = sourcePath;
  await fs.writeFile(metadataPath, stringify(metadata), "utf8");
}

async function rewriteConfigRegistryUrl(projectDir: string, registryUrl: string) {
  const configPath = path.join(projectDir, "skillpup.config.yaml");
  const config = await readYamlFile<Record<string, unknown>>(configPath);
  const registry = (config.registry as Record<string, unknown> | undefined) ?? {};
  config.registry = {
    ...registry,
    url: registryUrl,
  };
  await fs.writeFile(configPath, stringify(config), "utf8");
}

describe("skillpup sniff", () => {
  let rootDir: string;

  beforeAll(async () => {
    rootDir = await makeTempDir("skillpup-sniff-");
  });

  afterAll(async () => {
    await fs.rm(rootDir, { recursive: true, force: true });
  });

  it(
    "matches a nested local source repo through its GitHub origin",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        skillPath: "skills/reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/team-skills.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-1",
            skill_name: "reviewer",
            overall_risk: "high",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/main/skills/reviewer/SKILL.md",
          },
        ],
        assessments: {
          "skill-1": {
            id: "skill-1",
            skill_name: "reviewer",
            sha: sourceCommit,
            scan_date: "2026-03-16T21:03:14Z",
            assessment: {
              findings: [
                {
                  severity: "high",
                  title: "Writes files",
                },
              ],
              permissions_requested: [
                {
                  permission: "file_system_write",
                  necessity: "required",
                },
              ],
              capabilities: {
                file_system: {
                  detected: true,
                  risk_level: "high",
                },
                tools: true,
              },
            },
          },
        },
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", source.repoDir, "--path", "skills/reviewer"],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer [high]");
        expect(result.stdout).toContain("source: example/team-skills:skills/reviewer/SKILL.md");
        expect(result.stdout).toContain("freshness: exact-commit");
        expect(result.stdout).toContain("Writes files");
        expect(result.stdout).toContain("file_system_write (required)");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "treats a bare local directory target as source mode",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer-skill",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/reviewer-skill.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-bare-local",
            skill_name: "reviewer-skill",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/reviewer-skill",
            github_html_url:
              "https://github.com/example/reviewer-skill/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-bare-local": {
            id: "skill-bare-local",
            skill_name: "reviewer-skill",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(path.dirname(source.repoDir), ["sniff", "reviewer-skill"], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer-skill [medium]");
        expect(result.stdout).toContain("freshness: exact-commit");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "matches a local source subdirectory using repo-relative GitHub paths",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        skillPath: "skills/reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/team-skills.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-subdir-root",
            skill_name: "reviewer",
            overall_risk: "high",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/main/skills/reviewer/SKILL.md",
          },
        ],
        assessments: {
          "skill-subdir-root": {
            id: "skill-subdir-root",
            skill_name: "reviewer",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", path.join(source.repoDir, "skills"), "--path", "reviewer"],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer [high]");
        expect(result.stdout).toContain("source: example/team-skills:skills/reviewer/SKILL.md");
        expect(result.stdout).toContain("freshness: exact-commit");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "reads a local untracked skill path from the working tree",
    async () => {
      const repoDir = path.join(rootDir, "working-tree-skill");
      await initTestRepo(repoDir);
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/team-skills.git"],
        repoDir
      );
      await fs.writeFile(path.join(repoDir, "README.md"), "# working tree skill\n", "utf8");
      await runGit(["add", "README.md"], repoDir);
      await runGit(["commit", "--no-gpg-sign", "-m", "initial"], repoDir);
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], repoDir);
      await fs.mkdir(path.join(repoDir, ".agents", "skills", "gh-address-comments"), {
        recursive: true,
      });
      await fs.writeFile(
        path.join(repoDir, ".agents", "skills", "gh-address-comments", "SKILL.md"),
        "# gh-address-comments\n",
        "utf8"
      );

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-working-tree",
            skill_name: "gh-address-comments",
            overall_risk: "high",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/main/.agents/skills/gh-address-comments/SKILL.md",
          },
        ],
        assessments: {
          "skill-working-tree": {
            id: "skill-working-tree",
            skill_name: "gh-address-comments",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(
          repoDir,
          ["sniff", ".", "--path", ".agents/skills/gh-address-comments"],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:gh-address-comments [high]");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "uses the repo directory name when sniffing the repo root working tree",
    async () => {
      const source = await createSkillRepo({
        skillName: "repo-root-skill",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/repo-root-skill.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-repo-root",
            skill_name: "repo-root-skill",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/repo-root-skill",
            github_html_url:
              "https://github.com/example/repo-root-skill/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-repo-root": {
            id: "skill-repo-root",
            skill_name: "repo-root-skill",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(source.repoDir, ["sniff", "."], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:repo-root-skill [medium]");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "matches local source skills when the current branch name contains slashes",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        skillPath: "skills/reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(["checkout", "-b", "feature/dog-mode"], source.repoDir);
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/team-skills.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-slash-ref",
            skill_name: "reviewer",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-17T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/feature/dog-mode/skills/reviewer/SKILL.md",
          },
        ],
        assessments: {
          "skill-slash-ref": {
            id: "skill-slash-ref",
            skill_name: "reviewer",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", source.repoDir, "--path", "skills/reviewer"],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer [medium]");
        expect(result.stdout).toContain("freshness: exact-commit");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "does not match nested skill paths when sniffing a repo-root skill",
    async () => {
      const source = await createSkillRepo({
        skillName: "repo-root-skill",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/repo-root-skill.git"],
        source.repoDir
      );

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-nested",
            skill_name: "repo-root-skill",
            overall_risk: "critical",
            analysis_timestamp: "2026-03-17T21:03:14Z",
            repo_full_name: "example/repo-root-skill",
            github_html_url:
              "https://github.com/example/repo-root-skill/blob/main/nested/repo-root-skill/SKILL.md",
          },
        ],
        assessments: {
          "skill-nested": {
            id: "skill-nested",
            skill_name: "repo-root-skill",
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(source.repoDir, ["sniff", "."], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("NOT INDEXED: skill:repo-root-skill");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "reports unsupported-source for a local repo without a GitHub origin",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [],
        assessments: {},
      });

      try {
        const result = await runCli(rootDir, ["sniff", source.repoDir], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("UNSUPPORTED SOURCE: skill:reviewer");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "reports not-indexed when Tego has no matching skill",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/reviewer.git"],
        source.repoDir
      );
      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [],
        assessments: {},
      });

      try {
        const result = await runCli(rootDir, ["sniff", source.repoDir], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("NOT INDEXED: skill:reviewer");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "matches when the GitHub repo casing differs from Tego",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/Reviewer.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-case-mismatch",
            skill_name: "reviewer",
            overall_risk: "low",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/reviewer",
            github_html_url: "https://github.com/example/reviewer/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-case-mismatch": {
            id: "skill-case-mismatch",
            skill_name: "reviewer",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(rootDir, ["sniff", source.repoDir], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer [low]");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "ignores Tego candidates that omit repo_full_name",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/reviewer.git"],
        source.repoDir
      );
      const sourceCommit = await runGitCapture(["rev-parse", "HEAD"], source.repoDir);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-missing-repo",
            skill_name: "reviewer",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            github_html_url: "https://github.com/example/reviewer/blob/main/SKILL.md",
          },
          {
            id: "skill-valid-repo",
            skill_name: "reviewer",
            overall_risk: "low",
            analysis_timestamp: "2026-03-17T21:03:14Z",
            repo_full_name: "example/reviewer",
            github_html_url: "https://github.com/example/reviewer/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-valid-repo": {
            id: "skill-valid-repo",
            skill_name: "reviewer",
            sha: sourceCommit,
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(rootDir, ["sniff", source.repoDir], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: skill:reviewer [low]");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "sniffs a buried skill by version and reports different-commit freshness",
    async () => {
      const registryDir = path.join(rootDir, "registry-versioned");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);
      await rewriteBuriedSourceUrl(
        registryDir,
        "reviewer",
        "v1.0.0",
        "git@github.com:example/reviewer.git"
      );

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-2",
            skill_name: "reviewer",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/reviewer",
            github_html_url: "https://github.com/example/reviewer/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-2": {
            id: "skill-2",
            skill_name: "reviewer",
            sha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
            scan_date: "2026-03-16T21:03:14Z",
            assessment: {
              findings: [
                {
                  severity: "medium",
                  title: "Runs commands",
                },
              ],
            },
          },
        },
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", "reviewer@v1.0.0", "--registry", registryDir],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: reviewer@v1.0.0 [medium]");
        expect(result.stdout).toContain("freshness: different-commit");
        expect(result.stdout).toContain("Runs commands");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "normalizes leading dot segments in buried source paths",
    async () => {
      const registryDir = path.join(rootDir, "registry-dot-path");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "reviewer",
        skillPath: "skills/reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        source.repoDir,
        "--path",
        "./skills/reviewer",
        "--registry",
        registryDir,
      ]);
      await rewriteBuriedSourceUrl(
        registryDir,
        "reviewer",
        "v1.0.0",
        "git@github.com:example/team-skills.git"
      );
      await rewriteBuriedSourcePath(
        registryDir,
        "reviewer",
        "v1.0.0",
        "./skills/reviewer"
      );

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-dot-path",
            skill_name: "reviewer",
            overall_risk: "high",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/main/skills/reviewer/SKILL.md",
          },
        ],
        assessments: {
          "skill-dot-path": {
            id: "skill-dot-path",
            skill_name: "reviewer",
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", "reviewer@v1.0.0", "--registry", registryDir],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: reviewer@v1.0.0 [high]");
        expect(result.stdout).toContain("source: example/team-skills:skills/reviewer/SKILL.md");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "scans only skills when registry mode has no selectors",
    async () => {
      const registryDir = path.join(rootDir, "registry-all-skills");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const skillSource = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", skillSource.repoDir, "--registry", registryDir]);
      await rewriteBuriedSourceUrl(
        registryDir,
        "reviewer",
        "v1.0.0",
        "git@github.com:example/reviewer.git"
      );

      const subagentSource = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        subagentSource.repoDir,
        "--path",
        subagentSource.subagentPath,
        "--registry",
        registryDir,
      ]);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-3",
            skill_name: "reviewer",
            overall_risk: "low",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "example/reviewer",
            github_html_url: "https://github.com/example/reviewer/blob/main/SKILL.md",
          },
        ],
        assessments: {
          "skill-3": {
            id: "skill-3",
            skill_name: "reviewer",
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(rootDir, ["sniff", "--registry", registryDir], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: reviewer@v1.0.0 [low]");
        expect(result.stdout).toContain("Sniffed 1 target: 1 matched");
        expect(result.stdout).not.toContain("subagent:reviewer");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "sniffs a configured consumer skill through lockfile metadata without registry access",
    async () => {
      const registryDir = path.join(rootDir, "registry-project-mode");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "gh-address-comments",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);
      await rewriteBuriedSourceUrl(
        registryDir,
        "gh-address-comments",
        "v1.0.0",
        "https://github.com/openai/skills/tree/main/skills/.curated/gh-address-comments"
      );

      const consumerDir = path.join(rootDir, "consumer-project-mode");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, [
        "fetch",
        "gh-address-comments",
        "--registry",
        registryDir,
      ]);
      await rewriteConfigRegistryUrl(consumerDir, "./missing-registry");

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-project-mode",
            skill_name: "gh-address-comments",
            overall_risk: "high",
            analysis_timestamp: "2026-03-16T21:03:14Z",
            repo_full_name: "openai/skills",
            github_html_url:
              "https://github.com/openai/skills/blob/main/skills/.curated/gh-address-comments/SKILL.md",
          },
        ],
        assessments: {
          "skill-project-mode": {
            id: "skill-project-mode",
            skill_name: "gh-address-comments",
            sha: "v1.0.0",
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(consumerDir, ["sniff", "gh-address-comments"], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: gh-address-comments@v1.0.0 [high]");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "keeps repo-root source paths when lockfile tree URLs use slash refs",
    async () => {
      const registryDir = path.join(rootDir, "registry-project-mode-slash-ref-root");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const source = await createSkillRepo({
        skillName: "repo-root-skill",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, ["bury", source.repoDir, "--registry", registryDir]);
      await rewriteBuriedSourceUrl(
        registryDir,
        "repo-root-skill",
        "v1.0.0",
        "https://github.com/example/team-skills/tree/feature/dog-mode"
      );
      await rewriteBuriedSourceRef(
        registryDir,
        "repo-root-skill",
        "v1.0.0",
        "feature/dog-mode"
      );

      const consumerDir = path.join(rootDir, "consumer-project-mode-slash-ref-root");
      await initTestRepo(consumerDir);
      await runCli(consumerDir, [
        "fetch",
        "repo-root-skill",
        "--registry",
        registryDir,
      ]);
      await rewriteConfigRegistryUrl(consumerDir, "./missing-registry");

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [
          {
            id: "skill-project-root-slash-ref",
            skill_name: "repo-root-skill",
            overall_risk: "medium",
            analysis_timestamp: "2026-03-17T21:03:14Z",
            repo_full_name: "example/team-skills",
            github_html_url:
              "https://github.com/example/team-skills/blob/feature/dog-mode/SKILL.md",
          },
        ],
        assessments: {
          "skill-project-root-slash-ref": {
            id: "skill-project-root-slash-ref",
            skill_name: "repo-root-skill",
            assessment: {},
          },
        },
      });

      try {
        const result = await runCli(consumerDir, ["sniff", "repo-root-skill"], {
          env: {
            TEGO_API_KEY: "test-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("MATCHED: repo-root-skill@v1.0.0 [medium]");
        expect(result.stdout).toContain("source: example/team-skills:SKILL.md");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "reports unsupported-kind for an explicit subagent selector",
    async () => {
      const registryDir = path.join(rootDir, "registry-subagent");
      await runCli(rootDir, ["bury", "init", registryDir]);
      await initTestRepo(registryDir);

      const subagentSource = await createSubagentRepo({
        subagentName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runCli(rootDir, [
        "bury",
        subagentSource.repoDir,
        "--path",
        subagentSource.subagentPath,
        "--registry",
        registryDir,
      ]);

      const server = await startTegoServer({
        expectedApiKey: "test-key",
        skills: [],
        assessments: {},
      });

      try {
        const result = await runCli(
          rootDir,
          ["sniff", "subagent:reviewer", "--registry", registryDir],
          {
            env: {
              TEGO_API_KEY: "test-key",
              SKILLPUP_TEGO_BASE_URL: server.baseUrl,
            },
          }
        );

        expect(result.exitCode).toBe(0);
        expect(result.stdout).toContain("UNSUPPORTED KIND: subagent:reviewer");
        expect(result.stdout).toContain(
          "Sniffed 1 target: 0 matched, 0 not indexed, 0 unsupported source, 1 unsupported kind"
        );
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it("fails when TEGO_API_KEY is missing", async () => {
    const source = await createSkillRepo({
      skillName: "reviewer",
      versions: ["v1.0.0"],
    });

    const result = await runCli(rootDir, ["sniff", source.repoDir], {
      env: {
        TEGO_API_KEY: "",
      },
    });

    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("TEGO_API_KEY is required");
  });

  it(
    "fails when Tego rejects the API key",
    async () => {
      const source = await createSkillRepo({
        skillName: "reviewer",
        versions: ["v1.0.0"],
      });
      await runGit(
        ["remote", "add", "origin", "git@github.com:example/reviewer.git"],
        source.repoDir
      );

      const server = await startTegoServer({
        expectedApiKey: "good-key",
        skills: [],
        assessments: {},
      });

      try {
        const result = await runCli(rootDir, ["sniff", source.repoDir], {
          env: {
            TEGO_API_KEY: "bad-key",
            SKILLPUP_TEGO_BASE_URL: server.baseUrl,
          },
        });

        expect(result.exitCode).toBe(1);
        expect(result.stderr).toContain("Tego API rejected TEGO_API_KEY");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );
});
