import type { CodeForgeTool } from "../toolRegistry";
import { FactStoreAction, SkillManageAction } from "../types";
import { FACT_FEEDBACK_SCHEMA, FACT_STORE_SCHEMA } from "../holographic/factTools";
import { invalidToolType, numericOrUndefined, optionalString } from "../toolValidation";

export const memoryTools: readonly CodeForgeTool[] = [
  {
    name: "memory",
    description:
      "Save durable information to persistent curated memory that survives across sessions. Two " +
      "targets: 'user' (who the user is — preferences, communication style) and 'memory' (your own " +
      "notes — environment facts, project conventions, tool quirks). Actions: add, replace (old_text " +
      "identifies the entry), remove (old_text identifies the entry). Save proactively when the user " +
      "corrects you, shares a preference, or you learn a stable fact; keep entries compact.",
    searchHint: "save persistent curated memory user profile preferences",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add", "replace", "remove"] },
        target: { type: "string", enum: ["memory", "user"] },
        content: { type: "string" },
        old_text: { type: "string" },
        reason: { type: "string" }
      },
      required: ["action", "target"],
      additionalProperties: false
    },
    parse(input) {
      const action = input.action;
      const target = input.target;
      if ((action === "add" || action === "replace" || action === "remove") && (target === "memory" || target === "user")) {
        return {
          type: "memory",
          action,
          target,
          content: optionalString(input.content),
          oldText: optionalString(input.old_text),
          reason: optionalString(input.reason)
        };
      }
      return undefined;
    },
    validate(action) {
      if (action.type !== "memory") {
        return invalidToolType(action, "memory");
      }
      if ((action.action === "add" || action.action === "replace") && !action.content?.trim()) {
        return { ok: false, message: "content is required for add/replace." };
      }
      if ((action.action === "replace" || action.action === "remove") && !action.oldText?.trim()) {
        return { ok: false, message: "old_text is required for replace/remove." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "memory" ? `${action.action} ${action.target} memory` : "Update memory";
    }
  },
  {
    name: "skill_manage",
    description:
      "Author and refine local skills (.codeforge/skills) — your procedural memory for recurring " +
      "task types. Actions: create (full SKILL.md with YAML frontmatter, name+description required), " +
      "patch (old_string/new_string — preferred for small fixes), edit (full SKILL.md rewrite), " +
      "write_file/remove_file (support files under references/, templates/, scripts/, assets/), and " +
      "delete (archives the skill — recoverable; pinned skills refuse delete). On delete pass " +
      "absorbed_into=<umbrella> when merging into another skill, or \"\" when pruning.",
    searchHint: "create edit patch delete skill procedural memory",
    risk: "edit",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["create", "patch", "edit", "delete", "write_file", "remove_file"] },
        name: { type: "string", description: "Skill name (lowercase, hyphens/underscores, <=64 chars)." },
        content: { type: "string", description: "Full SKILL.md (frontmatter + body). Required for create/edit." },
        old_string: { type: "string", description: "Text to find (patch). Unique unless replace_all." },
        new_string: { type: "string", description: "Replacement text (patch). Empty string deletes the match." },
        replace_all: { type: "boolean", description: "Replace all occurrences instead of requiring a unique match." },
        file_path: { type: "string", description: "Support file under references/, templates/, scripts/, or assets/." },
        file_content: { type: "string", description: "Content for the support file (write_file)." },
        absorbed_into: { type: "string", description: "On delete: umbrella skill name if merged, or \"\" if pruned." },
        reason: { type: "string" }
      },
      required: ["action", "name"],
      additionalProperties: false
    },
    parse(input) {
      const action = input.action;
      if (typeof input.name !== "string" || !["create", "patch", "edit", "delete", "write_file", "remove_file"].includes(String(action))) {
        return undefined;
      }
      return {
        type: "skill_manage",
        action: action as SkillManageAction["action"],
        name: input.name,
        content: optionalString(input.content),
        oldString: optionalString(input.old_string),
        newString: typeof input.new_string === "string" ? input.new_string : undefined,
        replaceAll: input.replace_all === true ? true : undefined,
        filePath: optionalString(input.file_path),
        fileContent: typeof input.file_content === "string" ? input.file_content : undefined,
        absorbedInto: typeof input.absorbed_into === "string" ? input.absorbed_into : undefined,
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "skill_manage") {
        return invalidToolType(action, "skill_manage");
      }
      if (!action.name.trim()) {
        return { ok: false, message: "Skill name is required." };
      }
      if ((action.action === "create" || action.action === "edit") && !action.content?.trim()) {
        return { ok: false, message: "content is required for create/edit." };
      }
      if (action.action === "patch" && !action.oldString?.trim()) {
        return { ok: false, message: "old_string is required for patch." };
      }
      if ((action.action === "write_file" || action.action === "remove_file") && !action.filePath?.trim()) {
        return { ok: false, message: "file_path is required for write_file/remove_file." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "skill_manage" ? `${action.action} skill ${action.name}` : "Manage skill";
    }
  },
  {
    name: "skill_view",
    description: "Read a local skill's SKILL.md (or a support file under references/, templates/, scripts/, assets/) before patching it.",
    searchHint: "view read skill contents",
    risk: "read",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        name: { type: "string", description: "Skill name." },
        file_path: { type: "string", description: "Optional support file path under the skill directory." },
        reason: { type: "string" }
      },
      required: ["name"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.name === "string"
        ? { type: "skill_view", name: input.name, filePath: optionalString(input.file_path), reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "skill_view") {
        return invalidToolType(action, "skill_view");
      }
      return action.name.trim() ? { ok: true } : { ok: false, message: "Skill name is required." };
    },
    summarize(action) {
      return action.type === "skill_view" ? `View skill ${action.name}` : "View skill";
    }
  },
  {
    name: "skills_list",
    description: "List local skills (.codeforge/skills) with their descriptions, to find an existing skill to extend before creating a new one.",
    searchHint: "list available skills",
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
      return { type: "skills_list", reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "skills_list" ? { ok: true } : invalidToolType(action, "skills_list");
    },
    summarize() {
      return "List skills";
    }
  },
  {
    name: "fact_store",
    description: FACT_STORE_SCHEMA.description,
    searchHint: "durable fact memory save search probe reason contradict",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: FACT_STORE_SCHEMA.parameters,
    parse(input) {
      const action = input.action;
      if (!["save", "search", "probe", "related", "reason", "contradict", "delete", "list"].includes(String(action))) {
        return undefined;
      }
      return {
        type: "fact_store",
        action: action as FactStoreAction["action"],
        content: optionalString(input.content),
        category: optionalString(input.category),
        tags: Array.isArray(input.tags) ? input.tags.filter((t): t is string => typeof t === "string") : undefined,
        query: optionalString(input.query),
        entity: optionalString(input.entity),
        entities: Array.isArray(input.entities) ? input.entities.filter((t): t is string => typeof t === "string") : undefined,
        id: numericOrUndefined(input.id),
        limit: typeof input.limit === "number" ? input.limit : undefined,
        reason: optionalString(input.reason)
      };
    },
    validate(action) {
      if (action.type !== "fact_store") {
        return invalidToolType(action, "fact_store");
      }
      if (action.action === "save" && !action.content?.trim()) {
        return { ok: false, message: "content is required to save a fact." };
      }
      if ((action.action === "probe" || action.action === "related") && !action.entity?.trim()) {
        return { ok: false, message: "entity is required for probe/related." };
      }
      if (action.action === "reason" && (!action.entities || action.entities.length === 0)) {
        return { ok: false, message: "entities is required for reason." };
      }
      if (action.action === "delete" && action.id === undefined) {
        return { ok: false, message: "id is required for delete." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "fact_store" ? `fact_store ${action.action}` : "fact store";
    }
  },
  {
    name: "fact_feedback",
    description: FACT_FEEDBACK_SCHEMA.description,
    searchHint: "rate durable fact trust feedback helpful",
    risk: "memory",
    concurrencySafe: false,
    requiresApproval: false,
    parameters: FACT_FEEDBACK_SCHEMA.parameters,
    parse(input) {
      const id = numericOrUndefined(input.id);
      if (id === undefined || typeof input.helpful !== "boolean") {
        return undefined;
      }
      return { type: "fact_feedback", id, helpful: input.helpful, reason: optionalString(input.reason) };
    },
    validate(action) {
      return action.type === "fact_feedback" ? { ok: true } : invalidToolType(action, "fact_feedback");
    },
    summarize(action) {
      return action.type === "fact_feedback" ? `fact_feedback ${action.helpful ? "helpful" : "unhelpful"}` : "fact feedback";
    }
  },
];
