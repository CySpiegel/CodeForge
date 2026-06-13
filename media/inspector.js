// Run-inspector rendering for the CodeForge webview: builds the read-only event + permission-audit list
// into a container from an inspector snapshot. Pure — parameters and DOM/Date globals only (no app state),
// so it lives in its own file loaded before main.js and exposes renderInspectorInto on window.CodeForge;
// the view's thin renderInspector wrapper passes its two container nodes. No build step for media/.
(function () {
  function renderInspectorInto(container, inspector, compact) {
    if (!container) {
      return;
    }
    const entries = Array.isArray(inspector?.entries) ? inspector.entries : [];
    const audit = Array.isArray(inspector?.audit) ? inspector.audit : [];
    container.replaceChildren();
    if (entries.length === 0 && audit.length === 0) {
      const empty = document.createElement("div");
      empty.className = "inspector-empty";
      empty.textContent = "No run events recorded yet.";
      container.append(empty);
      return;
    }
    const header = document.createElement("div");
    header.className = "inspector-header";
    const title = document.createElement("strong");
    title.textContent = "Run inspector";
    const count = document.createElement("span");
    count.textContent = `${entries.length} events - ${audit.length} audit`;
    header.append(title, count);
    container.append(header);

    for (const entry of entries.slice(0, compact ? 8 : 40)) {
      container.append(renderInspectorEntry(entry));
    }

    if (!compact && audit.length > 0) {
      const auditTitle = document.createElement("div");
      auditTitle.className = "inspector-section-title";
      auditTitle.textContent = "Permission audit";
      container.append(auditTitle);
      for (const item of audit.slice(0, 80)) {
        container.append(renderAuditEntry(item));
      }
    }
  }

  function renderInspectorEntry(entry) {
    const row = document.createElement("div");
    row.className = "inspector-row";
    row.dataset.level = entry.level || "info";
    const title = document.createElement("div");
    title.className = "inspector-title";
    title.textContent = `${new Date(entry.createdAt || Date.now()).toLocaleTimeString()} ${entry.category || "event"} - ${entry.summary || ""}`;
    row.append(title);
    if (entry.detail) {
      const detail = document.createElement("pre");
      detail.textContent = String(entry.detail).split(/\r?\n/).slice(0, 6).join("\n");
      row.append(detail);
    }
    return row;
  }

  function renderAuditEntry(entry) {
    const row = document.createElement("div");
    row.className = "audit-row";
    row.textContent = `${new Date(entry.createdAt || Date.now()).toLocaleTimeString()} ${entry.action || "action"} ${entry.outcome || ""} (${entry.behavior || ""}/${entry.source || ""}) - ${entry.reason || ""}`;
    return row;
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.renderInspectorInto = renderInspectorInto;
}());
