(function () {
  const vscode = acquireVsCodeApi();
  const elements = {
    messages: document.getElementById("messages"),
    approvals: document.getElementById("approvals"),
    form: document.getElementById("promptForm"),
    input: document.getElementById("promptInput"),
    configure: document.getElementById("configure"),
    refreshModels: document.getElementById("refreshModels"),
    settingsToggle: document.getElementById("settingsToggle"),
    settingsPanel: document.getElementById("settingsPanel"),
    profileSelect: document.getElementById("profileSelect"),
    modelSelect: document.getElementById("modelSelect"),
    compactContext: document.getElementById("compactContext"),
    contextValue: document.getElementById("contextValue"),
    baseUrl: document.getElementById("baseUrl"),
    modelInput: document.getElementById("modelInput"),
    maxFiles: document.getElementById("maxFiles"),
    maxBytes: document.getElementById("maxBytes"),
    commandTimeout: document.getElementById("commandTimeout"),
    allowlist: document.getElementById("allowlist"),
    saveSettings: document.getElementById("saveSettings")
  };

  let state;
  let streamingMessage;

  elements.form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = elements.input.value.trim();
    if (!text) {
      return;
    }
    elements.input.value = "";
    vscode.postMessage({ type: "sendPrompt", text });
  });

  elements.input.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      elements.form.requestSubmit();
    }
  });

  elements.configure.addEventListener("click", () => {
    vscode.postMessage({ type: "configureEndpoint" });
  });

  elements.refreshModels.addEventListener("click", () => {
    vscode.postMessage({ type: "refreshModels" });
  });

  elements.settingsToggle.addEventListener("click", () => {
    elements.settingsPanel.classList.toggle("hidden");
  });

  elements.profileSelect.addEventListener("change", () => {
    vscode.postMessage({ type: "selectProfile", profileId: elements.profileSelect.value });
  });

  elements.modelSelect.addEventListener("change", () => {
    const model = elements.modelSelect.value;
    elements.modelInput.value = model;
    vscode.postMessage({ type: "selectModel", model });
  });

  elements.compactContext.addEventListener("click", () => {
    vscode.postMessage({ type: "compactContext" });
  });

  elements.saveSettings.addEventListener("click", () => {
    vscode.postMessage({
      type: "saveSettings",
      activeProfileId: elements.profileSelect.value,
      model: elements.modelInput.value.trim(),
      allowlist: elements.allowlist.value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean),
      maxFiles: Number(elements.maxFiles.value),
      maxBytes: Number(elements.maxBytes.value),
      commandTimeoutSeconds: Number(elements.commandTimeout.value)
    });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "sessionReset") {
      elements.messages.replaceChildren();
      elements.approvals.replaceChildren();
      streamingMessage = undefined;
    } else if (message.type === "state") {
      state = message.state;
      renderState();
    } else if (message.type === "models") {
      state = {
        ...(state || {}),
        models: message.models || [],
        selectedModel: message.selectedModel || state?.selectedModel || ""
      };
      renderModels(message.error);
    } else if (message.type === "contextUsage") {
      state = { ...(state || {}), contextUsage: message.usage };
      renderContextUsage(message.usage);
    } else if (message.type === "openSettings") {
      elements.settingsPanel.classList.remove("hidden");
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
      const pre = streamingMessage.querySelector("pre");
      pre.textContent += message.text;
      elements.messages.scrollTop = elements.messages.scrollHeight;
    } else if (message.type === "status") {
      addStatus(message.text);
    } else if (message.type === "toolResult") {
      addMessage("system", message.text);
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
    renderModels();
    renderSettings();
    renderContextUsage(state.contextUsage);
  }

  function renderProfiles() {
    const profiles = state.profiles || [];
    replaceOptions(elements.profileSelect, profiles.map((profile) => ({
      value: profile.id,
      label: profile.label
    })), state.activeProfileId);
  }

  function renderModels(error) {
    const models = state?.models || [];
    const selectedModel = state?.selectedModel || "";
    const options = models.length > 0
      ? models.map((model) => ({ value: model, label: model }))
      : [{ value: selectedModel, label: selectedModel || "No models found" }];
    replaceOptions(elements.modelSelect, options, selectedModel);
    elements.modelSelect.disabled = models.length === 0 && !selectedModel;
    if (error) {
      addStatus(`Model refresh failed: ${error}`);
    }
  }

  function renderSettings() {
    if (!state) {
      return;
    }
    elements.baseUrl.value = state.activeBaseUrl || "";
    elements.modelInput.value = state.selectedModel || "";
    elements.maxFiles.value = String(state.settings?.maxFiles ?? 24);
    elements.maxBytes.value = String(state.settings?.maxBytes ?? 120000);
    elements.commandTimeout.value = String(state.settings?.commandTimeoutSeconds ?? 120);
    elements.allowlist.value = (state.settings?.allowlist || []).join("\n");
  }

  function renderContextUsage(usage) {
    const safeUsage = usage || { percent: 0, label: "0 B / 0 B" };
    const percent = Math.max(0, Math.min(100, Number(safeUsage.percent) || 0));
    elements.contextValue.textContent = `${percent}%`;
    elements.compactContext.title = `Context ${safeUsage.label}. Click to compact with the selected model.`;
    elements.compactContext.style.setProperty("--context-percent", `${percent * 3.6}deg`);
    elements.compactContext.classList.toggle("warning", percent >= 70 && percent < 90);
    elements.compactContext.classList.toggle("danger", percent >= 90);
  }

  function replaceOptions(select, options, selectedValue) {
    const previous = select.value;
    select.replaceChildren();
    for (const option of options) {
      const node = document.createElement("option");
      node.value = option.value || "";
      node.textContent = option.label || option.value || "";
      select.append(node);
    }
    select.value = selectedValue || previous || options[0]?.value || "";
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
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role;
    const content = document.createElement("pre");
    content.textContent = text || "";
    item.append(label, content);
    elements.messages.append(item);
    elements.messages.scrollTop = elements.messages.scrollHeight;
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
    const detail = document.createElement("pre");
    detail.textContent = approval.action.type === "run_command"
      ? approval.action.command
      : approval.action.patch;

    const actions = document.createElement("div");
    actions.className = "approval-actions";
    const approve = document.createElement("button");
    approve.textContent = "Approve";
    approve.addEventListener("click", () => vscode.postMessage({ type: "approve", id: approval.id }));
    const reject = document.createElement("button");
    reject.textContent = "Reject";
    reject.addEventListener("click", () => vscode.postMessage({ type: "reject", id: approval.id }));
    actions.append(approve, reject);

    item.append(title, summary, detail, actions);
    elements.approvals.append(item);
  }

  function removeApproval(id) {
    const item = elements.approvals.querySelector(`[data-id="${CSS.escape(id)}"]`);
    item?.remove();
  }
}());
