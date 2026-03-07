import { describe, expect, it } from "vitest";
import {
  parseGitHubTreeUrl,
  splitGitHubTreeRefAndPath,
} from "../src/source-spec.js";

describe("parseGitHubTreeUrl", () => {
  it("parses GitHub tree URLs into repo URL and ref/path segments", () => {
    expect(
      parseGitHubTreeUrl(
        "https://github.com/openai/skills/tree/main/skills/.curated/figma"
      )
    ).toEqual({
      repoUrl: "https://github.com/openai/skills.git",
      refAndPathSegments: ["main", "skills", ".curated", "figma"],
    });
  });

  it("returns null for plain repository URLs", () => {
    expect(parseGitHubTreeUrl("https://github.com/openai/skills.git")).toBeNull();
  });
});

describe("splitGitHubTreeRefAndPath", () => {
  it("prefers the longest matching ref prefix", async () => {
    const refs = new Set(["main", "feature/dog-mode"]);
    await expect(
      splitGitHubTreeRefAndPath(
        ["feature", "dog-mode", "skills", "fetcher"],
        async (candidate) => refs.has(candidate)
      )
    ).resolves.toEqual({
      ref: "feature/dog-mode",
      path: "skills/fetcher",
    });
  });

  it("supports tree URLs that point at the repo root for a ref", async () => {
    await expect(
      splitGitHubTreeRefAndPath(["main"], async (candidate) => candidate === "main")
    ).resolves.toEqual({
      ref: "main",
      path: undefined,
    });
  });
});
