import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  RegistryRootMetadata,
  SkillIndex,
  SkillIndexVersion,
  SkillVersionMetadata,
} from "./types.js";
import { cloneRepo, ensureEmptyDir } from "./git.js";
import {
  computeDirectoryDigest,
  copyDirectoryStrict,
  ensureDir,
  pathExists,
} from "./fs-utils.js";
import {
  REGISTRY_FILE_BASENAME,
  canonicalRegistryPath,
  compareSemverDescending,
  resolveInside,
  toPosix,
  validateSkillName,
} from "./utils.js";

const registryRootSchema = z.object({
  schemaVersion: z.literal(1),
  backend: z.literal("git-bundle"),
});

const indexSchema = z.object({
  name: z.string().min(1),
  versions: z
    .array(
      z.object({
        version: z.string().min(1),
        metadataPath: z.string().min(1),
        digest: z.string().min(1),
        buriedAt: z.string().min(1),
      })
    )
    .default([]),
});

const metadataSchema = z.object({
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

type RegistryHandle = {
  backend: GitBundleRegistryBackend;
  cleanup: () => Promise<void>;
};

async function readYamlFile<T>(filePath: string, schema: z.ZodSchema<T>) {
  const fileContents = await fs.readFile(filePath, "utf8");
  const { parse } = await import("yaml");
  const parsed = schema.safeParse(parse(fileContents));
  if (!parsed.success) {
    throw new Error(`Invalid YAML at ${filePath}: ${parsed.error.message}`);
  }
  return parsed.data;
}

async function writeYamlFile(filePath: string, value: unknown) {
  const { stringify } = await import("yaml");
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, stringify(value), "utf8");
}

export class GitBundleRegistryBackend {
  constructor(readonly rootPath: string) {}

  static async init(rootPath: string) {
    const metadata: RegistryRootMetadata = {
      schemaVersion: 1,
      backend: "git-bundle",
    };

    await ensureDir(rootPath);
    await ensureDir(path.join(rootPath, "skills"));
    await writeYamlFile(path.join(rootPath, REGISTRY_FILE_BASENAME), metadata);

    const readmePath = path.join(rootPath, "README.md");
    if (!(await pathExists(readmePath))) {
      await fs.writeFile(
        readmePath,
        "# Skillpup Registry\n\nThis repository stores immutable skill bundles and metadata for `skillpup`.\n",
        "utf8"
      );
    }
  }

  async validate() {
    const metadataPath = path.join(this.rootPath, REGISTRY_FILE_BASENAME);
    if (!(await pathExists(metadataPath))) {
      throw new Error(`No registry found at ${this.rootPath}`);
    }
    await readYamlFile(metadataPath, registryRootSchema);
  }

  async listVersions(skillName: string): Promise<SkillIndexVersion[]> {
    const indexPath = this.getIndexPath(skillName);
    if (!(await pathExists(indexPath))) {
      return [];
    }
    const index = await readYamlFile(indexPath, indexSchema);
    return index.versions;
  }

  async listSkills() {
    const skillsRoot = path.join(this.rootPath, "skills");
    if (!(await pathExists(skillsRoot))) {
      return [];
    }

    const entries = await fs.readdir(skillsRoot, { withFileTypes: true });
    const skills: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (!(await pathExists(path.join(skillsRoot, entry.name, "index.yaml")))) {
        continue;
      }

      skills.push(entry.name);
    }

    return skills.sort((left, right) => left.localeCompare(right));
  }

  async readVersionMetadata(skillName: string, version: string) {
    const metadataPath = this.getMetadataPath(skillName, version);
    if (!(await pathExists(metadataPath))) {
      throw new Error(`Missing version ${skillName}@${version} in registry`);
    }
    return readYamlFile(metadataPath, metadataSchema);
  }

  async readBundlePath(skillName: string, version: string) {
    const bundlePath = this.getBundlePath(skillName, version);
    if (!(await pathExists(bundlePath))) {
      throw new Error(`Missing bundle for ${skillName}@${version}`);
    }
    return bundlePath;
  }

  async publishVersion(args: {
    skillName: string;
    version: string;
    sourceDir: string;
    sourceUrl: string;
    sourcePath: string;
    sourceRef: string;
    sourceCommit: string;
  }): Promise<{
    metadata: SkillVersionMetadata;
    indexPath: string;
    versionPath: string;
  }> {
    const { skillName, version, sourceDir, sourceUrl, sourcePath, sourceRef, sourceCommit } =
      args;
    validateSkillName(skillName);

    const versionPath = resolveInside(this.rootPath, canonicalRegistryPath(skillName, version));
    if (await pathExists(versionPath)) {
      throw new Error(`Registry version already exists: ${skillName}@${version}`);
    }

    const bundlePath = path.join(versionPath, "skill");
    await ensureDir(versionPath);
    await copyDirectoryStrict(sourceDir, bundlePath);

    const digest = await computeDirectoryDigest(bundlePath);
    const metadata: SkillVersionMetadata = {
      name: skillName,
      version,
      registryPath: canonicalRegistryPath(skillName, version),
      digest,
      buriedAt: new Date().toISOString(),
      sourceUrl,
      sourcePath: toPosix(sourcePath),
      sourceRef,
      sourceCommit,
    };

    await writeYamlFile(this.getMetadataPath(skillName, version), metadata);

    const index = await this.readOrCreateIndex(skillName);
    index.versions.push({
      version,
      metadataPath: toPosix(path.join(canonicalRegistryPath(skillName, version), "metadata.yaml")),
      digest,
      buriedAt: metadata.buriedAt,
    });
    index.versions = sortIndexVersions(index.versions);
    await writeYamlFile(this.getIndexPath(skillName), index);

    return {
      metadata,
      indexPath: this.getIndexPath(skillName),
      versionPath,
    };
  }

  private async readOrCreateIndex(skillName: string): Promise<SkillIndex> {
    const indexPath = this.getIndexPath(skillName);
    if (!(await pathExists(indexPath))) {
      return { name: skillName, versions: [] };
    }
    return readYamlFile(indexPath, indexSchema);
  }

  private getIndexPath(skillName: string) {
    return resolveInside(this.rootPath, "skills", skillName, "index.yaml");
  }

  private getMetadataPath(skillName: string, version: string) {
    return resolveInside(
      this.rootPath,
      canonicalRegistryPath(skillName, version),
      "metadata.yaml"
    );
  }

  private getBundlePath(skillName: string, version: string) {
    return resolveInside(this.rootPath, canonicalRegistryPath(skillName, version), "skill");
  }
}

function sortIndexVersions(versions: SkillIndexVersion[]) {
  return [...versions].sort((left, right) => {
    const semverComparison = compareSemverDescending(left.version, right.version);
    if (semverComparison !== 0) {
      return semverComparison;
    }
    return right.buriedAt.localeCompare(left.buriedAt);
  });
}

export async function openRegistryForRead(registryUrl: string): Promise<RegistryHandle> {
  if (await pathExists(registryUrl)) {
    const backend = new GitBundleRegistryBackend(path.resolve(registryUrl));
    await backend.validate();
    return {
      backend,
      cleanup: async () => {},
    };
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "skillpup-registry-"));
  const cloneDir = path.join(tempRoot, "registry");
  await ensureEmptyDir(tempRoot);
  await cloneRepo(registryUrl, cloneDir);
  const backend = new GitBundleRegistryBackend(cloneDir);
  await backend.validate();
  return {
    backend,
    cleanup: async () => {
      await fs.rm(tempRoot, { recursive: true, force: true });
    },
  };
}

export async function openRegistryForWrite(registryPath: string) {
  const backend = new GitBundleRegistryBackend(path.resolve(registryPath));
  await backend.validate();
  return backend;
}
