import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { SkillpupLockfile } from "./types.js";

const lockfileEntrySchema = z.object({
  name: z.string().min(1),
  version: z.string().min(1),
  registryPath: z.string().min(1),
  digest: z.string().min(1),
  buriedAt: z.string().min(1),
  sourceUrl: z.string().min(1),
  sourcePath: z.string().min(1),
  sourceRef: z.string().min(1),
  sourceCommit: z.string().min(1),
});

const lockfileSchema = z.object({
  skills: z.array(lockfileEntrySchema).default([]),
});

export async function loadLockfile(lockfilePath: string): Promise<SkillpupLockfile> {
  try {
    const fileContents = await fs.readFile(lockfilePath, "utf8");
    const { parse } = await import("yaml");
    const parsed = lockfileSchema.safeParse(parse(fileContents));
    if (!parsed.success) {
      throw new Error(`Invalid lockfile: ${parsed.error.message}`);
    }
    return parsed.data;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { skills: [] };
    }
    throw error;
  }
}

export async function writeLockfile(
  lockfilePath: string,
  lockfile: SkillpupLockfile
) {
  const { stringify } = await import("yaml");
  const contents = stringify({
    skills: lockfile.skills,
  });
  await fs.mkdir(path.dirname(lockfilePath), { recursive: true });
  await fs.writeFile(lockfilePath, contents, "utf8");
}
