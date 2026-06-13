// Approval-card rendering for the CodeForge webview: the approve/reject card, the structured
// ask-user-question form, and the per-action detail summary. Unlike dom.js these touch host state
// (the VS Code message bridge and the approvals container node), so this file exposes a factory that
// main.js calls once with its live references; the returned addApproval/removeApproval keep their call
// sites unchanged. cssEscape is injected from dom.js. Loaded before main.js; no build step for media/.
(function () {
  function createApprovals(deps) {
    const { vscode, container, cssEscape } = deps;

    function approvalDetail(action) {
      if (!action) {
        return "";
      }
      if (action.type === "run_command") {
        return action.command;
      }
      if (action.type === "mcp_call_tool") {
        return `${action.serverId}/${action.toolName}\n\n${JSON.stringify(action.arguments || {}, null, 2)}`;
      }
      if (action.type === "ask_user_question") {
        return (action.questions || []).map((question) => {
          const options = (question.options || []).map((option) => `- ${option.label}: ${option.description}`).join("\n");
          return `${question.question}\n${options}`;
        }).join("\n\n");
      }
      if (action.type === "task_create") {
        return `${action.subject || ""}\n\n${action.description || ""}`;
      }
      if (action.type === "task_update") {
        return `${action.taskId || ""}${action.status ? ` -> ${action.status}` : ""}`;
      }
      if (action.type === "task_get") {
        return action.taskId || "";
      }
      if (action.type === "task_list") {
        return action.status || "all tasks";
      }
      if (action.type === "code_hover" || action.type === "code_definition" || action.type === "code_references") {
        return `${action.path}:${action.line}:${action.character}`;
      }
      if (action.type === "code_symbols") {
        return action.path || action.query || "";
      }
      if (action.type === "mcp_list_resources") {
        return action.serverId || "all configured MCP servers";
      }
      if (action.type === "mcp_read_resource") {
        return `${action.serverId}:${action.uri}`;
      }
      if (action.type === "notebook_read") {
        return action.path;
      }
      if (action.type === "notebook_edit_cell") {
        return `${action.path} cell ${action.index}\n\n${action.content || ""}`;
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

    function renderQuestionApproval(approval, reasonElement) {
      const form = document.createElement("form");
      form.className = "question-approval";
      const questions = Array.isArray(approval.action?.questions) ? approval.action.questions : [];
      const error = document.createElement("div");
      error.className = "approval-reason";
      error.textContent = reasonElement.textContent;
      form.append(error);

      questions.forEach((question, questionIndex) => {
        const field = document.createElement("fieldset");
        field.className = "question-field";
        const legend = document.createElement("legend");
        legend.textContent = question.question || `Question ${questionIndex + 1}`;
        field.append(legend);

        const options = Array.isArray(question.options) ? question.options : [];
        options.forEach((option, optionIndex) => {
          const id = `${approval.id}-${questionIndex}-${optionIndex}`;
          const label = document.createElement("label");
          label.className = "question-option";
          const input = document.createElement("input");
          input.type = question.multiSelect ? "checkbox" : "radio";
          input.name = `${approval.id}-${questionIndex}`;
          input.value = option.label || "";
          input.id = id;
          const text = document.createElement("span");
          text.textContent = `${option.label || "Option"}${option.description ? ` - ${option.description}` : ""}`;
          label.append(input, text);
          field.append(label);
          if (option.preview) {
            const preview = document.createElement("pre");
            preview.className = "question-preview";
            preview.textContent = option.preview;
            field.append(preview);
          }
        });

        const other = document.createElement("input");
        other.className = "question-other";
        other.type = "text";
        other.placeholder = "Other";
        other.dataset.questionIndex = String(questionIndex);
        field.append(other);
        form.append(field);
      });

      const actions = document.createElement("div");
      actions.className = "approval-actions";
      const submit = document.createElement("button");
      submit.type = "submit";
      submit.textContent = "Submit";
      const reject = document.createElement("button");
      reject.type = "button";
      reject.className = "secondary";
      reject.textContent = "Skip";
      reject.addEventListener("click", () => vscode.postMessage({ type: "reject", id: approval.id }));
      actions.append(submit, reject);
      form.append(actions);

      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const answers = {};
        let missing = false;
        questions.forEach((question, questionIndex) => {
          const selected = Array.from(form.querySelectorAll(`input[name="${cssEscape(`${approval.id}-${questionIndex}`)}"]:checked`)).map((input) => input.value).filter(Boolean);
          const other = form.querySelector(`.question-other[data-question-index="${questionIndex}"]`)?.value?.trim();
          const answer = other || selected.join(", ");
          if (!answer) {
            missing = true;
          }
          answers[question.question] = answer;
        });
        if (missing) {
          error.textContent = "Select or type an answer for each question.";
          return;
        }
        vscode.postMessage({ type: "answerQuestion", id: approval.id, answers });
      });

      return form;
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
      if (approval.action?.type === "ask_user_question") {
        const questionForm = renderQuestionApproval(approval, reason);
        item.append(title, summary, risk, questionForm, actions);
        container?.append(item);
        return;
      }
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
      container?.append(item);
    }

    function removeApproval(id) {
      const item = container?.querySelector(`[data-id="${cssEscape(id)}"]`);
      item?.remove();
    }

    return { addApproval, removeApproval };
  }

  window.CodeForge = window.CodeForge || {};
  window.CodeForge.createApprovals = createApprovals;
}());
