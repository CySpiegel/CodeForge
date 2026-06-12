import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { contextItemKindLabel } from "../core/contextBuilder";
import { ContextUsage, formatBytes } from "../core/contextUsage";
import {
  formatLocalAgentList,
  formatLocalCommandList,
  formatLocalSkillList,
  loadLocalAgents,
  loadLocalCommands,
  loadLocalSkills,
  renderLocalCommand,
  renderLocalSkillPrompt
} from "../core/localExtensions";
import type { MemoryStore } from "../core/memory";
import type { SessionRecord } from "../core/session";
import { toolSummary } from "../core/toolRegistry";
import { AgentMode, ChatMessage, ContextItem, PermissionMode, WorkspacePort } from "../core/types";
import { workerCommandList } from "../core/workerAgents";
import type { WorkerSummary } from "../core/workerTypes";
import { buildWorkspaceIndex } from "../core/workspaceIndex";
import type {
  AgentAuditEntry,
  AgentCapabilitySummary,
  AgentInspectorEntry,
  AgentUiEvent
} from "./agentUiTypes";
import type { ModelResolver } from "./modelResolver";
import type { SessionService } from "./sessionService";
import { errorMessage, firstLines } from "./toolText";
import type { WorkerManager } from "./workerManager";

// The slash-command surface the router drives on the controller. Intentionally wide — this is the one
// top-level dispatcher, so it reaches into every controller capability. Collaborators (config,
// sessions, models, workers, memoryStore) are passed as object refs; one-shot controller operations and
// state reads are passed as bound closures so the router never touches controller internals directly.
export interface SlashCommandHost {
  readonly config: CodeForgeConfigService;
  readonly workspace: WorkspacePort;
  readonly sessions: SessionService;
  readonly models: ModelResolver;
  readonly workers: WorkerManager;
  readonly memoryStore: MemoryStore | undefined;
  emit(event: AgentUiEvent): void;
  // Lifecycle / run control
  reset(): void;
  cancel(): void;
  resumeSession(sessionId: string | undefined): Promise<void>;
  compactContext(focus: string): Promise<void>;
  undo(): Promise<void>;
  runDoctor(): Promise<void>;
  runPrompt(visiblePrompt: string, modelPrompt: string): Promise<void>;
  setAgentMode(mode: AgentMode): Promise<void>;
  setPermissionMode(mode: PermissionMode): Promise<void>;
  // Context / pins
  pinFile(path: string): Promise<void>;
  pinActiveFile(): Promise<void>;
  unpinFile(path?: string): Promise<void>;
  currentContextUsage(): ContextUsage;
  emitContextUsage(): void;
  // Models
  selectModel(model: string): Promise<void>;
  refreshModels(): Promise<void>;
  // Sub-system command handlers
  handleCuratorCommand(rest: string): Promise<void>;
  handleMcpCommand(rest: string): Promise<void>;
  // Workers
  showWorkerOutput(workerId: string): void;
  attachWorkerOutput(workerId: string): void;
  stopWorker(workerId: string): void;
  // Transcript / state
  replaceMessages(messages: readonly ChatMessage[], reason: "compact" | "restore", preserveContextItems?: boolean): void;
  publishTranscript(): Promise<void>;
  publishState(): Promise<void>;
  clearApprovals(): void;
  emitInspector(): void;
  capabilitySummaries(profileId: string): Promise<readonly AgentCapabilitySummary[]>;
  // State reads
  getMessages(): readonly ChatMessage[];
  getLastContextItems(): readonly ContextItem[];
  getPinnedFiles(): readonly string[];
  getInspectorEntries(): readonly AgentInspectorEntry[];
  getAuditEntries(): readonly AgentAuditEntry[];
  currentSignal(): AbortSignal | undefined;
}

// Owns the entire `/command` surface: parsing, dispatch, and the read-only report/list builders behind
// each command. The controller delegates `handle()` from sendPrompt and keeps only the run engine and
// the session-application internals the router calls back into via SlashCommandHost.
export class SlashCommandRouter {
  constructor(private readonly host: SlashCommandHost) {}

