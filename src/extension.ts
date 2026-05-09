import * as vscode from "vscode";
import { AgentController } from "./agent/agentController";
import { DiffPreviewProvider, DiffService } from "./adapters/diffService";
import { TerminalRunner } from "./adapters/terminalRunner";
import { CodeForgeConfigService } from "./adapters/vscodeConfig";
import { VsCodeWorkspacePort } from "./adapters/vscodeWorkspace";
import { CodeForgeViewProvider } from "./ui/codeForgeViewProvider";

export function activate(context: vscode.ExtensionContext): void {
  const config = new CodeForgeConfigService(context.secrets);
  const workspace = new VsCodeWorkspacePort();
  const terminal = new TerminalRunner();
  const previewProvider = new DiffPreviewProvider();
  const diff = new DiffService(previewProvider);
  const controller = new AgentController(config, workspace, terminal, diff);
  const viewProvider = new CodeForgeViewProvider(context.extensionUri, controller);

  context.subscriptions.push(
    vscode.workspace.registerTextDocumentContentProvider("codeforge-preview", previewProvider),
    vscode.window.registerWebviewViewProvider(CodeForgeViewProvider.viewType, viewProvider),
    vscode.commands.registerCommand("codeforge.openChat", () => viewProvider.focus()),
    vscode.commands.registerCommand("codeforge.openSettings", () => viewProvider.openSettings()),
    vscode.commands.registerCommand("codeforge.configureEndpoint", async () => {
      await config.configureEndpoint();
      await viewProvider.focus();
    }),
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
    vscode.commands.registerCommand("codeforge.resetSession", () => controller.reset())
  );
}

export function deactivate(): void {
  // No long-lived resources outside VS Code disposables.
}
