// Background-worker panel rendering for the CodeForge webview: builds the workers list (one row per
// background sub-agent, with open/attach/stop actions) into the workers panel. View-coupled (the vscode
// bridge, the panel node, and formatNumber from dom.js), so it exposes a factory createWorkerList(deps)
// the view calls once with its live refs; renderWorkerRow stays private. Loaded before main.js; no build
// step for media/ — keep this valid browser JS.
(function () {
  function createWorkerList(deps) {
    const { vscode, elements, formatNumber } = deps;

    function renderWorkers(workers) {
      if (!elements.workersPanel) {
        return;
      }
      const activeWorkers = Array.isArray(workers) ? workers : [];
      elements.workersPanel.replaceChildren();
      elements.workersPanel.classList.toggle("hidden", activeWorkers.length === 0);
      if (activeWorkers.length === 0) {
        return;
      }

      const header = document.createElement("div");
      header.className = "workers-header";
      const title = document.createElement("strong");
      title.textContent = "Workers";
      const count = document.createElement("span");
      count.textContent = `${activeWorkers.filter((worker) => worker.status === "running").length} running`;
      header.append(title, count);
      elements.workersPanel.append(header);

      for (const worker of activeWorkers.slice(0, 5)) {
        elements.workersPanel.append(renderWorkerRow(worker));
      }
    }

    function renderWorkerRow(worker) {
      const row = document.createElement("div");
      row.className = "worker-row";
      row.dataset.status = worker.status || "running";

      const meta = document.createElement("div");
      meta.className = "worker-meta";
      const title = document.createElement("div");
      title.className = "worker-title";
      title.textContent = `${worker.label || worker.kind || "Worker"} · ${worker.status || "running"}`;
      const detail = document.createElement("div");
      detail.className = "worker-detail";
      const parts = [];
      if (worker.model) {
        parts.push(worker.model);
      }
      if (worker.toolUseCount) {
        parts.push(`${worker.toolUseCount} tools`);
      }
      if (worker.tokenCount) {
        parts.push(`${formatNumber(worker.tokenCount)} tokens`);
      }
      if (worker.filesInspected?.length) {
        parts.push(`${worker.filesInspected.length} files`);
      }
      detail.textContent = parts.length > 0 ? parts.join(" · ") : worker.prompt || worker.id;
      const summary = document.createElement("div");
      summary.className = "worker-summary";
      summary.textContent = worker.error || worker.summary || worker.prompt || "";
      meta.append(title, detail, summary);

      const actions = document.createElement("div");
      actions.className = "worker-actions";
      const output = document.createElement("button");
      output.type = "button";
      output.className = "secondary";
      output.textContent = "Open";
      output.addEventListener("click", () => vscode.postMessage({ type: "workerOutput", workerId: worker.id }));
      actions.append(output);
      const attach = document.createElement("button");
      attach.type = "button";
      attach.className = "secondary";
      attach.textContent = "Attach";
      attach.addEventListener("click", () => vscode.postMessage({ type: "workerAttach", workerId: worker.id }));
      actions.append(attach);
      if (worker.status === "running") {
        const stop = document.createElement("button");
        stop.type = "button";
        stop.className = "secondary";
        stop.textContent = "Stop";
        stop.addEventListener("click", () => vscode.postMessage({ type: "workerStop", workerId: worker.id }));
        actions.append(stop);
      }

      row.append(meta, actions);
      return row;
    }

    return { renderWorkers };
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.createWorkerList = createWorkerList;
}());
