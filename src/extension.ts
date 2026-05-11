import * as vscode from "vscode";
import { AgentController, AgentUiState } from "./agent/agentController";
import { DiffPreviewProvider, DiffService } from "./adapters/diffService";
import { TerminalRunner } from "./adapters/terminalRunner";
import { CodeForgeConfigService } from "./adapters/vscodeConfig";
import { VsCodeCodeIntelPort } from "./adapters/vscodeCodeIntel";
import { VsCodeMemoryStore } from "./adapters/vscodeMemoryStore";
import { VsCodeNotebookPort } from "./adapters/vscodeNotebookPort";
import { VsCodeSessionStore } from "./adapters/vscodeSessionStore";
import { VsCodeWorkspacePort } from "./adapters/vscodeWorkspace";
import { CodeForgeViewProvider } from "./ui/codeForgeViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const config = new CodeForgeConfigService(context.secrets);
  const workspace = new VsCodeWorkspacePort();
  const terminal = new TerminalRunner();
  const previewProvider = new DiffPreviewProvider();
  const diff = new DiffService(previewProvider);
  const sessions = new VsCodeSessionStore(context);
  const memories = new VsCodeMemoryStore(context);
  const codeIntel = new VsCodeCodeIntelPort();
  const notebooks = new VsCodeNotebookPort();
  const controller = new AgentController(config, workspace, terminal, diff, sessions, memories, codeIntel, notebooks);
  const viewProvider = new CodeForgeViewProvider(context.extensionUri, controller);
  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.name = "CodeForge";
  statusBar.command = "codeforge.openChat";
  statusBar.text = "$(code) CodeForge";
  statusBar.tooltip = "Open CodeForge";
  statusBar.show();
  const disposeStatusListener = controller.onEvent((event) => {
    if (event.type === "state") {
      updateStatusBar(statusBar, event.state);
    }
  });
  void controller.initializeSession();

  context.subscriptions.push(
    statusBar,
    new vscode.Disposable(disposeStatusListener),
    vscode.workspace.registerTextDocumentContentProvider("codeforge-preview", previewProvider),
    vscode.window.registerWebviewViewProvider(CodeForgeViewProvider.viewType, viewProvider),
    vscode.commands.registerCommand("codeforge.openChat", () => viewProvider.focus()),
    vscode.commands.registerCommand("codeforge.newSession", async () => {
      await viewProvider.focus();
      controller.newSession();
    }),
    vscode.commands.registerCommand("codeforge.openSettings", () => viewProvider.openSettings()),
    vscode.commands.registerCommand("codeforge.askSelection", async () => {
      await viewProvider.focus();
      await controller.sendPrompt("Answer my question about the selected code. Use the current selection as primary context.");
    }),
    vscode.commands.registerCommand("codeforge.editSelection", async () => {
      await viewProvider.focus();
      await controller.sendPrompt("Propose an edit for the selected code. Return a unified diff and wait for CodeForge approval before applying anything.");
    }),
    vscode.commands.registerCommand("codeforge.explainFile", async () => {
      await viewProvider.focus();
      await controller.sendPrompt("Explain the current file and identify the most important design choices.");
    }),
    vscode.commands.registerCommand("codeforge.generateTests", async () => {
      await viewProvider.focus();
      await controller.sendPrompt("Generate or update focused tests for the selected code or current file. Use local diagnostics when helpful, prefer existing test patterns, and propose edits for review before applying anything.");
    }),
    vscode.commands.registerCommand("codeforge.fixDiagnostics", async () => {
      await viewProvider.focus();
      await controller.sendPrompt("Inspect the current VS Code diagnostics for the selected code or current file, explain the likely root cause, and propose focused fixes for review before applying anything.");
    }),
    vscode.commands.registerCommand("codeforge.cancel", () => controller.cancel()),
    vscode.commands.registerCommand("codeforge.resetSession", () => controller.reset())
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}

function updateStatusBar(item: vscode.StatusBarItem, state: AgentUiState): void {
  const model = state.selectedModel || state.activeProfileLabel;
  const shortModel = model.length > 24 ? `${model.slice(0, 21)}...` : model;
  item.text = `$(code) CodeForge ${shortModel} ${state.contextUsage.percent}%`;
  item.tooltip = [
    `Profile: ${state.activeProfileLabel}`,
    `Endpoint: ${state.activeBaseUrl}`,
    `Model: ${state.selectedModel || "(profile default)"}`,
    `Context: ${state.contextUsage.label}`
  ].join("\n");
}
