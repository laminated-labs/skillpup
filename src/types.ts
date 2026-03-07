export type RegistryConfig = {
  type: "git";
  url: string;
};

export type SkillConfigEntry = {
  name: string;
  version?: string;
};

export type SkillpupConfig = {
  registry: RegistryConfig;
  skillsDir: string;
  skills: SkillConfigEntry[];
};

export type ResolvedSkillConfigEntry = {
  name: string;
  version: string;
};

export type LockfileEntry = {
  name: string;
  version: string;
  registryPath: string;
  digest: string;
  buriedAt: string;
  sourceUrl: string;
  sourcePath: string;
  sourceRef: string;
  sourceCommit: string;
};

export type SkillpupLockfile = {
  skills: LockfileEntry[];
};

export type RegistryRootMetadata = {
  schemaVersion: 1;
  backend: "git-bundle";
};

export type SkillIndexVersion = {
  version: string;
  metadataPath: string;
  digest: string;
  buriedAt: string;
};

export type SkillIndex = {
  name: string;
  versions: SkillIndexVersion[];
};

export type SkillVersionMetadata = LockfileEntry;

export type FetchResult = {
  configPath: string;
  lockfilePath: string;
  installed: SkillVersionMetadata[];
  removed: string[];
};

export type BuryAddResult = {
  metadata: SkillVersionMetadata;
  indexPath: string;
  versionPath: string;
};
