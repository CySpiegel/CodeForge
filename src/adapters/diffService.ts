import * as vscode from "vscode";
import { EditFileAction, WriteFileAction } from "../core/types";
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

  async previewWriteFile(action: WriteFileAction): Promise<void> {
    await this.previewTextChange(action.path, action.content, `CodeForge Preview: ${action.path}`);
  }

  async previewEditFile(action: EditFileAction): Promise<void> {
    const uri = resolveWorkspaceUri(action.path);
    const original = await readFileIfExists(uri);
    const proposed = applyTextEdit(original, action);
    await this.previewTextChange(action.path, proposed, `CodeForge Preview: ${action.path}`);
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

  async applyWriteFile(action: WriteFileAction): Promise<readonly string[]> {
    await this.applyTextChange(action.path, action.content);
    return [action.path];
  }

  async applyEditFile(action: EditFileAction): Promise<readonly string[]> {
    const uri = resolveWorkspaceUri(action.path);
    const original = await readFileIfExists(uri);
    await this.applyTextChange(action.path, applyTextEdit(original, action));
    return [action.path];
  }

  private async previewTextChange(path: string, proposed: string, title: string): Promise<void> {
    const originalUri = resolveWorkspaceUri(path);
    const previewUri = vscode.Uri.parse(`codeforge-preview:/${encodeURIComponent(path)}?${Date.now()}`);
    this.previews.set(previewUri, proposed);
    await vscode.commands.executeCommand("vscode.diff", originalUri, previewUri, title);
  }

  private async applyTextChange(path: string, proposed: string): Promise<void> {
    const uri = resolveWorkspaceUri(path);
    const original = await readFileIfExists(uri);
    const edit = new vscode.WorkspaceEdit();
    if (original.length === 0) {
      edit.createFile(uri, { ignoreIfExists: true, overwrite: false });
    }
    edit.replace(uri, fullDocumentRange(original), proposed);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code rejected the workspace edit.");
    }
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

function applyTextEdit(original: string, action: EditFileAction): string {
  const occurrences = countOccurrences(original, action.oldText);
  if (occurrences === 0) {
    throw new Error(`edit_file oldText was not found in ${action.path}.`);
  }
  if (!action.replaceAll && occurrences > 1) {
    throw new Error(`edit_file oldText appears ${occurrences} times in ${action.path}. Set replaceAll to true or provide a more specific oldText.`);
  }
  return action.replaceAll
    ? original.split(action.oldText).join(action.newText)
    : original.replace(action.oldText, action.newText);
}

function countOccurrences(value: string, search: string): number {
  if (!search) {
    return 0;
  }
  let count = 0;
  let index = value.indexOf(search);
  while (index !== -1) {
    count++;
    index = value.indexOf(search, index + search.length);
  }
  return count;
}
