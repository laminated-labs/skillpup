import fs from "node:fs/promises";
import path from "node:path";
import { parse } from "smol-toml";
import { z } from "zod";
import { resolveInside } from "./utils.js";

const subagentManifestSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  developer_instructions: z.string().min(1),
});

export type ParsedSubagentManifest = z.infer<typeof subagentManifestSchema>;

export function isSubagentFilePath(targetPath: string) {
  return path.extname(targetPath).toLowerCase() === ".toml";
}

export async function readSubagentManifest(filePath: string) {
  const contents = await fs.readFile(filePath, "utf8");
  let parsed: unknown;

  try {
    parsed = parse(contents);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`Invalid subagent TOML at ${filePath}: ${message}`);
  }

  const validated = subagentManifestSchema.safeParse(parsed);
  if (!validated.success) {
    throw new Error(
      `Invalid subagent TOML at ${filePath}: ${validated.error.message}`
    );
  }

  return validated.data;
}

export function buildSubagentBundleFileName(name: string) {
  return `${name}.toml`;
}

export function buildSubagentBundleFilePath(bundleDir: string, name: string) {
  return resolveInside(bundleDir, buildSubagentBundleFileName(name));
}
