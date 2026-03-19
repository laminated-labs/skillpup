import fs from "node:fs/promises";
import path from "node:path";
import { pathExists } from "./fs-utils.js";
import { REGISTRY_FILE_BASENAME } from "./utils.js";

export async function findContainingRegistryRoot(targetPath: string) {
  let currentPath = path.resolve(targetPath);
  const stats = await fs.stat(currentPath).catch(() => null);
  if (stats?.isFile()) {
    currentPath = path.dirname(currentPath);
  }

  while (true) {
    const markerPath = path.join(currentPath, REGISTRY_FILE_BASENAME);
    if (await pathExists(markerPath)) {
      return currentPath;
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      return null;
    }
    currentPath = parentPath;
  }
}
