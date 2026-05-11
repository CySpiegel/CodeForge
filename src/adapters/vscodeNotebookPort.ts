import * as vscode from "vscode";
import { NotebookAction, NotebookPort } from "../core/notebooks";
import { resolveWorkspaceUri } from "./vscodeWorkspace";

export class VsCodeNotebookPort implements NotebookPort {
  async execute(action: NotebookAction, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error("Notebook request was cancelled.");
    }
    return action.type === "notebook_read"
      ? this.read(action.path)
      : this.editCell(action.path, action.index, action.content, action.language, action.kind);
  }

  private async read(path: string): Promise<string> {
    const document = await vscode.workspace.openNotebookDocument(resolveWorkspaceUri(path));
    const cells = document.getCells().map((cell, index) => {
      const kind = cell.kind === vscode.NotebookCellKind.Markup ? "markdown" : "code";
      const language = cell.document.languageId || "plaintext";
      return `Cell ${index} [${kind}/${language}]\n${clip(cell.document.getText(), 20000)}`;
    });
    return `notebook_read ${path}\n\n${cells.length > 0 ? cells.join("\n\n---\n\n") : "Notebook has no cells."}`;
  }

  private async editCell(path: string, index: number, content: string, language: string | undefined, kind: "code" | "markdown" | undefined): Promise<string> {
    const uri = resolveWorkspaceUri(path);
    const document = await vscode.workspace.openNotebookDocument(uri);
    if (index < 0 || index >= document.cellCount) {
      throw new Error(`Notebook cell index ${index} is outside the range 0-${Math.max(0, document.cellCount - 1)}.`);
    }

    const existing = document.cellAt(index);
    const nextKind = kind === "markdown"
      ? vscode.NotebookCellKind.Markup
      : kind === "code"
        ? vscode.NotebookCellKind.Code
        : existing.kind;
    const nextLanguage = language?.trim() || existing.document.languageId || "plaintext";
    const nextCell = new vscode.NotebookCellData(nextKind, content, nextLanguage);
    nextCell.metadata = existing.metadata;

    const edit = new vscode.WorkspaceEdit();
    edit.set(uri, [vscode.NotebookEdit.replaceCells(new vscode.NotebookRange(index, index + 1), [nextCell])]);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code rejected the notebook edit.");
    }
    await document.save();
    return `notebook_edit_cell ${path}:${index}\n\nUpdated cell ${index}.`;
  }
}

function clip(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  return `${Buffer.from(value).subarray(0, maxBytes).toString("utf8")}\n\n[CodeForge clipped this notebook cell.]`;
}
