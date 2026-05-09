import * as vscode from "vscode";
import { ContextItem, SearchResult, WorkspacePort } from "../core/types";

const excludePattern = "{**/.git/**,**/node_modules/**,**/out/**,**/dist/**,**/build/**,**/.vscode-test/**,**/*.png,**/*.jpg,**/*.jpeg,**/*.gif,**/*.webp,**/*.pdf,**/*.zip,**/*.wasm}";

export class VsCodeWorkspacePort implements WorkspacePort {
  async listTextFiles(limit: number, signal?: AbortSignal): Promise<readonly string[]> {
    const files = await vscode.workspace.findFiles("**/*", excludePattern, limit);
    if (signal?.aborted) {
      throw new Error("Context collection was cancelled.");
    }
    return files.map(toWorkspacePath).filter((path): path is string => Boolean(path)).sort();
  }

  async readTextFile(path: string, maxBytes: number, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error("File read was cancelled.");
    }
    const uri = resolveWorkspaceUri(path);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).subarray(0, maxBytes).toString("utf8");
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
    const files = await vscode.workspace.findFiles("**/*", excludePattern, 500);
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
}

export function resolveWorkspaceUri(path: string): vscode.Uri {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    throw new Error("CodeForge requires an open workspace folder for file operations.");
  }

  const cleanPath = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (cleanPath.includes("../") || cleanPath === "..") {
    throw new Error(`Refusing to access path outside the workspace: ${path}`);
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

function trim(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n\n[CodeForge clipped this content.]`;
}
