import type { CodeForgeConfigService } from "../adapters/vscodeConfig";
import { buildReviewPrompt, REVIEW_TOOL_HINT } from "../core/backgroundReview";
import {
  applyAutomaticTransitions,
  CURATOR_REVIEW_PROMPT,
  formatCandidateList,
  formatTransitionSummary,
  parseCuratorSummary,
  readCuratorState,
  shouldRunCurator,
  writeCuratorState
} from "../core/curator";
import { listBackups, rollbackSkills, snapshotSkills } from "../core/curatorBackup";
import { archivedSkillDirPath, skillDirPath, SkillIo } from "../core/skillIo";
import { SkillManager } from "../core/skillManager";
import { SkillUsageReportRow, SkillUsageTracker } from "../core/skillUsage";
import { codeForgeTools } from "../core/toolRegistry";
import { ChatMessage, LlmProvider, LlmRequest, LlmStreamEvent, ProviderCapabilities, ToolCall, ToolDefinition } from "../core/types";
import type { AgentUiEvent } from "./agentController";
import { describeMemoryWrite, learningNotice, ReviewToolOutcome, reviewActionsFromText, reviewWriteSucceeded, summarizeReviewActions } from "./learningReview";
import { MemoryManager } from "./memoryManager";
import { errorMessage, isToolErrorText, safeParseArgs } from "./toolText";

const maxBackgroundReviewIterations = 6;
const maxCuratorIterations = 24;

// Everything the learning/curator loop needs from the controller. The controller owns the run-loop
// state (turn/iteration counts, error flag, transcript) and the model plumbing; this coordinator owns
// only the learning/curator state and logic.
export interface LearningDeps {
  memoryManager(): MemoryManager | undefined;
  skillManager(): SkillManager | undefined;
  skillIo(): SkillIo | undefined;
  skillUsage(): SkillUsageTracker | undefined;
  readonly config: CodeForgeConfigService;
  createProvider(): Promise<LlmProvider>;
  resolveModel(provider: LlmProvider, signal: AbortSignal): Promise<string>;
  resolveAuxiliaryModel(provider: LlmProvider, signal: AbortSignal, fallbackModel?: string): Promise<string>;
  capabilities(provider: LlmProvider, model: string, signal: AbortSignal): Promise<ProviderCapabilities>;
  streamChatWithIdleTimeout(provider: LlmProvider, request: LlmRequest, abort: AbortController, purpose: string): AsyncIterable<LlmStreamEvent>;
  requestMaxTokens(): number | undefined;
  ensureMemoryInitialized(): Promise<void>;
  publishState(): Promise<void>;
  emit(event: AgentUiEvent): void;
  recordInspector(level: "info" | "warn" | "error", category: string, summary: string, detail?: string): void;
  getMessages(): readonly ChatMessage[];
  getUserTurnCount(): number;
  getToolIterationCount(): number;
  getLastRunErrored(): boolean;
}

// Owns the Hermes-style self-improvement review (distil durable memory/skills from finished runs) and
// the long-horizon curator (skill-library maintenance). Fire-and-forget and fully guarded — it can
// never block or break a user run.
export class LearningCoordinator {
  private reviewInFlight = false;
  private inBackgroundReview = false;
  private reviewSkillWritesBlocked = false;
  private curatorInFlight = false;
  private lastMemoryReviewTurnCount = 0;
  private lastSkillReviewIterationCount = 0;
  private lastReviewedMessageCount = 0;

  constructor(private readonly deps: LearningDeps) {}

  // True while a background review/curator pass is running, so the controller can tag agent-created
  // skills correctly during that pass.
  isInBackgroundReview(): boolean {
    return this.inBackgroundReview;
  }

  reset(): void {
    this.reviewInFlight = false;
    this.inBackgroundReview = false;
    this.reviewSkillWritesBlocked = false;
    this.curatorInFlight = false;
    this.lastMemoryReviewTurnCount = 0;
    this.lastSkillReviewIterationCount = 0;
    this.lastReviewedMessageCount = 0;
  }

