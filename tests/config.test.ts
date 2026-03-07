import fs from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadProjectConfig } from "../src/config.js";
import { makeTempDir } from "./helpers.js";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempDirs.map((dir) => fs.rm(dir, { recursive: true, force: true }))
  );
  tempDirs.length = 0;
});

describe("loadProjectConfig", () => {
  it("applies the default skillsDir", async () => {
    const tempDir = await makeTempDir("skillpup-config-");
    tempDirs.push(tempDir);
    await fs.writeFile(
      path.join(tempDir, "skillpup.config.yaml"),
      `registry:
  type: git
  url: /tmp/registry
skills:
  - name: reviewer
    version: v1.2.3
`,
      "utf8"
    );

    const loaded = await loadProjectConfig(tempDir);
    expect(loaded?.config.skillsDir).toBe(".agent/skills");
    expect(loaded?.config.skills[0]?.name).toBe("reviewer");
  });

  it("returns null when no config is present", async () => {
    const tempDir = await makeTempDir("skillpup-config-missing-");
    tempDirs.push(tempDir);
    const loaded = await loadProjectConfig(tempDir);
    expect(loaded).toBeNull();
  });
});
