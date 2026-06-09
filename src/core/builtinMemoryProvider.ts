// Built-in curated-notes memory — TS port of Hermes `tools/memory_tool.py` (MemoryStore +
// MEMORY_SCHEMA). Two bounded text stores the agent edits itself via the `memory` tool:
//   - "memory": the agent's own notes (environment facts, conventions, tool quirks)
//   - "user":   who the user is (preferences, communication style, expectations)
//
// Both are injected into the system prompt as a FROZEN snapshot captured at session start, so
// mid-session writes persist to disk immediately (durable) but do NOT change the system prompt
// — preserving the prefix cache for the whole session. The snapshot refreshes on the next
// session start. Char limits (model-independent) force the agent to consolidate.

import { ToolDefinition } from "./types";
import { MemoryInitContext, MemoryProvider, MemoryTarget } from "./memoryProvider";
import { firstThreatMessage, scanForThreats } from "./threatPatterns";

/** Persistence port for curated notes — keeps the provider unit-testable and storage-agnostic. */
export interface CuratedNoteStore {
  load(target: MemoryTarget): Promise<readonly string[]>;
  save(target: MemoryTarget, entries: readonly string[]): Promise<void>;
}

export interface BuiltinMemoryOptions {
  readonly memoryCharLimit?: number;
  readonly userCharLimit?: number;
}

const ENTRY_DELIMITER = "\n§\n";
const SEPARATOR = "═".repeat(46);

type MemoryToolResult = Record<string, unknown> & { readonly success: boolean };

function fmt(n: number): string {
  return n.toLocaleString("en-US");
}

export class BuiltinMemoryProvider implements MemoryProvider {
  readonly name = "builtin";

  private readonly store: CuratedNoteStore;
  private readonly memoryCharLimit: number;
  private readonly userCharLimit: number;

  private memoryEntries: string[] = [];
  private userEntries: string[] = [];
  private snapshot: Record<MemoryTarget, string> = { memory: "", user: "" };

  constructor(store: CuratedNoteStore, options: BuiltinMemoryOptions = {}) {
    this.store = store;
    this.memoryCharLimit = options.memoryCharLimit ?? 2200;
    this.userCharLimit = options.userCharLimit ?? 1375;
  }

  isAvailable(): boolean {
    return true;
  }

  async initialize(_ctx: MemoryInitContext): Promise<void> {
    this.memoryEntries = dedupe(await this.store.load("memory"));
    this.userEntries = dedupe(await this.store.load("user"));
    this.rebuildSnapshot();
  }

  getToolSchemas(): readonly ToolDefinition[] {
    return [MEMORY_SCHEMA];
  }

  systemPromptBlock(): string {
    return [this.snapshot.memory, this.snapshot.user].filter(Boolean).join("\n\n");
  }

  async prefetch(): Promise<string> {
    // Curated notes live in the (frozen) system prompt, not in per-turn recall.
    return "";
  }

  async handleToolCall(toolName: string, args: Record<string, unknown>): Promise<string> {
    if (toolName !== "memory") {
      return JSON.stringify({ success: false, error: `builtin memory does not handle tool '${toolName}'.` });
    }
    const action = String(args.action ?? "");
    const target = String(args.target ?? "memory");
    if (target !== "memory" && target !== "user") {
      return JSON.stringify({ success: false, error: `Invalid target '${target}'. Use 'memory' or 'user'.` });
    }
    const content = typeof args.content === "string" ? args.content : undefined;
    const oldText = typeof args.old_text === "string" ? args.old_text : undefined;

    let result: MemoryToolResult;
    if (action === "add") {
      if (!content) {
        return JSON.stringify({ success: false, error: "Content is required for 'add' action." });
      }
      result = await this.add(target, content);
    } else if (action === "replace") {
      if (!oldText) {
        return JSON.stringify({ success: false, error: "old_text is required for 'replace' action." });
      }
      if (!content) {
        return JSON.stringify({ success: false, error: "content is required for 'replace' action." });
      }
      result = await this.replace(target, oldText, content);
    } else if (action === "remove") {
      if (!oldText) {
        return JSON.stringify({ success: false, error: "old_text is required for 'remove' action." });
      }
      result = await this.remove(target, oldText);
    } else {
      return JSON.stringify({ success: false, error: `Unknown action '${action}'. Use: add, replace, remove` });
    }
    return JSON.stringify(result);
  }

  // -- Mutations (port of MemoryStore.add/replace/remove) -------------------

