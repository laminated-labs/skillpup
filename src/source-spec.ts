export type ParsedGitHubTreeUrl = {
  repoUrl: string;
  refAndPathSegments: string[];
};

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
