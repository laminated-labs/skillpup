export type ArtifactKind = "skill" | "subagent";

export type RegistryConfig = {
  type: "git";
  url: string;
};

export type ArtifactConfigEntry = {
  name: string;
  version?: string;
};

export type SkillConfigEntry = ArtifactConfigEntry;
export type SubagentConfigEntry = ArtifactConfigEntry;

export type SkillpupConfig = {
  registry: RegistryConfig;
  skillsDir: string;
  skills: SkillConfigEntry[];
  subagentsDir: string;
  subagents: SubagentConfigEntry[];
};

export type ResolvedSkillConfigEntry = {
  name: string;
  version: string;
};

export type ResolvedArtifactConfigEntry = {
  kind: ArtifactKind;
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

export type ArtifactVersionMetadata = LockfileEntry & {
  kind: ArtifactKind;
};

export type SkillpupLockfile = {
  skills: LockfileEntry[];
  subagents: LockfileEntry[];
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

export type SkillVersionMetadata = ArtifactVersionMetadata;

export type FetchResult = {
  configPath: string;
  lockfilePath: string;
  installed: ArtifactVersionMetadata[];
  removed: Array<{ kind: ArtifactKind; name: string }>;
};

export type BuryAddResult = {
  metadata: ArtifactVersionMetadata;
  indexPath: string;
  versionPath: string;
};

export type RefreshResult = {
  metadata: ArtifactVersionMetadata;
  indexPath: string;
  versionPath: string;
  digestChanged: boolean;
};