  private async add(target: MemoryTarget, rawContent: string): Promise<MemoryToolResult> {
    const content = rawContent.trim();
    if (!content) {
      return { success: false, error: "Content cannot be empty." };
    }
    const threat = firstThreatMessage(content, "strict");
    if (threat) {
      return { success: false, error: threat };
    }

    const entries = this.entriesFor(target);
    const limit = this.charLimit(target);

    if (entries.includes(content)) {
      return this.successResponse(target, "Entry already exists (no duplicate added).");
    }

    const newTotal = joinLength([...entries, content]);
    if (newTotal > limit) {
      const current = this.charCount(target);
      return {
        success: false,
        error:
          `Memory at ${fmt(current)}/${fmt(limit)} chars. Adding this entry (${content.length} chars) ` +
          "would exceed the limit. Consolidate now: use 'replace' to merge overlapping entries into " +
          "shorter ones or 'remove' stale or less important entries (see current_entries below), then " +
          "retry this add — all in this turn.",
        current_entries: [...entries],
        usage: `${fmt(current)}/${fmt(limit)}`
      };
    }

    entries.push(content);
    await this.persist(target);
    return this.successResponse(target, "Entry added.");
  }

  private async replace(target: MemoryTarget, rawOld: string, rawNew: string): Promise<MemoryToolResult> {
    const oldText = rawOld.trim();
    const newContent = rawNew.trim();
    if (!oldText) {
      return { success: false, error: "old_text cannot be empty." };
    }
    if (!newContent) {
      return { success: false, error: "new_content cannot be empty. Use 'remove' to delete entries." };
    }
    const threat = firstThreatMessage(newContent, "strict");
    if (threat) {
      return { success: false, error: threat };
    }

    const entries = this.entriesFor(target);
    const matches = matchIndexes(entries, oldText);
    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }
    if (matches.length > 1 && new Set(matches.map((i) => entries[i])).size > 1) {
      return { success: false, error: `Multiple entries matched '${oldText}'. Be more specific.`, matches: previews(entries, matches) };
    }

    const idx = matches[0];
    const limit = this.charLimit(target);
    const test = [...entries];
    test[idx] = newContent;
    const newTotal = joinLength(test);
    if (newTotal > limit) {
      const current = this.charCount(target);
      return {
        success: false,
        error:
          `Replacement would put memory at ${fmt(newTotal)}/${fmt(limit)} chars. Shorten the new content, ` +
          "or 'remove' other stale or less important entries to make room (see current_entries below), " +
          "then retry — all in this turn.",
        current_entries: [...entries],
        usage: `${fmt(current)}/${fmt(limit)}`
      };
    }

    entries[idx] = newContent;
    await this.persist(target);
    return this.successResponse(target, "Entry replaced.");
  }

  private async remove(target: MemoryTarget, rawOld: string): Promise<MemoryToolResult> {
    const oldText = rawOld.trim();
    if (!oldText) {
      return { success: false, error: "old_text cannot be empty." };
    }
    const entries = this.entriesFor(target);
    const matches = matchIndexes(entries, oldText);
    if (matches.length === 0) {
      return { success: false, error: `No entry matched '${oldText}'.` };
    }
    if (matches.length > 1 && new Set(matches.map((i) => entries[i])).size > 1) {
      return { success: false, error: `Multiple entries matched '${oldText}'. Be more specific.`, matches: previews(entries, matches) };
    }
    entries.splice(matches[0], 1);
    await this.persist(target);
    return this.successResponse(target, "Entry removed.");
  }

  // -- Internals ------------------------------------------------------------

  private entriesFor(target: MemoryTarget): string[] {
    return target === "user" ? this.userEntries : this.memoryEntries;
  }

  private charLimit(target: MemoryTarget): number {
    return target === "user" ? this.userCharLimit : this.memoryCharLimit;
  }

  private charCount(target: MemoryTarget): number {
    return joinLength(this.entriesFor(target));
  }

  private async persist(target: MemoryTarget): Promise<void> {
    await this.store.save(target, this.entriesFor(target));
  }

  private successResponse(target: MemoryTarget, message: string): MemoryToolResult {
    const entries = this.entriesFor(target);
    const current = this.charCount(target);
    const limit = this.charLimit(target);
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    return {
      success: true,
      target,
      entries: [...entries],
      usage: `${pct}% — ${fmt(current)}/${fmt(limit)} chars`,
      entry_count: entries.length,
      message
    };
  }

  private rebuildSnapshot(): void {
    this.snapshot = {
      memory: this.renderBlock("memory", sanitizeForSnapshot(this.memoryEntries, "MEMORY")),
      user: this.renderBlock("user", sanitizeForSnapshot(this.userEntries, "USER"))
    };
  }

  private renderBlock(target: MemoryTarget, entries: readonly string[]): string {
    if (entries.length === 0) {
      return "";
    }
    const limit = this.charLimit(target);
    const content = entries.join(ENTRY_DELIMITER);
    const current = content.length;
    const pct = limit > 0 ? Math.min(100, Math.floor((current / limit) * 100)) : 0;
    const header =
      target === "user"
        ? `USER PROFILE (who the user is) [${pct}% — ${fmt(current)}/${fmt(limit)} chars]`
        : `MEMORY (your personal notes) [${pct}% — ${fmt(current)}/${fmt(limit)} chars]`;
    return `${SEPARATOR}\n${header}\n${SEPARATOR}\n${content}`;
  }
}

