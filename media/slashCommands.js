// Slash-command + model autocomplete menu for the CodeForge composer: builds the "/command" and
// "/models <query>" dropdown, handles keyboard navigation and selection, and throttles command/model
// refresh requests. Owns its menu state (items + selection index + refresh timestamps). Model selection
// itself mutates app state, so that stays in main.js and is invoked here via onSelectModel. DOM/format
// helpers come from dom.js. Loaded before main.js; no build step for media/ — keep this valid browser JS.
(function () {
  const { formatNumber } = window.CodeForge.dom;

  function createSlashCommands(deps) {
    const { elements, vscode, getState, builtInSlashCommands, resizePromptInput, onSelectModel } = deps;

    let slashCommandItems = [];
    let slashCommandIndex = 0;
    let lastCommandRefreshAt = 0;
    let lastModelRefreshAt = 0;

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
      const state = getState();
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
      const state = getState();
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
      const state = getState();
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

    function chooseSlashCommand(index = slashCommandIndex) {
      const command = slashCommandItems[index];
      const context = slashCommandContext();
      if (!command || !context || !elements.input) {
        hideSlashCommandMenu();
        return;
      }
      if (command.kind === "model") {
        onSelectModel(command.value || command.name);
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

    return {
      renderSlashCommandMenu,
      moveSlashCommandSelection,
      chooseSlashCommand,
      hideSlashCommandMenu,
      isSlashCommandMenuOpen,
      modelEntries,
      formatModelDetails,
      requestModelRefreshIfNeeded
    };
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.createSlashCommands = createSlashCommands;
}());