  async handle(rawPrompt: string): Promise<void> {
    const [commandWithSlash, ...args] = rawPrompt.trim().split(/\s+/);
    const command = commandWithSlash.toLowerCase();
    const rest = args.join(" ");
    const permissionMode = permissionModeFromSlashCommand(command);
    if (permissionMode) {
      await this.setPermissionModeFromSlash(permissionMode);
      return;
    }

    switch (command) {
      case "/clear":
      case "/reset":
      case "/new":
        this.host.reset();
        return;
      case "/stop":
      case "/cancel":
        this.host.cancel();
        return;
      case "/history":
      case "/sessions":
      case "/chats":
        await this.showSessionHistory();
        return;
      case "/resume":
        await this.host.resumeSession(rest || undefined);
        return;
      case "/fork":
        await this.forkSession(rest || undefined);
        return;
      case "/diff":
        await this.showSessionDiff(rest || undefined);
        return;
      case "/export":
        await this.exportSession(rest || undefined);
        return;
      case "/compact":
        await this.host.compactContext(rest);
        return;
      case "/undo":
        await this.host.undo();
        return;
      case "/curator":
        await this.host.handleCuratorCommand(rest);
        return;
      case "/context": {
        this.host.emit({ type: "message", role: "system", text: this.formatContextReport() });
        this.host.emitContextUsage();
        return;
      }
      case "/doctor":
        await this.host.runDoctor();
        return;
      case "/index":
        await this.showWorkspaceIndex();
        return;
      case "/pin":
        if (rest) {
          await this.host.pinFile(rest);
        } else {
          await this.host.pinActiveFile();
        }
        return;
      case "/unpin":
        await this.host.unpinFile(rest || undefined);
        return;
      case "/pins":
        this.host.emit({ type: "message", role: "system", text: this.formatPinnedFilesReport() });
        return;
      case "/inspect":
      case "/inspector":
        this.host.emitInspector();
        this.host.emit({ type: "message", role: "system", text: this.formatInspectorReport() });
        return;
      case "/audit":
        this.host.emitInspector();
        this.host.emit({ type: "message", role: "system", text: this.formatAuditReport() });
        return;
      case "/capabilities":
        this.host.emit({ type: "message", role: "system", text: await this.formatCapabilityReport() });
        return;
      case "/commands":
        await this.showLocalCommands();
        return;
      case "/mcp":
        await this.host.handleMcpCommand(rest);
        return;
      case "/workers":
        this.showWorkers();
        return;
      case "/worker":
        await this.handleWorkerCommand(rest);
        return;
      case "/agents":
        await this.showLocalAgents();
        return;
      case "/review":
        await this.runReviewCommand(rest);
        return;
      case "/skills":
        await this.showLocalSkills();
        return;
      case "/skill":
        await this.handleSkillCommand(rest);
        return;
      case "/memory":
        await this.handleMemoryCommand(rest);
        return;
      case "/config":
      case "/settings":
        this.host.emit({ type: "openSettings" });
        await this.host.publishState();
        return;
      case "/model":
      case "/models":
        if (rest) {
          await this.host.selectModel(rest);
          this.host.emit({ type: "message", role: "system", text: `Model set to ${rest}.` });
        } else {
          await this.host.refreshModels();
          this.host.emit({ type: "message", role: "system", text: this.formatModelReport() });
        }
        return;
      case "/agent":
      case "/auto":
        await this.host.setAgentMode("agent");
        if (rest) {
          await this.host.runPrompt(rest, rest);
        }
        return;
      case "/ask":
        await this.host.setAgentMode("ask");
        if (rest) {
          await this.host.runPrompt(rest, rest);
        }
        return;
      case "/plan":
        await this.host.setAgentMode("plan");
        if (rest) {
          await this.host.runPrompt(rest, rest);
        }
        return;
      default:
        if (await this.tryLocalSlashCommand(command.slice(1), rest, rawPrompt.trim())) {
          return;
        }
        this.host.emit({
          type: "message",
          role: "system",
          text: `Unknown command ${command}. Available commands: /new, /compact, /undo, /curator, /context, /doctor, /index, /pin, /unpin, /pins, /inspect, /audit, /capabilities, /commands, /mcp, /workers, /worker, /agents, /review, /skills, /skill, /memory, /clear, /stop, /history, /resume, /fork, /diff, /export, /model, /models, /agent, /ask, /plan, /manual, /smart, /full-auto, /config.`
        });
    }
  }

