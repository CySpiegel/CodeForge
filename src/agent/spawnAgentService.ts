import { toolDefinitions } from "../core/actionProtocol";
import { LocalAgent } from "../core/localExtensions";
import { AgentAction } from "../core/types";
import { findWorkerDefinition, isWorkerKind } from "../core/workerAgents";
import { WorkerDefinition, WorkerSummary } from "../core/workerTypes";
import type { AgentUiEvent } from "./agentUiTypes";
import type { WorkerManager } from "./workerManager";

export interface SpawnAgentServiceDeps {
  readonly workers: WorkerManager;
  loadAgents(): Promise<readonly LocalAgent[]>;
  signal(): AbortSignal | undefined;
  emit(event: AgentUiEvent): void;
}

// Implements the spawn_agent tool: resolve the requested agent (built-in kind or workspace-local
// definition), launch a worker, and either return immediately (background) or wait out the foreground
// window. Owns the local-agent -> worker-definition mapping (allowed tool sets per requested capability).
export class SpawnAgentService {
  constructor(private readonly deps: SpawnAgentServiceDeps) {}

  async execute(action: Extract<AgentAction, { readonly type: "spawn_agent" }>): Promise<string> {
    const definition = await this.resolveDefinition(action.agent);
    const worker = this.deps.workers.spawnDefinition(definition, action.prompt);
    this.emitWorkerStarted(worker);
    if (action.background === true) {
      return `spawn_agent ${worker.id}\n\nLaunched ${worker.label} in the background. Use worker_output with workerId "${worker.id}" to inspect progress.`;
    }

    const completed = await this.deps.workers.waitFor(worker.id, 120000, this.deps.signal());
    const output = this.deps.workers.output(worker.id);
    if (!completed || completed.status === "running") {
      return `spawn_agent ${worker.id}\n\n${worker.label} is still running after the foreground wait window. Use worker_output with workerId "${worker.id}" to inspect progress.\n\n${output ?? ""}`.trim();
    }
    return output ?? `spawn_agent ${worker.id}\n\n${worker.label} finished with status ${completed.status}.`;
  }

  private async resolveDefinition(name: string | undefined): Promise<WorkerDefinition> {
    const normalized = name?.trim().toLowerCase() || "implement";
    const builtInName = normalized === "general" || normalized === "general-purpose" || normalized === "agent"
      ? "implement"
      : normalized;
    if (isWorkerKind(builtInName) && builtInName !== "custom") {
      const definition = findWorkerDefinition(builtInName);
      if (definition) {
        return definition;
      }
    }

    const agents = await this.deps.loadAgents();
    const agent = agents.find((item) => item.name.toLowerCase() === normalized);
    if (!agent) {
      throw new Error(`No CodeForge agent named ${normalized}. Built-ins: explore, plan, review, verify, implement. Local agents: ${agents.map((item) => item.name).join(", ") || "none"}.`);
    }
    return localAgentWorkerDefinition(agent);
  }

  private emitWorkerStarted(worker: WorkerSummary): void {
    this.deps.emit({
      type: "message",
      role: "system",
      text: `${worker.label} worker started: ${worker.id}\n\nUse /worker output ${worker.id} to view its transcript or /worker stop ${worker.id} to stop it.`
    });
  }
}

const localAgentReadTools = ["list_files", "glob_files", "read_file", "search_text", "grep_text", "list_diagnostics", "tool_search", "tool_list"] as const;
const localAgentCodeIntelTools = ["code_hover", "code_definition", "code_references", "code_symbols"] as const;
const localAgentNotebookReadTools = ["notebook_read"] as const;
const localAgentNotebookEditTools = ["notebook_edit_cell"] as const;
const localAgentStateTools = ["tool_search", "tool_list", "task_create", "task_update", "task_list", "task_get"] as const;
const localAgentQuestionTools = ["ask_user_question"] as const;
const localAgentEditTools = ["open_diff", "propose_patch", "write_file", "edit_file"] as const;
const localAgentCommandTools = ["run_command"] as const;
const localAgentMcpTools = ["mcp_call_tool", "mcp_list_resources", "mcp_read_resource"] as const;
const localAgentAutomationTools = ["spawn_agent", "worker_output"] as const;
const localAgentMemoryTools = ["memory", "fact_store", "fact_feedback"] as const;
const localAgentSkillTools = ["skill_manage", "skill_view", "skills_list"] as const;

