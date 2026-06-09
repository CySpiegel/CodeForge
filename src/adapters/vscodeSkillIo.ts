import * as vscode from "vscode";
import { SKILLS_ROOT, SkillIo } from "../core/skillIo";

// SkillIo implemented over the VS Code filesystem API, rooted at the first workspace folder.
// Used for skill authoring (skill_manage) and the usage sidecar, which the read-only WorkspacePort
// and the tracked-file DiffService do not cover.
export class VsCodeSkillIo implements SkillIo {
  private root(): vscode.Uri | undefined {
    return (vscode.workspace.workspaceFolders ?? [])[0]?.uri;
  }

  private uri(relPath: string): vscode.Uri | undefined {
    const root = this.root();
    if (!root) {
      return undefined;
    }
    return vscode.Uri.joinPath(root, ...relPath.split("/").filter(Boolean));
  }

  async read(relPath: string): Promise<string | undefined> {
    const uri = this.uri(relPath);
    if (!uri) {
      return undefined;
    }
    try {
      return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString("utf8");
    } catch {
      return undefined;
    }
  }

  async write(relPath: string, content: string): Promise<void> {
    const uri = this.uri(relPath);
    if (!uri) {
      throw new Error("Open a workspace folder before saving skills.");
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(uri, ".."));
    await vscode.workspace.fs.writeFile(uri, Buffer.from(content, "utf8"));
  }

  async remove(relPath: string): Promise<void> {
    const uri = this.uri(relPath);
    if (!uri) {
      return;
    }
    try {
      await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
    } catch {
      // Already gone — nothing to remove.
    }
  }

  async move(fromRel: string, toRel: string): Promise<void> {
    const from = this.uri(fromRel);
    const to = this.uri(toRel);
    if (!from || !to) {
      throw new Error("Open a workspace folder before moving skills.");
    }
    await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(to, ".."));
    await vscode.workspace.fs.rename(from, to, { overwrite: true });
  }

  async exists(relPath: string): Promise<boolean> {
    const uri = this.uri(relPath);
    if (!uri) {
      return false;
    }
    try {
      await vscode.workspace.fs.stat(uri);
      return true;
    } catch {
      return false;
    }
  }

  async listAll(relPath: string): Promise<readonly string[]> {
    const out: string[] = [];
    const walk = async (dirRel: string): Promise<void> => {
      const uri = this.uri(dirRel);
      if (!uri) {
        return;
      }
      let entries: [string, vscode.FileType][];
      try {
        entries = await vscode.workspace.fs.readDirectory(uri);
      } catch {
        return;
      }
      for (const [name, type] of entries) {
        const childRel = `${dirRel}/${name}`;
        if (type === vscode.FileType.Directory) {
          await walk(childRel);
        } else if (type === vscode.FileType.File) {
          out.push(childRel);
        }
      }
    };
    await walk(relPath.replace(/\/+$/, ""));
    return out;
  }

  async listSkillNames(): Promise<readonly string[]> {
    const uri = this.uri(SKILLS_ROOT);
    if (!uri) {
      return [];
    }
    try {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      const names = new Set<string>();
      for (const [entryName, type] of entries) {
        if (entryName.startsWith(".")) {
          continue;
        }
        if (type === vscode.FileType.Directory) {
          names.add(entryName);
        } else if (type === vscode.FileType.File && entryName.endsWith(".md")) {
          names.add(entryName.slice(0, -3));
        }
      }
      return [...names];
    } catch {
      return [];
    }
  }
}
