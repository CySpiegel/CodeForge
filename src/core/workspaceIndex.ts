import { ContextItem, WorkspaceDiagnostic, WorkspacePort } from "./types";

export interface WorkspaceIndexOptions {
  readonly maxFiles: number;
  readonly maxAnalyzedFiles: number;
  readonly maxBytesPerFile: number;
}

export async function buildWorkspaceIndex(
  workspace: WorkspacePort,
  options: WorkspaceIndexOptions,
  signal?: AbortSignal
): Promise<ContextItem | undefined> {
  const files = await workspace.listTextFiles(options.maxFiles, signal);
  if (files.length === 0) {
    return undefined;
  }

  const diagnostics = await workspace.getDiagnostics(undefined, 40, signal).catch(() => []);
  const summaries = await summarizeFiles(workspace, files.slice(0, options.maxAnalyzedFiles), options.maxBytesPerFile, signal);
  const content = [
    `Total indexed files: ${files.length}`,
    `Primary directories: ${topEntries(files.map((file) => topDirectory(file)), 8).join(", ") || "(root only)"}`,
    `Languages: ${topEntries(files.map(fileExtension), 10).join(", ") || "unknown"}`,
    "",
    "Important files:",
    ...importantFiles(files).map((file) => `- ${file}`),
    "",
    "Diagnostics:",
    ...formatDiagnostics(diagnostics),
    "",
    "Code map:",
    ...summaries.flatMap(formatFileSummary)
  ].join("\n").trim();

  return {
    kind: "workspaceIndex",
    label: "Offline workspace index",
    content
  };
}

interface FileSummary {
  readonly path: string;
  readonly imports: readonly string[];
  readonly symbols: readonly string[];
}

async function summarizeFiles(
  workspace: WorkspacePort,
  files: readonly string[],
  maxBytesPerFile: number,
  signal?: AbortSignal
): Promise<readonly FileSummary[]> {
  const summaries: FileSummary[] = [];
  for (const path of files) {
    if (signal?.aborted) {
      throw new Error("Workspace index build was cancelled.");
    }
    try {
      const content = await workspace.readTextFile(path, maxBytesPerFile, signal);
      const imports = extractImports(content);
      const symbols = extractSymbols(content);
      if (imports.length > 0 || symbols.length > 0 || isImportantFile(path)) {
        summaries.push({ path, imports, symbols });
      }
    } catch {
      // Binary, generated, or unreadable files are still represented by the file list.
    }
  }
  return summaries;
}

function formatFileSummary(summary: FileSummary): readonly string[] {
  const lines = [`- ${summary.path}`];
  if (summary.symbols.length > 0) {
    lines.push(`  symbols: ${summary.symbols.slice(0, 12).join(", ")}`);
  }
  if (summary.imports.length > 0) {
    lines.push(`  imports: ${summary.imports.slice(0, 10).join(", ")}`);
  }
  return lines;
}

function extractImports(content: string): readonly string[] {
  const imports = new Set<string>();
  const patterns = [
    /\bimport\s+(?:[^"']+\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\(["']([^"']+)["']\)/g,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm,
    /^\s*import\s+([A-Za-z0-9_.]+)\s*$/gm,
    /^\s*#include\s+[<"]([^>"]+)[>"]/gm
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        imports.add(match[1]);
      }
    }
  }
  return [...imports].slice(0, 20);
}

function extractSymbols(content: string): readonly string[] {
  const symbols = new Set<string>();
  const patterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\b(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/g,
    /\bclass\s+([A-Za-z_$][\w$]*)/g,
    /\binterface\s+([A-Za-z_$][\w$]*)/g,
    /\btype\s+([A-Za-z_$][\w$]*)\s*=/g,
    /\bexport\s+const\s+([A-Za-z_$][\w$]*)/g,
    /^\s*(?:def|class)\s+([A-Za-z_][\w]*)/gm,
    /^\s*(?:func|type)\s+([A-Za-z_][\w]*)/gm
  ];
  for (const pattern of patterns) {
    for (const match of content.matchAll(pattern)) {
      if (match[1]) {
        symbols.add(match[1]);
      }
    }
  }
  return [...symbols].slice(0, 24);
}

function topEntries(values: readonly string[], limit: number): readonly string[] {
  const counts = new Map<string, number>();
  for (const value of values) {
    counts.set(value, (counts.get(value) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, limit)
    .map(([value, count]) => `${value} (${count})`);
}

function topDirectory(path: string): string {
  const [first] = path.split("/");
  return first && first.includes(".") ? "." : first || ".";
}

function fileExtension(path: string): string {
  const file = path.split("/").pop() ?? path;
  const index = file.lastIndexOf(".");
  return index > 0 ? file.slice(index + 1).toLowerCase() : "none";
}

function importantFiles(files: readonly string[]): readonly string[] {
  return files.filter(isImportantFile).slice(0, 20);
}

function isImportantFile(path: string): boolean {
  return /(^|\/)(package\.json|tsconfig\.json|README\.md|CODEFORGE\.md|Makefile|Cargo\.toml|go\.mod|pyproject\.toml|requirements\.txt|pom\.xml|build\.gradle|Dockerfile)$/i.test(path);
}

function formatDiagnostics(diagnostics: readonly WorkspaceDiagnostic[]): readonly string[] {
  if (diagnostics.length === 0) {
    return ["- none reported by VS Code"];
  }
  return diagnostics.slice(0, 16).map((diagnostic) => (
    `- ${diagnostic.severity} ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.message}`
  ));
}
