// MCP server draft editor for the CodeForge settings panel: owns the editable server-draft state
// (drafts + current selection + dirty flag), renders the server list and field editor, and shows probe
// results. Unlike the pure dom.js lift this is a stateful sub-component, so it exposes a factory
// createMcpEditor(deps) that holds the draft state behind a small interface the view drives from its
// event handlers (and syncs from settings on each render). DOM/string helpers come from dom.js; the host
// injects vscode, the elements map, a live MCP-status accessor, and the JSON-object parser (which reports
// errors through the chat log). Loaded before main.js; no build step for media/ — keep this valid browser JS.
(function () {
  const { setDisabled, setValue, setChecked, splitArgs } = window.CodeForge.dom;

  function createMcpEditor(deps) {
    const { vscode, elements, mcpStatuses, parseJsonObject } = deps;

    let mcpDrafts = [];
    let selectedMcpId = "";
    let mcpDraftDirty = false;

    function cloneMcpServers(servers) {
      return (Array.isArray(servers) ? servers : []).map((server) => ({
        id: String(server.id || ""),
        label: String(server.label || server.id || ""),
        enabled: server.enabled !== false,
        transport: ["http", "sse", "stdio"].includes(server.transport) ? server.transport : "http",
        url: String(server.url || ""),
        command: String(server.command || ""),
        args: Array.isArray(server.args) ? server.args.filter((item) => typeof item === "string") : [],
        cwd: String(server.cwd || ""),
        headers: server.headers && typeof server.headers === "object" && !Array.isArray(server.headers) ? { ...server.headers } : {}
      }));
    }

    function renderMcpEditor() {
      renderMcpServerList();
      const selected = mcpDrafts.find((server) => server.id === selectedMcpId) || mcpDrafts[0];
      selectedMcpId = selected?.id || "";
      const hasSelection = Boolean(selected);
      setDisabled(elements.deleteMcpServer, !hasSelection);
      setDisabled(elements.checkMcpServer, !hasSelection);
      for (const field of [elements.mcpId, elements.mcpLabel, elements.mcpEnabled, elements.mcpTransport, elements.mcpUrl, elements.mcpCommand, elements.mcpArgs, elements.mcpCwd, elements.mcpHeaders]) {
        setDisabled(field, !hasSelection);
      }
      if (!selected) {
        setValue(elements.mcpId, "");
        setValue(elements.mcpLabel, "");
        setChecked(elements.mcpEnabled, true);
        setValue(elements.mcpTransport, "http");
        setValue(elements.mcpUrl, "");
        setValue(elements.mcpCommand, "");
        setValue(elements.mcpArgs, "");
        setValue(elements.mcpCwd, "");
        setValue(elements.mcpHeaders, "{}");
        renderMcpProbeStatus("No MCP server selected.");
        return;
      }
      setValue(elements.mcpId, selected.id);
      setValue(elements.mcpLabel, selected.label);
      setChecked(elements.mcpEnabled, selected.enabled !== false);
      setValue(elements.mcpTransport, selected.transport || "http");
      setValue(elements.mcpUrl, selected.url || "");
      setValue(elements.mcpCommand, selected.command || "");
      setValue(elements.mcpArgs, (selected.args || []).join(" "));
      setValue(elements.mcpCwd, selected.cwd || "");
      setValue(elements.mcpHeaders, JSON.stringify(selected.headers || {}, null, 2));
      renderMcpProbeFromState(selected.id);
    }

    function renderMcpServerList() {
      if (!elements.mcpServerList) {
        return;
      }
      elements.mcpServerList.replaceChildren();
      if (mcpDrafts.length === 0) {
        const empty = document.createElement("div");
        empty.className = "mcp-empty";
        empty.textContent = "No MCP servers configured.";
        elements.mcpServerList.append(empty);
        return;
      }
      const statuses = new Map(mcpStatuses().map((server) => [server.id, server]));
      for (const server of mcpDrafts) {
        const status = statuses.get(server.id);
        const row = document.createElement("div");
        row.className = "mcp-server-row";
        row.setAttribute("aria-selected", server.id === selectedMcpId ? "true" : "false");
        const select = document.createElement("button");
        select.type = "button";
        select.className = "mcp-server-select";
        const title = document.createElement("span");
        title.className = "mcp-server-title";
        title.textContent = server.label || server.id || "Unnamed MCP";
        const detail = document.createElement("span");
        detail.className = "mcp-server-detail";
        detail.textContent = `${server.transport || "http"}${status ? ` - ${status.enabled ? status.valid ? "ready" : "blocked" : "disabled"}` : ""}`;
        select.append(title, detail);
        select.addEventListener("click", () => {
          updateSelectedMcpDraftFromFields();
          selectedMcpId = server.id;
          renderMcpEditor();
        });
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "secondary mcp-server-delete";
        remove.textContent = "Delete";
        remove.title = `Delete ${server.label || server.id || "MCP server"}`;
        remove.addEventListener("click", () => {
          deleteMcpDraft(server.id);
        });
        row.append(select, remove);
        elements.mcpServerList.append(row);
      }
    }

    function addMcpDraft() {
      updateSelectedMcpDraftFromFields();
      const id = uniqueMcpId();
      mcpDrafts = [
        ...mcpDrafts,
        {
          id,
          label: "Local MCP",
          enabled: true,
          transport: "http",
          url: "http://127.0.0.1:3000/mcp",
          command: "",
          args: [],
          cwd: "",
          headers: {}
        }
      ];
      selectedMcpId = id;
      mcpDraftDirty = true;
      renderMcpEditor();
      elements.mcpLabel?.focus();
    }

    function deleteSelectedMcpDraft() {
      if (!selectedMcpId) {
        return;
      }
      deleteMcpDraft(selectedMcpId);
    }

    function deleteMcpDraft(id) {
      if (!id) {
        return;
      }
      const removed = mcpDrafts.find((server) => server.id === id);
      mcpDrafts = mcpDrafts.filter((server) => server.id !== id);
      selectedMcpId = mcpDrafts[0]?.id || "";
      mcpDraftDirty = true;
      if (removed) {
        renderMcpProbeStatus(`Deleted ${removed.label || removed.id}. Save settings to apply.`);
      }
      renderMcpEditor();
    }

    function updateSelectedMcpDraftFromFields() {
      if (!selectedMcpId) {
        return;
      }
      const index = mcpDrafts.findIndex((server) => server.id === selectedMcpId);
      if (index < 0) {
        return;
      }
      const headers = parseJsonObject(elements.mcpHeaders, "MCP headers");
      if (headers === undefined) {
        return;
      }
      const nextId = safeMcpId(elements.mcpId?.value || selectedMcpId);
      const next = {
        ...mcpDrafts[index],
        id: nextId,
        label: elements.mcpLabel?.value.trim() || nextId,
        enabled: elements.mcpEnabled?.checked !== false,
        transport: ["http", "sse", "stdio"].includes(elements.mcpTransport?.value) ? elements.mcpTransport.value : "http",
        url: elements.mcpUrl?.value.trim() || "",
        command: elements.mcpCommand?.value.trim() || "",
        args: splitArgs(elements.mcpArgs?.value || ""),
        cwd: elements.mcpCwd?.value.trim() || "",
        headers
      };
      mcpDrafts[index] = next;
      selectedMcpId = next.id;
      mcpDraftDirty = true;
    }

    function serializedMcpDrafts() {
      return mcpDrafts
        .map((server) => {
          const transport = ["http", "sse", "stdio"].includes(server.transport) ? server.transport : "http";
          const result = {
            id: safeMcpId(server.id),
            label: server.label || safeMcpId(server.id),
            enabled: server.enabled !== false,
            transport
          };
          if (transport === "stdio") {
            result.command = server.command || "";
            result.args = server.args || [];
            if (server.cwd) {
              result.cwd = server.cwd;
            }
          } else {
            result.url = server.url || "";
          }
          if (server.headers && Object.keys(server.headers).length > 0) {
            result.headers = server.headers;
          }
          return result;
        })
        .filter((server) => server.id && server.label);
    }

    function renderMcpProbe(inspections) {
      if (!inspections.length) {
        renderMcpProbeStatus("No MCP probe results.");
        return;
      }
      const selected = inspections.find((inspection) => inspection.server?.id === selectedMcpId) || inspections[0];
      if (!selected || !elements.mcpProbePanel) {
        return;
      }
      elements.mcpProbePanel.replaceChildren(renderMcpInspection(selected));
    }

    function renderMcpProbeFromState(serverId) {
      const status = mcpStatuses().find((server) => server.id === serverId);
      if (!status) {
        renderMcpProbeStatus("Save settings or check the server to see tools and resources.");
        return;
      }
      const text = status.enabled ? status.valid ? "Ready. Check the server to list tools and resources." : `Blocked: ${status.reason || "invalid configuration"}` : "Disabled.";
      renderMcpProbeStatus(text);
    }

    function renderMcpProbeStatus(text) {
      if (!elements.mcpProbePanel) {
        return;
      }
      const item = document.createElement("div");
      item.className = "mcp-probe-empty";
      item.textContent = text;
      elements.mcpProbePanel.replaceChildren(item);
    }

    function renderMcpInspection(inspection) {
      const wrapper = document.createElement("div");
      wrapper.className = "mcp-probe-result";
      const title = document.createElement("strong");
      const server = inspection.server || {};
      title.textContent = `${server.label || server.id || "MCP server"} - ${server.enabled ? server.valid ? "ready" : "blocked" : "disabled"}`;
      wrapper.append(title);
      if (inspection.error || server.reason) {
        const error = document.createElement("p");
        error.className = "mcp-probe-error";
        error.textContent = inspection.error || server.reason;
        wrapper.append(error);
      }
      wrapper.append(renderMcpProbeGroup("Tools", inspection.tools || [], "name", ""));
      wrapper.append(renderMcpProbeGroup("Resources", inspection.resources || [], "uri", server.id || selectedMcpId));
      return wrapper;
    }

    function renderMcpProbeGroup(label, items, key, serverId) {
      const group = document.createElement("div");
      group.className = "mcp-probe-group";
      const heading = document.createElement("div");
      heading.className = "mcp-probe-heading";
      heading.textContent = `${label} (${items.length})`;
      group.append(heading);
      if (!items.length) {
        const empty = document.createElement("div");
        empty.className = "mcp-probe-empty";
        empty.textContent = `No ${label.toLowerCase()} reported.`;
        group.append(empty);
        return group;
      }
      for (const item of items.slice(0, 24)) {
        const row = document.createElement("div");
        row.className = "mcp-probe-row";
        const name = document.createElement("span");
        name.className = "mcp-probe-name";
        name.textContent = item[key] || item.name || "";
        const detail = document.createElement("span");
        detail.className = "mcp-probe-detail";
        detail.textContent = item.description || item.mimeType || "";
        row.append(name, detail);
        if (label === "Resources" && serverId) {
          const attach = document.createElement("button");
          attach.type = "button";
          attach.className = "secondary mcp-attach-button";
          attach.textContent = "Attach";
          attach.addEventListener("click", () => {
            updateSelectedMcpDraftFromFields();
            vscode.postMessage({ type: "attachMcpResource", serverId, uri: item.uri, mcpServers: serializedMcpDrafts() });
          });
          row.append(attach);
        }
        group.append(row);
      }
      return group;
    }

    function uniqueMcpId() {
      let suffix = mcpDrafts.length + 1;
      let id = "local-mcp";
      const ids = new Set(mcpDrafts.map((server) => server.id));
      while (ids.has(id)) {
        id = `local-mcp-${suffix}`;
        suffix += 1;
      }
      return id;
    }

    function safeMcpId(value) {
      return String(value || "").trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || uniqueMcpId();
    }

    // Rehydrate drafts from the saved settings unless the user has unsaved edits in flight. Reads the
    // configured-servers slice (state.settings.mcpServers), distinct from the runtime status slice.
    function mcpSyncFromState(configuredServers) {
      if (mcpDraftDirty) {
        return;
      }
      mcpDrafts = cloneMcpServers(configuredServers || []);
      selectedMcpId = selectedMcpId && mcpDrafts.some((server) => server.id === selectedMcpId)
        ? selectedMcpId
        : mcpDrafts[0]?.id || "";
    }

    return {
      renderMcpEditor,
      renderMcpServerList,
      addMcpDraft,
      deleteSelectedMcpDraft,
      updateSelectedMcpDraftFromFields,
      serializedMcpDrafts,
      renderMcpProbe,
      renderMcpProbeStatus,
      mcpSelectedId: () => selectedMcpId,
      mcpMarkClean: () => { mcpDraftDirty = false; },
      mcpSyncFromState
    };
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.createMcpEditor = createMcpEditor;
}());