  private async setPermissionModeFromSlash(mode: PermissionMode): Promise<void> {
    // setPermissionMode already emits the "Permission mode set to ..." confirmation from the
    // persisted value, so the slash path just delegates.
    await this.host.setPermissionMode(mode);
  }

  private async showLocalCommands(): Promise<void> {
    const commands = await loadLocalCommands(this.host.workspace);
    this.host.emit({ type: "message", role: "system", text: formatLocalCommandList(commands) });
  }

  private async runReviewCommand(scope: string): Promise<void> {
    const target = scope.trim() || "the current branch, workspace changes, or relevant repo context";
    await this.host.runPrompt(`/review ${scope}`.trim(), reviewCommandPrompt(target));
  }

  private showWorkers(): void {
    const workers = this.host.workers.list();
    this.host.emit({ type: "workers", workers });
    this.host.emit({ type: "message", role: "system", text: formatWorkerList(workers) });
  }

  private async handleWorkerCommand(rest: string): Promise<void> {
    const [subcommandRaw, ...tail] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "list";
    switch (subcommand) {
      case "list":
      case "status":
        this.showWorkers();
        return;
      case "output":
      case "show":
      case "open": {
        const workerId = tail[0];
        if (!workerId) {
          this.host.emit({ type: "message", role: "system", text: "Usage: /worker output <worker-id>" });
          return;
        }
        this.host.showWorkerOutput(workerId);
        return;
      }
      case "attach": {
        const workerId = tail[0];
        if (!workerId) {
          this.host.emit({ type: "message", role: "system", text: "Usage: /worker attach <worker-id>" });
          return;
        }
        this.host.attachWorkerOutput(workerId);
        return;
      }
      case "stop":
      case "cancel": {
        const workerId = tail[0];
        if (!workerId) {
          this.host.emit({ type: "message", role: "system", text: "Usage: /worker stop <worker-id>" });
          return;
        }
        this.host.stopWorker(workerId);
        return;
      }
      case "help":
        this.host.emit({ type: "message", role: "system", text: workerCommandList() });
        return;
      default:
        this.host.emit({ type: "message", role: "system", text: workerCommandList() });
    }
  }

  private async showLocalSkills(): Promise<void> {
    const skills = await loadLocalSkills(this.host.workspace);
    this.host.emit({ type: "message", role: "system", text: formatLocalSkillList(skills) });
  }

  private async showLocalAgents(): Promise<void> {
    const agents = await loadLocalAgents(this.host.workspace);
    this.host.emit({ type: "message", role: "system", text: formatLocalAgentList(agents) });
  }

  private async handleSkillCommand(rest: string): Promise<void> {
    const [firstRaw, ...tail] = rest.trim().split(/\s+/);
    const first = firstRaw?.toLowerCase() || "";
    if (!first || first === "list") {
      await this.showLocalSkills();
      return;
    }

    const name = first === "use" ? tail.shift()?.toLowerCase() : first;
    const task = (first === "use" ? tail : rest.trim().split(/\s+/).slice(1)).join(" ").trim();
    if (!name) {
      this.host.emit({ type: "message", role: "system", text: "Usage: /skill <name> <task> or /skill list." });
      return;
    }

    const skills = await loadLocalSkills(this.host.workspace);
    const skill = skills.find((item) => item.name.toLowerCase() === name);
    if (!skill) {
      this.host.emit({ type: "message", role: "system", text: `No local CodeForge skill named ${name}.\n\n${formatLocalSkillList(skills)}` });
      return;
    }

    await this.host.runPrompt(`/skill ${skill.name}${task ? ` ${task}` : ""}`, renderLocalSkillPrompt(skill, task));
  }

  private async tryLocalSlashCommand(name: string, args: string, visiblePrompt: string): Promise<boolean> {
    if (!name) {
      return false;
    }
    const commands = await loadLocalCommands(this.host.workspace);
    const command = commands.find((item) => item.name.toLowerCase() === name.toLowerCase());
    if (!command) {
      return false;
    }
    const skills = command.skills.length > 0 ? await loadLocalSkills(this.host.workspace) : [];
    await this.host.runPrompt(visiblePrompt, renderLocalCommand(command, args, skills));
    return true;
  }

