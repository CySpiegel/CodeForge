import * as vscode from "vscode";
import { AgentController, AgentUiEvent } from "../agent/agentController";

export class CodeForgeViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "codeforge.chatView";
  private readonly extensionUri: vscode.Uri;
  private readonly controller: AgentController;
  private view: vscode.WebviewView | undefined;
  private disposeControllerListener: (() => void) | undefined;

  constructor(extensionUri: vscode.Uri, controller: AgentController) {
    this.extensionUri = extensionUri;
    this.controller = controller;
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "media")]
    };
    webviewView.webview.html = this.html(webviewView.webview);

    webviewView.webview.onDidReceiveMessage((message: WebviewMessage) => {
      void this.handleMessage(message);
    });

    this.disposeControllerListener?.();
    this.disposeControllerListener = this.controller.onEvent((event) => {
      void this.post(event);
    });
    void this.controller.publishState();
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CodeForgeViewProvider.viewType}.focus`);
  }

  async post(event: AgentUiEvent): Promise<void> {
    await this.view?.webview.postMessage(event);
  }

  async openSettings(): Promise<void> {
    await this.focus();
    await this.post({ type: "openSettings" });
    await this.controller.publishState();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "sendPrompt" && typeof message.text === "string" && message.text.trim()) {
      await this.controller.sendPrompt(message.text.trim());
    } else if (message.type === "approve" && typeof message.id === "string") {
      await this.controller.approve(message.id);
    } else if (message.type === "reject" && typeof message.id === "string") {
      this.controller.reject(message.id);
    } else if (message.type === "reset") {
      this.controller.reset();
    } else if (message.type === "configureEndpoint") {
      await vscode.commands.executeCommand("codeforge.configureEndpoint");
      await this.controller.refreshModels();
    } else if (message.type === "refreshModels") {
      await this.controller.refreshModels();
    } else if (message.type === "selectModel" && typeof message.model === "string") {
      await this.controller.selectModel(message.model);
    } else if (message.type === "selectProfile" && typeof message.profileId === "string") {
      await this.controller.selectProfile(message.profileId);
    } else if (message.type === "compactContext") {
      await this.controller.compactContext();
    } else if (message.type === "saveSettings") {
      await this.controller.updateSettings({
        activeProfileId: typeof message.activeProfileId === "string" ? message.activeProfileId : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
        allowlist: Array.isArray(message.allowlist) ? message.allowlist.filter((item): item is string => typeof item === "string") : undefined,
        maxFiles: typeof message.maxFiles === "number" ? message.maxFiles : undefined,
        maxBytes: typeof message.maxBytes === "number" ? message.maxBytes : undefined,
        commandTimeoutSeconds: typeof message.commandTimeoutSeconds === "number" ? message.commandTimeoutSeconds : undefined
      });
    }
  }

  private html(webview: vscode.Webview): string {
    const nonce = getNonce();
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "main.js"));
    const styleUri = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "media", "styles.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `font-src ${webview.cspSource}`
    ].join("; ");

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${styleUri}">
  <title>CodeForge</title>
</head>
<body>
  <header class="toolbar">
    <div class="endpoint">
      <select id="profileSelect" title="Endpoint profile" aria-label="Endpoint profile"></select>
      <button id="refreshModels" class="icon-button" title="Refresh models" aria-label="Refresh models">Refresh</button>
    </div>
    <button id="settingsToggle" class="icon-button settings-button" title="Settings" aria-label="Settings"><span aria-hidden="true">&#9881;</span><span class="sr-only">Settings</span></button>
  </header>
  <section class="model-row" aria-label="Model and context controls">
    <select id="modelSelect" title="Model" aria-label="Model"></select>
    <button id="compactContext" class="context-ring" title="Compact context with selected model" aria-label="Compact context">
      <span id="contextValue">0%</span>
    </button>
  </section>
  <section id="settingsPanel" class="settings hidden" aria-label="CodeForge settings">
    <div class="settings-grid">
      <label>Base URL<input id="baseUrl" type="text" readonly></label>
      <label>Model<input id="modelInput" type="text" placeholder="Model ID"></label>
      <label>Context files<input id="maxFiles" type="number" min="1" max="200"></label>
      <label>Context bytes<input id="maxBytes" type="number" min="8000" max="2000000"></label>
      <label>Command timeout<input id="commandTimeout" type="number" min="5" max="1800"></label>
      <label class="wide">Network allowlist<textarea id="allowlist" rows="3" placeholder="one host, origin, or CIDR per line"></textarea></label>
    </div>
    <div class="settings-actions">
      <button id="configure" type="button">Endpoint Wizard</button>
      <button id="saveSettings" type="button">Save Settings</button>
    </div>
  </section>
  <main id="messages" class="messages" aria-live="polite"></main>
  <section id="approvals" class="approvals" aria-label="Pending approvals"></section>
  <footer class="composer">
    <form id="promptForm" class="prompt">
      <textarea id="promptInput" rows="3" placeholder="Ask CodeForge..."></textarea>
      <button type="submit">Send</button>
    </form>
  </footer>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface WebviewMessage {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly activeProfileId?: string;
  readonly allowlist?: readonly unknown[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly commandTimeoutSeconds?: number;
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
