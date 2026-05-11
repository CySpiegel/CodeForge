export function workspacePathCandidates(rawPath: string, workspaceFolderNames: readonly string[] = []): readonly string[] {
  const normalized = normalizeWorkspacePathInput(rawPath);
  const withoutPosition = stripTrailingPosition(normalized);
  const baseCandidates = uniqueStrings([normalized, withoutPosition].filter((path) => path.length > 0));
  const candidates: string[] = [];

  for (const candidate of baseCandidates) {
    candidates.push(candidate);
    if (isAbsoluteLike(candidate) || isFileUri(candidate)) {
      continue;
    }

    const clean = candidate.replace(/^\/+/, "").replace(/^\.\//, "");
    candidates.push(clean);
    for (const folderName of workspaceFolderNames) {
      const normalizedFolderName = folderName.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      if (!normalizedFolderName) {
        continue;
      }
      if (clean === normalizedFolderName) {
        candidates.push("");
      } else if (clean.toLowerCase().startsWith(`${normalizedFolderName.toLowerCase()}/`)) {
        candidates.push(clean.slice(normalizedFolderName.length + 1));
      }
    }
  }

  return uniqueStrings(candidates.filter((path) => path.length > 0));
}

export function normalizeWorkspacePathInput(rawPath: string): string {
  let path = rawPath.trim().replace(/\\/g, "/");
  path = stripMatchingWrapper(path, "`", "`");
  path = stripMatchingWrapper(path, "\"", "\"");
  path = stripMatchingWrapper(path, "'", "'");
  path = stripMatchingWrapper(path, "<", ">");
  return path.trim();
}

function stripTrailingPosition(path: string): string {
  if (isFileUri(path)) {
    return path.replace(/:(\d+)(?::\d+)?$/, "");
  }
  if (/^[A-Za-z]:\/?$/.test(path)) {
    return path;
  }
  return path.replace(/:(\d+)(?::\d+)?$/, "");
}

function stripMatchingWrapper(path: string, start: string, end: string): string {
  return path.startsWith(start) && path.endsWith(end) && path.length >= start.length + end.length
    ? path.slice(start.length, path.length - end.length)
    : path;
}

function isAbsoluteLike(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:\//.test(path);
}

function isFileUri(path: string): boolean {
  return /^file:\/\//i.test(path);
}

function uniqueStrings(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values) {
    if (!seen.has(value)) {
      seen.add(value);
      result.push(value);
    }
  }
  return result;
}
