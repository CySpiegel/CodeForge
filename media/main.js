(function () {
  const vscode = acquireVsCodeApi();
  // Markdown rendering lives in markdown.js (loaded first); pulled in here so the call sites are unchanged.
  const renderMarkdown = window.CodeForge.renderMarkdown;
  // Run-inspector list rendering lives in inspector.js (loaded first); the thin renderInspector wrapper below
  // passes this view's two container nodes.
  const renderInspectorInto = window.CodeForge.renderInspectorInto;
  // Stateless DOM/format/string helpers live in dom.js (loaded first); pulled in so call sites are unchanged.
  const {
    truncateStatus,
    formatNumber,
    numberOrFallback,
    estimatedTokens,
    tokensToBytes,
    replaceOptions,
    summarizeToolResult,
    on,
    setValue,
    setChecked,
    setDisabled,
    splitLines,
    splitArgs,
    cssEscape
  } = window.CodeForge.dom;
  const elements = {
    messages: document.getElementById("messages"),
    workersPanel: document.getElementById("workersPanel"),
    approvals: document.getElementById("approvals"),
    form: document.getElementById("promptForm"),
    input: document.getElementById("promptInput"),
    runStatusLabel: document.getElementById("runStatusLabel"),
    runStatusDots: document.getElementById("runStatusDots"),
    slashCommandMenu: document.getElementById("slashCommandMenu"),
    stopRun: document.getElementById("stopRun"),
    settingsPanel: document.getElementById("settingsPanel"),
    settingsClose: document.getElementById("settingsClose"),
    settingsCancel: document.getElementById("settingsCancel"),
    settingsTabs: Array.from(document.querySelectorAll("[data-settings-tab]")),
    settingsPanes: Array.from(document.querySelectorAll("[data-settings-pane]")),
    inspectorPanel: document.getElementById("inspectorPanel"),
    inspectorContent: document.getElementById("inspectorContent"),
    refreshInspector: document.getElementById("refreshInspector"),
    runInspector: document.getElementById("runInspector"),
    undoChange: document.getElementById("undoChange"),
    pinActiveFile: document.getElementById("pinActiveFile"),
    clearPinnedFiles: document.getElementById("clearPinnedFiles"),
    memoryText: document.getElementById("memoryText"),
    memoryScope: document.getElementById("memoryScope"),
    memoryNamespace: document.getElementById("memoryNamespace"),
    addMemory: document.getElementById("addMemory"),
    clearMemories: document.getElementById("clearMemories"),
    memoryList: document.getElementById("memoryList"),
    endpointPickerButton: document.getElementById("endpointPickerButton"),
    endpointPickerMenu: document.getElementById("endpointPickerMenu"),
    endpointPickerLabel: document.getElementById("endpointPickerLabel"),
    agentModeButton: document.getElementById("agentModeButton"),
    agentModeMenu: document.getElementById("agentModeMenu"),
    agentModeIcon: document.getElementById("agentModeIcon"),
    modelPickerButton: document.getElementById("modelPickerButton"),
    modelPickerMenu: document.getElementById("modelPickerMenu"),
    profileButton: document.getElementById("profileButton"),
    profileMenu: document.getElementById("profileMenu"),
    profileSelect: document.getElementById("profileSelect"),
    addProfile: document.getElementById("addProfile"),
    compactContext: document.getElementById("compactContext"),
    contextValue: document.getElementById("contextValue"),
    contextTooltip: document.getElementById("contextTooltip"),
    endpointMeta: document.getElementById("endpointMeta"),
    profileLabel: document.getElementById("profileLabel"),
    baseUrl: document.getElementById("baseUrl"),
    apiKey: document.getElementById("apiKey"),
    modelInput: document.getElementById("modelInput"),
    modelMeta: document.getElementById("modelMeta"),
    maxTokens: document.getElementById("maxTokens"),
    commandTimeout: document.getElementById("commandTimeout"),
    modelIdleTimeout: document.getElementById("modelIdleTimeout"),
    streamCompletionGrace: document.getElementById("streamCompletionGrace"),
    maxInvalidToolCallRetries: document.getElementById("maxInvalidToolCallRetries"),
    commandOutputLimit: document.getElementById("commandOutputLimit"),
    permissionModeButton: document.getElementById("permissionModeButton"),
    permissionModeMenu: document.getElementById("permissionModeMenu"),
    permissionModeLabel: document.getElementById("permissionModeLabel"),
    permissionRules: document.getElementById("permissionRules"),
    addMcpServer: document.getElementById("addMcpServer"),
    deleteMcpServer: document.getElementById("deleteMcpServer"),
    checkMcpServer: document.getElementById("checkMcpServer"),
    mcpServerList: document.getElementById("mcpServerList"),
    mcpId: document.getElementById("mcpId"),
    mcpLabel: document.getElementById("mcpLabel"),
    mcpEnabled: document.getElementById("mcpEnabled"),
    mcpTransport: document.getElementById("mcpTransport"),
    mcpUrl: document.getElementById("mcpUrl"),
    mcpCommand: document.getElementById("mcpCommand"),
    mcpArgs: document.getElementById("mcpArgs"),
    mcpCwd: document.getElementById("mcpCwd"),
    mcpHeaders: document.getElementById("mcpHeaders"),
    mcpProbePanel: document.getElementById("mcpProbePanel"),
    allowlist: document.getElementById("allowlist"),
    saveSettings: document.getElementById("saveSettings")
  };

  // Approval-card rendering lives in approvals.js (loaded first); bound here to this view's live vscode
  // bridge, approvals container, and cssEscape so the addApproval/removeApproval call sites are unchanged.
  const { addApproval, removeApproval } = window.CodeForge.createApprovals({
    vscode,
    container: elements.approvals,
    cssEscape
  });

  // Background-worker panel rendering lives in workerList.js (loaded first); bound to this view's vscode
  // bridge, elements, and formatNumber so the renderWorkers call sites are unchanged.
  const { renderWorkers } = window.CodeForge.createWorkerList({ vscode, elements, formatNumber });

  let state;
  let streamingMessage;
  let streamingReasoning;
  let isCreatingProfile = false;
  let pendingProfileCreate = false;
  let slashCommandItems = [];
  let slashCommandIndex = 0;
  let lastCommandRefreshAt = 0;
  let lastModelRefreshAt = 0;
  let activeSettingsTab = "general";
  // The MCP server draft editor (its own state + rendering + probe display) lives in mcpEditor.js, loaded
  // first. It owns the draft state; the view drives it from the event handlers below, reads back the
  // current selection, marks it clean on save, and re-syncs it from settings on each render.
  const {
    renderMcpEditor,
    renderMcpServerList,
    addMcpDraft,
    deleteSelectedMcpDraft,
    updateSelectedMcpDraftFromFields,
    serializedMcpDrafts,
    renderMcpProbe,
    renderMcpProbeStatus,
    mcpSelectedId,
    mcpMarkClean,
    mcpSyncFromState
  } = window.CodeForge.createMcpEditor({
    vscode,
    elements,
    mcpStatuses: () => state?.mcpServers || [],
    parseJsonObject: parseJsonObjectSetting
  });
  let editingMemoryId = "";
  let contextTooltipText = "Context used: 0 / 0 tokens (0%)\nClick to compact context.";
  let currentRunStatus = "Ready";
  let currentRunStatusDetail = "Ready";
  let currentRunStatusBusy = false;
  const builtInSlashCommands = [
    { name: "compact", description: "Compact the current session context", argumentHint: "[focus]" },
    { name: "undo", description: "Undo the last applied file change" },
    { name: "curator", description: "Maintain the skill library", argumentHint: "[status|run|pause|resume|pin|unpin|archive|restore|backup|rollback]" },
    { name: "context", description: "Show context usage and attached local context" },
    { name: "doctor", description: "Check endpoint, model, workspace, permissions, and MCP status" },
    { name: "index", description: "Build and show the offline workspace index" },
    { name: "pin", description: "Pin focused file or path into future context", argumentHint: "[path]" },
    { name: "unpin", description: "Unpin a path or clear all pinned context", argumentHint: "[path|all]" },
    { name: "pins", description: "List pinned context files" },
    { name: "inspect", description: "Show recent run inspector events" },
    { name: "audit", description: "Show permission and approval audit history" },
    { name: "capabilities", description: "Show cached endpoint model capabilities" },
    { name: "commands", description: "List workspace-local slash commands" },
    { name: "mcp", description: "List configured local MCP servers" },
    { name: "workers", description: "List worker tasks" },
    { name: "worker", description: "Manage workers", argumentHint: "list|output|attach|stop" },
    { name: "agents", description: "List workspace-local agent definitions" },
    { name: "review", description: "Review code or current changes", argumentHint: "[scope]" },
    { name: "skills", description: "List workspace-local skills" },
    { name: "skill", description: "Run a workspace-local skill", argumentHint: "<name> <task>" },
    { name: "memory", description: "Manage explicit local memories", argumentHint: "list|add|remove|clear" },
    { name: "new", description: "Start a clean chat session for this workspace" },
    { name: "clear", description: "Reset the current chat session" },
    { name: "stop", description: "Stop the current request" },
    { name: "history", description: "Show recent local sessions" },
    { name: "sessions", description: "Show recent local sessions" },
    { name: "chats", description: "Show recent local sessions" },
    { name: "resume", description: "Resume a local session", argumentHint: "[session-id]" },
    { name: "fork", description: "Fork the current or selected local session", argumentHint: "[session-id]" },
    { name: "diff", description: "Show recorded edit and command checkpoints", argumentHint: "[session-id]" },
    { name: "export", description: "Export a local session", argumentHint: "[session-id]" },
    { name: "model", description: "Show or set the active model", argumentHint: "[model-id]" },
    { name: "models", description: "Select an available model from the active endpoint" },
    { name: "agent", description: "Switch to Agent mode", argumentHint: "[task]" },
    { name: "ask", description: "Switch to Ask mode", argumentHint: "[question]" },
    { name: "plan", description: "Switch to Plan mode", argumentHint: "[task]" },
    { name: "manual", description: "Set approvals to Manual" },
    { name: "smart", description: "Set approvals to Smart" },
    { name: "full-auto", description: "Set approvals to Full Auto" },
    { name: "config", description: "Open CodeForge settings" },
    { name: "settings", description: "Open CodeForge settings" },
    { name: "reset", description: "Reset the current chat session" },
    { name: "cancel", description: "Stop the current request" }
  ];
  const permissionModeOptions = [
    { value: "manual", label: "Manual", description: "Ask before edits and local commands" },
    { value: "smart", label: "Smart", description: "Allow reads; ask before edits and local actions" },
    { value: "fullAuto", label: "Full Auto", description: "Proceed without most approval prompts" }
  ];
  const agentModeOptions = [
    { value: "agent", label: "Agent", icon: "⬢", description: "Autonomous coding with approved local actions" },
    { value: "ask", label: "Ask", icon: "?", description: "Quick answers and code help with read-only context" },
    { value: "plan", label: "Plan", icon: "▤", description: "Analyze and outline before implementation" }
  ];

  on(elements.form, "submit", (event) => {
    event.preventDefault();
    const text = elements.input?.value.trim();
    if (!text) {
      return;
    }
    elements.input.value = "";
    resizePromptInput();
    hideSlashCommandMenu();
    vscode.postMessage({ type: "sendPrompt", text });
  });

  on(elements.input, "input", () => {
    resizePromptInput();
    renderSlashCommandMenu();
  });

  on(elements.input, "focus", () => {
    renderSlashCommandMenu();
  });

  on(elements.input, "keydown", (event) => {
    if (isSlashCommandMenuOpen()) {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        moveSlashCommandSelection(1);
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        moveSlashCommandSelection(-1);
        return;
      }
      if ((event.key === "Enter" && !event.shiftKey && !event.isComposing) || event.key === "Tab") {
        event.preventDefault();
        chooseSlashCommand(slashCommandIndex);
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        hideSlashCommandMenu();
        return;
      }
    }
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      elements.form?.requestSubmit();
    }
  });

  window.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault();
      elements.input?.focus();
    } else if (event.key === "Escape") {
      closeMenus();
      hideContextTooltip();
      hideSlashCommandMenu();
      closeSettingsWindow();
    }
  });

  on(elements.stopRun, "click", () => {
    vscode.postMessage({ type: "cancel" });
  });

  on(elements.profileButton, "click", () => {
    toggleComboMenu(elements.profileMenu, elements.profileButton);
  });

  on(elements.addProfile, "click", () => {
    startNewProfileDraft();
  });

  on(elements.endpointPickerButton, "click", () => {
    renderEndpointPicker();
    toggleComboMenu(elements.endpointPickerMenu, elements.endpointPickerButton);
  });

  on(elements.permissionModeButton, "click", () => {
    renderPermissionModePicker();
    toggleComboMenu(elements.permissionModeMenu, elements.permissionModeButton);
  });

  on(elements.agentModeButton, "click", () => {
    renderAgentModePicker();
    toggleComboMenu(elements.agentModeMenu, elements.agentModeButton);
  });

  on(elements.modelPickerButton, "click", () => {
    requestModelRefreshIfNeeded();
    renderModelPicker();
    toggleComboMenu(elements.modelPickerMenu, elements.modelPickerButton);
  });

  on(elements.settingsClose, "click", () => {
    closeSettingsWindow();
  });

  on(elements.settingsCancel, "click", () => {
    closeSettingsWindow();
  });

  for (const tab of elements.settingsTabs || []) {
    on(tab, "click", () => {
      setSettingsTab(tab.dataset.settingsTab || "general");
    });
  }

  on(elements.addMcpServer, "click", () => {
    addMcpDraft();
  });

  on(elements.deleteMcpServer, "click", () => {
    deleteSelectedMcpDraft();
  });

  on(elements.checkMcpServer, "click", () => {
    updateSelectedMcpDraftFromFields();
    if (!mcpSelectedId()) {
      addMessage("system error", "Error: Select an MCP server before checking it.");
      return;
    }
    renderMcpProbeStatus("Checking MCP server...");
    vscode.postMessage({ type: "probeMcpServers", serverId: mcpSelectedId(), mcpServers: serializedMcpDrafts() });
  });

  for (const field of [elements.mcpId, elements.mcpLabel, elements.mcpEnabled, elements.mcpTransport, elements.mcpUrl, elements.mcpCommand, elements.mcpArgs, elements.mcpCwd, elements.mcpHeaders]) {
    on(field, "input", () => {
      updateSelectedMcpDraftFromFields();
      renderMcpServerList();
    });
    on(field, "change", () => {
      updateSelectedMcpDraftFromFields();
      renderMcpServerList();
    });
  }

  on(elements.settingsPanel, "pointerdown", (event) => {
    if (event.target === elements.settingsPanel) {
      closeSettingsWindow();
    }
  });

  on(elements.profileSelect, "change", () => {
    isCreatingProfile = false;
    renderProfiles();
    renderEndpointFields();
    vscode.postMessage({ type: "selectProfile", profileId: elements.profileSelect?.value || "" });
  });

  window.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && (target === elements.input || target.closest(".slash-command-menu") || target.closest(".combo") || target.closest(".endpoint-picker") || target.closest(".permission-picker") || target.closest(".agent-mode-picker") || target.closest(".model-picker"))) {
      return;
    }
    closeMenus();
    hideSlashCommandMenu();
  });

  window.addEventListener("resize", () => {
    closeMenus();
    hideContextTooltip();
    hideSlashCommandMenu();
  });
  window.addEventListener("scroll", (event) => {
    const target = event.target;
    if (target instanceof Element && (target.closest(".combo-menu") || target.closest(".slash-command-menu") || target.closest(".endpoint-picker-menu") || target.closest(".permission-mode-menu") || target.closest(".agent-mode-menu") || target.closest(".model-picker-menu"))) {
      return;
    }
    closeMenus();
    hideContextTooltip();
    hideSlashCommandMenu();
  }, true);

  on(elements.slashCommandMenu, "wheel", (event) => {
    event.stopPropagation();
  });

  on(elements.slashCommandMenu, "pointerdown", (event) => {
    event.stopPropagation();
  });

  on(elements.compactContext, "click", () => {
    vscode.postMessage({ type: "compactContext" });
  });

  on(elements.undoChange, "click", () => {
    vscode.postMessage({ type: "requestUndo" });
  });
  on(elements.pinActiveFile, "click", () => {
    vscode.postMessage({ type: "pinActiveFile" });
  });

  on(elements.clearPinnedFiles, "click", () => {
    vscode.postMessage({ type: "clearPinnedFiles" });
  });

  on(elements.runInspector, "click", () => {
    toggleInspectorPanel();
  });

  on(elements.refreshInspector, "click", () => {
    vscode.postMessage({ type: "refreshInspector" });
  });

  on(elements.addMemory, "click", () => {
    const text = elements.memoryText?.value.trim() || "";
    if (!text) {
      addMessage("system error", "Error: Memory text is required.");
      return;
    }
    vscode.postMessage({
      type: editingMemoryId ? "updateMemory" : "addMemory",
      id: editingMemoryId,
      text,
      scope: elements.memoryScope?.value || "workspace",
      namespace: elements.memoryNamespace?.value.trim() || ""
    });
    editingMemoryId = "";
    if (elements.addMemory) {
      elements.addMemory.textContent = "Add Memory";
    }
    setValue(elements.memoryText, "");
  });

  on(elements.clearMemories, "click", () => {
    editingMemoryId = "";
    if (elements.addMemory) {
      elements.addMemory.textContent = "Add Memory";
    }
    vscode.postMessage({ type: "clearMemories" });
  });

  on(elements.compactContext, "mouseenter", () => {
    showContextTooltip();
  });

  on(elements.compactContext, "mouseleave", () => {
    hideContextTooltip();
  });

  on(elements.compactContext, "focus", () => {
    showContextTooltip();
  });

  on(elements.compactContext, "blur", () => {
    hideContextTooltip();
  });

  on(elements.saveSettings, "click", () => {
    const permissionRules = parsePermissionRules();
    if (!permissionRules) {
      return;
    }
    updateSelectedMcpDraftFromFields();
    const mcpServers = serializedMcpDrafts();
    const profileLabel = elements.profileLabel?.value.trim() || "";
    const baseUrl = elements.baseUrl?.value.trim() || "";
    if (!profileLabel) {
      addMessage("system error", "Error: OpenAI API profile name is required.");
      return;
    }
    if (!baseUrl) {
      addMessage("system error", "Error: OpenAI API Base URL is required.");
      return;
    }
    pendingProfileCreate = isCreatingProfile;
    mcpMarkClean();
    vscode.postMessage({
      type: "saveSettings",
      activeProfileId: elements.profileSelect?.value || "",
      createProfile: isCreatingProfile,
      profileLabel,
      baseUrl,
      apiKey: elements.apiKey?.value.trim() || "",
      model: elements.modelInput?.value.trim() || "",
      allowlist: splitLines(elements.allowlist?.value || ""),
      mcpServers,
      maxTokens: Number(elements.maxTokens?.value || 0),
      commandTimeoutSeconds: Number(elements.commandTimeout?.value),
      modelIdleTimeoutSeconds: Number(elements.modelIdleTimeout?.value),
      streamCompletionGraceSeconds: Number(elements.streamCompletionGrace?.value),
      maxInvalidToolCallRetries: Number(elements.maxInvalidToolCallRetries?.value),
      commandOutputLimitBytes: tokensToBytes(elements.commandOutputLimit?.value),
      permissionRules
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "sessionReset") {
      elements.messages?.replaceChildren();
      elements.workersPanel?.replaceChildren();
      elements.workersPanel?.classList.add("hidden");
      elements.inspectorPanel?.replaceChildren();
      elements.inspectorPanel?.classList.add("hidden");
      elements.approvals?.replaceChildren();
      streamingMessage = undefined;
      streamingReasoning = undefined;
    } else if (message.type === "state") {
      state = message.state;
      if (pendingProfileCreate) {
        isCreatingProfile = false;
        pendingProfileCreate = false;
      }
      renderState();
    } else if (message.type === "models") {
      state = {
        ...(state || {}),
        models: message.models || [],
        modelInfo: message.modelInfo || [],
        selectedModel: message.selectedModel || state?.selectedModel || ""
      };
      if (message.backendLabel) {
        state.activeBackendLabel = message.backendLabel;
      }
      state.selectedModelInfo = findModelInfo(state.selectedModel);
      renderModelRefreshStatus(message.error);
      renderEndpointMeta();
      renderModelMeta();
      renderModelPicker();
      if (isSlashCommandMenuOpen()) {
        renderSlashCommandMenu();
      }
    } else if (message.type === "mcpProbe") {
      renderMcpProbe(message.inspections || []);
    } else if (message.type === "contextUsage") {
      state = { ...(state || {}), contextUsage: message.usage };
      renderContextUsage(message.usage);
    } else if (message.type === "workers") {
      state = { ...(state || {}), workers: message.workers || [] };
      renderWorkers(message.workers || []);
    } else if (message.type === "inspector") {
      state = { ...(state || {}), inspector: message.inspector };
      renderInspector(message.inspector);
    } else if (message.type === "openSettings") {
      openSettingsWindow();
      renderState();
    } else if (message.type === "message") {
      if (message.role === "assistant" && streamingMessage) {
        streamingMessage = undefined;
        return;
      }
      addMessage(message.role, message.text);
    } else if (message.type === "assistantReasoningDelta") {
      setRunStatus("Thinking");
      const block = ensureReasoningBlock();
      const body = block.querySelector(".reasoning-content");
      if (body) {
        const nextText = `${block.dataset.rawText || ""}${message.text || ""}`;
        block.dataset.rawText = nextText;
        renderMarkdown(body, nextText);
      }
      scrollMessages();
    } else if (message.type === "assistantDelta") {
      setRunStatus("Generating");
      // The model moved from thinking to answering: collapse the reasoning block so the answer leads.
      finalizeReasoningBlock();
      if (!streamingMessage) {
        streamingMessage = addMessage("assistant", "");
      }
      const content = streamingMessage.querySelector(".message-content");
      if (content) {
        const nextText = `${streamingMessage.dataset.rawText || ""}${message.text || ""}`;
        streamingMessage.dataset.rawText = nextText;
        renderMarkdown(content, nextText);
      }
      scrollMessages();
    } else if (message.type === "status") {
      setRunStatus(message.text);
      addStatus(message.text);
    } else if (message.type === "toolResult") {
      addToolResult(message.text);
    } else if (message.type === "toolUse") {
      finalizeReasoningBlock();
      updateRunStatusFromToolUse(message.toolUse);
      upsertToolUse(message.toolUse);
    } else if (message.type === "sessions") {
      addSessionList(message.sessions || []);
    } else if (message.type === "approvalRequested") {
      setRunStatus("Waiting for approval");
      addApproval(message.approval);
    } else if (message.type === "approvalResolved") {
      removeApproval(message.id);
      setRunStatus(message.accepted ? "Continuing after approval" : "Continuing after rejection");
      addStatus(message.text);
    } else if (message.type === "error") {
      setRunStatus(`Error: ${message.text || "request failed"}`);
      addMessage("system error", `Error: ${message.text}`);
    } else if (message.type === "runComplete") {
      streamingMessage = undefined;
      finalizeReasoningBlock();
      if (message.reason === "awaitingApproval") {
        setRunStatus("Waiting for approval");
      } else {
        setRunStatus("Idle");
      }
    }
  });

  function renderState() {
    if (!state) {
      return;
    }
    renderProfiles();
    renderSettings();
    renderEndpointMeta();
    renderModelMeta();
    renderEndpointPicker();
    renderAgentModePicker();
    renderModelPicker();
    renderWorkers(state.workers || []);
    renderActiveContext();
    renderMemoryList();
    renderInspector(state.inspector);
    renderContextUsage(state.contextUsage);
    if (isSlashCommandMenuOpen()) {
      renderSlashCommandMenu();
    }
  }

  function renderProfiles() {
    const profiles = state.profiles || [];
    const options = profiles.map((profile) => ({
      value: profile.id,
      label: profile.label
    }));
    const selected = replaceOptions(elements.profileSelect, options, state.activeProfileId);
    setValue(elements.profileSelect, isCreatingProfile ? "" : selected);
    renderComboMenu(elements.profileMenu, elements.profileButton, options, isCreatingProfile ? "" : selected, "Endpoint", (value) => {
      isCreatingProfile = false;
      setValue(elements.profileSelect, value);
      if (state) {
        state = { ...state, activeProfileId: value };
      }
      renderProfiles();
      renderEndpointFields();
      vscode.postMessage({ type: "selectProfile", profileId: value });
    });
    if (isCreatingProfile && elements.profileButton) {
      elements.profileButton.textContent = "New OpenAI API profile";
    }
  }

  function renderModelRefreshStatus(error) {
    if (error) {
      addStatus(`Model refresh failed: ${error}`);
    }
  }

  function renderSettings() {
    if (!state) {
      return;
    }
    renderEndpointFields();
    if (elements.maxTokens) {
      const discoveredTokens = state.selectedModelInfo?.contextLength || findModelInfo(state.selectedModel || "")?.contextLength;
      elements.maxTokens.placeholder = discoveredTokens ? `Auto (${formatNumber(discoveredTokens)})` : "Auto";
    }
    setValue(elements.maxTokens, state.settings?.maxTokens ? String(state.settings.maxTokens) : "");
    setValue(elements.commandTimeout, String(state.settings?.commandTimeoutSeconds ?? 120));
    setValue(elements.modelIdleTimeout, String(state.settings?.modelIdleTimeoutSeconds ?? 300));
    setValue(elements.streamCompletionGrace, String(state.settings?.streamCompletionGraceSeconds ?? 30));
    setValue(elements.maxInvalidToolCallRetries, String(state.settings?.maxInvalidToolCallRetries ?? 3));
    setValue(elements.commandOutputLimit, String(estimatedTokens(state.settings?.commandOutputLimitBytes ?? 200000)));
    renderPermissionModePicker();
    setValue(elements.permissionRules, JSON.stringify(state.settings?.permissionRules || [], null, 2));
    mcpSyncFromState(state.settings?.mcpServers);
    renderSettingsTabs();
    renderMcpEditor();
    setValue(elements.allowlist, (state.settings?.allowlist || []).join("\n"));
  }

  function renderActiveContext() {
    const active = state?.activeContext || {};
    const pinned = Array.isArray(active.pinnedFiles) ? active.pinnedFiles : [];
    const workspaceReady = active.workspaceReady === true;
    if (elements.pinActiveFile) {
      elements.pinActiveFile.textContent = active.activeFile ? "Pin file" : workspaceReady ? "Repo" : "No folder";
      elements.pinActiveFile.title = active.activeFile
        ? `Pin ${active.activeFile} into this chat context`
        : workspaceReady
          ? "The open repo folder is already used as context. Use /pin <path> to force a specific file into every request."
          : "Open a repo folder for context";
      elements.pinActiveFile.disabled = !active.activeFile;
    }
    if (elements.clearPinnedFiles) {
      elements.clearPinnedFiles.textContent = pinned.length > 0 ? `Pins ${pinned.length}` : "Pins";
      elements.clearPinnedFiles.title = pinned.length > 0 ? `Clear pinned files:\n${pinned.join("\n")}` : "No pinned files";
      elements.clearPinnedFiles.disabled = pinned.length === 0;
    }
    renderRunStatus();
  }

  function setRunStatus(text) {
    const normalized = String(text || "").trim();
    const display = runStatusDisplay(normalized);
    currentRunStatus = truncateStatus(display.label);
    currentRunStatusDetail = normalized || display.label;
    currentRunStatusBusy = display.busy;
    renderRunStatus();
  }

  function updateRunStatusFromToolUse(toolUse) {
    if (!toolUse) {
      return;
    }
    if (toolUse.status === "running") {
      setRunStatus(`Running ${toolUse.name}`);
    } else if (toolUse.status === "approval") {
      setRunStatus("Waiting for approval");
    } else if (toolUse.status === "failed") {
      setRunStatus(`${toolUse.name} failed`);
    }
  }

  function renderRunStatus() {
    if (elements.runStatusLabel) {
      elements.runStatusLabel.textContent = currentRunStatus || "Ready";
      elements.runStatusLabel.title = currentRunStatusDetail || currentRunStatus || "Ready";
    }
    if (elements.runStatusDots) {
      elements.runStatusDots.classList.toggle("active", currentRunStatusBusy);
    }
  }

  function runStatusDisplay(text) {
    if (!text || text === "Idle") {
      return { label: "Ready", busy: false };
    }
    const waitingMatch = text.match(/still waiting on [^:]+: ([^,]+) idle, (.+?) before timeout\./);
    if (waitingMatch) {
      return { label: `Waiting for model (${waitingMatch[1]} idle)`, busy: true };
    }
    if (/^Calling/.test(text) || /^Streaming response$/.test(text)) {
      return { label: "Generating", busy: true };
    }
    if (/^Generating$/.test(text)) {
      return { label: "Generating", busy: true };
    }
    if (/^Thinking$/.test(text)) {
      return { label: "Thinking", busy: true };
    }
    if (/^Rate limit reached/.test(text)) {
      return { label: text, busy: true };
    }
    if (/^Continuing after /.test(text)) {
      return { label: "Generating", busy: true };
    }
    if (/^Continuing \d+ queued tool call/.test(text)) {
      return { label: "Running queued tools", busy: true };
    }
    if (/^(Compacting context|Auto-compacting context)/.test(text)) {
      return { label: "Compacting context", busy: true };
    }
    if (/^Running /.test(text)) {
      return { label: text, busy: true };
    }
    if (/^Waiting for approval/.test(text)) {
      return { label: "Waiting for approval", busy: false };
    }
    if (/^Stopping /.test(text)) {
      return { label: "Stopping", busy: true };
    }
    if (/^Stopped/.test(text)) {
      return { label: "Stopped", busy: false };
    }
    if (/^Error:/.test(text)) {
      return { label: text, busy: false };
    }
    return { label: text, busy: false };
  }

  function renderMemoryList() {
    if (!elements.memoryList) {
      return;
    }
    const memories = Array.isArray(state?.memories) ? state.memories : [];
    elements.memoryList.replaceChildren();
    if (memories.length === 0) {
      const empty = document.createElement("div");
      empty.className = "memory-empty";
      empty.textContent = "No local memories saved.";
      elements.memoryList.append(empty);
      return;
    }
    for (const memory of memories) {
      const row = document.createElement("div");
      row.className = "memory-row";
      const meta = document.createElement("div");
      meta.className = "memory-meta";
      const title = document.createElement("div");
      title.className = "memory-title";
      title.textContent = `${memory.scope || "workspace"}${memory.namespace ? `:${memory.namespace}` : ""} - ${new Date(memory.createdAt || Date.now()).toLocaleString()}`;
      const text = document.createElement("div");
      text.className = "memory-text";
      text.textContent = memory.text || "";
      meta.append(title, text);
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Delete";
      remove.addEventListener("click", () => vscode.postMessage({ type: "removeMemory", id: memory.id }));
      const edit = document.createElement("button");
      edit.type = "button";
      edit.className = "secondary";
      edit.textContent = "Edit";
      edit.addEventListener("click", () => {
        editingMemoryId = memory.id || "";
        setValue(elements.memoryText, memory.text || "");
        setValue(elements.memoryScope, memory.scope || "workspace");
        setValue(elements.memoryNamespace, memory.namespace || "");
        if (elements.addMemory) {
          elements.addMemory.textContent = "Save Memory";
        }
        elements.memoryText?.focus();
      });
      const actions = document.createElement("div");
      actions.className = "memory-row-actions";
      actions.append(edit, remove);
      row.append(meta, actions);
      elements.memoryList.append(row);
    }
  }

  function toggleInspectorPanel() {
    if (!elements.inspectorPanel) {
      return;
    }
    const shouldOpen = elements.inspectorPanel.classList.contains("hidden");
    elements.inspectorPanel.classList.toggle("hidden", !shouldOpen);
    if (shouldOpen) {
      renderInspector(state?.inspector);
      vscode.postMessage({ type: "refreshInspector" });
    }
  }

  function renderInspector(inspector) {
    renderInspectorInto(elements.inspectorPanel, inspector, true);
    renderInspectorInto(elements.inspectorContent, inspector, false);
  }

  function setSettingsTab(tab) {
    activeSettingsTab = tab || "general";
    renderSettingsTabs();
  }

  function renderSettingsTabs() {
    for (const tab of elements.settingsTabs || []) {
      const selected = tab.dataset.settingsTab === activeSettingsTab;
      tab.setAttribute("aria-selected", selected ? "true" : "false");
    }
    for (const pane of elements.settingsPanes || []) {
      pane.classList.toggle("hidden", pane.dataset.settingsPane !== activeSettingsTab);
    }
  }

  function openSettingsWindow() {
    closeMenus();
    hideContextTooltip();
    hideSlashCommandMenu();
    elements.settingsPanel?.classList.remove("hidden");
    setSettingsTab(activeSettingsTab);
    elements.settingsClose?.focus();
  }

  function closeSettingsWindow() {
    const wasOpen = Boolean(elements.settingsPanel && !elements.settingsPanel.classList.contains("hidden"));
    closeMenus();
    elements.settingsPanel?.classList.add("hidden");
    if (wasOpen) {
      elements.input?.focus();
    }
  }

  function renderEndpointFields() {
    if (!state) {
      return;
    }
    if (isCreatingProfile) {
      return;
    }
    const profile = state.profiles?.find((item) => item.id === state.activeProfileId);
    setValue(elements.profileLabel, profile?.label || state.activeProfileLabel || "");
    setValue(elements.baseUrl, profile?.baseUrl || state.activeBaseUrl || "");
    setValue(elements.apiKey, "");
    if (elements.apiKey) {
      elements.apiKey.placeholder = profile?.hasApiKey ? "API key saved" : "Optional API key";
    }
    setValue(elements.modelInput, state.selectedModel || "");
    renderEndpointMeta();
    renderModelMeta();
  }

  function startNewProfileDraft() {
    isCreatingProfile = true;
    pendingProfileCreate = false;
    closeMenus();
    setValue(elements.profileSelect, "");
    setValue(elements.profileLabel, "");
    setValue(elements.baseUrl, "");
    setValue(elements.apiKey, "");
    setValue(elements.modelInput, "");
    if (elements.profileButton) {
      elements.profileButton.textContent = "New OpenAI API profile";
    }
    if (elements.apiKey) {
      elements.apiKey.placeholder = "Optional API key";
    }
    elements.profileLabel?.focus();
  }

  function renderEndpointMeta() {
    if (!elements.endpointMeta) {
      return;
    }
    const detected = state?.activeBackendLabel || "OpenAI API compatible";
    elements.endpointMeta.textContent = `Provider: OpenAI API. Detected backend: ${detected}.`;
  }

  function renderModelMeta() {
    if (!elements.modelMeta) {
      return;
    }
    const model = state?.selectedModelInfo || findModelInfo(state?.selectedModel || "");
    const contextOverride = state?.settings?.maxTokens;
    if (!model) {
      elements.modelMeta.textContent = contextOverride
        ? `Context override: ${formatNumber(contextOverride)} tokens.`
        : "Model metadata will update after model discovery.";
      return;
    }

    const details = [];
    if (contextOverride) {
      details.push(`context override ${formatNumber(contextOverride)} tokens`);
    }
    if (model.contextLength) {
      details.push(`context ${formatNumber(model.contextLength)} tokens`);
    }
    if (model.maxOutputTokens) {
      details.push(`output ${formatNumber(model.maxOutputTokens)} tokens`);
    }
    if (model.supportsReasoning) {
      details.push("thinking model");
    }
    const capability = (state?.capabilityCache || []).find((entry) => entry.model === (state?.selectedModel || model.id));
    if (capability) {
      details.push(capability.nativeToolCalls ? "native tools cached" : "JSON fallback cached");
    }
    elements.modelMeta.textContent = details.length > 0
      ? `Selected model: ${details.join(", ")}.`
      : "Selected model metadata was not exposed by this endpoint.";
  }

  function findModelInfo(modelId) {
    return (state?.modelInfo || []).find((model) => model.id === modelId);
  }

  function renderContextUsage(usage) {
    const safeUsage = usage || { percent: 0, label: "0 B / 0 B" };
    const percent = Math.max(0, Math.min(100, Number(safeUsage.percent) || 0));
    if (elements.contextValue) {
      elements.contextValue.textContent = `${percent}%`;
    }
    if (elements.compactContext) {
      contextTooltipText = contextTooltip(safeUsage, percent);
      elements.compactContext.setAttribute("aria-label", contextTooltipText.replace(/\n/g, ". "));
      elements.compactContext.style.setProperty("--context-progress", `${percent * 3.6}deg`);
      if (elements.contextTooltip && !elements.contextTooltip.classList.contains("hidden")) {
        elements.contextTooltip.textContent = contextTooltipText;
        positionContextTooltip();
      }
      elements.compactContext.classList.toggle("warning", percent >= 70 && percent < 90);
      elements.compactContext.classList.toggle("danger", percent >= 90);
    }
  }

  function showContextTooltip() {
    if (!elements.contextTooltip || !elements.compactContext) {
      return;
    }
    elements.contextTooltip.textContent = contextTooltipText;
    positionContextTooltip();
    elements.contextTooltip.classList.remove("hidden");
  }

  function hideContextTooltip() {
    elements.contextTooltip?.classList.add("hidden");
  }

  function positionContextTooltip() {
    const tooltip = elements.contextTooltip;
    const button = elements.compactContext;
    if (!tooltip || !button) {
      return;
    }

    const margin = 6;
    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(300, viewportWidth - margin * 2);
    const left = Math.min(Math.max(margin, rect.right - width), Math.max(margin, viewportWidth - width - margin));
    tooltip.style.width = `${width}px`;
    tooltip.style.left = `${left}px`;
    tooltip.style.right = "auto";
    tooltip.style.top = "0";
    tooltip.style.bottom = "auto";

    const measuredHeight = tooltip.offsetHeight || 96;
    const belowTop = rect.bottom + 5;
    const top = belowTop + measuredHeight + margin <= viewportHeight
      ? belowTop
      : Math.max(margin, rect.top - measuredHeight - 5);
    tooltip.style.top = `${top}px`;
  }

  function contextTooltip(usage, percent) {
    const tokenUsage = usage.tokens || {};
    const usedTokens = numberOrFallback(tokenUsage.usedTokens, estimatedTokens(usage.usedBytes || 0));
    const maxTokens = numberOrFallback(tokenUsage.maxTokens, estimatedTokens(usage.maxBytes || 0));
    const usageLabel = tokenUsage.source === "actual" ? "Actual token usage" : "Current context";
    const lines = [
      `${usageLabel}: ${formatNumber(usedTokens)} / ${formatNumber(maxTokens)} tokens (${percent}%)`
    ];
    if (tokenUsage.source === "actual") {
      if (typeof tokenUsage.promptTokens === "number") {
        lines.push(`Prompt: ${formatNumber(tokenUsage.promptTokens)} tokens`);
      }
      if (typeof tokenUsage.completionTokens === "number") {
        lines.push(`Completion: ${formatNumber(tokenUsage.completionTokens)} tokens`);
      }
    }
    const model = state?.selectedModelInfo || findModelInfo(state?.selectedModel || "");
    if (model?.contextLength) {
      lines.push(`Model context: ${formatNumber(model.contextLength)} tokens`);
    }
    if (model?.maxOutputTokens) {
      lines.push(`Max output: ${formatNumber(model.maxOutputTokens)} tokens`);
    }
    if (model?.supportsReasoning) {
      lines.push("Model type: thinking/reasoning");
    }
    lines.push("Click to compact context.");
    return lines.join("\n");
  }

  function renderPermissionModePicker() {
    const selectedValue = normalizePermissionMode(state?.settings?.permissionMode);
    const selectedOption = permissionModeOptions.find((option) => option.value === selectedValue) || permissionModeOptions[1];
    if (elements.permissionModeLabel) {
      elements.permissionModeLabel.textContent = `${selectedOption.label} Approvals`;
    }
    if (elements.permissionModeButton) {
      elements.permissionModeButton.title = `Approvals: ${selectedOption.label}`;
      elements.permissionModeButton.setAttribute("aria-label", `Approvals: ${selectedOption.label}`);
      elements.permissionModeButton.dataset.mode = selectedOption.value;
    }
    renderComboMenu(elements.permissionModeMenu, elements.permissionModeButton, permissionModeOptions, selectedValue, "Smart", choosePermissionMode, { preserveButtonText: true, includeDescription: true });
  }

  function choosePermissionMode(value) {
    const nextMode = normalizePermissionMode(value);
    if (state) {
      state = {
        ...state,
        settings: {
          ...(state.settings || {}),
          permissionMode: nextMode
        }
      };
    }
    renderPermissionModePicker();
    vscode.postMessage({ type: "setPermissionMode", permissionMode: nextMode });
  }

  function normalizePermissionMode(value) {
    if (value === "review" || value === "readOnly") {
      return "manual";
    }
    if (value === "workspaceTrusted") {
      return "fullAuto";
    }
    if (value === "default" || value === "acceptEdits") {
      return "smart";
    }
    return permissionModeOptions.some((option) => option.value === value) ? value : "smart";
  }

  function renderAgentModePicker() {
    const selectedValue = normalizeAgentMode(state?.settings?.agentMode);
    const selectedOption = agentModeOptions.find((option) => option.value === selectedValue) || agentModeOptions[0];
    if (elements.agentModeIcon) {
      elements.agentModeIcon.textContent = selectedOption.icon;
    }
    if (elements.agentModeButton) {
      elements.agentModeButton.title = `Agent mode: ${selectedOption.label}`;
      elements.agentModeButton.setAttribute("aria-label", `Agent mode: ${selectedOption.label}`);
      elements.agentModeButton.dataset.mode = selectedOption.value;
    }
    renderComboMenu(elements.agentModeMenu, elements.agentModeButton, agentModeOptions, selectedOption.value, "Agent", chooseAgentMode, { preserveButtonText: true, includeDescription: true });
  }

  function chooseAgentMode(value) {
    const nextMode = normalizeAgentMode(value);
    if (state) {
      state = {
        ...state,
        settings: {
          ...(state.settings || {}),
          agentMode: nextMode
        }
      };
    }
    renderAgentModePicker();
    vscode.postMessage({ type: "setAgentMode", agentMode: nextMode });
  }

  function normalizeAgentMode(value) {
    if (value === "auto") {
      return "agent";
    }
    return agentModeOptions.some((option) => option.value === value) ? value : "agent";
  }

  function renderEndpointPicker() {
    const profiles = state?.profiles || [];
    const options = profiles.map((profile) => ({
      value: profile.id,
      label: profile.label,
      description: profile.baseUrl
    }));
    const selectedProfile = profiles.find((profile) => profile.id === state?.activeProfileId);
    if (elements.endpointPickerLabel) {
      elements.endpointPickerLabel.textContent = selectedProfile?.label || state?.activeProfileLabel || "Local";
    }
    renderComboMenu(elements.endpointPickerMenu, elements.endpointPickerButton, options, state?.activeProfileId || "", "Local", chooseEndpoint, { preserveButtonText: true, includeDescription: true });
  }

  function chooseEndpoint(value) {
    if (!value) {
      return;
    }
    if (state) {
      state = { ...state, activeProfileId: value };
    }
    renderEndpointPicker();
    renderProfiles();
    renderEndpointFields();
    vscode.postMessage({ type: "selectProfile", profileId: value });
  }

  function renderModelPicker() {
    const models = modelEntries();
    const selectedModel = state?.selectedModel || "";
    const options = models.length > 0
      ? models.map((model) => ({
        value: model.id,
        label: model.id,
        description: formatModelDetails(model)
      }))
      : [{ value: selectedModel, label: selectedModel || "No models found", description: "Current active endpoint did not return models" }];
    const selectedOption = options.find((option) => option.value === selectedModel) || options[0];
    if (elements.modelPickerButton) {
      elements.modelPickerButton.textContent = selectedOption?.label || "Model";
      elements.modelPickerButton.title = selectedOption?.value ? `Model: ${selectedOption.value}` : "Model";
    }
    renderComboMenu(elements.modelPickerMenu, elements.modelPickerButton, options, selectedModel, "Model", selectModelFromPicker, { preserveButtonText: true, includeDescription: true });
  }

  function renderComboMenu(menu, button, options, selectedValue, fallbackLabel, onChoose, settings = {}) {
    if (!menu || !button) {
      return;
    }

    const selectedOption = options.find((option) => option.value === selectedValue) || options[0];
    if (!settings.preserveButtonText) {
      button.textContent = selectedOption?.label || fallbackLabel;
    }
    menu.replaceChildren();

    for (const option of options) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "combo-option";
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", option.value === selectedValue ? "true" : "false");
      if (settings.includeDescription) {
        const label = document.createElement("span");
        label.className = "combo-option-label";
        label.textContent = option.label || option.value || "";
        const description = document.createElement("span");
        description.className = "combo-option-description";
        description.textContent = option.description || "";
        item.append(label, description);
      } else {
        item.textContent = option.label || option.value || "";
      }
      item.addEventListener("click", () => {
        onChoose(option.value || "");
        closeMenus();
      });
      menu.append(item);
    }
  }

  function toggleComboMenu(menu, button) {
    if (!menu || !button) {
      return;
    }
    const shouldOpen = menu.classList.contains("hidden");
    hideSlashCommandMenu();
    closeMenus();
    if (shouldOpen) {
      menu.style.visibility = "hidden";
      menu.classList.remove("hidden");
      positionComboMenu(menu, button);
      menu.style.visibility = "";
      button.setAttribute("aria-expanded", "true");
    }
  }

  function positionComboMenu(menu, button) {
    const margin = 4;
    const gap = 3;
    const maxMenuHeight = 260;
    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(Math.max(rect.width, 180), Math.max(120, viewportWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    const availableBelow = viewportHeight - rect.bottom - margin;
    const availableAbove = rect.top - margin;
    const naturalHeight = Math.min(menu.scrollHeight || maxMenuHeight, maxMenuHeight);
    const openAbove = availableBelow < naturalHeight + gap && availableAbove > availableBelow;
    const availableHeight = Math.max(openAbove ? availableAbove : availableBelow, 80);
    const maxHeight = Math.min(maxMenuHeight, availableHeight);
    const renderedHeight = Math.min(naturalHeight, maxHeight);
    const top = openAbove
      ? Math.max(margin, rect.top - renderedHeight - gap)
      : Math.min(rect.bottom + gap, viewportHeight - renderedHeight - margin);

    menu.style.position = "fixed";
    menu.style.left = `${left}px`;
    menu.style.right = "auto";
    menu.style.top = `${top}px`;
    menu.style.width = `${width}px`;
    menu.style.maxHeight = `${maxHeight}px`;
  }

  function closeMenus() {
    const combos = [
      [elements.profileButton, elements.profileMenu],
      [elements.endpointPickerButton, elements.endpointPickerMenu],
      [elements.permissionModeButton, elements.permissionModeMenu],
      [elements.agentModeButton, elements.agentModeMenu],
      [elements.modelPickerButton, elements.modelPickerMenu]
    ];
    for (const [button, menu] of combos) {
      menu?.classList.add("hidden");
      button?.setAttribute("aria-expanded", "false");
    }
  }

  function renderSlashCommandMenu() {
    const context = slashCommandContext();
    if (!context || !elements.slashCommandMenu) {
      hideSlashCommandMenu();
      return;
    }

    if (context.kind === "models") {
      requestModelRefreshIfNeeded();
      slashCommandItems = modelSuggestions(context.query);
    } else {
      requestCommandRefreshIfNeeded();
      slashCommandItems = commandSuggestions(context.query);
    }
    slashCommandIndex = Math.min(Math.max(0, slashCommandIndex), Math.max(0, slashCommandItems.length - 1));
    elements.slashCommandMenu.replaceChildren();

    if (slashCommandItems.length === 0) {
      hideSlashCommandMenu();
      return;
    }

    slashCommandItems.forEach((command, index) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "slash-command-option";
      item.id = `slash-command-${index}`;
      item.setAttribute("role", "option");
      item.setAttribute("aria-selected", index === slashCommandIndex ? "true" : "false");
      if (command.kind === "empty") {
        item.setAttribute("aria-disabled", "true");
      }
      const name = document.createElement("span");
      name.className = "slash-command-name";
      name.textContent = command.kind === "model" || command.kind === "empty"
        ? command.name
        : `/${command.name}${command.argumentHint ? ` ${command.argumentHint}` : ""}`;
      const description = document.createElement("span");
      description.className = "slash-command-description";
      description.textContent = command.description || command.path || command.source;
      const source = document.createElement("span");
      source.className = "slash-command-source";
      source.textContent = command.kind === "model" || command.kind === "empty"
        ? command.source
        : command.source === "workspace" ? "workspace" : "built-in";
      item.append(name, description, source);
      item.addEventListener("pointerenter", () => {
        slashCommandIndex = index;
        updateSlashCommandSelection();
      });
      item.addEventListener("click", () => {
        chooseSlashCommand(index);
      });
      elements.slashCommandMenu.append(item);
    });

    elements.slashCommandMenu.style.visibility = "hidden";
    elements.slashCommandMenu.classList.remove("hidden");
    positionSlashCommandMenu();
    elements.slashCommandMenu.style.visibility = "";
    elements.input?.setAttribute("aria-expanded", "true");
    elements.input?.setAttribute("aria-activedescendant", `slash-command-${slashCommandIndex}`);
    updateSlashCommandSelection();
  }

  function positionSlashCommandMenu() {
    if (!elements.slashCommandMenu || !elements.input) {
      return;
    }

    const margin = 4;
    const gap = 6;
    const rect = elements.input.getBoundingClientRect();
    const hostRect = elements.input.closest(".prompt-input-wrap")?.getBoundingClientRect() || rect;
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(Math.max(hostRect.width, 220), Math.max(120, viewportWidth - margin * 2));
    const left = Math.min(Math.max(margin, hostRect.left), Math.max(margin, viewportWidth - width - margin));
    const availableAbove = Math.max(rect.top - margin - gap, 80);
    const maxHeight = Math.min(300, availableAbove, viewportHeight - margin * 2);
    const naturalHeight = Math.min(elements.slashCommandMenu.scrollHeight || maxHeight, maxHeight);
    const top = Math.max(margin, rect.top - naturalHeight - gap);

    elements.slashCommandMenu.style.left = `${left}px`;
    elements.slashCommandMenu.style.right = "auto";
    elements.slashCommandMenu.style.top = `${top}px`;
    elements.slashCommandMenu.style.bottom = "auto";
    elements.slashCommandMenu.style.width = `${width}px`;
    elements.slashCommandMenu.style.maxHeight = `${maxHeight}px`;
  }

  function slashCommandContext() {
    if (!elements.input) {
      return undefined;
    }
    const value = elements.input.value;
    const cursor = elements.input.selectionStart ?? value.length;
    if (cursor === null || cursor < 1 || !value.startsWith("/")) {
      return undefined;
    }
    const firstWhitespace = value.search(/\s/);
    const commandEnd = firstWhitespace === -1 ? value.length : firstWhitespace;
    const commandName = value.slice(1, commandEnd).toLowerCase();
    if (commandName === "models") {
      if (value.slice(0, cursor).includes("\n") || cursor < commandEnd) {
        return undefined;
      }
      const queryStart = firstWhitespace === -1 ? commandEnd : firstWhitespace + 1;
      return {
        kind: "models",
        query: value.slice(queryStart, cursor).trimStart().toLowerCase(),
        commandEnd
      };
    }
    if (cursor > commandEnd || value.slice(0, cursor).includes("\n")) {
      return undefined;
    }
    return {
      kind: "commands",
      query: value.slice(1, commandEnd).toLowerCase(),
      commandEnd
    };
  }

  function commandSuggestions(query) {
    const byName = new Map();
    for (const command of builtInSlashCommands) {
      byName.set(command.name, { ...command, source: "built-in" });
    }
    for (const command of state?.localCommands || []) {
      if (!byName.has(command.name)) {
        byName.set(command.name, { ...command, source: "workspace" });
      }
    }
    return [...byName.values()]
      .filter((command) => command.name.toLowerCase().startsWith(query))
      .sort((left, right) => {
        if (left.source !== right.source) {
          return left.source === "built-in" ? -1 : 1;
        }
        return left.name.localeCompare(right.name);
      })
      .slice(0, 12);
  }

  function modelSuggestions(query) {
    const models = modelEntries();
    const normalizedQuery = (query || "").toLowerCase();
    if (models.length === 0) {
      return [{
        kind: "empty",
        name: "No models found",
        description: "The active OpenAI API endpoint did not return any models.",
        source: "endpoint"
      }];
    }
    const matches = models
      .filter((model) => model.id.toLowerCase().includes(normalizedQuery))
      .map((model) => ({
        kind: "model",
        name: model.id,
        value: model.id,
        description: formatModelDetails(model),
        source: model.id === state?.selectedModel ? "current" : "model"
      }))
      .slice(0, 20);
    return matches.length > 0 ? matches : [{
      kind: "empty",
      name: "No matching models",
      description: "Keep typing to filter the current endpoint model list.",
      source: "endpoint"
    }];
  }

  function modelEntries() {
    if (state?.modelInfo?.length > 0) {
      return state.modelInfo;
    }
    return (state?.models || []).map((id) => ({ id }));
  }

  function formatModelDetails(model) {
    const details = [];
    if (model.contextLength) {
      details.push(`${formatNumber(model.contextLength)} ctx`);
    }
    if (model.maxOutputTokens) {
      details.push(`${formatNumber(model.maxOutputTokens)} output`);
    }
    if (model.supportsReasoning) {
      details.push("thinking");
    }
    return details.length > 0 ? details.join(", ") : "Available on current endpoint";
  }

  function requestCommandRefreshIfNeeded() {
    const now = Date.now();
    if (now - lastCommandRefreshAt < 2000) {
      return;
    }
    lastCommandRefreshAt = now;
    vscode.postMessage({ type: "refreshCommands" });
  }

  function requestModelRefreshIfNeeded() {
    const now = Date.now();
    if (now - lastModelRefreshAt < 2000) {
      return;
    }
    lastModelRefreshAt = now;
    vscode.postMessage({ type: "refreshModels" });
  }

  function moveSlashCommandSelection(delta) {
    if (slashCommandItems.length === 0) {
      return;
    }
    slashCommandIndex = (slashCommandIndex + delta + slashCommandItems.length) % slashCommandItems.length;
    updateSlashCommandSelection();
  }

  function updateSlashCommandSelection() {
    if (!elements.slashCommandMenu) {
      return;
    }
    const options = [...elements.slashCommandMenu.querySelectorAll(".slash-command-option")];
    options.forEach((option, index) => {
      const selected = index === slashCommandIndex;
      option.setAttribute("aria-selected", selected ? "true" : "false");
      if (selected) {
        option.scrollIntoView({ block: "nearest" });
      }
    });
    elements.input?.setAttribute("aria-activedescendant", `slash-command-${slashCommandIndex}`);
  }

  function chooseSlashCommand(index) {
    const command = slashCommandItems[index];
    const context = slashCommandContext();
    if (!command || !context || !elements.input) {
      hideSlashCommandMenu();
      return;
    }
    if (command.kind === "model") {
      selectModelFromPicker(command.value || command.name);
      return;
    }
    if (command.kind === "empty") {
      return;
    }
    const suffix = elements.input.value.slice(context.commandEnd);
    const needsSpace = suffix.startsWith(" ") || suffix.length === 0;
    elements.input.value = `/${command.name}${needsSpace ? " " : ""}${suffix.replace(/^\s*/, "")}`;
    if (command.name === "models") {
      slashCommandIndex = 0;
      resizePromptInput();
      elements.input.focus();
      const cursor = elements.input.value.length;
      elements.input.setSelectionRange(cursor, cursor);
      renderSlashCommandMenu();
      return;
    }
    hideSlashCommandMenu();
    resizePromptInput();
    elements.input.focus();
    const cursor = Math.min(elements.input.value.length, command.name.length + 2);
    elements.input.setSelectionRange(cursor, cursor);
  }

  function selectModelFromPicker(model) {
    if (!model || !elements.input) {
      hideSlashCommandMenu();
      return;
    }
    if (state) {
      state = {
        ...state,
        selectedModel: model,
        selectedModelInfo: findModelInfo(model)
      };
    }
    setValue(elements.modelInput, model);
    renderModelMeta();
    renderModelPicker();
    elements.input.value = "";
    resizePromptInput();
    hideSlashCommandMenu();
    elements.input.focus();
    addStatus(`Model set to ${model}.`);
    vscode.postMessage({ type: "selectModel", model });
  }

  function hideSlashCommandMenu() {
    elements.slashCommandMenu?.classList.add("hidden");
    elements.input?.setAttribute("aria-expanded", "false");
    elements.input?.removeAttribute("aria-activedescendant");
    slashCommandItems = [];
    slashCommandIndex = 0;
  }

  function isSlashCommandMenuOpen() {
    return Boolean(elements.slashCommandMenu && !elements.slashCommandMenu.classList.contains("hidden"));
  }

  function parsePermissionRules() {
    return parseJsonArraySetting(elements.permissionRules, "Permission rules");
  }

  function parseJsonArraySetting(element, label) {
    const raw = element?.value.trim() || "";
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        addMessage("system error", `Error: ${label} must be a JSON array.`);
        return undefined;
      }
      return parsed;
    } catch (error) {
      addMessage("system error", `Error: Could not parse ${label} JSON. ${error.message || String(error)}`);
      return undefined;
    }
  }

  function parseJsonObjectSetting(element, label) {
    const raw = element?.value.trim() || "";
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        addMessage("system error", `Error: ${label} must be a JSON object.`);
        return undefined;
      }
      return parsed;
    } catch (error) {
      addMessage("system error", `Error: Could not parse ${label} JSON. ${error.message || String(error)}`);
      return undefined;
    }
  }

  function addStatus(text) {
    if (!text || text === "Idle") {
      return;
    }
    addMessage("system", text);
  }

  function addMessage(role, text) {
    const item = document.createElement("article");
    item.className = `message ${role}`;
    item.dataset.rawText = text || "";
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role;
    const content = document.createElement("div");
    content.className = "message-content markdown-body";
    renderMarkdown(content, text || "");
    item.append(label, content);
    elements.messages?.append(item);
    scrollMessages();
    return item;
  }

  function ensureReasoningBlock() {
    if (streamingReasoning && streamingReasoning.isConnected) {
      return streamingReasoning;
    }
    const block = document.createElement("details");
    block.className = "message reasoning";
    block.open = true;
    block.dataset.rawText = "";
    const summary = document.createElement("summary");
    summary.className = "reasoning-summary";
    summary.textContent = "Thinking…";
    const body = document.createElement("div");
    body.className = "reasoning-content markdown-body";
    block.append(summary, body);
    elements.messages?.append(block);
    streamingReasoning = block;
    return block;
  }

  function finalizeReasoningBlock() {
    if (!streamingReasoning) {
      return;
    }
    streamingReasoning.open = false;
    const summary = streamingReasoning.querySelector(".reasoning-summary");
    if (summary) {
      summary.textContent = "Thoughts";
    }
    streamingReasoning = undefined;
  }

  function addToolResult(text) {
    const item = document.createElement("details");
    item.className = "message tool-result";
    const summary = document.createElement("summary");
    summary.textContent = summarizeToolResult(text || "");
    const content = document.createElement("pre");
    content.textContent = text || "";
    item.append(summary, content);
    elements.messages?.append(item);
    scrollMessages();
    return item;
  }

  function upsertToolUse(toolUse) {
    if (!toolUse || !toolUse.id) {
      return;
    }
    const id = `tool-${toolUse.id}`;
    let item = elements.messages?.querySelector(`[data-tool-id="${cssEscape(id)}"]`);
    if (!item) {
      item = document.createElement("article");
      item.className = "message tool-use";
      item.dataset.toolId = id;

      const label = document.createElement("div");
      label.className = "role";
      label.textContent = "tool";
      const content = document.createElement("div");
      content.className = "tool-use-content";
      item.append(label, content);
      elements.messages?.append(item);
    }

    item.classList.toggle("failed", toolUse.status === "failed");
    item.classList.toggle("approval", toolUse.status === "approval");
    let content = item.querySelector(".tool-use-content");
    if (!content) {
      content = document.createElement("div");
      content.className = "tool-use-content";
      item.append(content);
    }
    content.replaceChildren();

    const status = document.createElement("span");
    status.className = `tool-status ${toolUse.status}`;
    status.textContent = toolUse.status;
    const summary = document.createElement("span");
    summary.className = "tool-summary";
    summary.textContent = toolUse.summary || toolUse.name;
    const mode = document.createElement("span");
    mode.className = "tool-mode";
    mode.textContent = toolUse.readOnly ? "read-only" : "approval";
    content.append(status, summary, mode);
    scrollMessages();
  }

  function addSessionList(sessions) {
    const item = document.createElement("article");
    item.className = "message session-list";

    const label = document.createElement("div");
    label.className = "role";
    label.textContent = "history";

    const content = document.createElement("div");
    content.className = "session-list-content";

    const header = document.createElement("div");
    header.className = "session-list-header";
    const title = document.createElement("strong");
    title.textContent = "Repo chat history";
    const newChat = document.createElement("button");
    newChat.type = "button";
    newChat.className = "secondary";
    newChat.textContent = "New chat";
    newChat.addEventListener("click", () => vscode.postMessage({ type: "newSession" }));
    header.append(title, newChat);
    content.append(header);

    if (!sessions.length) {
      const empty = document.createElement("p");
      empty.className = "session-empty";
      empty.textContent = "No saved CodeForge sessions for this workspace yet.";
      content.append(empty);
    } else {
      for (const session of sessions) {
        content.append(renderSessionRow(session));
      }
    }

    item.append(label, content);
    elements.messages?.append(item);
    scrollMessages();
    return item;
  }

  function renderSessionRow(session) {
    const row = document.createElement("div");
    row.className = "session-row";

    const meta = document.createElement("div");
    meta.className = "session-meta";
    const title = document.createElement("div");
    title.className = "session-title";
    title.textContent = session.title || session.id;
    const detail = document.createElement("div");
    detail.className = "session-detail";
    const pending = session.pendingApprovalCount ? `, ${session.pendingApprovalCount} pending approval(s)` : "";
    detail.textContent = `${new Date(session.updatedAt || Date.now()).toLocaleString()} - ${session.messageCount || 0} message(s)${pending}`;
    meta.append(title, detail);

    const open = document.createElement("button");
    open.type = "button";
    open.className = "secondary";
    open.textContent = "Open";
    open.addEventListener("click", () => vscode.postMessage({ type: "resumeSession", sessionId: session.id }));

    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "secondary";
    remove.textContent = "Delete";
    remove.title = `Delete ${session.title || session.id}`;
    remove.addEventListener("click", () => vscode.postMessage({ type: "deleteSession", sessionId: session.id }));

    const actions = document.createElement("div");
    actions.className = "session-actions";
    actions.append(open, remove);

    row.append(meta, actions);
    return row;
  }

  function resizePromptInput() {
    if (!elements.input) {
      return;
    }
    elements.input.style.height = "auto";
    const maxHeight = Math.max(48, Math.floor((window.innerHeight || document.documentElement.clientHeight) * 0.32));
    const nextHeight = Math.min(elements.input.scrollHeight, maxHeight);
    elements.input.style.height = `${nextHeight}px`;
    elements.input.style.overflowY = elements.input.scrollHeight > maxHeight ? "auto" : "hidden";
  }

  function scrollMessages() {
    if (elements.messages) {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    }
  }

  vscode.postMessage({ type: "webviewReady" });
}());
