// Stateless DOM, formatting, and string utilities for the CodeForge webview. Pure — parameters and browser
// globals only (no `elements`/`vscode`/`state` closure access), so they live in their own file loaded
// BEFORE main.js and are pulled into main.js via window.CodeForge.dom, leaving every call site unchanged.
// There is no build step for media/ — keep this valid browser JS.
(function () {
  function truncateStatus(value) {
    return value.length > 64 ? `${value.slice(0, 61)}...` : value;
  }

  function formatNumber(value) {
    return new Intl.NumberFormat().format(value);
  }

  function numberOrFallback(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function estimatedTokens(bytes) {
    return Math.max(0, Math.ceil((Number(bytes) || 0) / 4));
  }

  function tokensToBytes(tokens) {
    return Math.max(0, Math.round((Number(tokens) || 0) * 4));
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

  function summarizeToolResult(text) {
    const firstLine = (text || "").split(/\r?\n/).find((line) => line.trim()) || "Tool result";
    return firstLine.length > 96 ? `${firstLine.slice(0, 93)}...` : firstLine;
  }

  function on(element, type, listener) {
    if (element) {
      element.addEventListener(type, listener);
    }
  }

  function setValue(element, value) {
    if (element) {
      element.value = value;
    }
  }

  function setChecked(element, value) {
    if (element) {
      element.checked = Boolean(value);
    }
  }

  function setDisabled(element, value) {
    if (element) {
      element.disabled = Boolean(value);
    }
  }

  function splitLines(value) {
    return value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  }

  function splitArgs(value) {
    return String(value || "").match(/(?:"([^"]*)"|'([^']*)'|[^\s]+)/g)?.map((item) => item.replace(/^["']|["']$/g, "")) || [];
  }

  function cssEscape(value) {
    return typeof CSS !== "undefined" && CSS.escape ? CSS.escape(value) : String(value).replace(/["\\]/g, "\\$&");
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.dom = {
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
  };
}());