  // Re-baseline the review markers after a session is restored from disk so the next review only looks
  // at messages added in the resumed session.
  onSessionRestored(messageCount: number): void {
    this.reviewInFlight = false;
    this.inBackgroundReview = false;
    this.reviewSkillWritesBlocked = false;
    this.curatorInFlight = false;
    this.lastMemoryReviewTurnCount = this.deps.getUserTurnCount();
    this.lastSkillReviewIterationCount = 0;
    this.lastReviewedMessageCount = messageCount;
  }

  async maybeRunBackgroundReview(): Promise<void> {
    if (this.reviewInFlight || !this.deps.memoryManager()) {
      return;
    }
    const settings = this.deps.config.getMemorySettings();
    if (!settings.enabled || this.deps.getUserTurnCount() < Math.max(1, settings.reviewMinTurns)) {
      return;
    }
    const memoryDue = settings.nudgeInterval > 0 && this.deps.getUserTurnCount() - this.lastMemoryReviewTurnCount >= settings.nudgeInterval;
    const skillsDue = Boolean(this.deps.skillManager()) && settings.skillsEnabled && settings.skillNudgeInterval > 0
      && this.deps.getToolIterationCount() - this.lastSkillReviewIterationCount >= settings.skillNudgeInterval;
    if (!memoryDue && !skillsDue) {
      return;
    }
    // Advance the markers up front so a transient failure does not immediately re-fire the review.
    if (memoryDue) {
      this.lastMemoryReviewTurnCount = this.deps.getUserTurnCount();
    }
    if (skillsDue) {
      this.lastSkillReviewIterationCount = this.deps.getToolIterationCount();
    }

    const slice = this.deps.getMessages().slice(this.lastReviewedMessageCount);
    const didWork = slice.some((message) => message.role === "assistant" && ((message.toolCalls?.length ?? 0) > 0 || message.content.trim().length > 0));
    if (!didWork) {
      this.lastReviewedMessageCount = this.deps.getMessages().length;
      return;
    }

    // Anti-poisoning: never distil a SKILL or reusable lesson from a run that failed — a wrong approach
    // must not become durable guidance the agent follows forever. A failed run is restricted to
    // outcome-independent persona facts and verified corrections (enforced by the prompt and the
    // skill-write block below).
    const outcome = this.assessRunOutcome(slice);
    const reviewSkills = skillsDue && outcome === "ok";
    this.deps.recordInspector("info", "memory", `Self-improvement review on a ${outcome === "ok" ? "successful" : "failed/abandoned"} run.`, `memory=${memoryDue}, skills=${reviewSkills}`);

    this.reviewInFlight = true;
    this.inBackgroundReview = true;
    this.reviewSkillWritesBlocked = outcome !== "ok";
    try {
      await this.deps.ensureMemoryInitialized();
      const summary = await this.runBackgroundReview(memoryDue, reviewSkills, slice, outcome);
      this.lastReviewedMessageCount = this.deps.getMessages().length;
      if (summary) {
        // Per-update "learning" notices are emitted live inside runBackgroundReview as each memory,
        // user-profile, or skill write lands; here we just refresh the side panels (Learned/memory
        // list/skills) so they reflect what was just saved.
        await this.deps.publishState();
      }
    } catch (error) {
      this.deps.recordInspector("warn", "memory", "Background self-improvement review failed.", errorMessage(error));
    } finally {
      this.inBackgroundReview = false;
      this.reviewInFlight = false;
      this.reviewSkillWritesBlocked = false;
    }
  }

  // Classify the reviewed slice so the learning loop can refuse to harvest durable skills/lessons from
  // a run that went wrong. Conservative: a run is "failed" only on a clear signal (an error surfaced
  // during the run, or tool calls were dominated by errors).
  private assessRunOutcome(slice: readonly ChatMessage[]): "ok" | "failed" {
    if (this.deps.getLastRunErrored()) {
      return "failed";
    }
    let toolResults = 0;
    let toolErrors = 0;
    for (const message of slice) {
      if (message.role === "tool") {
        toolResults++;
        if (isToolErrorText(message.content)) {
          toolErrors++;
        }
      }
    }
    if (toolResults >= 3 && toolErrors / toolResults >= 0.5) {
      return "failed";
    }
    return "ok";
  }

