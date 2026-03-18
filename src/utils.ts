import path from "node:path";
import semver from "semver";
import type { ArtifactKind } from "./types.js";

export const DEFAULT_SKILLS_DIR = ".agents/skills";
export const DEFAULT_SUBAGENTS_DIR = ".codex/agents";
export const CONFIG_FILE_BASENAME = "skillpup.config.yaml";
export const LOCKFILE_BASENAME = "skillpup.lock.yaml";
export const REGISTRY_FILE_BASENAME = "skillpup-registry.yaml";
export const skillNamePattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function toPosix(input: string) {
  return input.split(path.sep).join("/");
}

export function resolveInside(root: string, ...segments: string[]) {
  const resolved = path.resolve(root, ...segments);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Resolved path escapes root: ${resolved}`);
  }
  return resolved;
}

export function validateArtifactName(name: string) {
  if (!skillNamePattern.test(name)) {
    throw new Error(
      `Invalid artifact name "${name}". Names may contain letters, numbers, ".", "_" and "-".`
    );
  }
}

export const validateSkillName = validateArtifactName;

export function parseArtifactSpecifier(input: string): {
  kind?: ArtifactKind;
  name: string;
  version?: string;
} {
  let kind: ArtifactKind | undefined;
  let remainder = input;

  if (remainder.startsWith("skill:")) {
    kind = "skill";
    remainder = remainder.slice("skill:".length);
  } else if (remainder.startsWith("subagent:")) {
    kind = "subagent";
    remainder = remainder.slice("subagent:".length);
  }

  if (!remainder) {
    throw new Error(`Invalid artifact specifier "${input}".`);
  }

  const atIndex = remainder.lastIndexOf("@");
  if (atIndex <= 0) {
    validateArtifactName(remainder);
    return { kind, name: remainder };
  }

  const name = remainder.slice(0, atIndex);
  const version = remainder.slice(atIndex + 1);
  validateArtifactName(name);
  if (!version) {
    throw new Error(`Invalid artifact specifier "${input}".`);
  }

  return { kind, name, version };
}

export function parseSkillSpecifier(input: string) {
  const parsed = parseArtifactSpecifier(input);
  if (parsed.kind === "subagent") {
    throw new Error(`Invalid skill specifier "${input}".`);
  }

  return {
    name: parsed.name,
    version: parsed.version,
  };
}

export function formatArtifactRef(
  name: string,
  version: string,
  kind: ArtifactKind = "skill"
) {
  return kind === "skill" ? `${name}@${version}` : `subagent:${name}@${version}`;
}

export function formatArtifactSpecifier(
  name: string,
  kind: ArtifactKind,
  version?: string
) {
  const base = `${kind}:${name}`;
  return version ? `${base}@${version}` : base;
}

export function formatSkillRef(name: string, version: string) {
  return formatArtifactRef(name, version, "skill");
}

export function artifactKindDirectory(kind: ArtifactKind) {
  return kind === "skill" ? "skills" : "subagents";
}

export function artifactBundleDirectory(kind: ArtifactKind) {
  return kind === "skill" ? "skill" : "subagent";
}

export function canonicalRegistryPath(
  name: string,
  version: string,
  kind: ArtifactKind = "skill"
) {
  return `${artifactKindDirectory(kind)}/${name}/versions/${version}`;
}

export function formatArtifactKindLabel(kind: ArtifactKind) {
  return kind === "skill" ? "skill" : "subagent";
}

export function parseSemverLike(version: string) {
  const cleaned = semver.clean(version, { loose: true });
  return cleaned ? new semver.SemVer(cleaned) : null;
}

export function isSemverLike(version: string) {
  return parseSemverLike(version) !== null;
}

export function compareSemverDescending(left: string, right: string) {
  const leftParsed = parseSemverLike(left);
  const rightParsed = parseSemverLike(right);
  if (!leftParsed || !rightParsed) {
    return 0;
  }
  return semver.rcompare(leftParsed, rightParsed);
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}
