// Filesystem port for the skills feature. The existing WorkspacePort is read-only and DiffService
// only writes/edits tracked files, so skill authoring (create/move/delete + the usage sidecar)
// needs its own small capability. Adapters implement this over vscode.workspace.fs; the skill
// manager and usage tracker depend only on this port so they stay unit-testable.

export const SKILLS_ROOT = ".codeforge/skills";
export const SKILLS_ARCHIVE = `${SKILLS_ROOT}/.archive`;
export const USAGE_FILE = `${SKILLS_ROOT}/.usage.json`;
export const SKILL_SUPPORT_DIRS = ["references", "templates", "scripts", "assets"] as const;

export interface SkillIo {
  /** Read a file under the workspace. Returns undefined when it does not exist. */
  read(relPath: string): Promise<string | undefined>;
  /** Write a file, creating parent directories as needed. */
  write(relPath: string, content: string): Promise<void>;
  /** Delete a file or directory (recursive). No-op if missing. */
  remove(relPath: string): Promise<void>;
  /** Move/rename a path (used to archive a skill directory). */
  move(fromRel: string, toRel: string): Promise<void>;
  exists(relPath: string): Promise<boolean>;
  /** Top-level skill names under SKILLS_ROOT (directories and flat *.md, excluding dot-entries). */
  listSkillNames(): Promise<readonly string[]>;
  /** Every file path (recursive) under relPath. Used by the curator backup. */
  listAll(relPath: string): Promise<readonly string[]>;
}

export const CURATOR_STATE_FILE = `${SKILLS_ROOT}/.curator_state.json`;
export const CURATOR_BACKUPS = `${SKILLS_ROOT}/.curator_backups`;

export function skillDirPath(name: string): string {
  return `${SKILLS_ROOT}/${name}`;
}

export function skillMdPath(name: string): string {
  return `${SKILLS_ROOT}/${name}/SKILL.md`;
}

export function flatSkillPath(name: string): string {
  return `${SKILLS_ROOT}/${name}.md`;
}

export function archivedSkillDirPath(name: string): string {
  return `${SKILLS_ARCHIVE}/${name}`;
}

/** Validate a support-file path is under an allowed subdir and has no traversal. */
export function isAllowedSupportFile(filePath: string): boolean {
  const normalized = filePath.replace(/\\/g, "/").replace(/^\/+/, "");
  if (normalized.includes("..") || normalized.endsWith("/")) {
    return false;
  }
  const top = normalized.split("/")[0];
  return (SKILL_SUPPORT_DIRS as readonly string[]).includes(top) && normalized.split("/").length >= 2;
}
