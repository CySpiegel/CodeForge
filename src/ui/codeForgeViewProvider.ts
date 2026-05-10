import * as vscode from "vscode";
import { AgentController, AgentUiEvent } from "../agent/agentController";
import { parsePermissionRules } from "../core/permissions";
import { AgentMode, PermissionMode } from "../core/types";

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
      void this.handleMessage(message).catch((error) => {
        void this.post({ type: "error", text: errorMessage(error) });
      });
    });

    this.disposeControllerListener?.();
    this.disposeControllerListener = this.controller.onEvent((event) => {
      void this.post(event);
    });
    void this.controller.publishTranscript()
      .then(() => this.controller.refreshModels())
      .catch((error) => {
        void this.post({ type: "error", text: errorMessage(error) });
      });
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
    await this.controller.refreshModels();
  }

  private async handleMessage(message: WebviewMessage): Promise<void> {
    if (message.type === "sendPrompt" && typeof message.text === "string" && message.text.trim()) {
      await this.controller.sendPrompt(message.text.trim());
    } else if (message.type === "approve" && typeof message.id === "string") {
      await this.controller.approve(message.id);
    } else if (message.type === "previewApproval" && typeof message.id === "string") {
      await this.controller.previewApproval(message.id);
    } else if (message.type === "reject" && typeof message.id === "string") {
      await this.controller.reject(message.id);
    } else if (message.type === "reset") {
      this.controller.reset();
    } else if (message.type === "newSession") {
      this.controller.newSession();
    } else if (message.type === "resumeSession") {
      await this.controller.resumeSession(typeof message.sessionId === "string" ? message.sessionId : undefined);
    } else if (message.type === "cancel") {
      this.controller.cancel();
    } else if (message.type === "selectModel" && typeof message.model === "string") {
      await this.controller.selectModel(message.model);
    } else if (message.type === "selectProfile" && typeof message.profileId === "string") {
      await this.controller.selectProfile(message.profileId);
    } else if (message.type === "refreshCommands") {
      await this.controller.publishState();
    } else if (message.type === "refreshModels") {
      await this.controller.refreshModels();
    } else if (message.type === "setAgentMode") {
      const agentMode = parseAgentMode(message.agentMode);
      if (agentMode) {
        await this.controller.setAgentMode(agentMode);
      }
    } else if (message.type === "setPermissionMode") {
      const permissionMode = parsePermissionMode(message.permissionMode);
      if (permissionMode) {
        await this.controller.setPermissionMode(permissionMode);
      }
    } else if (message.type === "compactContext") {
      await this.controller.compactContext();
    } else if (message.type === "saveSettings") {
      await this.controller.updateSettings({
        activeProfileId: typeof message.activeProfileId === "string" ? message.activeProfileId : undefined,
        createProfile: message.createProfile === true,
        profileLabel: typeof message.profileLabel === "string" ? message.profileLabel : undefined,
        baseUrl: typeof message.baseUrl === "string" ? message.baseUrl : undefined,
        apiKey: typeof message.apiKey === "string" ? message.apiKey : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
        allowlist: Array.isArray(message.allowlist) ? message.allowlist.filter((item): item is string => typeof item === "string") : undefined,
        maxFiles: typeof message.maxFiles === "number" ? message.maxFiles : undefined,
        maxBytes: typeof message.maxBytes === "number" ? message.maxBytes : undefined,
        commandTimeoutSeconds: typeof message.commandTimeoutSeconds === "number" ? message.commandTimeoutSeconds : undefined,
        commandOutputLimitBytes: typeof message.commandOutputLimitBytes === "number" ? message.commandOutputLimitBytes : undefined,
        permissionMode: parsePermissionMode(message.permissionMode),
        permissionRules: message.permissionRules === undefined ? undefined : parsePermissionRules(message.permissionRules, "workspace")
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
  <div class="shell">
    <section id="settingsPanel" class="settings hidden" role="dialog" aria-modal="true" aria-labelledby="settingsTitle">
      <div class="settings-surface">
        <header class="settings-header">
          <div class="settings-heading">
            <h2 id="settingsTitle">Settings</h2>
            <p>OpenAI API endpoint, context, and local permission controls.</p>
          </div>
          <button id="settingsClose" class="icon-button settings-close" type="button" title="Close settings" aria-label="Close settings">&times;</button>
        </header>
        <div class="settings-content">
          <div class="settings-grid">
            <label class="wide">OpenAI API profile
              <div class="profile-control">
                <div class="combo settings-combo" data-combo="profile">
                  <button id="profileButton" class="combo-button" type="button" aria-haspopup="listbox" aria-expanded="false">OpenAI API</button>
                  <div id="profileMenu" class="combo-menu hidden" role="listbox" aria-label="OpenAI API profile"></div>
                  <select id="profileSelect" class="native-select" tabindex="-1" aria-hidden="true"></select>
                </div>
                <button id="addProfile" class="icon-button add-profile" type="button" title="Add OpenAI API profile" aria-label="Add OpenAI API profile">+</button>
              </div>
            </label>
            <div id="endpointMeta" class="settings-meta wide"></div>
            <label class="wide">Profile name<input id="profileLabel" type="text" placeholder="OpenAI API profile name"></label>
            <label class="wide">OpenAI API Base URL<input id="baseUrl" type="text" placeholder="http://127.0.0.1:1234"></label>
            <label class="wide">API key<input id="apiKey" type="password" autocomplete="off" placeholder="Optional API key"></label>
            <label>Model<input id="modelInput" type="text" placeholder="Model ID"></label>
            <div id="modelMeta" class="settings-meta wide"></div>
            <label>Context files<input id="maxFiles" type="number" min="1" max="200"></label>
            <label>Context bytes<input id="maxBytes" type="number" min="8000" max="2000000"></label>
            <label>Command timeout<input id="commandTimeout" type="number" min="5" max="1800"></label>
            <label>Command output<input id="commandOutputLimit" type="number" min="16000" max="2000000"></label>
            <label class="wide">Network allowlist<textarea id="allowlist" rows="3" placeholder="one host, origin, or CIDR per line"></textarea></label>
            <label class="wide">Permission rules<textarea id="permissionRules" rows="5" placeholder='[{"kind":"command","pattern":"npm test","behavior":"allow","scope":"workspace"}]'></textarea></label>
          </div>
        </div>
        <div class="settings-actions">
          <button id="settingsCancel" class="secondary" type="button">Close</button>
          <button id="saveSettings" type="button">Save Settings</button>
        </div>
      </div>
    </section>
    <main id="messages" class="messages" aria-live="polite"></main>
    <section id="approvals" class="approvals" aria-label="Pending approvals"></section>
    <footer class="composer">
      <form id="promptForm" class="prompt">
        <div class="composer-card">
          <div class="composer-tip"><strong>CodeForge</strong> Local OpenAI API</div>
          <div class="prompt-input-wrap">
            <textarea id="promptInput" rows="1" placeholder="Describe what to build" aria-controls="slashCommandMenu" aria-autocomplete="list"></textarea>
            <div id="slashCommandMenu" class="slash-command-menu hidden" role="listbox" aria-label="Slash commands"></div>
          </div>
          <div class="prompt-actions">
            <div class="agent-mode-picker">
              <button id="agentModeButton" class="agent-mode-button" type="button" title="Agent mode" aria-label="Agent mode" aria-haspopup="listbox" aria-expanded="false"><span id="agentModeIcon" aria-hidden="true">&#11042;</span><span class="sr-only">Agent mode</span></button>
              <div id="agentModeMenu" class="agent-mode-menu hidden" role="listbox" aria-label="Agent mode"></div>
            </div>
            <div class="model-picker">
              <button id="modelPickerButton" class="model-picker-button" type="button" title="Model" aria-label="Model" aria-haspopup="listbox" aria-expanded="false">Auto</button>
              <div id="modelPickerMenu" class="model-picker-menu hidden" role="listbox" aria-label="Model"></div>
            </div>
            <button id="stopRun" type="button" class="secondary stop-button">Stop</button>
            <button id="submitPrompt" class="send-button" type="submit" title="Send" aria-label="Send"><span aria-hidden="true">&#8593;</span></button>
          </div>
        </div>
        <div class="composer-status-row">
          <div class="endpoint-picker">
            <button id="endpointPickerButton" class="endpoint-picker-button" type="button" title="Endpoint" aria-label="Endpoint" aria-haspopup="listbox" aria-expanded="false"><span class="endpoint-icon" aria-hidden="true"></span><span id="endpointPickerLabel">Local</span></button>
            <div id="endpointPickerMenu" class="endpoint-picker-menu hidden" role="listbox" aria-label="Endpoint"></div>
          </div>
          <div class="permission-picker">
            <button id="permissionModeButton" class="permission-mode-button" type="button" title="Approvals" aria-label="Approvals" aria-haspopup="listbox" aria-expanded="false"><span id="permissionModeLabel">Smart Approvals</span></button>
            <div id="permissionModeMenu" class="permission-mode-menu hidden" role="listbox" aria-label="Approvals"></div>
          </div>
          <button id="compactContext" class="context-ring" type="button" aria-label="Compact context" aria-describedby="contextTooltip">
            <span id="contextValue">0%</span>
          </button>
          <div id="contextTooltip" class="context-tooltip hidden" role="tooltip"></div>
        </div>
      </form>
    </footer>
  </div>
  <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
  }
}

interface WebviewMessage {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly sessionId?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly activeProfileId?: string;
  readonly createProfile?: boolean;
  readonly profileLabel?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly allowlist?: readonly unknown[];
  readonly agentMode?: string;
  readonly permissionMode?: string;
  readonly permissionRules?: readonly unknown[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly commandTimeoutSeconds?: number;
  readonly commandOutputLimitBytes?: number;
}

function parsePermissionMode(value: unknown): PermissionMode | undefined {
  return value === "manual" || value === "smart" || value === "fullAuto"
    ? value
    : undefined;
}

function parseAgentMode(value: unknown): AgentMode | undefined {
  switch (value) {
    case "agent":
    case "ask":
    case "plan":
      return value;
    default:
      return undefined;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getNonce(): string {
  const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let text = "";
  for (let index = 0; index < 32; index++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}
