import type { CodeForgeTool } from "../toolRegistry";
import { invalidToolType, optionalPositiveInteger, optionalString, parseQuestions, validateLimit } from "../toolValidation";

export const interactionTools: readonly CodeForgeTool[] = [
  {
    name: "ask_user_question",
    description: "Pause the local model loop and ask the user one or more structured multiple-choice questions inside the VS Code extension.",
    searchHint: "ask user choice",
    risk: "question",
    concurrencySafe: true,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        questions: {
          type: "array",
          minItems: 1,
          maxItems: 4,
          items: {
            type: "object",
            properties: {
              question: { type: "string" },
              header: { type: "string" },
              multiSelect: { type: "boolean" },
              options: {
                type: "array",
                minItems: 2,
                maxItems: 4,
                items: {
                  type: "object",
                  properties: {
                    label: { type: "string" },
                    description: { type: "string" },
                    preview: { type: "string" }
                  },
                  required: ["label", "description"],
                  additionalProperties: false
                }
              }
            },
            required: ["question", "header", "options"],
            additionalProperties: false
          }
        },
        reason: { type: "string" }
      },
      required: ["questions"],
      additionalProperties: false
    },
    parse(input) {
      const questions = parseQuestions(input.questions);
      return questions.length > 0
        ? { type: "ask_user_question", questions, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "ask_user_question") {
        return invalidToolType(action, "ask_user_question");
      }
      if (action.questions.length < 1 || action.questions.length > 4) {
        return { ok: false, message: "ask_user_question requires 1-4 questions." };
      }
      const seenQuestions = new Set<string>();
      for (const question of action.questions) {
        if (!question.question.trim() || !question.question.trim().endsWith("?")) {
          return { ok: false, message: "Each question must be non-empty and end with a question mark." };
        }
        if (!question.header.trim() || question.header.length > 18) {
          return { ok: false, message: "Each question header must be 1-18 characters." };
        }
        const normalizedQuestion = question.question.trim().toLowerCase();
        if (seenQuestions.has(normalizedQuestion)) {
          return { ok: false, message: "Question texts must be unique." };
        }
        seenQuestions.add(normalizedQuestion);
        if (question.options.length < 2 || question.options.length > 4) {
          return { ok: false, message: "Each question must have 2-4 options." };
        }
        const labels = new Set<string>();
        for (const option of question.options) {
          if (!option.label.trim() || !option.description.trim()) {
            return { ok: false, message: "Question option labels and descriptions must not be empty." };
          }
          if (option.label.length > 40) {
            return { ok: false, message: "Question option labels must be 40 characters or fewer." };
          }
          const normalizedLabel = option.label.trim().toLowerCase();
          if (labels.has(normalizedLabel)) {
            return { ok: false, message: "Option labels must be unique within a question." };
          }
          labels.add(normalizedLabel);
        }
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "ask_user_question" ? `Ask ${action.questions.length} user question(s)` : "Ask user question";
    }
  },
  {
    name: "tool_search",
    description: "Search CodeForge's deferred tool catalog and load matching tool schemas for the next model turn.",
    searchHint: "load deferred tool schema",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Tool capability query, or select:tool_name to load an exact tool schema." },
        limit: { type: "number" },
        reason: { type: "string" }
      },
      required: ["query"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.query === "string"
        ? {
          type: "tool_search",
          query: input.query,
          limit: optionalPositiveInteger(input.limit),
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "tool_search") {
        return invalidToolType(action, "tool_search");
      }
      const query = action.query.trim();
      if (!query) {
        return { ok: false, message: "tool_search query must not be empty." };
      }
      if (query.length > 200) {
        return { ok: false, message: "tool_search query must be 200 characters or fewer." };
      }
      return validateLimit(action.limit);
    },
    summarize(action) {
      return action.type === "tool_search" ? `Search tools for ${action.query}` : "Search tools";
    }
  },
  {
    name: "tool_list",
    description: "List CodeForge model-facing tools, risks, approval requirements, and concurrency metadata.",
    searchHint: "list available tools",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return { type: "tool_list", reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "tool_list" ? { ok: true } : invalidToolType(action, "tool_list");
    },
    summarize() {
      return "List available tools";
    }
  },
];
