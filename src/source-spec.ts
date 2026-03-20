import path from "node:path";

export type ParsedGitHubTreeUrl = {
  repoUrl: string;
  refAndPathSegments: string[];
};

export type GitHubRepoRef = {
  owner: string;
  repo: string;
  repoFullName: string;
};

export function isScpLikeGitUrl(sourceUrl: string) {
  return /^[^@]+@[^:]+:.+/.test(sourceUrl);
}

export function isWindowsAbsolutePath(sourcePath: string) {
  return /^[a-zA-Z]:[\\/]/.test(sourcePath) || /^\\\\[^\\]+\\[^\\]+/.test(sourcePath);
}

export function isAbsoluteLocalSourcePath(sourcePath: string) {
  return path.isAbsolute(sourcePath) || isWindowsAbsolutePath(sourcePath);
}

export function parseGitHubTreeUrl(source: string): ParsedGitHubTreeUrl | null {
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    return null;
  }

  if (parsedUrl.protocol !== "https:" || parsedUrl.hostname !== "github.com") {
    return null;
  }

  const segments = parsedUrl.pathname.split("/").filter(Boolean);
  if (segments.length < 4 || segments[2] !== "tree") {
    return null;
  }

  const [owner, repoName] = segments;
  return {
    repoUrl: `https://github.com/${owner}/${repoName}.git`,
    refAndPathSegments: segments.slice(3),
  };
}

export function parseGitHubRepoUrl(source: string): GitHubRepoRef | null {
  const parsedTreeUrl = parseGitHubTreeUrl(source);
  if (parsedTreeUrl) {
    return parseGitHubRepoUrl(parsedTreeUrl.repoUrl);
  }

  if (isScpLikeGitUrl(source)) {
    const match = source.match(/^[^@]+@github\.com:([^/]+)\/(.+?)(?:\.git)?$/);
    if (!match) {
      return null;
    }

    const [, owner, repo] = match;
    return {
      owner,
      repo,
      repoFullName: `${owner}/${repo}`,
    };
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(source);
  } catch {
    return null;
  }

  if (parsedUrl.hostname !== "github.com") {
    return null;
  }

  const segments = parsedUrl.pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => segment.replace(/\.git$/, ""));
  if (segments.length < 2) {
    return null;
  }

  const [owner, repo] = segments;
  if (!owner || !repo) {
    return null;
  }

  return {
    owner,
    repo,
    repoFullName: `${owner}/${repo}`,
  };
}

export async function splitGitHubTreeRefAndPath(
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
  if (parseGitHubTreeUrl(sourceUrl) || isScpLikeGitUrl(sourceUrl)) {
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
