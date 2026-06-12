import { parseActionsFromAssistantText } from "../core/actionProtocol";

export interface ReviewToolOutcome {
  readonly output: string;
  readonly summary: string;
  readonly notice: string;
}

export function reviewWriteSucceeded(output: string): boolean {
  try {
    return Boolean((JSON.parse(output) as { success?: boolean }).success);
  } catch {
    return false;
  }
}

export function describeMemoryWrite(args: Record<string, unknown>): string {
  const action = String(args.action ?? "update");
  const target = args.target === "user" ? "user profile" : "memory";
  const verb = action === "add" ? "saved to" : action === "remove" ? "removed from" : "updated";
  return `${verb} ${target}`;
}

// Hermes-style, user-facing notification shown live in the chat each time the autonomous
// self-improvement review writes to memory, the user profile (user.md), or a skill — so the user can
// see the system is actively learning. Returns "" for read-only review tools.
export function learningNotice(name: string, args: Record<string, unknown>): string {
  if (name === "memory") {
    const action = String(args.action ?? "update");
    const isUser = args.target === "user";
    const snippet = noticeSnippet(args.content);
    if (action === "remove") {
      return isUser ? "👤 Updated your user profile — removed an outdated note" : "🧠 Pruned a memory it no longer needs";
    }
    const verb = action === "add" ? "Learned" : "Refined";
    if (isUser) {
      return `👤 ${verb} something about you${snippet ? `: “${snippet}”` : ""}`;
    }
    return `🧠 ${verb} a lesson from this session${snippet ? `: “${snippet}”` : ""}`;
  }
  if (name === "skill_manage") {
    const action = String(args.action ?? "update");
    const skill = String(args.name ?? "").trim();
    const named = skill ? ` “${skill}”` : "";
    if (action === "create") {
      return `🛠️ Created a new skill${named}`;
    }
    if (action === "delete" || action === "remove_file") {
      return `🗑️ Retired the skill${named}`;
    }
    return `🛠️ Improved the skill${named}`;
  }
  return "";
}

function noticeSnippet(value: unknown): string {
  if (typeof value !== "string") {
    return "";
  }
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > 80 ? `${text.slice(0, 77)}…` : text;
}

export function summarizeReviewActions(actions: readonly string[]): string {
  return [...new Set(actions.filter(Boolean))].join(" · ");
}

// Recover memory/skill tool calls from a non-native model's text (the CodeForge JSON action protocol).
export function reviewActionsFromText(content: string): { readonly name: string; readonly args: Record<string, unknown> }[] {
  const out: { name: string; args: Record<string, unknown> }[] = [];
  for (const action of parseActionsFromAssistantText(content)) {
    if (action.type === "memory") {
      out.push({ name: "memory", args: { action: action.action, target: action.target, content: action.content, old_text: action.oldText } });
    } else if (action.type === "skill_manage") {
      out.push({
        name: "skill_manage",
        args: {
          action: action.action,
          name: action.name,
          content: action.content,
          old_string: action.oldString,
          new_string: action.newString,
          replace_all: action.replaceAll,
          file_path: action.filePath,
          file_content: action.fileContent,
          absorbed_into: action.absorbedInto
        }
      });
    } else if (action.type === "skill_view") {
      out.push({ name: "skill_view", args: { name: action.name, file_path: action.filePath } });
    } else if (action.type === "skills_list") {
      out.push({ name: "skills_list", args: {} });
    }
  }
  return out;
}
