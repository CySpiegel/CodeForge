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
  }

  async focus(): Promise<void> {
    await vscode.commands.executeCommand(`${CodeForgeViewProvider.viewType}.focus`);
  }

  async post(event: AgentUiEvent): Promise<void> {
    await this.view?.webview.postMessage(event);
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
    <button id="configure" title="Configure endpoint">Endpoint</button>
    <button id="reset" title="Reset session">Reset</button>
  </header>
  <main id="messages" class="messages" aria-live="polite"></main>
  <section id="approvals" class="approvals" aria-label="Pending approvals"></section>
  <form id="promptForm" class="prompt">
    <textarea id="promptInput" rows="4" placeholder="Ask CodeForge..."></textarea>
    <button type="submit">Send</button>
  </form>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface WebviewMessage {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
