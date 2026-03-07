import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { resolveInside, toPosix } from "./utils.js";

type TreeEntry =
  | { kind: "dir"; relativePath: string; absolutePath: string }
  | { kind: "file"; relativePath: string; absolutePath: string };

export async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function ensureDir(targetPath: string) {
  await fs.mkdir(targetPath, { recursive: true });
}

export async function removePath(targetPath: string) {
  await fs.rm(targetPath, { recursive: true, force: true });
}

async function assertRootIsNotSymlink(rootDir: string) {
  const stats = await fs.lstat(rootDir);
  if (stats.isSymbolicLink()) {
    throw new Error(`Symlinked skill roots are not supported: ${rootDir}`);
  }
}

async function collectTree(rootDir: string): Promise<TreeEntry[]> {
  await assertRootIsNotSymlink(rootDir);
  const entries: TreeEntry[] = [];

  async function walk(relativeDir: string): Promise<void> {
    const absoluteDir = relativeDir
      ? resolveInside(rootDir, relativeDir)
      : rootDir;
    const dirEntries = await fs.readdir(absoluteDir, { withFileTypes: true });
    dirEntries.sort((left, right) => left.name.localeCompare(right.name));

    for (const entry of dirEntries) {
      const relativePath = relativeDir
        ? path.posix.join(relativeDir, entry.name)
        : entry.name;
      const absolutePath = resolveInside(rootDir, relativePath);

      if (entry.isSymbolicLink()) {
        throw new Error(`Symlinked content is not supported: ${relativePath}`);
      }

      if (entry.isDirectory()) {
        entries.push({ kind: "dir", relativePath, absolutePath });
        await walk(relativePath);
        continue;
      }

      if (entry.isFile()) {
        entries.push({ kind: "file", relativePath, absolutePath });
        continue;
      }

      throw new Error(`Unsupported filesystem entry in skill bundle: ${relativePath}`);
    }
  }

  await walk("");
  return entries;
}

export async function copyDirectoryStrict(sourceDir: string, destinationDir: string) {
  const entries = await collectTree(sourceDir);
  await ensureDir(destinationDir);

  for (const entry of entries) {
    const destinationPath = resolveInside(destinationDir, entry.relativePath);
    if (entry.kind === "dir") {
      await ensureDir(destinationPath);
      continue;
    }

    await ensureDir(path.dirname(destinationPath));
    await fs.copyFile(entry.absolutePath, destinationPath);
    const sourceStats = await fs.stat(entry.absolutePath);
    await fs.chmod(destinationPath, sourceStats.mode);
  }
}

export async function computeDirectoryDigest(rootDir: string) {
  const entries = await collectTree(rootDir);
  const hash = createHash("sha256");

  for (const entry of entries) {
    const relativePath = toPosix(entry.relativePath);
    if (entry.kind === "dir") {
      hash.update(`dir:${relativePath}\0`);
      continue;
    }

    hash.update(`file:${relativePath}\0`);
    const fileContents = await fs.readFile(entry.absolutePath);
    hash.update(fileContents);
    hash.update("\0");
  }

  return `sha256:${hash.digest("hex")}`;
}
