import * as vscode from "vscode";
import { CodeIntelAction, CodeIntelPort } from "../core/codeIntel";
import { resolveWorkspaceUri, toWorkspacePath } from "./vscodeWorkspace";

export class VsCodeCodeIntelPort implements CodeIntelPort {
  async execute(action: CodeIntelAction, signal?: AbortSignal): Promise<string> {
    if (signal?.aborted) {
      throw new Error("Code intelligence request was cancelled.");
    }

    switch (action.type) {
      case "code_hover":
        return this.hover(action.path, action.line, action.character);
      case "code_definition":
        return this.definitions(action.path, action.line, action.character);
      case "code_references":
        return this.references(action.path, action.line, action.character, action.includeDeclaration ?? false);
      case "code_symbols":
        return this.symbols(action.path, action.query);
    }
  }

  private async hover(path: string, line: number, character: number): Promise<string> {
    const uri = resolveWorkspaceUri(path);
    const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
      "vscode.executeHoverProvider",
      uri,
      position(line, character)
    );
    if (!hovers || hovers.length === 0) {
      return `code_hover ${path}:${line}:${character}\n\nNo hover information.`;
    }
    const lines = hovers.flatMap((hover) => hover.contents.map(markedStringText)).filter(Boolean);
    return `code_hover ${path}:${line}:${character}\n\n${lines.join("\n\n") || "No hover information."}`;
  }

  private async definitions(path: string, line: number, character: number): Promise<string> {
    const uri = resolveWorkspaceUri(path);
    const definitions = await vscode.commands.executeCommand<readonly (vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      uri,
      position(line, character)
    );
    return `code_definition ${path}:${line}:${character}\n\n${formatLocations(definitions)}`;
  }

  private async references(path: string, line: number, character: number, includeDeclaration: boolean): Promise<string> {
    const uri = resolveWorkspaceUri(path);
    const references = await vscode.commands.executeCommand<readonly vscode.Location[]>(
      "vscode.executeReferenceProvider",
      uri,
      position(line, character),
      { includeDeclaration }
    );
    return `code_references ${path}:${line}:${character}\n\n${formatLocations(references)}`;
  }

  private async symbols(path: string | undefined, query: string | undefined): Promise<string> {
    if (path) {
      const uri = resolveWorkspaceUri(path);
      const symbols = await vscode.commands.executeCommand<readonly vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      );
      return `code_symbols ${path}\n\n${formatDocumentSymbols(symbols)}`;
    }

    const symbols = await vscode.commands.executeCommand<readonly vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      query ?? ""
    );
    return `code_symbols ${query ?? ""}\n\n${formatWorkspaceSymbols(symbols)}`;
  }
}

function position(line: number, character: number): vscode.Position {
  return new vscode.Position(Math.max(0, line - 1), Math.max(0, character - 1));
}

function markedStringText(value: vscode.MarkdownString | vscode.MarkedString): string {
  if (value instanceof vscode.MarkdownString) {
    return value.value;
  }
  if (typeof value === "string") {
    return value;
  }
  return `\`\`\`${value.language}\n${value.value}\n\`\`\``;
}

function formatLocations(locations: readonly (vscode.Location | vscode.LocationLink)[] | undefined): string {
  if (!locations || locations.length === 0) {
    return "No locations.";
  }
  return locations.slice(0, 80).map((location) => {
    const uri = "uri" in location ? location.uri : location.targetUri;
    const range = "range" in location ? location.range : location.targetSelectionRange ?? location.targetRange;
    const path = toWorkspacePath(uri) ?? uri.toString();
    return `${path}:${range.start.line + 1}:${range.start.character + 1}`;
  }).join("\n");
}

function formatDocumentSymbols(symbols: readonly vscode.DocumentSymbol[] | undefined): string {
  if (!symbols || symbols.length === 0) {
    return "No symbols.";
  }
  const lines: string[] = [];
  const visit = (symbol: vscode.DocumentSymbol, depth: number) => {
    if (lines.length >= 120) {
      return;
    }
    lines.push(`${"  ".repeat(depth)}${symbol.name} (${symbolKindName(symbol.kind)}) ${symbol.range.start.line + 1}:${symbol.range.start.character + 1}`);
    for (const child of symbol.children) {
      visit(child, depth + 1);
    }
  };
  for (const symbol of symbols) {
    visit(symbol, 0);
  }
  return lines.join("\n");
}

function formatWorkspaceSymbols(symbols: readonly vscode.SymbolInformation[] | undefined): string {
  if (!symbols || symbols.length === 0) {
    return "No symbols.";
  }
  return symbols.slice(0, 120).map((symbol) => {
    const path = toWorkspacePath(symbol.location.uri) ?? symbol.location.uri.toString();
    return `${symbol.name} (${symbolKindName(symbol.kind)}) ${path}:${symbol.location.range.start.line + 1}:${symbol.location.range.start.character + 1}`;
  }).join("\n");
}

function symbolKindName(kind: vscode.SymbolKind): string {
  return vscode.SymbolKind[kind] ?? String(kind);
}
