(function () {
  const vscode = acquireVsCodeApi();
  const elements = {
    messages: document.getElementById("messages"),
    approvals: document.getElementById("approvals"),
    form: document.getElementById("promptForm"),
    input: document.getElementById("promptInput"),
    slashCommandMenu: document.getElementById("slashCommandMenu"),
    stopRun: document.getElementById("stopRun"),
    settingsToggle: document.getElementById("settingsToggle"),
    settingsPanel: document.getElementById("settingsPanel"),
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
    maxFiles: document.getElementById("maxFiles"),
    maxBytes: document.getElementById("maxBytes"),
    commandTimeout: document.getElementById("commandTimeout"),
    commandOutputLimit: document.getElementById("commandOutputLimit"),
    modeStatus: document.getElementById("modeStatus"),
    permissionRules: document.getElementById("permissionRules"),
    allowlist: document.getElementById("allowlist"),
    saveSettings: document.getElementById("saveSettings")
  };

  let state;
  let streamingMessage;
  let isCreatingProfile = false;
  let pendingProfileCreate = false;
  let slashCommandItems = [];
  let slashCommandIndex = 0;
  let lastCommandRefreshAt = 0;
  let lastModelRefreshAt = 0;
  let contextTooltipText = "Context used: 0 / 0 tokens (0%)\nClick to compact context.";
  const builtInSlashCommands = [
    { name: "compact", description: "Compact the current session context", argumentHint: "[focus]" },
    { name: "context", description: "Show context usage and attached local context" },
    { name: "commands", description: "List workspace-local slash commands" },
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
    { name: "auto", description: "Switch agent mode to Auto" },
    { name: "plan", description: "Switch agent mode to Plan", argumentHint: "[task]" },
    { name: "default", description: "Set permission mode to Default" },
    { name: "review", description: "Set permission mode to Review" },
    { name: "accept-edits", description: "Set permission mode to Accept edits" },
    { name: "read-only", description: "Set permission mode to Read only" },
    { name: "workspace-trusted", description: "Set permission mode to Workspace trusted" },
    { name: "config", description: "Open CodeForge settings" },
    { name: "settings", description: "Open CodeForge settings" },
    { name: "reset", description: "Reset the current chat session" },
    { name: "cancel", description: "Stop the current request" }
  ];
  const permissionModeOptions = [
    { value: "default", label: "Default" },
    { value: "review", label: "Review" },
    { value: "acceptEdits", label: "Accept edits" },
    { value: "readOnly", label: "Read only" },
    { value: "workspaceTrusted", label: "Workspace trusted" }
  ];
  const agentModeOptions = [
    { value: "auto", label: "Auto", icon: "⬢", description: "Implement with approved local actions" },
    { value: "plan", label: "Plan", icon: "⏸", description: "Read-only planning before implementation" }
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
      elements.settingsPanel?.classList.add("hidden");
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

  on(elements.agentModeButton, "click", () => {
    renderAgentModePicker();
    toggleComboMenu(elements.agentModeMenu, elements.agentModeButton);
  });

  on(elements.modelPickerButton, "click", () => {
    requestModelRefreshIfNeeded();
    renderModelPicker();
    toggleComboMenu(elements.modelPickerMenu, elements.modelPickerButton);
  });

  on(elements.settingsToggle, "click", () => {
    closeMenus();
    elements.settingsPanel?.classList.toggle("hidden");
  });

  on(elements.profileSelect, "change", () => {
    isCreatingProfile = false;
    renderProfiles();
    renderEndpointFields();
    vscode.postMessage({ type: "selectProfile", profileId: elements.profileSelect?.value || "" });
  });

  window.addEventListener("click", (event) => {
    const target = event.target;
    if (target instanceof Element && (target === elements.input || target.closest(".slash-command-menu") || target.closest(".combo") || target.closest(".endpoint-picker") || target.closest(".agent-mode-picker") || target.closest(".model-picker"))) {
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
    if (target instanceof Element && (target.closest(".combo-menu") || target.closest(".slash-command-menu") || target.closest(".endpoint-picker-menu") || target.closest(".agent-mode-menu") || target.closest(".model-picker-menu"))) {
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
    vscode.postMessage({
      type: "saveSettings",
      activeProfileId: elements.profileSelect?.value || "",
      createProfile: isCreatingProfile,
      profileLabel,
      baseUrl,
      apiKey: elements.apiKey?.value.trim() || "",
      model: elements.modelInput?.value.trim() || "",
      allowlist: splitLines(elements.allowlist?.value || ""),
      maxFiles: Number(elements.maxFiles?.value),
      maxBytes: Number(elements.maxBytes?.value),
      commandTimeoutSeconds: Number(elements.commandTimeout?.value),
      commandOutputLimitBytes: Number(elements.commandOutputLimit?.value),
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
      elements.approvals?.replaceChildren();
      streamingMessage = undefined;
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
    } else if (message.type === "contextUsage") {
      state = { ...(state || {}), contextUsage: message.usage };
      renderContextUsage(message.usage);
    } else if (message.type === "openSettings") {
      elements.settingsPanel?.classList.remove("hidden");
      renderState();
    } else if (message.type === "message") {
      if (message.role === "assistant" && streamingMessage) {
        streamingMessage = undefined;
        return;
      }
      addMessage(message.role, message.text);
    } else if (message.type === "assistantDelta") {
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
      addStatus(message.text);
    } else if (message.type === "toolResult") {
      addToolResult(message.text);
    } else if (message.type === "toolUse") {
      upsertToolUse(message.toolUse);
    } else if (message.type === "sessions") {
      addSessionList(message.sessions || []);
    } else if (message.type === "approvalRequested") {
      addApproval(message.approval);
    } else if (message.type === "approvalResolved") {
      removeApproval(message.id);
      addStatus(message.text);
    } else if (message.type === "error") {
      addMessage("system error", `Error: ${message.text}`);
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
    setValue(elements.maxFiles, String(state.settings?.maxFiles ?? 24));
    setValue(elements.maxBytes, String(state.settings?.maxBytes ?? 120000));
    setValue(elements.commandTimeout, String(state.settings?.commandTimeoutSeconds ?? 120));
    setValue(elements.commandOutputLimit, String(state.settings?.commandOutputLimitBytes ?? 200000));
    renderPermissionModeStatus(state.settings?.permissionMode || "default");
    setValue(elements.permissionRules, JSON.stringify(state.settings?.permissionRules || [], null, 2));
    setValue(elements.allowlist, (state.settings?.allowlist || []).join("\n"));
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
    if (!model) {
      elements.modelMeta.textContent = "Model metadata will update after model discovery.";
      return;
    }

    const details = [];
    if (model.contextLength) {
      details.push(`context ${formatNumber(model.contextLength)} tokens`);
    }
    if (model.maxOutputTokens) {
      details.push(`output ${formatNumber(model.maxOutputTokens)} tokens`);
    }
    if (model.supportsReasoning) {
      details.push("thinking model");
    }
    elements.modelMeta.textContent = details.length > 0
      ? `Selected model: ${details.join(", ")}.`
      : "Selected model metadata was not exposed by this endpoint.";
  }

  function findModelInfo(modelId) {
    return (state?.modelInfo || []).find((model) => model.id === modelId);
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
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

  function numberOrFallback(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function estimatedTokens(bytes) {
    return Math.max(0, Math.ceil((Number(bytes) || 0) / 4));
  }

  function replaceOptions(select, options, selectedValue) {
    if (!select) {
      return selectedValue || options[0]?.value || "";
    }
    const previous = select.value;
    select.replaceChildren();
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value || "";
      node.textContent = option.label || option.value || "";
      select.append(node);
    }
    const optionValues = options.map((option) => option.value || "");
    const nextValue = selectedValue && optionValues.includes(selectedValue)
      ? selectedValue
      : previous && optionValues.includes(previous)
        ? previous
        : options[0]?.value || "";
    select.value = nextValue;
    return nextValue;
  }

  function renderPermissionModeStatus(selectedValue) {
    const selectedOption = permissionModeOptions.find((option) => option.value === selectedValue) || permissionModeOptions[0];
    if (elements.modeStatus) {
      elements.modeStatus.textContent = `${selectedOption.label} Approvals`;
    }
  }

  function renderAgentModePicker() {
    const selectedValue = state?.settings?.agentMode || "auto";
    const selectedOption = agentModeOptions.find((option) => option.value === selectedValue) || agentModeOptions[0];
    if (elements.agentModeIcon) {
      elements.agentModeIcon.textContent = selectedOption.icon;
    }
    if (elements.agentModeButton) {
      elements.agentModeButton.title = `Agent mode: ${selectedOption.label}`;
      elements.agentModeButton.setAttribute("aria-label", `Agent mode: ${selectedOption.label}`);
      elements.agentModeButton.dataset.mode = selectedOption.value;
    }
    renderComboMenu(elements.agentModeMenu, elements.agentModeButton, agentModeOptions, selectedOption.value, "Auto", chooseAgentMode, { preserveButtonText: true, includeDescription: true });
  }

  function chooseAgentMode(value) {
    const nextMode = agentModeOptions.some((option) => option.value === value) ? value : "auto";
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
      positionComboMenu(menu, button);
      menu.classList.remove("hidden");
      button.setAttribute("aria-expanded", "true");
    }
  }

  function positionComboMenu(menu, button) {
    const margin = 4;
    const rect = button.getBoundingClientRect();
    const viewportWidth = window.innerWidth || document.documentElement.clientWidth;
    const viewportHeight = window.innerHeight || document.documentElement.clientHeight;
    const width = Math.min(Math.max(rect.width, 180), Math.max(120, viewportWidth - margin * 2));
    const left = Math.min(Math.max(margin, rect.left), Math.max(margin, viewportWidth - width - margin));
    const availableBelow = viewportHeight - rect.bottom - margin;
    const availableAbove = rect.top - margin;
    const openAbove = availableBelow < 120 && availableAbove > availableBelow;
    const availableHeight = Math.max(openAbove ? availableAbove : availableBelow, 80);
    const maxHeight = Math.min(260, availableHeight);
    const top = openAbove
      ? Math.max(margin, rect.top - maxHeight - 3)
      : Math.min(rect.bottom + 3, viewportHeight - maxHeight - margin);

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

    elements.slashCommandMenu.classList.remove("hidden");
    elements.input?.setAttribute("aria-expanded", "true");
    elements.input?.setAttribute("aria-activedescendant", `slash-command-${slashCommandIndex}`);
    updateSlashCommandSelection();
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
    const raw = elements.permissionRules?.value.trim() || "";
    if (!raw) {
      return [];
    }
    try {
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) {
        addMessage("system error", "Error: Permission rules must be a JSON array.");
        return undefined;
      }
      return parsed;
    } catch (error) {
      addMessage("system error", `Error: Could not parse permission rules JSON. ${error.message || String(error)}`);
      return undefined;
    }
  }

  function renderMarkdown(container, text) {
    if (!container) {
      return;
    }

    const fragment = document.createDocumentFragment();
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    let index = 0;
    let paragraph = [];

    function flushParagraph() {
      if (paragraph.length === 0) {
        return;
      }
      const p = document.createElement("p");
      appendInline(p, paragraph.join("\n"));
      fragment.append(p);
      paragraph = [];
    }

    while (index < lines.length) {
      const line = lines[index];

      if (!line.trim()) {
        flushParagraph();
        index++;
        continue;
      }

      const fence = line.match(/^\s*```([A-Za-z0-9_.-]+)?\s*$/);
      if (fence) {
        flushParagraph();
        index++;
        const codeLines = [];
        while (index < lines.length && !/^\s*```\s*$/.test(lines[index])) {
          codeLines.push(lines[index]);
          index++;
        }
        if (index < lines.length) {
          index++;
        }
        const pre = document.createElement("pre");
        const code = document.createElement("code");
        renderCodeBlock(code, codeLines.join("\n"), fence[1] || "");
        pre.append(code);
        fragment.append(pre);
        continue;
      }

      const heading = line.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) {
        flushParagraph();
        const level = Math.min(6, heading[1].length + 2);
        const h = document.createElement(`h${level}`);
        appendInline(h, heading[2]);
        fragment.append(h);
        index++;
        continue;
      }

      if (/^\s*([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
        flushParagraph();
        fragment.append(document.createElement("hr"));
        index++;
        continue;
      }

      if (/^\s*>\s?/.test(line)) {
        flushParagraph();
        const quoteLines = [];
        while (index < lines.length && /^\s*>\s?/.test(lines[index])) {
          quoteLines.push(lines[index].replace(/^\s*>\s?/, ""));
          index++;
        }
        const blockquote = document.createElement("blockquote");
        appendInline(blockquote, quoteLines.join("\n"));
        fragment.append(blockquote);
        continue;
      }

      const unordered = line.match(/^\s*[-*+]\s+(.+)$/);
      const ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (unordered || ordered) {
        flushParagraph();
        const list = document.createElement(unordered ? "ul" : "ol");
        while (index < lines.length) {
          const itemMatch = unordered
            ? lines[index].match(/^\s*[-*+]\s+(.+)$/)
            : lines[index].match(/^\s*\d+[.)]\s+(.+)$/);
          if (!itemMatch) {
            break;
          }
          const li = document.createElement("li");
          appendInline(li, itemMatch[1]);
          list.append(li);
          index++;
        }
        fragment.append(list);
        continue;
      }

      paragraph.push(line);
      index++;
    }

    flushParagraph();
    container.replaceChildren(fragment);
  }

  function appendInline(parent, text) {
    const pattern = /(`([^`]+)`|\*\*([^*]+)\*\*|__([^_]+)__|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*([^*\s][^*]*?)\*|_([^_\s][^_]*?)_)/g;
    let cursor = 0;
    let match;

    while ((match = pattern.exec(text)) !== null) {
      appendText(parent, text.slice(cursor, match.index));
      if (match[2] !== undefined) {
        const code = document.createElement("code");
        code.textContent = match[2];
        parent.append(code);
      } else if (match[3] !== undefined || match[4] !== undefined) {
        const strong = document.createElement("strong");
        appendInline(strong, match[3] ?? match[4]);
        parent.append(strong);
      } else if (match[5] !== undefined && match[6] !== undefined) {
        const link = document.createElement("a");
        link.href = match[6];
        link.textContent = match[5];
        link.target = "_blank";
        link.rel = "noopener noreferrer";
        parent.append(link);
      } else {
        const em = document.createElement("em");
        appendInline(em, match[7] ?? match[8]);
        parent.append(em);
      }
      cursor = match.index + match[0].length;
    }

    appendText(parent, text.slice(cursor));
  }

  function appendText(parent, text) {
    const parts = String(text || "").split("\n");
    parts.forEach((part, index) => {
      if (index > 0) {
        parent.append(document.createElement("br"));
      }
      if (part) {
        parent.append(document.createTextNode(part));
      }
    });
  }

  function renderCodeBlock(code, source, language) {
    const normalized = normalizeLanguage(language);
    if (normalized) {
      code.dataset.language = normalized;
      code.className = `language-${normalized}`;
    }
    code.replaceChildren(highlightCode(source, normalized));
  }

  function highlightCode(source, language) {
    if (language === "diff" || language === "patch") {
      return highlightDiff(source);
    }
    if (language === "json" || language === "jsonc") {
      return highlightWithRules(source, [
        tokenRule("comment", "\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/"),
        tokenRule("property", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"(?=\\s*:)"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\""),
        tokenRule("number", "-?\\b\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b"),
        tokenRule("keyword", "\\b(?:true|false|null)\\b"),
        tokenRule("punctuation", "[{}\\[\\],:]")
      ]);
    }
    if (language === "html" || language === "xml" || language === "svg") {
      return highlightWithRules(source, [
        tokenRule("comment", "<!--[\\s\\S]*?-->"),
        tokenRule("tag", "<\\/?[A-Za-z][^>\\n]*?>"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'")
      ]);
    }
    if (language === "css" || language === "scss" || language === "less") {
      return highlightWithRules(source, [
        tokenRule("comment", "\\/\\*[\\s\\S]*?\\*\\/"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'"),
        tokenRule("property", "\\b-?[A-Za-z][\\w-]*(?=\\s*:)"),
        tokenRule("number", "-?\\b\\d+(?:\\.\\d+)?(?:[a-zA-Z%]+)?\\b"),
        tokenRule("selector", "[.#][A-Za-z_-][\\w-]*"),
        tokenRule("keyword", "\\b(?:important|inherit|initial|unset|revert|var|calc|rgb|rgba|hsl|hsla)\\b"),
        tokenRule("punctuation", "[{}():;,]")
      ]);
    }
    if (language === "sh" || language === "bash" || language === "shell" || language === "zsh") {
      return highlightWithRules(source, [
        tokenRule("comment", "#[^\\n]*"),
        tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'"),
        tokenRule("keyword", "\\b(?:if|then|else|elif|fi|for|while|do|done|case|esac|function|in|export|local|return|set|unset)\\b"),
        tokenRule("variable", "\\$\\{?[A-Za-z_][\\w]*\\}?|\\$\\d+"),
        tokenRule("number", "\\b\\d+\\b"),
        tokenRule("operator", "[|&;()<>]")
      ]);
    }
    if (language === "py" || language === "python") {
      return highlightWithRules(source, commonCodeRules("\\b(?:and|as|assert|async|await|break|class|continue|def|del|elif|else|except|False|finally|for|from|global|if|import|in|is|lambda|None|nonlocal|not|or|pass|raise|return|True|try|while|with|yield)\\b", true));
    }
    if (language === "go") {
      return highlightWithRules(source, commonCodeRules("\\b(?:break|case|chan|const|continue|default|defer|else|fallthrough|for|func|go|goto|if|import|interface|map|package|range|return|select|struct|switch|type|var)\\b", false));
    }
    if (language === "rs" || language === "rust") {
      return highlightWithRules(source, commonCodeRules("\\b(?:as|async|await|break|const|continue|crate|dyn|else|enum|extern|false|fn|for|if|impl|in|let|loop|match|mod|move|mut|pub|ref|return|self|Self|static|struct|super|trait|true|type|unsafe|use|where|while)\\b", false));
    }
    if (language === "cs" || language === "csharp") {
      return highlightWithRules(source, commonCodeRules("\\b(?:abstract|as|async|await|base|bool|break|case|catch|class|const|continue|decimal|default|delegate|do|double|else|enum|event|explicit|extern|false|finally|fixed|float|for|foreach|get|if|implicit|in|int|interface|internal|is|lock|namespace|new|null|object|operator|out|override|private|protected|public|readonly|record|ref|required|return|sealed|set|static|string|struct|switch|this|throw|true|try|typeof|using|var|virtual|void|while|with|yield)\\b", false));
    }
    return highlightWithRules(source, commonCodeRules("\\b(?:abstract|as|async|await|break|case|catch|class|const|continue|debugger|default|delete|do|else|enum|export|extends|false|finally|for|from|function|get|if|implements|import|in|instanceof|interface|let|new|null|of|package|private|protected|public|readonly|return|set|static|super|switch|this|throw|true|try|type|typeof|undefined|var|void|while|with|yield)\\b", false));
  }

  function commonCodeRules(keywordPattern, hashComments) {
    return [
      tokenRule("comment", `${hashComments ? "#[^\\n]*|" : ""}\\/\\/[^\\n]*|\\/\\*[\\s\\S]*?\\*\\/`),
      tokenRule("string", "\"(?:\\\\[\\s\\S]|[^\"\\\\])*\"|'(?:\\\\[\\s\\S]|[^'\\\\])*'|`(?:\\\\[\\s\\S]|[^`\\\\])*`"),
      tokenRule("keyword", keywordPattern),
      tokenRule("number", "\\b(?:0x[\\da-fA-F]+|\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)\\b"),
      tokenRule("function", "\\b[A-Za-z_$][\\w$]*(?=\\s*\\()"),
      tokenRule("type", "\\b[A-Z][A-Za-z0-9_]*\\b"),
      tokenRule("operator", "[{}\\[\\]().,;:+\\-*/%=&|!<>?~^]+")
    ];
  }

  function tokenRule(className, pattern) {
    return { className, pattern };
  }

  function highlightWithRules(source, rules) {
    const fragment = document.createDocumentFragment();
    const pattern = new RegExp(rules.map((rule) => `(${rule.pattern})`).join("|"), "g");
    let cursor = 0;
    let match;

    while ((match = pattern.exec(source)) !== null) {
      if (match.index < cursor) {
        continue;
      }
      appendPlainCode(fragment, source.slice(cursor, match.index));
      const ruleIndex = match.slice(1).findIndex((value) => value !== undefined);
      const className = rules[ruleIndex]?.className;
      appendCodeToken(fragment, match[0], className);
      cursor = pattern.lastIndex;
      if (pattern.lastIndex === match.index) {
        pattern.lastIndex++;
      }
    }

    appendPlainCode(fragment, source.slice(cursor));
    return fragment;
  }

  function highlightDiff(source) {
    const fragment = document.createDocumentFragment();
    const lines = source.match(/[^\n]*(?:\n|$)/g) || [];
    for (const line of lines) {
      if (!line) {
        continue;
      }
      const className = line.startsWith("@@")
        ? "hunk"
        : line.startsWith("+") && !line.startsWith("+++")
          ? "inserted"
          : line.startsWith("-") && !line.startsWith("---")
            ? "deleted"
            : line.startsWith("diff ") || line.startsWith("index ") || line.startsWith("+++") || line.startsWith("---")
              ? "meta"
              : "";
      appendCodeToken(fragment, line, className);
    }
    return fragment;
  }

  function appendCodeToken(parent, text, className) {
    if (!text) {
      return;
    }
    if (!className) {
      appendPlainCode(parent, text);
      return;
    }
    const span = document.createElement("span");
    span.className = `syntax-${className}`;
    span.textContent = text;
    parent.append(span);
  }

  function appendPlainCode(parent, text) {
    if (text) {
      parent.append(document.createTextNode(text));
    }
  }

  function normalizeLanguage(language) {
    const normalized = String(language || "").trim().toLowerCase();
    const aliases = {
      cjs: "js",
      htm: "html",
      javascript: "js",
      jsx: "js",
      mjs: "js",
      shellsession: "shell",
      text: "",
      tsx: "ts",
      typescript: "ts",
      yml: "yaml"
    };
    return aliases[normalized] ?? normalized;
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

  function addApproval(approval) {
    const item = document.createElement("article");
    item.className = "approval";
    item.dataset.id = approval.id;

    const title = document.createElement("h3");
    title.textContent = approval.title;
    const summary = document.createElement("p");
    summary.textContent = approval.summary;
    const risk = document.createElement("div");
    risk.className = "approval-risk";
    risk.textContent = approval.risk || approval.kind;
    const reason = document.createElement("div");
    reason.className = "approval-reason";
    reason.textContent = approval.permissionReason || "Approval is required by the current permission policy.";
    const detail = document.createElement("pre");
    detail.textContent = approval.detail || approvalDetail(approval.action);

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    if (hasDiffPreview(approval.action)) {
      const review = document.createElement("button");
      review.textContent = "Review";
      review.className = "secondary";
      review.addEventListener("click", () => vscode.postMessage({ type: "previewApproval", id: approval.id }));
      actions.append(review);
    }
    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.addEventListener("click", () => vscode.postMessage({ type: "approve", id: approval.id }));
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.addEventListener("click", () => vscode.postMessage({ type: "reject", id: approval.id }));
    actions.append(approve, reject);

    item.append(title, summary, risk, reason, detail, actions);
    elements.approvals?.append(item);
  }

  function removeApproval(id) {
    const item = elements.approvals?.querySelector(`[data-id="${cssEscape(id)}"]`);
    item?.remove();
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
    title.textContent = "Workspace chat history";
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

    row.append(meta, open);
    return row;
  }

  function approvalDetail(action) {
    if (!action) {
      return "";
    }
    if (action.type === "run_command") {
      return action.command;
    }
    if (action.type === "propose_patch") {
      return action.patch;
    }
    if (action.type === "open_diff") {
      return action.patch;
    }
    if (action.type === "write_file") {
      return `${action.path}\n\n${action.content || ""}`;
    }
    if (action.type === "edit_file") {
      return `${action.path}\n\nOLD:\n${action.oldText || ""}\n\nNEW:\n${action.newText || ""}`;
    }
    if (action.type === "list_files") {
      return action.pattern || "**/*";
    }
    if (action.type === "glob_files") {
      return action.pattern;
    }
    if (action.type === "read_file") {
      return action.path;
    }
    if (action.type === "search_text") {
      return action.query;
    }
    if (action.type === "grep_text") {
      return `${action.query}${action.include ? `\n${action.include}` : ""}`;
    }
    if (action.type === "list_diagnostics") {
      return action.path || "workspace diagnostics";
    }
    return action.type || "";
  }

  function hasDiffPreview(action) {
    return Boolean(action && (
      action.type === "propose_patch" ||
      action.type === "open_diff" ||
      action.type === "write_file" ||
      action.type === "edit_file"
    ));
  }

  function summarizeToolResult(text) {
    const firstLine = (text || "").split(/\r?\n/).find((line) => line.trim()) || "Tool result";
    return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
  }

  function on(element, type, listener) {
    if (element) {
      element.addEventListener(type, listener);
    }
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

  function setValue(element, value) {
    if (element) {
      element.value = value;
    }
  }

  function splitLines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function scrollMessages() {
    if (elements.messages) {
      elements.messages.scrollTop = elements.messages.scrollHeight;
    }
  }

  function cssEscape(value) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  }
}());
