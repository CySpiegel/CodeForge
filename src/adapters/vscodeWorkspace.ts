import * as vscode from "vscode";
import { ContextItem, DiagnosticSeverity, SearchResult, WorkspaceDiagnostic, WorkspacePort } from "../core/types";
import { validateWorkspaceGlob, validateWorkspacePath } from "../core/toolRegistry";

const excludePattern = "{**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.vscode-test/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.webp,**/*.pdf,**/*.zip,**/*.wasm}";

export class VsCodeWorkspacePort implements WorkspacePort {
  async listTextFiles(limit: number, signal?: AbortSignal): Promise<readonly string[]> {
    return this.listFiles(undefined, limit, signal);
  }

  async listFiles(pattern: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly string[]> {
    const include = pattern?.trim() || "**/*";
    const validation = validateWorkspaceGlob(include);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const files = await vscode.workspace.findFiles(include, excludePattern, limit);
    if (signal?.aborted) {
      throw new Error("Context collection was cancelled.");
    }
    return files.map(toWorkspacePath).filter((path): path is string => Boolean(path)).sort();
  }

  async globFiles(pattern: string, limit: number, signal?: AbortSignal): Promise<readonly string[]> {
    return this.listFiles(pattern, limit, signal);
  }

  async readTextFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error("File read was cancelled.");
    }
    const uri = resolveWorkspaceUri(path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).subarray(0, maxBytes).toString("utf8");
  }

  async getActiveTextDocument(maxBytes: number): Promise<ContextItem | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || isIgnoredDocument(editor.document)) {
      return undefined;
    }

    const workspacePath = toWorkspacePath(editor.document.uri);
    const label = workspacePath ?? unsavedDocumentLabel(editor.document);
    const text = editor.document.getText();
    const content = text || emptyActiveDocumentNote(editor.document, workspacePath);
    return {
      kind: "activeFile",
      label,
      content: trim(content, maxBytes)
    };
  }

  async getOpenTextDocuments(maxBytesPerDocument: number): Promise<readonly ContextItem[]> {
    const items: ContextItem[] = [];
    for (const document of vscode.workspace.textDocuments) {
      if (document.isUntitled || document.uri.scheme !== "file" || isIgnoredDocument(document)) {
        continue;
      }
      const path = toWorkspacePath(document.uri);
      if (!path) {
        continue;
      }
      items.push({
        kind: "openFile",
        label: path,
        content: trim(document.getText(), maxBytesPerDocument)
      });
    }
    return items;
  }

  async getActiveSelection(maxBytes: number): Promise<ContextItem | undefined> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      return undefined;
    }

    const path = toWorkspacePath(editor.document.uri) ?? editor.document.fileName;
    return {
      kind: "selection",
      label: `${path}:${editor.selection.start.line + 1}`,
      content: trim(editor.document.getText(editor.selection), maxBytes)
    };
  }

  async searchText(query: string, limit: number, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    return this.grepText(query, undefined, limit, signal);
  }

  async grepText(query: string, include: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly SearchResult[]> {
    const pattern = include?.trim() || "**/*";
    const validation = validateWorkspaceGlob(pattern);
    if (!validation.ok) {
      throw new Error(validation.message);
    }
    const files = await vscode.workspace.findFiles(pattern, excludePattern, Math.max(500, limit * 20));
    const results: SearchResult[] = [];
    const lowered = query.toLowerCase();

    for (const uri of files) {
      if (signal?.aborted || results.length >= limit) {
        break;
      }
      let text: string;
      try {
        text = Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
      } catch {
        continue;
      }
      const lines = text.split(/\r?\n/);
      for (let index = 0; index < lines.length && results.length < limit; index++) {
        if (lines[index].toLowerCase().includes(lowered)) {
          const path = toWorkspacePath(uri);
          if (path) {
            results.push({ path, line: index + 1, preview: lines[index].trim().slice(0, 240) });
          }
        }
      }
    }

    return results;
  }

  async getDiagnostics(path: string | undefined, limit: number, signal?: AbortSignal): Promise<readonly WorkspaceDiagnostic[]> {
    if (signal?.aborted) {
      throw new Error("Diagnostics read was cancelled.");
    }
    const target = path ? resolveWorkspaceUri(path).toString() : undefined;
    const diagnostics: WorkspaceDiagnostic[] = [];
    for (const [uri, items] of vscode.languages.getDiagnostics()) {
      if (signal?.aborted || diagnostics.length >= limit) {
        break;
      }
      if (target && uri.toString() !== target) {
        continue;
      }
      const workspacePath = toWorkspacePath(uri);
      if (!workspacePath) {
        continue;
      }
      for (const diagnostic of items) {
        if (diagnostics.length >= limit) {
          break;
        }
        diagnostics.push({
          path: workspacePath,
          line: diagnostic.range.start.line + 1,
          character: diagnostic.range.start.character + 1,
          severity: diagnosticSeverity(diagnostic.severity),
          message: diagnostic.message,
          source: diagnostic.source,
          code: diagnostic.code === undefined ? undefined : String(typeof diagnostic.code === "object" ? diagnostic.code.value : diagnostic.code)
        });
      }
    }
    return diagnostics.sort(compareDiagnostics);
  }
}

export function resolveWorkspaceUri(path: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("CodeForge requires an open workspace folder for file operations.");
  }

  const cleanPath = path.replace(/\\/g, "/").replace(/^\/+/, "");
  const validation = validateWorkspacePath(path);
  if (!validation.ok) {
    throw new Error(validation.message ?? `Refusing to access unsafe workspace path: ${path}`);
  }

  return vscode.Uri.joinPath(workspaceFolder.uri, cleanPath);
}

export function toWorkspacePath(uri: vscode.Uri): string | undefined {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(uri);
  if (!workspaceFolder) {
    return undefined;
  }
  return vscode.workspace.asRelativePath(uri, false);
}

function isIgnoredDocument(document: vscode.TextDocument): boolean {
  return document.languageId === "Log" || document.uri.path.includes("/node_modules/");
}

function unsavedDocumentLabel(document: vscode.TextDocument): string {
  const language = document.languageId && document.languageId !== "plaintext" ? ` ${document.languageId}` : "";
  const name = document.fileName || "Untitled";
  return `Unsaved active${language} editor: ${name}`;
}

function emptyActiveDocumentNote(document: vscode.TextDocument, workspacePath: string | undefined): string {
  if (workspacePath) {
    return `[CodeForge active file is empty. Use write_file with path "${workspacePath}" when the user asks you to write content into this file.]`;
  }

  const language = document.languageId && document.languageId !== "plaintext" ? ` ${document.languageId}` : "";
  return `[CodeForge active${language} editor is unsaved and has no workspace path. Ask the user to save it inside the workspace before using write_file or edit_file.]`;
}

function trim(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n\n[CodeForge clipped this content.]`;
}

function diagnosticSeverity(severity: vscode.DiagnosticSeverity): DiagnosticSeverity {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    case vscode.DiagnosticSeverity.Hint:
      return "hint";
  }
}

function compareDiagnostics(left: WorkspaceDiagnostic, right: WorkspaceDiagnostic): number {
  return severityRank(left.severity) - severityRank(right.severity)
    || left.path.localeCompare(right.path)
    || left.line - right.line
    || left.character - right.character;
}

function severityRank(severity: DiagnosticSeverity): number {
  switch (severity) {
    case "error":
      return 0;
    case "warning":
      return 1;
    case "information":
      return 2;
    case "hint":
      return 3;
  }
}