  private async showSessionHistory(): Promise<void> {
    if (!this.host.sessions.hasStore()) {
      this.host.emit({ type: "message", role: "system", text: "Session history is not available in this environment." });
      return;
    }

    const sessions = await this.host.sessions.listSummaries(10);
    if (sessions.length === 0) {
      this.host.emit({ type: "message", role: "system", text: "No saved CodeForge sessions." });
      return;
    }

    this.host.emit({ type: "sessions", sessions });
  }

  private async forkSession(sessionId: string | undefined): Promise<void> {
    if (!this.host.sessions.hasStore()) {
      this.host.emit({ type: "message", role: "system", text: "Session fork is not available in this environment." });
      return;
    }

    const source = sessionId ? await this.host.sessions.read(sessionId) : undefined;
    if (sessionId && !source) {
      this.host.emit({ type: "error", text: `No saved CodeForge session found for ${sessionId}.` });
      return;
    }
    const messages = source ? source.messages : this.host.getMessages();
    if (messages.length === 0) {
      this.host.emit({ type: "message", role: "system", text: "There is no session context to fork yet." });
      return;
    }

    this.host.clearApprovals();
    await this.host.sessions.startNewSession(`Fork of ${source?.title ?? "CodeForge session"}`);
    this.host.replaceMessages(messages, "restore");
    await this.host.publishTranscript();
    this.host.emit({ type: "message", role: "system", text: `Forked session${source ? ` ${source.id}` : ""} into a new local session.` });
  }

  private async showSessionDiff(sessionId: string | undefined): Promise<void> {
    if (!this.host.sessions.hasStore()) {
      this.host.emit({ type: "message", role: "system", text: "Session diff history is not available in this environment." });
      return;
    }

    const snapshot = await this.host.sessions.resolveStored(sessionId);
    if (!snapshot) {
      this.host.emit({ type: "error", text: sessionId ? `No saved CodeForge session found for ${sessionId}.` : "No saved CodeForge session found." });
      return;
    }

    const checkpoints = snapshot.records.filter(isCheckpointRecord);
    if (checkpoints.length === 0) {
      this.host.emit({ type: "message", role: "system", text: `No edit or command checkpoints recorded for ${snapshot.id}.` });
      return;
    }

    const lines = checkpoints.map((record, index) => {
      return `${index + 1}. ${new Date(record.createdAt).toLocaleString()} | ${record.summary} | ${toolSummary(record.action)}`;
    });
    this.host.emit({ type: "message", role: "system", text: `Checkpoints for ${snapshot.id}:\n${lines.join("\n")}` });
  }

  private async exportSession(sessionId: string | undefined): Promise<void> {
    if (!this.host.sessions.hasStore()) {
      this.host.emit({ type: "message", role: "system", text: "Session export is not available in this environment." });
      return;
    }

    const snapshot = await this.host.sessions.resolveStored(sessionId);
    if (!snapshot) {
      this.host.emit({ type: "error", text: sessionId ? `No saved CodeForge session found for ${sessionId}.` : "No saved CodeForge session found." });
      return;
    }

    const exportedPath = await this.host.sessions.exportSession(snapshot.id);
    if (!exportedPath) {
      this.host.emit({ type: "error", text: `Failed to export ${snapshot.id}.` });
      return;
    }
    this.host.emit({ type: "message", role: "system", text: `Exported ${snapshot.id} to ${exportedPath}.` });
  }

  private formatContextReport(): string {
    const usage = this.host.currentContextUsage();
    const lines = [
      `Context usage: ${usage.label} (${usage.percent}%).`,
      "",
      "Breakdown:",
      ...usage.breakdown.map((part) => `- ${part.label}: ${formatBytes(part.bytes)} (${part.percent}%)`)
    ];

    const contextItems = this.host.getLastContextItems();
    if (contextItems.length > 0) {
      lines.push("", "Last attached local context:");
      for (const item of contextItems) {
        lines.push(`- ${contextItemKindLabel(item.kind)}: ${item.label} (${formatBytes(Buffer.byteLength(item.content, "utf8"))})`);
      }
    } else {
      lines.push("", "Last attached local context: none yet in this session.");
    }

    return lines.join("\n");
  }

  private async showWorkspaceIndex(): Promise<void> {
    try {
      const index = await buildWorkspaceIndex(this.host.workspace, {
        maxFiles: 500,
        maxAnalyzedFiles: 80,
        maxBytesPerFile: 16000
      }, this.host.currentSignal());
      this.host.emit({
        type: "message",
        role: "system",
        text: index ? `Repo index:\n\n${index.content}` : "Repo index:\n\nNo repo files found."
      });
    } catch (error) {
      this.host.emit({ type: "error", text: `Failed to build workspace index: ${errorMessage(error)}` });
    }
  }

