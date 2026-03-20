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
  repo_full_name: string;
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
            (skill) => skill.repo_full_name.split("/", 1)[0] === owner
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
        expect(result.stdout).toContain("Sniffed 1 skill: 1 matched");
        expect(result.stdout).not.toContain("subagent:reviewer");
      } finally {
        await server.close();
      }
    },
    TEST_TIMEOUT
  );

  it(
    "sniffs a configured consumer skill through lockfile metadata",
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