  private async runBackgroundReview(reviewMemory: boolean, reviewSkills: boolean, slice: readonly ChatMessage[], outcome: "ok" | "failed" = "ok"): Promise<string> {
    const transcript = slice
      .filter((message) => message.role !== "system")
      .map((message) => `${message.role.toUpperCase()}:\n${message.content}`)
      .join("\n\n")
      .slice(-12000);
    const messages: ChatMessage[] = [
      { role: "system", content: `${buildReviewPrompt(reviewMemory, reviewSkills, outcome)}\n\n${REVIEW_TOOL_HINT}` },
      {
        role: "user",
        content: `--- Conversation to review ---\n${transcript}\n\n--- End conversation ---\n\nReview now using only the memory and skill tools. If nothing is worth saving, reply 'Nothing to save.' and stop.`
      }
    ];
    const abort = new AbortController();
    const provider = await this.deps.createProvider();
    const model = this.deps.config.getAuxiliaryModel()
      ? await this.deps.resolveAuxiliaryModel(provider, abort.signal)
      : await this.deps.resolveModel(provider, abort.signal);
    // Only offer native tool schemas when the endpoint supports them; otherwise rely on the JSON
    // action-protocol fallback taught by REVIEW_TOOL_HINT.
    const capabilities = await this.deps.capabilities(provider, model, abort.signal);
    const tools = capabilities.nativeToolCalls ? this.reviewToolSchemas() : undefined;
    const actions: string[] = [];

    for (let iteration = 0; iteration < maxBackgroundReviewIterations; iteration++) {
      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const event of this.deps.streamChatWithIdleTimeout(provider, {
        model,
        messages,
        tools,
        temperature: 0,
        maxTokens: this.deps.requestMaxTokens(),
        signal: abort.signal
      }, abort, "Self-improvement review")) {
        if (event.type === "content") {
          content += event.text;
        } else if (event.type === "toolCalls") {
          toolCalls.push(...event.toolCalls);
        }
      }

      if (toolCalls.length > 0) {
        messages.push({ role: "assistant", content, toolCalls });
        for (const toolCall of toolCalls) {
          const result = await this.executeReviewTool(toolCall.name, safeParseArgs(toolCall.argumentsJson));
          if (result.summary) {
            actions.push(result.summary);
          }
          if (result.notice) {
            this.deps.emit({ type: "message", role: "system", text: result.notice });
          }
          messages.push({ role: "tool", content: result.output, toolCallId: toolCall.id, name: toolCall.name });
        }
        continue;
      }

      // Non-native models emit the CodeForge JSON action protocol in text instead of native calls.
      const fallback = reviewActionsFromText(content);
      for (const action of fallback) {
        const result = await this.executeReviewTool(action.name, action.args);
        if (result.summary) {
          actions.push(result.summary);
        }
        if (result.notice) {
          this.deps.emit({ type: "message", role: "system", text: result.notice });
        }
      }
      break;
    }

