import { WorkspaceDiagnostic } from "../core/types";
import type { AgentInspectorEntry } from "./agentUiTypes";

export interface ChangeVerifierDeps {
  getDiagnostics(path: string, limit: number, signal?: AbortSignal): Promise<readonly WorkspaceDiagnostic[]>;
  recordInspector(level: AgentInspectorEntry["level"], category: string, summary: string, detail?: string): void;
  signal(): AbortSignal | undefined;
}

// After a write/edit/patch applies, collect VS Code diagnostics for the changed files and format the
// "Verification:" footer appended to the tool result so the model sees any new errors/warnings.
export class ChangeVerifier {
  constructor(private readonly deps: ChangeVerifierDeps) {}

  async verify(paths: readonly string[]): Promise<string> {
    const uniquePaths = uniqueStrings(paths).filter((path) => path && path !== "/dev/null");
    if (uniquePaths.length === 0) {
      return "";
    }

    const diagnostics: WorkspaceDiagnostic[] = [];
    for (const path of uniquePaths.slice(0, 12)) {
      try {
        diagnostics.push(...await this.deps.getDiagnostics(path, 20, this.deps.signal()));
      } catch {
        // Diagnostics are best-effort after edits; failed reads should not mask a successful write.
      }
    }

    const relevant = diagnostics
      .filter((diagnostic) => diagnostic.severity === "error" || diagnostic.severity === "warning")
      .slice(0, 30);
    const detail = relevant.length > 0
      ? relevant.map((diagnostic) => `${diagnostic.severity} ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.message}`).join("\n")
      : `No VS Code errors or warnings reported for ${uniquePaths.join(", ")}.`;
    this.deps.recordInspector(relevant.length > 0 ? "warn" : "info", "verification", `Checked diagnostics for ${uniquePaths.length} changed file(s).`, detail);
    return [
      "",
      "",
      "Verification:",
      relevant.length > 0
        ? relevant.map((diagnostic) => `- ${diagnostic.severity} ${diagnostic.path}:${diagnostic.line}:${diagnostic.character} ${diagnostic.message}`).join("\n")
        : `- No VS Code errors or warnings reported for ${uniquePaths.join(", ")}.`
    ].join("\n");
  }
}

function uniqueStrings(values: readonly string[] | undefined): readonly string[] {
  return [...new Set((values ?? []).map((value) => value.trim()).filter(Boolean))];
}
