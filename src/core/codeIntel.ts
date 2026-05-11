import { AgentAction } from "./types";

export type CodeIntelAction = Extract<AgentAction, {
  readonly type: "code_hover" | "code_definition" | "code_references" | "code_symbols";
}>;

export interface CodeIntelPort {
  execute(action: CodeIntelAction, signal?: AbortSignal): Promise<string>;
}

export class UnavailableCodeIntelPort implements CodeIntelPort {
  async execute(action: CodeIntelAction): Promise<string> {
    return `<tool_use_error>Error: VS Code language services are not available for ${action.type} in this environment.</tool_use_error>`;
  }
}
