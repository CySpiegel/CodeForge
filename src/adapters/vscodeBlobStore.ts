import * as vscode from "vscode";
import { BinaryStore } from "../core/holographic/sqlite";

// Persists the holographic SQLite database (raw bytes from sql.js `db.export()`) under the extension's
// global storage, so durable memory follows the user across workspaces. Fault-tolerant: a missing or
// unreadable file loads as empty (a fresh database).
export class VsCodeBlobStore implements BinaryStore {
  constructor(private readonly context: vscode.ExtensionContext, private readonly fileName: string) {}

  private uri(): vscode.Uri {
    return vscode.Uri.joinPath(this.context.globalStorageUri, this.fileName);
  }

  async load(): Promise<Uint8Array | undefined> {
    try {
      return await vscode.workspace.fs.readFile(this.uri());
    } catch {
      return undefined;
    }
  }

  async save(bytes: Uint8Array): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.context.globalStorageUri);
    await vscode.workspace.fs.writeFile(this.uri(), bytes);
  }
}
