import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { z } from "zod";
import type {
  ArtifactKind,
  ArtifactVersionMetadata,
  RegistryRootMetadata,
  RefreshResult,
  SkillIndex,
  SkillIndexVersion,
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
  artifactBundleDirectory,
  artifactKindDirectory,
  canonicalRegistryPath,
  compareSemverDescending,
  formatArtifactKindLabel,
  resolveInside,
  toPosix,
  validateArtifactName,
} from "./utils.js";

const registryRootSchema = z.object({
  schemaVersion: z.literal(1),
  backend: z.literal("git-bundle"),
});

function shouldIgnorePublishedEntry(relativePath: string) {
  return relativePath === ".git";
}

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
  kind: z.enum(["skill", "subagent"]).default("skill"),
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
    await ensureDir(path.join(rootPath, "subagents"));
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
    return this.listVersionsForKind("skill", skillName);
  }

  async listVersionsForKind(
    kind: ArtifactKind,
    name: string
  ): Promise<SkillIndexVersion[]> {
    const indexPath = this.getIndexPath(kind, name);
    if (!(await pathExists(indexPath))) {
      return [];
    }
    const index = await readYamlFile(indexPath, indexSchema);
    return index.versions;
  }

  async listSkills() {
    return this.listArtifacts("skill");
  }

  async listArtifacts(kind: ArtifactKind) {
    const artifactsRoot = path.join(this.rootPath, artifactKindDirectory(kind));
    if (!(await pathExists(artifactsRoot))) {
      return [];
    }

    const entries = await fs.readdir(artifactsRoot, { withFileTypes: true });
    const artifacts: string[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (!(await pathExists(path.join(artifactsRoot, entry.name, "index.yaml")))) {
        continue;
      }

      artifacts.push(entry.name);
    }

    return artifacts.sort((left, right) => left.localeCompare(right));
  }

  async readVersionMetadata(skillName: string, version: string) {
    return this.readVersionMetadataForKind("skill", skillName, version);
  }

  async readVersionMetadataForKind(
    kind: ArtifactKind,
    name: string,
    version: string
  ) {
    const metadataPath = this.getMetadataPath(kind, name, version);
    if (!(await pathExists(metadataPath))) {
      throw new Error(
        `Missing ${formatArtifactKindLabel(kind)} version ${name}@${version} in registry`
      );
    }
    const metadata = await readYamlFile(metadataPath, metadataSchema);
    return {
      ...metadata,
      kind,
    } satisfies ArtifactVersionMetadata;
  }

  async readBundlePath(skillName: string, version: string) {
    return this.readBundlePathForKind("skill", skillName, version);
  }

  async readBundlePathForKind(kind: ArtifactKind, name: string, version: string) {
    const bundlePath = this.getBundlePath(kind, name, version);
    if (!(await pathExists(bundlePath))) {
      throw new Error(
        `Missing ${formatArtifactKindLabel(kind)} bundle for ${name}@${version}`
      );
    }
    return bundlePath;
  }

  async publishVersion(args: {
    kind: ArtifactKind;
    name: string;
    version: string;
    sourceDir: string;
    sourceUrl: string;
    sourcePath: string;
    sourceRef: string;
    sourceCommit: string;
  }): Promise<{
    metadata: ArtifactVersionMetadata;
    indexPath: string;
    versionPath: string;
  }> {
    const { kind, name, version, sourceDir, sourceUrl, sourcePath, sourceRef, sourceCommit } =
      args;
    validateArtifactName(name);

    const versionPath = resolveInside(
      this.rootPath,
      canonicalRegistryPath(name, version, kind)
    );
    if (await pathExists(versionPath)) {
      throw new Error(
        `Registry version already exists: ${formatArtifactKindLabel(kind)} ${name}@${version}`
      );
    }

    const bundlePath = path.join(versionPath, artifactBundleDirectory(kind));
    await ensureDir(versionPath);
    await copyDirectoryStrict(sourceDir, bundlePath, {
      shouldIgnore: shouldIgnorePublishedEntry,
    });

    const digest = await computeDirectoryDigest(bundlePath, {
      shouldIgnore: shouldIgnorePublishedEntry,
    });
    const metadata: ArtifactVersionMetadata = {
      kind,
      name,
      version,
      registryPath: canonicalRegistryPath(name, version, kind),
      digest,
      buriedAt: new Date().toISOString(),
      sourceUrl,
      sourcePath: toPosix(sourcePath),
      sourceRef,
      sourceCommit,
    };

    await writeYamlFile(this.getMetadataPath(kind, name, version), metadata);

    const index = await this.readOrCreateIndex(kind, name);
    index.versions.push({
      version,
      metadataPath: toPosix(path.join(canonicalRegistryPath(name, version, kind), "metadata.yaml")),
      digest,
      buriedAt: metadata.buriedAt,
    });
    index.versions = sortIndexVersions(index.versions);
    await writeYamlFile(this.getIndexPath(kind, name), index);

    return {
      metadata,
      indexPath: this.getIndexPath(kind, name),
      versionPath,
    };
  }

  async refreshVersion(
    kind: ArtifactKind,
    name: string,
    version: string
  ): Promise<RefreshResult> {
    validateArtifactName(name);

    const versionPath = resolveInside(
      this.rootPath,
      canonicalRegistryPath(name, version, kind)
    );
    if (!(await pathExists(versionPath))) {
      throw new Error(
        `Missing ${formatArtifactKindLabel(kind)} version ${name}@${version} in registry`
      );
    }

    const metadataPath = this.getMetadataPath(kind, name, version);
    const bundlePath = this.getBundlePath(kind, name, version);
    if (!(await this.hasExpectedBundleRoot(kind, name, bundlePath))) {
      throw new Error(
        `Buried ${formatArtifactKindLabel(kind)} ${name}@${version} is missing its expected root content`
      );
    }

    const metadata = await this.readVersionMetadataForKind(kind, name, version);
    const digest = await computeDirectoryDigest(bundlePath);
    if (digest === metadata.digest) {
      return {
        metadata,
        indexPath: this.getIndexPath(kind, name),
        versionPath,
        digestChanged: false,
      };
    }

    const refreshedMetadata: SkillVersionMetadata = {
      ...metadata,
      digest,
      buriedAt: new Date().toISOString(),
    };
    await writeYamlFile(metadataPath, refreshedMetadata);

    const index = await this.readOrCreateIndex(kind, name);
    const versionEntry = index.versions.find((entry) => entry.version === version);
    if (!versionEntry) {
      throw new Error(
        `Missing index entry for ${formatArtifactKindLabel(kind)} ${name}@${version}`
      );
    }

    versionEntry.digest = digest;
    versionEntry.buriedAt = refreshedMetadata.buriedAt;
    index.versions = sortIndexVersions(index.versions);
    await writeYamlFile(this.getIndexPath(kind, name), index);

    return {
      metadata: refreshedMetadata,
      indexPath: this.getIndexPath(kind, name),
      versionPath,
      digestChanged: true,
    };
  }

  private async readOrCreateIndex(kind: ArtifactKind, name: string): Promise<SkillIndex> {
    const indexPath = this.getIndexPath(kind, name);
    if (!(await pathExists(indexPath))) {
      return { name, versions: [] };
    }
    return readYamlFile(indexPath, indexSchema);
  }

  private getIndexPath(kind: ArtifactKind, name: string) {
    return resolveInside(this.rootPath, artifactKindDirectory(kind), name, "index.yaml");
  }

  private getMetadataPath(kind: ArtifactKind, name: string, version: string) {
    return resolveInside(
      this.rootPath,
      canonicalRegistryPath(name, version, kind),
      "metadata.yaml"
    );
  }

  private getBundlePath(kind: ArtifactKind, name: string, version: string) {
    return resolveInside(
      this.rootPath,
      canonicalRegistryPath(name, version, kind),
      artifactBundleDirectory(kind)
    );
  }

  private async hasExpectedBundleRoot(
    kind: ArtifactKind,
    name: string,
    bundlePath: string
  ) {
    const expectedPath =
      kind === "skill"
        ? path.join(bundlePath, "SKILL.md")
        : path.join(bundlePath, `${name}.toml`);
    return pathExists(expectedPath);
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
