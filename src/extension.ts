import * as vscode from "vscode";
import { AgentController, AgentSessionSummary, AgentUiState } from "./agent/agentController";
import { DiffPreviewProvider, DiffService } from "./adapters/diffService";
import { TerminalRunner } from "./adapters/terminalRunner";
import { CodeForgeConfigService } from "./adapters/vscodeConfig";
import { VsCodeCodeIntelPort } from "./adapters/vscodeCodeIntel";
import { VsCodeEndpointCapabilityStore } from "./adapters/vscodeEndpointCapabilityStore";
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
  const endpointCapabilities = new VsCodeEndpointCapabilityStore(context);
  const codeIntel = new VsCodeCodeIntelPort();
  const notebooks = new VsCodeNotebookPort();
  const controller = new AgentController(config, workspace, terminal, diff, sessions, memories, codeIntel, notebooks, undefined, endpointCapabilities);
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
    vscode.window.registerWebviewViewProvider(CodeForgeViewProvider.viewType, viewProvider, {
      webviewOptions: { retainContextWhenHidden: true }
    }),
    vscode.commands.registerCommand("codeforge.openChat", () => viewProvider.focus()),
    vscode.commands.registerCommand("codeforge.newSession", async () => {
      await viewProvider.focus();
      controller.newSession();
    }),
    vscode.commands.registerCommand("codeforge.showConversations", async () => {
      await showConversationPicker(controller, viewProvider);
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

interface ConversationQuickPickItem extends vscode.QuickPickItem {
  readonly session: AgentSessionSummary;
}

const refreshButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("refresh"),
  tooltip: "Refresh conversations"
};

const newConversationButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("add"),
  tooltip: "New conversation"
};

const deleteConversationButton: vscode.QuickInputButton = {
  iconPath: new vscode.ThemeIcon("trash"),
  tooltip: "Delete conversation"
};

async function showConversationPicker(controller: AgentController, viewProvider: CodeForgeViewProvider): Promise<void> {
  const picker = vscode.window.createQuickPick<ConversationQuickPickItem>();
  picker.title = "CodeForge Conversations";
  picker.placeholder = "Select a conversation to resume";
  picker.matchOnDescription = true;
  picker.matchOnDetail = true;
  picker.buttons = [newConversationButton, refreshButton];

  const refresh = async () => {
    picker.busy = true;
    const currentSessionId = controller.getCurrentSessionId();
    const sessions = await controller.listSessions(100);
    picker.items = sessions.map((session) => toConversationItem(session, currentSessionId));
    picker.placeholder = sessions.length > 0 ? "Select a conversation to resume" : "No saved CodeForge conversations";
    picker.busy = false;
  };

  picker.onDidAccept(async () => {
    const selected = picker.selectedItems[0];
    if (!selected) {
      return;
    }
    picker.hide();
    await viewProvider.focus();
    await controller.resumeSession(selected.session.id);
  });

  picker.onDidTriggerButton(async (button) => {
    if (button === refreshButton) {
      await refresh();
      return;
    }
    if (button === newConversationButton) {
      picker.hide();
      await viewProvider.focus();
      controller.newSession();
    }
  });

  picker.onDidTriggerItemButton(async (event) => {
    if (event.button !== deleteConversationButton) {
      return;
    }
    const session = event.item.session;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete CodeForge conversation "${session.title || session.id}"?`,
      { modal: true },
      "Delete"
    );
    if (confirmed !== "Delete") {
      return;
    }
    await controller.deleteSession(session.id);
    await refresh();
  });

  picker.onDidHide(() => picker.dispose());
  picker.show();
  await refresh();
}

function toConversationItem(session: AgentSessionSummary, currentSessionId: string | undefined): ConversationQuickPickItem {
  const current = session.id === currentSessionId;
  const pending = session.pendingApprovalCount > 0 ? `, ${session.pendingApprovalCount} pending approval(s)` : "";
  return {
    label: `${current ? "$(circle-filled) " : ""}${session.title || "CodeForge conversation"}`,
    description: `${formatConversationTime(session.updatedAt)} - ${session.messageCount} message(s)${pending}`,
    detail: session.id,
    session,
    buttons: [deleteConversationButton]
  };
}

function formatConversationTime(value: number): string {
  return new Date(value || Date.now()).toLocaleString();
}