    return summarizeReviewActions(actions);
  }

  private reviewToolSchemas(): ToolDefinition[] {
    const memorySchemas = this.deps.memoryManager()?.getAllToolSchemas() ?? [];
    const skillNames = new Set(["skills_list", "skill_view", "skill_manage"]);
    const skillSchemas = this.deps.skillManager()
      ? codeForgeTools.filter((tool) => skillNames.has(tool.name)).map((tool) => ({ name: tool.name, description: tool.description, parameters: tool.parameters }))
      : [];
    return [...memorySchemas, ...skillSchemas];
  }

  private async executeReviewTool(name: string, args: Record<string, unknown>): Promise<ReviewToolOutcome> {
    const memoryManager = this.deps.memoryManager();
    const skillManager = this.deps.skillManager();
    try {
      if (name === "memory" && memoryManager) {
        const output = await memoryManager.handleToolCall("memory", args);
        const ok = reviewWriteSucceeded(output);
        return { output, summary: ok ? describeMemoryWrite(args) : "", notice: ok ? learningNotice("memory", args) : "" };
      }
      if (name === "skill_manage" && skillManager) {
        if (this.reviewSkillWritesBlocked) {
          // Anti-poisoning hard gate: a failed/abandoned run may not create or change skills.
          return {
            output: JSON.stringify({ success: false, error: "Skill changes are disabled for this review because the run did not succeed. Save only a durable user fact or a verified corrective note." }),
            summary: "",
            notice: ""
          };
        }
        const output = await skillManager.handleManage(args, { markAgentCreated: true });
        const ok = reviewWriteSucceeded(output);
        return {
          output,
          summary: ok ? `${String(args.action ?? "update")} skill ${String(args.name ?? "")}`.trim() : "",
          notice: ok ? learningNotice("skill_manage", args) : ""
        };
      }
      if (name === "skill_view" && skillManager) {
        return { output: await skillManager.handleView(args), summary: "", notice: "" };
      }
      if (name === "skills_list" && skillManager) {
        return { output: await skillManager.handleList(), summary: "", notice: "" };
      }
    } catch (error) {
      return { output: JSON.stringify({ success: false, error: errorMessage(error) }), summary: "", notice: "" };
    }
    return { output: JSON.stringify({ success: false, error: `Tool '${name}' is not available in the review pass.` }), summary: "", notice: "" };
  }

  // -- Curator (long-horizon skill maintenance) -----------------------------

  async maybeRunCuratorAuto(): Promise<void> {
    const io = this.deps.skillIo();
    if (this.curatorInFlight || !io || !this.deps.skillUsage() || !this.deps.skillManager()) {
      return;
    }
    const settings = this.deps.config.getCuratorSettings();
    const now = Date.now();
    let state;
    try {
      state = await readCuratorState(io);
    } catch {
      return;
    }
    const gate = shouldRunCurator(state, now, settings);
    if (gate.seedFirstRun) {
      state.lastRunAt = now;
      await writeCuratorState(io, state).catch(() => undefined);
      return;
    }
    if (!gate.run) {
      return;
    }
    await this.runCurator({ dryRun: false });
  }

  async runCurator(options: { readonly dryRun?: boolean } = {}): Promise<string> {
    const io = this.deps.skillIo();
    const usage = this.deps.skillUsage();
    if (!io || !usage || !this.deps.skillManager()) {
      return "Skills are not available in this environment.";
    }
    if (this.curatorInFlight) {
      return "A curator pass is already running.";
    }
    const settings = this.deps.config.getCuratorSettings();
    const now = Date.now();
    const dryRun = options.dryRun ?? false;
    const start = Date.now();
    this.curatorInFlight = true;
    this.inBackgroundReview = true;
    try {
      let backupNote = "";
      if (!dryRun && settings.backupEnabled) {
        const info = await snapshotSkills(io, now, settings.backupKeep).catch(() => undefined);
        if (info) {
          backupNote = `backup ${info.id} (${info.fileCount} files); `;
        }
      }
      const transitions = await applyAutomaticTransitions(io, usage, settings, now, !dryRun);
      const report = await usage.agentCreatedReport();
      const consolidation = await this.runCuratorConsolidation(report, now, dryRun);
      const summaryText = `${formatTransitionSummary(transitions)}${consolidation ? `; ${consolidation}` : ""}`;
      if (!dryRun) {
        const state = await readCuratorState(io);
        state.lastRunAt = now;
        state.lastRunDurationMs = Date.now() - start;
        state.lastRunSummary = summaryText;
        state.runCount += 1;
        await writeCuratorState(io, state).catch(() => undefined);
      }
      const message = `🧹 Curator${dryRun ? " (dry run)" : ""}: ${backupNote}${summaryText}`;
      this.deps.emit({ type: "message", role: "system", text: message });
      await this.deps.publishState();
      return message;
    } catch (error) {
      this.deps.recordInspector("warn", "memory", "Curator pass failed.", errorMessage(error));
      return `Curator pass failed: ${errorMessage(error)}`;
    } finally {
      this.inBackgroundReview = false;
      this.curatorInFlight = false;
    }
  }

  private async runCuratorConsolidation(report: readonly SkillUsageReportRow[], nowMs: number, dryRun: boolean): Promise<string> {
    if (dryRun || report.length === 0 || !this.deps.skillManager()) {
      return "";
    }
    const messages: ChatMessage[] = [
      { role: "system", content: `${CURATOR_REVIEW_PROMPT}\n\n${REVIEW_TOOL_HINT}` },
      {
        role: "user",
        content: `Candidate agent-created skills:\n${formatCandidateList(report, nowMs)}\n\nConsolidate now. Use skills_list / skill_view to inspect, then skill_manage to patch/create/write_file and to archive (action=delete) absorbed siblings. Finish with the structured summary block.`
      }
    ];
    const abort = new AbortController();
    const provider = await this.deps.createProvider();
    const model = this.deps.config.getAuxiliaryModel()
      ? await this.deps.resolveAuxiliaryModel(provider, abort.signal)
      : await this.deps.resolveModel(provider, abort.signal);
    const capabilities = await this.deps.capabilities(provider, model, abort.signal);
    const tools = capabilities.nativeToolCalls ? this.reviewToolSchemas().filter((tool) => tool.name.startsWith("skill")) : undefined;
    let lastContent = "";
    let ops = 0;

    for (let iteration = 0; iteration < maxCuratorIterations; iteration++) {
      let content = "";
      const toolCalls: ToolCall[] = [];
      for await (const event of this.deps.streamChatWithIdleTimeout(provider, {
        model,
        messages,
        tools,
        temperature: 0,
        maxTokens: this.deps.requestMaxTokens(),
        signal: abort.signal
      }, abort, "Curator consolidation")) {
        if (event.type === "content") {
          content += event.text;
        } else if (event.type === "toolCalls") {
          toolCalls.push(...event.toolCalls);
        }
      }
      lastContent = content || lastContent;

      if (toolCalls.length === 0) {
        for (const action of reviewActionsFromText(content).filter((a) => a.name.startsWith("skill"))) {
          await this.executeReviewTool(action.name, action.args);
          ops += 1;
        }
        break;
      }
      messages.push({ role: "assistant", content, toolCalls });
      for (const toolCall of toolCalls) {
        const result = await this.executeReviewTool(toolCall.name, safeParseArgs(toolCall.argumentsJson));
        if (toolCall.name === "skill_manage") {
          ops += 1;
        }
        messages.push({ role: "tool", content: result.output, toolCallId: toolCall.id, name: toolCall.name });
      }
    }

    const parsed = parseCuratorSummary(lastContent);
    if (ops === 0 && parsed.consolidations.length === 0 && parsed.prunings.length === 0) {
      return "";
    }
    return `consolidated ${parsed.consolidations.length} · pruned ${parsed.prunings.length}`;
  }

  /** Slash-command surface: /curator status|run|pause|resume|pin|unpin|archive|restore|backup|rollback|list-archived. */
  async handleCuratorCommand(rest: string): Promise<void> {
    const io = this.deps.skillIo();
    const usage = this.deps.skillUsage();
    const skillManager = this.deps.skillManager();
    if (!io || !usage || !skillManager) {
      this.deps.emit({ type: "error", text: "Skills are not available in this environment." });
      return;
    }
    const settings = this.deps.config.getCuratorSettings();
    const [verb, ...args] = rest.trim().split(/\s+/).filter(Boolean);
    const arg = args.filter((value) => !value.startsWith("--")).join(" ");
    const dryRun = args.includes("--dry-run");

    switch (verb ?? "status") {
      case "status": {
        const state = await readCuratorState(io);
        const report = await usage.agentCreatedReport();
        const byState = (s: string) => report.filter((row) => row.state === s).length;
        const pinned = report.filter((row) => row.pinned).map((row) => row.name);
        const last = state.lastRunAt ? new Date(state.lastRunAt).toISOString() : "never";
        this.deps.emit({
          type: "message",
          role: "system",
          text:
            `🧹 Curator: ${settings.enabled ? (state.paused ? "PAUSED" : "enabled") : "disabled"}\n` +
            `runs: ${state.runCount} · last run: ${last}\n` +
            `last summary: ${state.lastRunSummary ?? "—"}\n` +
            `interval: ${settings.intervalHours}h · stale after ${settings.staleAfterDays}d · archive after ${settings.archiveAfterDays}d\n` +
            `agent-created skills: ${report.length} (active ${byState("active")}, stale ${byState("stale")}, archived ${byState("archived")})\n` +
            `pinned (${pinned.length}): ${pinned.join(", ") || "none"}`
        });
        return;
      }
      case "run":
        await this.runCurator({ dryRun });
        return;
      case "pause": {
        const state = await readCuratorState(io);
        state.paused = true;
        await writeCuratorState(io, state);
        this.deps.emit({ type: "status", text: "Curator paused." });
        return;
      }
      case "resume": {
        const state = await readCuratorState(io);
        state.paused = false;
        await writeCuratorState(io, state);
        this.deps.emit({ type: "status", text: "Curator resumed." });
        return;
      }
      case "pin":
        if (!arg) {
          this.deps.emit({ type: "error", text: "Usage: /curator pin <skill>" });
          return;
        }
        await usage.setPinned(arg, true);
        this.deps.emit({ type: "status", text: `Pinned skill ${arg} (protected from auto-archive).` });
        return;
      case "unpin":
        if (!arg) {
          this.deps.emit({ type: "error", text: "Usage: /curator unpin <skill>" });
          return;
        }
        await usage.setPinned(arg, false);
        this.deps.emit({ type: "status", text: `Unpinned skill ${arg}.` });
        return;
      case "archive": {
        if (!arg) {
          this.deps.emit({ type: "error", text: "Usage: /curator archive <skill>" });
          return;
        }
        const result = JSON.parse(await skillManager.handleManage({ action: "delete", name: arg, absorbed_into: "" }));
        this.deps.emit({ type: result.success ? "status" : "error", text: result.message ?? result.error ?? "" });
        await this.deps.publishState();
        return;
      }
      case "restore": {
        if (!arg) {
          this.deps.emit({ type: "error", text: "Usage: /curator restore <skill>" });
          return;
        }
        if (!(await io.exists(archivedSkillDirPath(arg)))) {
          this.deps.emit({ type: "error", text: `No archived skill '${arg}'.` });
          return;
        }
        await io.move(archivedSkillDirPath(arg), skillDirPath(arg));
        await usage.setState(arg, "active");
        this.deps.emit({ type: "status", text: `Restored skill ${arg}.` });
        await this.deps.publishState();
        return;
      }
      case "list-archived": {
        const archived = (await usage.report()).filter((row) => row.state === "archived").map((row) => row.name);
        this.deps.emit({ type: "message", role: "system", text: `Archived skills (${archived.length}): ${archived.join(", ") || "none"}` });
        return;
      }
      case "backup": {
        const info = await snapshotSkills(io, Date.now(), settings.backupKeep);
        this.deps.emit({ type: "status", text: `Backed up ${info.fileCount} skill file(s) as ${info.id}.` });
        return;
      }
      case "rollback": {
        const ids = await listBackups(io);
        if (!arg && ids.length === 0) {
          this.deps.emit({ type: "error", text: "No curator backups to roll back to." });
          return;
        }
        const id = arg || ids[ids.length - 1];
        const result = await rollbackSkills(io, id, Date.now(), settings.backupKeep);
        this.deps.emit({ type: result.ok ? "status" : "error", text: result.message });
        await this.deps.publishState();
        return;
      }
      default:
        this.deps.emit({ type: "error", text: `Unknown curator command '${verb}'. Try: status, run, pause, resume, pin, unpin, archive, restore, list-archived, backup, rollback.` });
    }
  }
}
