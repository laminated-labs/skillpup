import fs from "node:fs/promises";
import path from "node:path";
import { cosmiconfig } from "cosmiconfig";
import { z } from "zod";
import type { SkillpupConfig } from "./types.js";
import { CONFIG_FILE_BASENAME, DEFAULT_SKILLS_DIR } from "./utils.js";

const registrySchema = z.object({
  type: z.literal("git").default("git"),
  url: z.string().min(1),
});

const skillEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1).optional(),
});

const configSchema = z.object({
  registry: registrySchema,
  skillsDir: z.string().min(1).default(DEFAULT_SKILLS_DIR),
  skills: z.array(skillEntrySchema).default([]),
});

export type LoadedProjectConfig = {
  path: string;
  config: SkillpupConfig;
};

const CONFIG_SEARCH_PLACES = [
  "skillpup.config.yaml",
  "skillpup.config.yml",
  ".skillpuprc",
  ".skillpuprc.json",
  ".skillpuprc.yaml",
  ".skillpuprc.yml",
] as const;

const explorer = cosmiconfig("skillpup", {
  searchPlaces: [...CONFIG_SEARCH_PLACES],
});

async function findConfigPath(baseDir: string): Promise<string | null> {
  let currentDir = path.resolve(baseDir);

  for (;;) {
    for (const searchPlace of CONFIG_SEARCH_PLACES) {
      const candidatePath = path.join(currentDir, searchPlace);
      try {
        await fs.access(candidatePath);
        return candidatePath;
      } catch {
        continue;
      }
    }

    const parentDir = path.dirname(currentDir);
    if (parentDir === currentDir) {
      return null;
    }
    currentDir = parentDir;
  }
}

export async function loadProjectConfig(
  baseDir: string = process.cwd()
): Promise<LoadedProjectConfig | null> {
  const configPath = await findConfigPath(baseDir);
  if (!configPath) {
    return null;
  }

  const result = await explorer.load(configPath);
  if (!result || result.isEmpty) {
    return null;
  }

  const parsed = configSchema.safeParse(result.config);
  if (!parsed.success) {
    throw new Error(`Invalid config: ${parsed.error.message}`);
  }

  return {
    path: result.filepath,
    config: parsed.data,
  };
}

export async function writeProjectConfig(
  configPath: string,
  config: SkillpupConfig
) {
  const { stringify } = await import("yaml");
  const normalizedConfig = {
    registry: config.registry,
    skillsDir: config.skillsDir,
    skills: config.skills.map((skill) => ({
      name: skill.name,
      ...(skill.version ? { version: skill.version } : {}),
    })),
  };

  const contents = stringify(normalizedConfig);
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, contents, "utf8");
}

export function getDefaultConfigPath(baseDir: string) {
  return path.join(baseDir, CONFIG_FILE_BASENAME);
}
