import * as vscode from "vscode";
import { AgentController, AgentUiEvent } from "../agent/agentController";
import { normalizeMcpServerConfigs } from "../adapters/vscodeConfig";
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
    } else if (message.type === "answerQuestion" && typeof message.id === "string" && isAnswerRecord(message.answers)) {
      await this.controller.answerQuestion(message.id, message.answers);
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
    } else if (message.type === "workerStop" && typeof message.workerId === "string") {
      this.controller.stopWorker(message.workerId);
    } else if (message.type === "workerOutput" && typeof message.workerId === "string") {
      this.controller.showWorkerOutput(message.workerId);
    } else if (message.type === "workerAttach" && typeof message.workerId === "string") {
      this.controller.attachWorkerOutput(message.workerId);
    } else if (message.type === "selectModel" && typeof message.model === "string") {
      await this.controller.selectModel(message.model);
    } else if (message.type === "selectProfile" && typeof message.profileId === "string") {
      await this.controller.selectProfile(message.profileId);
    } else if (message.type === "refreshCommands") {
      await this.controller.publishState();
    } else if (message.type === "refreshModels") {
      await this.controller.refreshModels();
    } else if (message.type === "webviewReady") {
      await this.controller.publishTranscript();
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
    } else if (message.type === "pinActiveFile") {
      await this.controller.pinActiveFile();
    } else if (message.type === "clearPinnedFiles") {
      await this.controller.unpinFile("all");
    } else if (message.type === "refreshInspector") {
      await this.controller.publishState();
    } else if (message.type === "addMemory" && typeof message.text === "string") {
      const scope = parseMemoryScope(message.scope) ?? "workspace";
      await this.controller.addMemory(message.text, scope, typeof message.namespace === "string" ? message.namespace : undefined);
    } else if (message.type === "updateMemory" && typeof message.id === "string" && typeof message.text === "string") {
      const scope = parseMemoryScope(message.scope) ?? "workspace";
      await this.controller.updateMemory(message.id, message.text, scope, typeof message.namespace === "string" ? message.namespace : undefined);
    } else if (message.type === "removeMemory" && typeof message.id === "string") {
      await this.controller.removeMemory(message.id);
    } else if (message.type === "clearMemories") {
      await this.controller.clearMemories();
    } else if (message.type === "saveSettings") {
      await this.controller.updateSettings({
        activeProfileId: typeof message.activeProfileId === "string" ? message.activeProfileId : undefined,
        createProfile: message.createProfile === true,
        profileLabel: typeof message.profileLabel === "string" ? message.profileLabel : undefined,
        baseUrl: typeof message.baseUrl === "string" ? message.baseUrl : undefined,
        apiKey: typeof message.apiKey === "string" ? message.apiKey : undefined,
        model: typeof message.model === "string" ? message.model : undefined,
        allowlist: Array.isArray(message.allowlist) ? message.allowlist.filter((item): item is string => typeof item === "string") : undefined,
        mcpServers: Array.isArray(message.mcpServers) ? message.mcpServers : undefined,
        maxFiles: typeof message.maxFiles === "number" ? message.maxFiles : undefined,
        maxBytes: typeof message.maxBytes === "number" ? message.maxBytes : undefined,
        commandTimeoutSeconds: typeof message.commandTimeoutSeconds === "number" ? message.commandTimeoutSeconds : undefined,
        commandOutputLimitBytes: typeof message.commandOutputLimitBytes === "number" ? message.commandOutputLimitBytes : undefined,
        permissionMode: parsePermissionMode(message.permissionMode),
        permissionRules: message.permissionRules === undefined ? undefined : parsePermissionRules(message.permissionRules, "workspace")
      });
    } else if (message.type === "probeMcpServers") {
      await this.controller.inspectMcpServers(
        typeof message.serverId === "string" ? message.serverId : undefined,
        normalizeMcpServerConfigs(Array.isArray(message.mcpServers) ? message.mcpServers : undefined)
      );
    } else if (message.type === "attachMcpResource" && typeof message.serverId === "string" && typeof message.uri === "string") {
      await this.controller.attachMcpResource(
        message.serverId,
        message.uri,
        normalizeMcpServerConfigs(Array.isArray(message.mcpServers) ? message.mcpServers : undefined)
      );
    } else if (message.type === "detachMcpResource" && typeof message.serverId === "string" && typeof message.uri === "string") {
      this.controller.detachMcpResource(message.serverId, message.uri);
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
        <div class="settings-tabs" role="tablist" aria-label="Settings sections">
          <button id="settingsTabGeneral" class="settings-tab" type="button" role="tab" aria-selected="true" data-settings-tab="general">Endpoint</button>
          <button id="settingsTabMcp" class="settings-tab" type="button" role="tab" aria-selected="false" data-settings-tab="mcp">MCP</button>
          <button id="settingsTabPermissions" class="settings-tab" type="button" role="tab" aria-selected="false" data-settings-tab="permissions">Permissions</button>
          <button id="settingsTabMemory" class="settings-tab" type="button" role="tab" aria-selected="false" data-settings-tab="memory">Memory</button>
          <button id="settingsTabInspector" class="settings-tab" type="button" role="tab" aria-selected="false" data-settings-tab="inspector">Inspector</button>
        </div>
        <div class="settings-content">
          <div id="settingsPaneGeneral" class="settings-pane" data-settings-pane="general">
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
            </div>
          </div>
          <div id="settingsPaneMcp" class="settings-pane hidden" data-settings-pane="mcp">
            <div class="mcp-screen">
              <section class="mcp-sidebar" aria-label="MCP servers">
                <div class="mcp-section-header">
                  <strong>MCP servers</strong>
                  <button id="addMcpServer" class="icon-button" type="button" title="Add MCP server" aria-label="Add MCP server">+</button>
                </div>
                <div id="mcpServerList" class="mcp-server-list"></div>
              </section>
              <section class="mcp-editor" aria-label="MCP server editor">
                <div class="settings-grid">
                  <label>ID<input id="mcpId" type="text" placeholder="local-tools"></label>
                  <label>Name<input id="mcpLabel" type="text" placeholder="Local tools"></label>
                  <label>Transport<select id="mcpTransport"><option value="http">Streamable HTTP</option><option value="sse">SSE</option><option value="stdio">stdio</option></select></label>
                  <label class="checkbox-label"><input id="mcpEnabled" type="checkbox"> Enabled</label>
                  <label class="wide">HTTP/SSE URL<input id="mcpUrl" type="text" placeholder="http://127.0.0.1:3000/mcp"></label>
                  <label>Command<input id="mcpCommand" type="text" placeholder="node"></label>
                  <label>Arguments<input id="mcpArgs" type="text" placeholder="server.js --flag"></label>
                  <label class="wide">Working directory<input id="mcpCwd" type="text" placeholder="/path/to/workspace-or-server"></label>
                  <label class="wide">Headers<textarea id="mcpHeaders" rows="4" placeholder='{"Authorization":"Bearer local-token"}'></textarea></label>
                </div>
                <div class="mcp-actions">
                  <button id="deleteMcpServer" class="secondary" type="button">Delete Selected</button>
                  <button id="checkMcpServer" type="button">Check Server</button>
                </div>
                <div id="mcpProbePanel" class="mcp-probe-panel" aria-live="polite"></div>
              </section>
            </div>
          </div>
          <div id="settingsPanePermissions" class="settings-pane hidden" data-settings-pane="permissions">
            <div class="settings-grid">
              <label class="wide">Permission rules<textarea id="permissionRules" rows="8" placeholder='[{"kind":"command","pattern":"npm test","behavior":"allow","scope":"workspace"}]'></textarea></label>
            </div>
          </div>
          <div id="settingsPaneMemory" class="settings-pane hidden" data-settings-pane="memory">
            <div class="settings-grid">
              <label class="wide">Memory text<textarea id="memoryText" rows="4" placeholder="Local preference, project fact, or recurring instruction"></textarea></label>
              <label>Scope<select id="memoryScope"><option value="workspace">Workspace</option><option value="user">User</option><option value="agent">Agent</option></select></label>
              <label>Agent name<input id="memoryNamespace" type="text" placeholder="optional for agent scope"></label>
            </div>
            <div class="memory-actions">
              <button id="addMemory" type="button">Add Memory</button>
              <button id="clearMemories" class="secondary" type="button">Clear All</button>
            </div>
            <div id="memoryList" class="memory-list" aria-live="polite"></div>
          </div>
          <div id="settingsPaneInspector" class="settings-pane hidden" data-settings-pane="inspector">
            <div class="inspector-actions">
              <button id="refreshInspector" class="secondary" type="button">Refresh</button>
            </div>
            <div id="inspectorContent" class="inspector-content" aria-live="polite"></div>
          </div>
        </div>
        <div class="settings-actions">
          <button id="settingsCancel" class="secondary" type="button">Close</button>
          <button id="saveSettings" type="button">Save Settings</button>
        </div>
      </div>
    </section>
    <main id="messages" class="messages" aria-live="polite"></main>
    <section id="inspectorPanel" class="inspector-panel hidden" aria-label="Run inspector"></section>
    <section id="workersPanel" class="workers-panel hidden" aria-label="CodeForge workers"></section>
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
          <button id="pinActiveFile" class="context-action" type="button" title="Pin focused file" aria-label="Pin focused file">Pin</button>
          <button id="clearPinnedFiles" class="context-action" type="button" title="Clear pinned files" aria-label="Clear pinned files">Clear pins</button>
          <button id="runInspector" class="context-action" type="button" title="Show run inspector" aria-label="Show run inspector">Run</button>
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

function isAnswerRecord(value: unknown): value is Record<string, string> {
  return typeof value === "object"
    && value !== null
    && !Array.isArray(value)
    && Object.values(value).every((item) => typeof item === "string");
}

interface WebviewMessage {
  readonly type: string;
  readonly text?: string;
  readonly id?: string;
  readonly answers?: Record<string, string>;
  readonly sessionId?: string;
  readonly workerId?: string;
  readonly serverId?: string;
  readonly uri?: string;
  readonly scope?: string;
  readonly namespace?: string;
  readonly model?: string;
  readonly profileId?: string;
  readonly activeProfileId?: string;
  readonly createProfile?: boolean;
  readonly profileLabel?: string;
  readonly baseUrl?: string;
  readonly apiKey?: string;
  readonly allowlist?: readonly unknown[];
  readonly mcpServers?: readonly unknown[];
  readonly agentMode?: string;
  readonly permissionMode?: string;
  readonly permissionRules?: readonly unknown[];
  readonly maxFiles?: number;
  readonly maxBytes?: number;
  readonly commandTimeoutSeconds?: number;
  readonly commandOutputLimitBytes?: number;
}

function parseMemoryScope(value: unknown): "workspace" | "user" | "agent" | undefined {
  return value === "workspace" || value === "user" || value === "agent" ? value : undefined;
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