  private formatPinnedFilesReport(): string {
    const pinned = [...this.host.getPinnedFiles()];
    return pinned.length === 0
      ? "Pinned context files: none. The open repo folder is still used automatically; use /pin <path> only when you want to force a specific file into every request."
      : `Pinned context files:\n${pinned.map((path) => `- ${path}`).join("\n")}`;
  }

  private formatInspectorReport(): string {
    const inspectorEntries = this.host.getInspectorEntries();
    if (inspectorEntries.length === 0) {
      return "Run inspector:\n\nNo run events recorded yet.";
    }
    const lines = inspectorEntries.slice(0, 40).map((entry) => {
      const when = new Date(entry.createdAt).toLocaleTimeString();
      return `- ${when} [${entry.level}] ${entry.category}: ${entry.summary}${entry.detail ? `\n  ${firstLines(entry.detail, 4).replace(/\n/g, "\n  ")}` : ""}`;
    });
    return `Run inspector:\n${lines.join("\n")}`;
  }

  private formatAuditReport(): string {
    const auditEntries = this.host.getAuditEntries();
    if (auditEntries.length === 0) {
      return "Permission audit:\n\nNo permission decisions recorded yet.";
    }
    const lines = auditEntries.slice(0, 60).map((entry) => {
      const when = new Date(entry.createdAt).toLocaleTimeString();
      return `- ${when} ${entry.action} ${entry.outcome} (${entry.behavior}/${entry.source}) - ${entry.reason}`;
    });
    return `Permission audit:\n${lines.join("\n")}`;
  }

  private async formatCapabilityReport(): Promise<string> {
    const profileId = this.host.config.getActiveProfileId();
    const entries = await this.host.capabilitySummaries(profileId);
    if (entries.length === 0) {
      return "Endpoint capability cache:\n\nNo cached model capabilities yet. Run /doctor or send a request to probe the selected model.";
    }
    const lines = entries.map((entry) => {
      const details = [
        entry.nativeToolCalls ? "native tools" : "json fallback",
        entry.streaming ? "streaming" : "non-streaming",
        entry.contextLength ? `${entry.contextLength.toLocaleString("en-US")} ctx` : undefined,
        entry.supportsReasoning ? "thinking" : undefined
      ].filter((item): item is string => Boolean(item)).join(", ");
      return `- ${entry.model} | ${details} | checked ${new Date(entry.checkedAt).toLocaleString()}`;
    });
    return `Endpoint capability cache:\n${lines.join("\n")}`;
  }

  private formatModelReport(): string {
    const activeProfileId = this.host.config.getActiveProfileId();
    const profile = this.host.config.getProfiles().find((item) => item.id === activeProfileId);
    const inspection = this.host.models.getInspection(activeProfileId);
    const selectedModel = profile ? this.host.models.selectedModelFor(profile, inspection) : inspection?.models[0]?.id || "";
    const lines = [
      `Active model: ${selectedModel || "(not configured)"}.`,
      inspection?.backendLabel ? `Detected backend: ${inspection.backendLabel}.` : undefined,
      "",
      "Available models:"
    ].filter((line): line is string => line !== undefined);

    if (!inspection || inspection.models.length === 0) {
      lines.push("- No models found. Check the OpenAI API endpoint settings.");
      return lines.join("\n");
    }

    for (const model of inspection.models) {
      const details = [
        model.contextLength ? `${model.contextLength.toLocaleString("en-US")} ctx` : undefined,
        model.maxOutputTokens ? `${model.maxOutputTokens.toLocaleString("en-US")} output` : undefined,
        model.supportsReasoning ? "thinking" : undefined
      ].filter((item): item is string => Boolean(item));
      const marker = model.id === selectedModel ? "*" : "-";
      lines.push(`${marker} ${model.id}${details.length > 0 ? ` (${details.join(", ")})` : ""}`);
    }
    lines.push("", "Use `/models` to pick from the active endpoint or `/model <model-id>` to switch directly.");
    return lines.join("\n");
  }

