export interface FilePatch {
  readonly oldPath: string;
  readonly newPath: string;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffHunk {
  readonly oldStart: number;
  readonly oldLines: number;
  readonly newStart: number;
  readonly newLines: number;
  readonly lines: readonly DiffLine[];
}

export type DiffLine =
  | { readonly type: "context"; readonly text: string }
  | { readonly type: "add"; readonly text: string }
  | { readonly type: "remove"; readonly text: string };

const hunkHeader = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

export function parseUnifiedDiff(patch: string): readonly FilePatch[] {
  const lines = patch.replace(/\r\n/g, "\n").split("\n");
  const files: FilePatch[] = [];
  let index = 0;

  while (index < lines.length) {
    if (!lines[index].startsWith("--- ")) {
      index++;
      continue;
    }

    const oldPath = cleanPath(lines[index].slice(4).trim());
    index++;
    if (index >= lines.length || !lines[index].startsWith("+++ ")) {
      throw new Error("Invalid unified diff: missing +++ file header.");
    }
    const newPath = cleanPath(lines[index].slice(4).trim());
    index++;

    const hunks: DiffHunk[] = [];
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const match = hunkHeader.exec(lines[index]);
      if (!match) {
        index++;
        continue;
      }

      const oldStart = Number(match[1]);
      const oldLines = match[2] ? Number(match[2]) : 1;
      const newStart = Number(match[3]);
      const newLines = match[4] ? Number(match[4]) : 1;
      index++;
      const hunkLines: DiffLine[] = [];

      while (index < lines.length && !lines[index].startsWith("@@ ") && !lines[index].startsWith("--- ")) {
        const line = lines[index];
        if (line.startsWith("\\")) {
          index++;
          continue;
        }
        if (line.startsWith("+")) {
          hunkLines.push({ type: "add", text: line.slice(1) });
        } else if (line.startsWith("-")) {
          hunkLines.push({ type: "remove", text: line.slice(1) });
        } else if (line.startsWith(" ")) {
          hunkLines.push({ type: "context", text: line.slice(1) });
        } else if (line === "") {
          hunkLines.push({ type: "context", text: "" });
        } else {
          break;
        }
        index++;
      }

      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }

    files.push({ oldPath, newPath, hunks });
  }

  return files;
}

export function applyFilePatch(original: string, filePatch: FilePatch): string {
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");
  const result: string[] = [];
  let sourceIndex = 0;

  for (const hunk of filePatch.hunks) {
    const targetIndex = Math.max(0, hunk.oldStart - 1);
    while (sourceIndex < targetIndex) {
      result.push(originalLines[sourceIndex]);
      sourceIndex++;
    }

    for (const line of hunk.lines) {
      if (line.type === "context") {
        assertLine(originalLines[sourceIndex], line.text, filePatch.oldPath, hunk.oldStart);
        result.push(originalLines[sourceIndex]);
        sourceIndex++;
      } else if (line.type === "remove") {
        assertLine(originalLines[sourceIndex], line.text, filePatch.oldPath, hunk.oldStart);
        sourceIndex++;
      } else {
        result.push(line.text);
      }
    }
  }

  while (sourceIndex < originalLines.length) {
    result.push(originalLines[sourceIndex]);
    sourceIndex++;
  }

  return result.join("\n");
}

export function targetPath(filePatch: FilePatch): string {
  return filePatch.newPath === "/dev/null" ? filePatch.oldPath : filePatch.newPath;
}

function assertLine(actual: string | undefined, expected: string, path: string, hunkStart: number): void {
  if (actual !== expected) {
    throw new Error(`Patch does not apply to ${path} near hunk starting at line ${hunkStart}.`);
  }
}

function cleanPath(path: string): string {
  const withoutTimestamp = path.split(/\t|  /, 1)[0];
  if (withoutTimestamp === "/dev/null") {
    return withoutTimestamp;
  }
  return withoutTimestamp.replace(/^a\//, "").replace(/^b\//, "");
}