function dedupe(entries: readonly string[]): string[] {
  return [...new Set(entries.map((e) => e.trim()).filter(Boolean))];
}

function joinLength(entries: readonly string[]): number {
  return entries.length === 0 ? 0 : entries.join(ENTRY_DELIMITER).length;
}

function matchIndexes(entries: readonly string[], needle: string): number[] {
  const out: number[] = [];
  entries.forEach((entry, i) => {
    if (entry.includes(needle)) {
      out.push(i);
    }
  });
  return out;
}

function previews(entries: readonly string[], indexes: readonly number[]): string[] {
  return indexes.map((i) => {
    const e = entries[i];
    return e.length > 80 ? `${e.slice(0, 80)}...` : e;
  });
}

// Sanitize entries for the FROZEN snapshot only. Live state keeps the raw text so the user can
// inspect + remove a poisoned entry; the snapshot gets a [BLOCKED: …] placeholder instead.
function sanitizeForSnapshot(entries: readonly string[], label: string): string[] {
  return entries.map((entry) => {
    if (!entry || entry.startsWith("[BLOCKED:")) {
      return entry;
    }
    const findings = scanForThreats(entry, "strict");
    if (findings.length === 0) {
      return entry;
    }
    return (
      `[BLOCKED: ${label} entry contained threat pattern(s): ${findings.join(", ")}. ` +
      "Removed from system prompt; use the memory tool to inspect and remove the original.]"
    );
  });
}

// =============================================================================
// OpenAI function-calling schema (ported from MEMORY_SCHEMA)
// =============================================================================

export const MEMORY_SCHEMA: ToolDefinition = {
  name: "memory",
  description:
    "Save durable information to persistent memory that survives across sessions. Memory is " +
    "injected into future turns, so keep it compact and focused on facts that will still matter " +
    "later.\n\n" +
    "WHEN TO SAVE (do this proactively, don't wait to be asked):\n" +
    "- User corrects you or says 'remember this' / 'don't do that again'\n" +
    "- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n" +
    "- You discover something about the environment (OS, installed tools, project structure)\n" +
    "- You learn a convention, API quirk, or workflow specific to this user's setup\n" +
    "- You identify a stable fact that will be useful again in future sessions\n\n" +
    "PRIORITY: User preferences and corrections > environment facts > procedural knowledge. The " +
    "most valuable memory prevents the user from having to repeat themselves.\n\n" +
    "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state.\n\n" +
    "TWO TARGETS:\n" +
    "- 'user': who the user is -- name, role, preferences, communication style, pet peeves\n" +
    "- 'memory': your notes -- environment facts, project conventions, tool quirks, lessons learned\n\n" +
    "ACTIONS: add (new entry), replace (update existing -- old_text identifies it), remove (delete " +
    "-- old_text identifies it).\n\n" +
    "SKIP: trivial/obvious info, things easily re-discovered, raw data dumps, and temporary task state.",
  parameters: {
    type: "object",
    properties: {
      action: {
        type: "string",
        enum: ["add", "replace", "remove"],
        description: "The action to perform."
      },
      target: {
        type: "string",
        enum: ["memory", "user"],
        description: "Which memory store: 'memory' for personal notes, 'user' for user profile."
      },
      content: {
        type: "string",
        description: "The entry content. Required for 'add' and 'replace'."
      },
      old_text: {
        type: "string",
        description: "Short unique substring identifying the entry to replace or remove."
      }
    },
    required: ["action", "target"]
  }
};
