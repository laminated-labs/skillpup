import path from "node:path";

export type HostedGitForge = "github" | "bitbucket-cloud";

export type ParsedHostedSourceViewUrl = {
  forge: HostedGitForge;
  owner: string;
  repo: string;
  repoFullName: string;
  repoUrl: string;
  repoUrls: string[];
  refAndPathSegments: string[];
};

export type HostedRepoRef = {
  forge: HostedGitForge;
  owner: string;
  repo: string;
  repoFullName: string;
};

const hostedForgeConfigs = [
  {
    forge: "github",
    hostname: "github.com",
    sourceViewSegment: "tree",
  },
  {
    forge: "bitbucket-cloud",
    hostname: "bitbucket.org",
    sourceViewSegment: "src",
  },
] as const satisfies Array<{
  forge: HostedGitForge;
  hostname: string;
  sourceViewSegment: string;
}>;

export function isScpLikeGitUrl(sourceUrl: string) {
  return /^[^@]+@[^:]+:.+/.test(sourceUrl);
}

export function isWindowsAbsolutePath(sourcePath: string) {
  return /^[a-zA-Z]:[\\/]/.test(sourcePath) || /^\\\\[^\\]+\\[^\\]+/.test(sourcePath);
}

export function isAbsoluteLocalSourcePath(sourcePath: string) {
  return path.isAbsolute(sourcePath) || isWindowsAbsolutePath(sourcePath);
}

function decodePathSegment(segment: string) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function splitDecodedPathSegments(pathname: string) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map(decodePathSegment);
}

function getHostedForgeConfig(hostname: string) {
  const normalizedHostname = hostname.toLowerCase();
  return hostedForgeConfigs.find((config) => config.hostname === normalizedHostname) ?? null;
}

function buildHostedRepoRef(
  forge: HostedGitForge,
  owner: string,
  repo: string
): HostedRepoRef {
  return {
    forge,
    owner,
    repo,
    repoFullName: `${owner}/${repo}`,
  };
}

function buildHostedCloneUrl(
  forge: HostedGitForge,
  owner: string,
  repo: string
) {
  const config = hostedForgeConfigs.find((entry) => entry.forge === forge)!;
  return `https://${config.hostname}/${owner}/${repo}.git`;
}

function buildHostedSshCloneUrl(
  forge: HostedGitForge,
  owner: string,
  repo: string
) {
  const config = hostedForgeConfigs.find((entry) => entry.forge === forge)!;
  return `git@${config.hostname}:${owner}/${repo}.git`;
}

function buildHostedCloneUrls(
  forge: HostedGitForge,
  owner: string,
  repo: string
) {
  return [buildHostedCloneUrl(forge, owner, repo), buildHostedSshCloneUrl(forge, owner, repo)];
}

export function parseHostedSourceViewUrl(source: string): ParsedHostedSourceViewUrl | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:") {
    return null;
  }

  const forgeConfig = getHostedForgeConfig(parsedUrl.hostname);
  if (!forgeConfig) {
    return null;
  }

  const segments = splitDecodedPathSegments(parsedUrl.pathname);
  if (segments.length < 4 || segments[2] !== forgeConfig.sourceViewSegment) {
    return null;
  }

  const [owner, repoName] = segments;
  const normalizedRepoName = repoName.replace(/\.git$/, "");
  const repoUrls = buildHostedCloneUrls(forgeConfig.forge, owner, normalizedRepoName);
  return {
    ...buildHostedRepoRef(forgeConfig.forge, owner, normalizedRepoName),
    repoUrl: repoUrls[0]!,
    repoUrls,
    refAndPathSegments: segments.slice(3),
  };
}

export function parseHostedRepoUrl(source: string): HostedRepoRef | null {
  const parsedSourceViewUrl = parseHostedSourceViewUrl(source);
  if (parsedSourceViewUrl) {
    return buildHostedRepoRef(
      parsedSourceViewUrl.forge,
      parsedSourceViewUrl.owner,
      parsedSourceViewUrl.repo
    );
  }

  if (isScpLikeGitUrl(source)) {
    const match = source.match(/^[^@]+@([^:]+):([^/]+)\/([^/]+?)(?:\.git)?$/);
    if (!match) {
      return null;
    }

    const [, hostname, owner, repo] = match;
    const forgeConfig = getHostedForgeConfig(hostname);
    if (!forgeConfig) {
      return null;
    }

    return buildHostedRepoRef(forgeConfig.forge, owner, repo);
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    return null;
  }

  const forgeConfig = getHostedForgeConfig(parsedUrl.hostname);
  if (!forgeConfig) {
    return null;
  }

  const segments = splitDecodedPathSegments(parsedUrl.pathname).map((segment) =>
    segment.replace(/\.git$/, "")
  );
  if (segments.length < 2 || segments.length > 2) {
    return null;
  }

  const [owner, repo] = segments;
  if (!owner || !repo) {
    return null;
  }

  return buildHostedRepoRef(forgeConfig.forge, owner, repo);
}

export async function splitHostedRefAndPath(
  refAndPathSegments: string[],
  refExists: (candidate: string) => Promise<boolean>
) {
  for (let index = refAndPathSegments.length; index >= 1; index -= 1) {
    const ref = refAndPathSegments.slice(0, index).join("/");
    if (!(await refExists(ref))) {
      continue;
    }

    const path = refAndPathSegments.slice(index).join("/");
    return {
      ref,
      path: path || undefined,
    };
  }

  return null;
}

export function normalizeStoredSourceUrl(sourceUrl: string, cwd: string) {
  if (parseHostedSourceViewUrl(sourceUrl) || isScpLikeGitUrl(sourceUrl)) {
    return sourceUrl;
  }

  if (isAbsoluteLocalSourcePath(sourceUrl)) {
    return sourceUrl;
  }

  try {
    const parsedUrl = new URL(sourceUrl);
    if (parsedUrl.protocol) {
      return sourceUrl;
    }
  } catch {
    // Fall through to local path normalization.
  }

  return path.resolve(cwd, sourceUrl);
}
