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

// Tolerant of extra spacing and missing line counts/numbers. The applier no longer trusts the @@ line
// numbers (it searches for the context), so a garbled header still yields a usable hunk.
const hunkHeader = /^@@+\s*-(\d*)(?:,(\d+))?\s+\+(\d*)(?:,(\d+))?\s*@@/;

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
    // Tolerate a missing +++ header (some local models emit a single-sided header): fall back to the
    // old path as the new path instead of discarding the whole patch.
    let newPath = oldPath;
    if (index < lines.length && lines[index].startsWith("+++ ")) {
      newPath = cleanPath(lines[index].slice(4).trim());
      index++;
    }

    const hunks: DiffHunk[] = [];
    while (index < lines.length && !lines[index].startsWith("--- ")) {
      const line = lines[index];
      const match = hunkHeader.exec(line);
      if (!match) {
        index++;
        continue;
      }

      const oldStart = match[1] ? Number(match[1]) : NaN;
      const oldLines = match[2] ? Number(match[2]) : 1;
      const newStart = match[3] ? Number(match[3]) : NaN;
      const newLines = match[4] ? Number(match[4]) : 1;
      index++;
      const hunkLines: DiffLine[] = [];

      while (index < lines.length && !lines[index].startsWith("@@") && !lines[index].startsWith("--- ")) {
        const body = lines[index];
        if (body.startsWith("\\")) {
          index++;
          continue;
        }
        if (body.startsWith("+")) {
          hunkLines.push({ type: "add", text: body.slice(1) });
        } else if (body.startsWith("-")) {
          hunkLines.push({ type: "remove", text: body.slice(1) });
        } else if (body.startsWith(" ")) {
          hunkLines.push({ type: "context", text: body.slice(1) });
        } else if (body === "") {
          hunkLines.push({ type: "context", text: "" });
        } else {
          // A context line that lost its leading space (common when a model or markdown strips it).
          // Treat it as context rather than ending the hunk and dropping the rest of its lines.
          hunkLines.push({ type: "context", text: body });
        }
        index++;
      }

      hunks.push({ oldStart, oldLines, newStart, newLines, lines: hunkLines });
    }

    files.push({ oldPath, newPath, hunks });
  }

  return files;
}

// Apply a parsed file patch. Unlike a strict positional applier, this SEARCHES the file for each
// hunk's context/removed lines (the @@ line numbers are only a hint) and tolerates whitespace
// differences, because local models routinely emit slightly-off line numbers and reflowed whitespace.
// It never applies a hunk whose removed/context lines are not found, and it preserves the file's
// original line endings.
export function applyFilePatch(original: string, filePatch: FilePatch): string {
  const eol = detectEol(original);
  const originalLines = original.replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let cursor = 0;

  for (const hunk of filePatch.hunks) {
    const start = locateHunk(originalLines, hunk, cursor);
    if (start === undefined) {
      throw new Error(applyFailureMessage(filePatch.oldPath, hunk, originalLines));
    }

    for (let i = cursor; i < start; i++) {
      out.push(originalLines[i]);
    }

    // Context lines keep the FILE's actual text (so a whitespace-fuzzy match doesn't rewrite unrelated
    // lines); add lines come from the patch; remove lines consume a source line and emit nothing.
    let src = start;
    for (const line of hunk.lines) {
      if (line.type === "add") {
        out.push(line.text);
      } else if (line.type === "context") {
        out.push(src < originalLines.length ? originalLines[src] : line.text);
        src++;
      } else {
        src++;
      }
    }
    cursor = src;
  }

  for (let i = cursor; i < originalLines.length; i++) {
    out.push(originalLines[i]);
  }

  return out.join(eol);
}

export function targetPath(filePatch: FilePatch): string {
  return filePatch.newPath === "/dev/null" ? filePatch.oldPath : filePatch.newPath;
}

// Find where a hunk's context+removed block sits in the source. Returns the source index at which the
// block starts, or undefined if it cannot be located. Tries progressively looser whitespace matching,
// and within a tier picks the occurrence nearest the @@ hint so a duplicated block doesn't misapply.
function locateHunk(source: readonly string[], hunk: DiffHunk, minStart: number): number | undefined {
  const expected = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
  const hint = Number.isFinite(hunk.oldStart) ? Math.max(minStart, hunk.oldStart - 1) : minStart;

  if (expected.length === 0) {
    // Pure insertion: nothing to match — place it at the hint, never before already-consumed lines.
    return Math.min(Math.max(hint, minStart), source.length);
  }

  const lastStart = source.length - expected.length;
  for (let tier = 0; tier <= 2; tier++) {
    let best: number | undefined;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (let start = minStart; start <= lastStart; start++) {
      if (!matchesAt(source, expected, start, tier)) {
        continue;
      }
      const distance = Math.abs(start - hint);
      if (distance < bestDistance) {
        best = start;
        bestDistance = distance;
      }
    }
    if (best !== undefined) {
      return best;
    }
  }
  return undefined;
}

function matchesAt(source: readonly string[], expected: readonly string[], start: number, tier: number): boolean {
  for (let i = 0; i < expected.length; i++) {
    if (!lineMatches(source[start + i], expected[i], tier)) {
      return false;
    }
  }
  return true;
}

// tier 0: exact · tier 1: ignore trailing whitespace · tier 2: ignore all leading/trailing whitespace.
function lineMatches(actual: string | undefined, expected: string, tier: number): boolean {
  if (actual === undefined) {
    return false;
  }
  if (tier === 0) {
    return actual === expected;
  }
  if (tier === 1) {
    return actual.replace(/[ \t]+$/, "") === expected.replace(/[ \t]+$/, "");
  }
  return actual.trim() === expected.trim();
}

function applyFailureMessage(path: string, hunk: DiffHunk, source: readonly string[]): string {
  const expected = hunk.lines.filter((line) => line.type !== "add").map((line) => line.text);
  const at = Number.isFinite(hunk.oldStart) ? hunk.oldStart : 1;
  const windowStart = Math.max(0, at - 4);
  const windowEnd = Math.min(source.length, at + expected.length + 3);
  const near = source.slice(windowStart, windowEnd).map((line, i) => `${windowStart + i + 1}: ${line}`).join("\n");
  const where = Number.isFinite(hunk.oldStart) ? `near hunk starting at line ${hunk.oldStart}` : "for one hunk";
  return (
    `Patch does not apply to ${path} ${where}: could not find the hunk's context/removed lines in the file ` +
    `(searched the whole file and allowed whitespace differences). Re-read the file and re-issue the patch with ` +
    `exact context lines.\nFile contents near there:\n${near}`
  );
}

function detectEol(text: string): string {
  const crlf = (text.match(/\r\n/g) ?? []).length;
  const total = (text.match(/\n/g) ?? []).length;
  return crlf > total - crlf ? "\r\n" : "\n";
}

function cleanPath(path: string): string {
  const withoutTimestamp = path.split(/\t|  /, 1)[0];
  if (withoutTimestamp === "/dev/null") {
    return withoutTimestamp;
  }
  return withoutTimestamp.replace(/^a\//, "").replace(/^b\//, "");
}