function localAgentWorkerDefinition(agent: LocalAgent): WorkerDefinition {
  const label = agent.label?.trim() || agent.name;
  return {
    kind: "custom",
    name: agent.name,
    label,
    invocationName: agent.name,
    description: agent.description ?? `Workspace-local CodeForge agent ${agent.name}.`,
    maxTurns: Math.max(1, Math.min(12, agent.maxTurns ?? 6)),
    allowedToolNames: localAgentAllowedToolNames(agent),
    local: true,
    systemPrompt: [
      `You are the workspace-local CodeForge agent "${label}" running inside VS Code.`,
      "Use only the configured OpenAI API-compatible endpoint and CodeForge-provided workspace tools.",
      `Agent definition file: ${agent.path}`,
      agent.description ? `Agent description: ${agent.description}` : undefined,
      "Follow the agent instructions exactly unless they conflict with CodeForge safety, workspace permission policy, or the user's latest request.",
      "Use the workspace tools you are allowed to use. Any edit, command, or MCP side effect is routed through the parent VS Code approval and permission policy.",
      "Do not use network resources outside explicitly configured endpoints.",
      "Agent instructions:",
      agent.body,
      "When reporting, include these plain labels when they fit: Scope, Result, Key files, Files changed, Issues, Confidence."
    ].filter((line): line is string => Boolean(line)).join("\n")
  };
}

function localAgentAllowedToolNames(agent: LocalAgent): readonly WorkerDefinition["allowedToolNames"][number][] {
  const requested = agent.tools.length > 0 ? agent.tools : ["read"];
  const allowed = new Set<string>();
  const knownToolNames = new Set(toolDefinitions.map((tool) => tool.name));
  for (const rawTool of requested) {
    const tool = rawTool.toLowerCase();
    if (tool === "read" || tool === "readonly" || tool === "read-only") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
    } else if (tool === "code" || tool === "lsp" || tool === "symbols") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
    } else if (tool === "state" || tool === "task" || tool === "tasks" || tool === "todo" || tool === "todos") {
      addTools(allowed, localAgentStateTools);
    } else if (tool === "ask" || tool === "question" || tool === "questions") {
      addTools(allowed, localAgentQuestionTools);
    } else if (tool === "edit" || tool === "write" || tool === "files") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentStateTools);
      addTools(allowed, localAgentQuestionTools);
      addTools(allowed, localAgentEditTools);
      addTools(allowed, localAgentNotebookEditTools);
    } else if (tool === "notebook" || tool === "notebooks") {
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentNotebookEditTools);
    } else if (tool === "command" || tool === "shell" || tool === "bash" || tool === "terminal") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCommandTools);
    } else if (tool === "mcp" || tool === "service") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentMcpTools);
    } else if (tool === "agent" || tool === "agents" || tool === "delegate") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentAutomationTools);
    } else if (tool === "memory" || tool === "remember") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentMemoryTools);
    } else if (tool === "skill" || tool === "skills") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentSkillTools);
    } else if (tool === "all") {
      addTools(allowed, localAgentReadTools);
      addTools(allowed, localAgentCodeIntelTools);
      addTools(allowed, localAgentNotebookReadTools);
      addTools(allowed, localAgentStateTools);
      addTools(allowed, localAgentQuestionTools);
      addTools(allowed, localAgentEditTools);
      addTools(allowed, localAgentNotebookEditTools);
      addTools(allowed, localAgentCommandTools);
      addTools(allowed, localAgentMcpTools);
      addTools(allowed, localAgentAutomationTools);
      addTools(allowed, localAgentMemoryTools);
      addTools(allowed, localAgentSkillTools);
    } else if (knownToolNames.has(tool)) {
      allowed.add(tool);
    }
  }
  if (allowed.size === 0) {
    addTools(allowed, localAgentReadTools);
    addTools(allowed, localAgentCodeIntelTools);
    addTools(allowed, localAgentNotebookReadTools);
  }
  return [...allowed];
}

function addTools(target: Set<string>, tools: readonly string[]): void {
  for (const tool of tools) {
    target.add(tool);
  }
}
