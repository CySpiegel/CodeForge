import { PermissionMode } from "./types";

export type LegacyPermissionMode = "default" | "review" | "acceptEdits" | "readOnly" | "workspaceTrusted";

export function normalizeSettingsPermissionMode(value: unknown): PermissionMode {
  switch (value) {
    case "manual":
    case "review":
    case "readOnly":
      return "manual";
    case "fullAuto":
    case "workspaceTrusted":
      return "fullAuto";
    case "smart":
    case "default":
    case "acceptEdits":
    default:
      return "smart";
  }
}
