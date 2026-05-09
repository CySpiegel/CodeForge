(function () {
  const vscode = acquireVsCodeApi();
  const messages = document.getElementById("messages");
  const approvals = document.getElementById("approvals");
  const form = document.getElementById("promptForm");
  const input = document.getElementById("promptInput");
  const reset = document.getElementById("reset");
  const configure = document.getElementById("configure");
  let streamingMessage;

  form.addEventListener("submit", (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!text) {
      return;
    }
    input.value = "";
    vscode.postMessage({ type: "sendPrompt", text });
  });

  reset.addEventListener("click", () => {
    vscode.postMessage({ type: "reset" });
  });

  configure.addEventListener("click", () => {
    vscode.postMessage({ type: "configureEndpoint" });
  });

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (!message || typeof message.type !== "string") {
      return;
    }

    if (message.type === "sessionReset") {
      messages.replaceChildren();
      approvals.replaceChildren();
      streamingMessage = undefined;
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
      messages.scrollTop = messages.scrollHeight;
    } else if (message.type === "status") {
      addMessage("system", message.text);
    } else if (message.type === "toolResult") {
      addMessage("system", message.text);
    } else if (message.type === "approvalRequested") {
      addApproval(message.approval);
    } else if (message.type === "approvalResolved") {
      removeApproval(message.id);
      addMessage("system", message.text);
    } else if (message.type === "error") {
      addMessage("system", `Error: ${message.text}`);
    }
  });

  function addMessage(role, text) {
    const item = document.createElement("article");
    item.className = `message ${role}`;
    const label = document.createElement("div");
    label.className = "role";
    label.textContent = role;
    const content = document.createElement("pre");
    content.textContent = text || "";
    item.append(label, content);
    messages.append(item);
    messages.scrollTop = messages.scrollHeight;
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
    approvals.append(item);
  }

  function removeApproval(id) {
    const item = approvals.querySelector(`[data-id="${CSS.escape(id)}"]`);
    item?.remove();
  }
}());
