import { AgentAction } from "./types";

export type NotebookAction = Extract<AgentAction, {
  readonly type: "notebook_read" | "notebook_edit_cell";
}>;

export interface NotebookPort {
  execute(action: NotebookAction, signal?: AbortSignal): Promise<string>;
}

export class UnavailableNotebookPort implements NotebookPort {
  async execute(action: NotebookAction): Promise<string> {
    return `<tool_use_error>Error: VS Code notebook APIs are not available for ${action.type} in this environment.</tool_use_error>`;
  }
}
