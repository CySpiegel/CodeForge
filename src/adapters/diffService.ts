import * as vscode from "vscode";
import { applyFilePatch, parseUnifiedDiff, targetPath } from "../core/unifiedDiff";
import { resolveWorkspaceUri } from "./vscodeWorkspace";

export class DiffPreviewProvider implements vscode.TextDocumentContentProvider {
  private readonly content = new Map<string, string>();
  private readonly changedEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changedEmitter.event;

  set(uri: vscode.Uri, value: string): void {
    this.content.set(uri.toString(), value);
    this.changedEmitter.fire(uri);
  }

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.content.get(uri.toString()) ?? "";
  }
}

export class DiffService {
  private readonly previews: DiffPreviewProvider;

  constructor(previews: DiffPreviewProvider) {
    this.previews = previews;
  }

  async previewPatch(patch: string): Promise<void> {
    const filePatches = parseUnifiedDiff(patch);
    if (filePatches.length === 0) {
      throw new Error("No file patches were found in the proposed diff.");
    }

    const first = filePatches[0];
    const path = targetPath(first);
    const originalUri = resolveWorkspaceUri(path);
    const original = await readFileIfExists(originalUri);
    const proposed = applyFilePatch(original, first);
    const previewUri = vscode.Uri.parse(`codeforge-preview:/${encodeURIComponent(path)}?${Date.now()}`);
    this.previews.set(previewUri, proposed);
    await vscode.commands.executeCommand("vscode.diff", originalUri, previewUri, `CodeForge Preview: ${path}`);

    if (filePatches.length > 1) {
      void vscode.window.showInformationMessage(`CodeForge opened the first of ${filePatches.length} proposed file changes. Approving applies all files.`);
    }
  }

  async applyPatch(patch: string): Promise<readonly string[]> {
    const filePatches = parseUnifiedDiff(patch);
    const edit = new vscode.WorkspaceEdit();
    const changedPaths: string[] = [];

    for (const filePatch of filePatches) {
      const path = targetPath(filePatch);
      const uri = resolveWorkspaceUri(path);
      const original = await readFileIfExists(uri);
      const proposed = applyFilePatch(original, filePatch);
      const fullRange = fullDocumentRange(original);
      if (original.length === 0) {
        edit.createFile(uri, { ignoreIfExists: true, overwrite: false });
      }
      edit.replace(uri, fullRange, proposed);
      changedPaths.push(path);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code rejected the workspace edit.");
    }
    return changedPaths;
  }
}

async function readFileIfExists(uri: vscode.Uri): Promise<string> {
  try {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
  } catch {
    return "";
  }
}

function fullDocumentRange(text: string): vscode.Range {
  const lines = text.split(/\r?\n/);
  const lastLine = Math.max(0, lines.length - 1);
  return new vscode.Range(new vscode.Position(0, 0), new vscode.Position(lastLine, lines[lastLine].length));
}
