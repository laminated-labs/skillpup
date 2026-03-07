import path from "node:path";
import semver from "semver";

export const DEFAULT_SKILLS_DIR = ".agent/skills";
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

export function validateSkillName(name: string) {
  if (!skillNamePattern.test(name)) {
    throw new Error(
      `Invalid skill name "${name}". Names may contain letters, numbers, ".", "_" and "-".`
    );
  }
}

export function parseSkillSpecifier(input: string) {
  const atIndex = input.lastIndexOf("@");
  if (atIndex <= 0) {
    validateSkillName(input);
    return { name: input };
  }

  const name = input.slice(0, atIndex);
  const version = input.slice(atIndex + 1);
  validateSkillName(name);
  if (!version) {
    throw new Error(`Invalid skill specifier "${input}".`);
  }

  return { name, version };
}

export function formatSkillRef(name: string, version: string) {
  return `${name}@${version}`;
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

export function canonicalRegistryPath(name: string, version: string) {
  return `skills/${name}/versions/${version}`;
}

export function uniqueStrings(values: string[]) {
  return Array.from(new Set(values));
}
