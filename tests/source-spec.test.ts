import { describe, expect, it } from "vitest";
import {
  normalizeStoredSourceUrl,
  parseHostedRepoUrl,
  parseHostedSourceViewUrl,
  splitHostedRefAndPath,
} from "../src/source-spec.js";

describe("parseHostedSourceViewUrl", () => {
  it("parses GitHub tree URLs into repo URL and ref/path segments", () => {
    expect(
      parseHostedSourceViewUrl(
        "https://github.com/openai/skills/tree/main/skills/.curated/figma"
      )
    ).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
      repoUrl: "https://github.com/openai/skills.git",
      repoUrls: [
        "https://github.com/openai/skills.git",
        "git@github.com:openai/skills.git",
      ],
      refAndPathSegments: ["main", "skills", ".curated", "figma"],
    });
  });

  it("normalizes GitHub tree URLs whose repo segment already ends with .git", () => {
    expect(parseHostedSourceViewUrl("https://github.com/openai/skills.git/tree/main")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
      repoUrl: "https://github.com/openai/skills.git",
      repoUrls: [
        "https://github.com/openai/skills.git",
        "git@github.com:openai/skills.git",
      ],
      refAndPathSegments: ["main"],
    });
  });

  it("parses Bitbucket Cloud source-view URLs into repo URL and ref/path segments", () => {
    expect(
      parseHostedSourceViewUrl(
        "https://bitbucket.org/openai/skills/src/main/skills/.curated/figma"
      )
    ).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
      repoUrl: "https://bitbucket.org/openai/skills.git",
      repoUrls: [
        "https://bitbucket.org/openai/skills.git",
        "git@bitbucket.org:openai/skills.git",
      ],
      refAndPathSegments: ["main", "skills", ".curated", "figma"],
    });
  });

  it("decodes Bitbucket Cloud source-view ref segments", () => {
    expect(
      parseHostedSourceViewUrl(
        "https://bitbucket.org/openai/skills/src/feature%2Fdog-mode/skills/fetcher"
      )
    ).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
      repoUrl: "https://bitbucket.org/openai/skills.git",
      repoUrls: [
        "https://bitbucket.org/openai/skills.git",
        "git@bitbucket.org:openai/skills.git",
      ],
      refAndPathSegments: ["feature/dog-mode", "skills", "fetcher"],
    });
  });

  it("returns null for plain repository URLs", () => {
    expect(parseHostedSourceViewUrl("https://github.com/openai/skills.git")).toBeNull();
    expect(parseHostedSourceViewUrl("https://bitbucket.org/openai/skills.git")).toBeNull();
  });
});

describe("splitHostedRefAndPath", () => {
  it("prefers the longest matching ref prefix", async () => {
    const refs = new Set(["main", "feature/dog-mode"]);
    await expect(
      splitHostedRefAndPath(
        ["feature/dog-mode", "skills", "fetcher"],
        async (candidate) => refs.has(candidate)
      )
    ).resolves.toEqual({
      ref: "feature/dog-mode",
      path: "skills/fetcher",
    });
  });

  it("supports tree URLs that point at the repo root for a ref", async () => {
    await expect(
      splitHostedRefAndPath(["main"], async (candidate) => candidate === "main")
    ).resolves.toEqual({
      ref: "main",
      path: undefined,
    });
  });
});

describe("parseHostedRepoUrl", () => {
  it("parses GitHub HTTPS repository URLs", () => {
    expect(parseHostedRepoUrl("https://github.com/openai/skills.git")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses GitHub scp-style SSH URLs", () => {
    expect(parseHostedRepoUrl("git@github.com:openai/skills.git")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses GitHub ssh:// repository URLs", () => {
    expect(parseHostedRepoUrl("ssh://git@github.com/openai/skills.git")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses GitHub git:// and git+https:// repository URLs", () => {
    expect(parseHostedRepoUrl("git://github.com/openai/skills.git")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
    expect(parseHostedRepoUrl("git+https://github.com/openai/skills.git")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses Bitbucket Cloud HTTPS repository URLs", () => {
    expect(parseHostedRepoUrl("https://bitbucket.org/openai/skills.git")).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses Bitbucket Cloud scp-style SSH URLs", () => {
    expect(parseHostedRepoUrl("git@bitbucket.org:openai/skills.git")).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses Bitbucket Cloud ssh:// repository URLs", () => {
    expect(parseHostedRepoUrl("ssh://git@bitbucket.org/openai/skills.git")).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("parses source-view URLs whose repo segment already ends with .git", () => {
    expect(parseHostedRepoUrl("https://github.com/openai/skills.git/tree/main")).toEqual({
      forge: "github",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
    expect(parseHostedRepoUrl("https://bitbucket.org/openai/skills.git/src/main")).toEqual({
      forge: "bitbucket-cloud",
      owner: "openai",
      repo: "skills",
      repoFullName: "openai/skills",
    });
  });

  it("rejects non-repository hosted URLs with extra path segments", () => {
    expect(parseHostedRepoUrl("git@github.com:openai/skills/blob/main/SKILL.md")).toBeNull();
    expect(parseHostedRepoUrl("https://github.com/openai/skills/blob/main/SKILL.md")).toBeNull();
    expect(parseHostedRepoUrl("https://github.com/openai/skills/issues/123")).toBeNull();
    expect(parseHostedRepoUrl("https://bitbucket.org/openai/skills/pull-requests/123")).toBeNull();
  });
});

describe("normalizeStoredSourceUrl", () => {
  it("preserves Bitbucket Cloud source-view URLs", () => {
    expect(
      normalizeStoredSourceUrl(
        "https://bitbucket.org/openai/skills/src/main/skills/reviewer",
        "/tmp"
      )
    ).toBe("https://bitbucket.org/openai/skills/src/main/skills/reviewer");
  });
});