  private async handleMemoryCommand(rest: string): Promise<void> {
    const memoryStore = this.host.memoryStore;
    if (!memoryStore) {
      this.host.emit({ type: "message", role: "system", text: "Local memory is not available in this environment." });
      return;
    }

    const [subcommandRaw, ...args] = rest.trim().split(/\s+/);
    const subcommand = subcommandRaw?.toLowerCase() || "list";
    const value = args.join(" ").trim();

    switch (subcommand) {
      case "add":
      case "remember": {
        if (!value) {
          this.host.emit({ type: "message", role: "system", text: "Usage: /memory add <local instruction or preference>" });
          return;
        }
        const memory = await memoryStore.add(value);
        this.host.emit({ type: "message", role: "system", text: `Saved local memory ${memory.id}.` });
        return;
      }
      case "remove":
      case "forget":
      case "delete": {
        if (!value) {
          this.host.emit({ type: "message", role: "system", text: "Usage: /memory remove <memory-id>" });
          return;
        }
        const removed = await memoryStore.remove(value);
        this.host.emit({ type: "message", role: "system", text: removed ? `Removed local memory ${value}.` : `No local memory found for ${value}.` });
        return;
      }
      case "clear":
        await memoryStore.clear();
        this.host.emit({ type: "message", role: "system", text: "Cleared all local CodeForge memories." });
        return;
      case "list": {
        const memories = await memoryStore.list();
        if (memories.length === 0) {
          this.host.emit({ type: "message", role: "system", text: "No local CodeForge memories are saved." });
          return;
        }
        const lines = memories.map((memory) => {
          const scope = memory.scope === "agent" && memory.namespace ? `agent:${memory.namespace}` : memory.scope ?? "workspace";
          return `${memory.id} | ${scope} | ${new Date(memory.createdAt).toLocaleString()} | ${memory.text}`;
        });
        this.host.emit({ type: "message", role: "system", text: `Local CodeForge memories:\n${lines.join("\n")}` });
        return;
      }
      default:
        this.host.emit({ type: "message", role: "system", text: "Usage: /memory list, /memory add <text>, /memory remove <id>, or /memory clear." });
    }
  }
}

function permissionModeFromSlashCommand(command: string): PermissionMode | undefined {
  switch (command) {
    case "/manual":
    case "/read-only":
    case "/readonly":
      return "manual";
    case "/smart":
    case "/default":
    case "/accept-edits":
    case "/acceptedits":
      return "smart";
    case "/full-auto":
    case "/fullauto":
    case "/workspace-trusted":
    case "/workspacetrusted":
      return "fullAuto";
    default:
      return undefined;
  }
}

function reviewCommandPrompt(scope: string): string {
  return [
    "You are an expert code reviewer working inside VS Code.",
    `Review: ${scope}`,
    "",
    "Use repo read/search/diagnostic tools when evidence is not already available.",
    "Do not edit files, create files, run terminal commands, or launch workers unless the user explicitly asks for implementation or verification.",
    "Prioritize correctness bugs, regressions, unsafe assumptions, missing tests, and behavior that conflicts with the user request.",
    "Lead with findings. Include concrete file paths and line references when available. If there are no concrete findings, say that clearly and list any remaining test gaps."
  ].join("\n");
}

function formatWorkerList(workers: readonly WorkerSummary[]): string {
  if (workers.length === 0) {
    return `${workerCommandList()}\n\nNo workers have run in this chat session.`;
  }
  const lines = workers.map((worker) => {
    const detail = [
      worker.model,
      worker.toolUseCount > 0 ? `${worker.toolUseCount} tools` : undefined,
      worker.tokenCount > 0 ? `${worker.tokenCount.toLocaleString("en-US")} tokens` : undefined,
      worker.filesInspected.length > 0 ? `${worker.filesInspected.length} files` : undefined
    ].filter((item): item is string => Boolean(item)).join(", ");
    const summary = worker.error ?? worker.summary ?? worker.prompt;
    return `- ${worker.id} | ${worker.label} | ${worker.status}${detail ? ` | ${detail}` : ""}\n  ${summary}`;
  });
  return `Workers:\n${lines.join("\n")}\n\nUse /worker output <id> to view a transcript or /worker stop <id> to stop a running worker.`;
}

function isCheckpointRecord(record: SessionRecord): record is Extract<SessionRecord, { readonly type: "checkpoint" }> {
  return record.type === "checkpoint";
}
