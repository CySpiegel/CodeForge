import * as vscode from "vscode";
import { EditFileAction, WriteFileAction } from "../core/types";
import { applyFilePatch, parseUnifiedDiff, targetPath } from "../core/unifiedDiff";
import { resolveWorkspaceUri } from "./vscodeWorkspace";

export class EditFileMatchError extends Error {
  readonly modelRecoverableToolError = true;

  constructor(message: string) {
    super(message);
    this.name = "EditFileMatchError";
  }
}

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
    const changedUris: vscode.Uri[] = [];

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
      changedUris.push(uri);
    }

    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      throw new Error("VS Code rejected the workspace edit.");
    }
    await saveAppliedUris(changedUris);
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
    await saveAppliedUris([uri]);
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
  const actualOldText = findActualOldText(original, action.oldText);
  if (!actualOldText) {
    throw new EditFileMatchError(editTextNotFoundMessage(original, action));
  }

  const actualNewText = preserveQuoteStyle(action.oldText, actualOldText, action.newText);
  const occurrences = countOccurrences(original, actualOldText);
  if (occurrences === 0) {
    throw new EditFileMatchError(editTextNotFoundMessage(original, action));
  }
  if (!action.replaceAll && occurrences > 1) {
    throw new EditFileMatchError(`edit_file oldText appears ${occurrences} times in ${action.path}. Set replaceAll to true or provide a more specific oldText.\n\nRequested oldText:\n${action.oldText}`);
  }
  return action.replaceAll
    ? original.split(actualOldText).join(actualNewText)
    : original.replace(actualOldText, actualNewText);
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

function findActualOldText(fileContent: string, search: string): string | undefined {
  if (!search) {
    return undefined;
  }
  if (fileContent.includes(search)) {
    return search;
  }

  const lineEndingAdjusted = search.includes("\n") ? search.replace(/\r?\n/g, fileContent.includes("\r\n") ? "\r\n" : "\n") : search;
  if (lineEndingAdjusted !== search && fileContent.includes(lineEndingAdjusted)) {
    return lineEndingAdjusted;
  }

  const desanitized = desanitize(search);
  if (desanitized !== search && fileContent.includes(desanitized)) {
    return desanitized;
  }

  const normalizedSearch = normalizeQuotes(search);
  const normalizedFile = normalizeQuotes(fileContent);
  const normalizedIndex = normalizedFile.indexOf(normalizedSearch);
  if (normalizedIndex !== -1) {
    return fileContent.slice(normalizedIndex, normalizedIndex + search.length);
  }

  return undefined;
}

function editTextNotFoundMessage(original: string, action: EditFileAction): string {
  return [
    `edit_file oldText was not found in ${action.path}.`,
    "",
    "The file changed or the model used stale/imprecise text. Do not ask the user to approve this edit again unchanged.",
    "Read the current file contents and retry with an exact oldText copied from the current file.",
    "",
    "Requested oldText:",
    action.oldText,
    "",
    "Current file excerpts that may be relevant:",
    relevantFileExcerpts(original, action.oldText)
  ].join("\n");
}

function relevantFileExcerpts(fileContent: string, search: string): string {
  const lines = fileContent.split(/\r?\n/);
  if (lines.length === 0) {
    return "(file is empty)";
  }

  const needles = distinctiveNeedles(search);
  const matchingLineIndexes = new Set<number>();
  for (const needle of needles) {
    const normalizedNeedle = normalizeForLooseLineMatch(needle);
    if (!normalizedNeedle) {
      continue;
    }
    for (let index = 0; index < lines.length; index++) {
      const normalizedLine = normalizeForLooseLineMatch(lines[index]);
      if (normalizedLine.includes(normalizedNeedle) || normalizedNeedle.includes(normalizedLine)) {
        matchingLineIndexes.add(index);
        break;
      }
    }
  }

  const centers = matchingLineIndexes.size > 0 ? [...matchingLineIndexes].slice(0, 3) : [0];
  const chunks = centers.map((center) => numberedSnippet(lines, Math.max(0, center - 4), Math.min(lines.length, center + 5)));
  return chunks.join("\n\n---\n\n");
}

function distinctiveNeedles(search: string): readonly string[] {
  const unique = new Set<string>();
  for (const line of search.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.length >= 8) {
      unique.add(trimmed);
    }
    if (unique.size >= 4) {
      break;
    }
  }
  if (unique.size === 0 && search.trim()) {
    unique.add(search.trim().slice(0, 80));
  }
  return [...unique];
}

function numberedSnippet(lines: readonly string[], start: number, end: number): string {
  return lines.slice(start, end).map((line, offset) => `${start + offset + 1}: ${line}`).join("\n");
}

function normalizeForLooseLineMatch(value: string): string {
  return normalizeQuotes(value).replace(/\s+/g, " ").trim().toLowerCase();
}

function normalizeQuotes(value: string): string {
  return value
    .replaceAll("‘", "'")
    .replaceAll("’", "'")
    .replaceAll("“", "\"")
    .replaceAll("”", "\"");
}

function preserveQuoteStyle(oldText: string, actualOldText: string, newText: string): string {
  if (oldText === actualOldText) {
    return newText;
  }
  let result = newText;
  if (actualOldText.includes("“") || actualOldText.includes("”")) {
    result = replaceDirectionalQuotes(result, "\"", "“", "”");
  }
  if (actualOldText.includes("‘") || actualOldText.includes("’")) {
    result = replaceDirectionalQuotes(result, "'", "‘", "’");
  }
  return result;
}

function replaceDirectionalQuotes(value: string, straight: string, open: string, close: string): string {
  let opening = true;
  let result = "";
  for (const char of value) {
    if (char !== straight) {
      result += char;
      continue;
    }
    result += opening ? open : close;
    opening = !opening;
  }
  return result;
}

function desanitize(value: string): string {
  const replacements: ReadonlyArray<readonly [string, string]> = [
    ["<fnr>", "<function_results>"],
    ["<n>", "<name>"],
    ["</n>", "</name>"],
    ["<o>", "<output>"],
    ["</o>", "</output>"],
    ["<e>", "<error>"],
    ["</e>", "</error>"],
    ["<s>", "<system>"],
    ["</s>", "</system>"],
    ["<r>", "<result>"],
    ["</r>", "</result>"],
    ["< META_START >", "<META_START>"],
    ["< META_END >", "<META_END>"],
    ["< EOT >", "<EOT>"],
    ["< META >", "<META>"],
    ["< SOS >", "<SOS>"]
  ];
  let result = value;
  for (const [from, to] of replacements) {
    result = result.split(from).join(to);
  }
  return result;
}

async function saveAppliedUris(uris: readonly vscode.Uri[]): Promise<void> {
  for (const uri of uris) {
    const document = await vscode.workspace.openTextDocument(uri);
    if (document.isDirty) {
      const saved = await document.save();
      if (!saved) {
        throw new Error(`VS Code applied edits to ${uri.fsPath || uri.toString()} but did not save them.`);
      }
    }
  }
}
