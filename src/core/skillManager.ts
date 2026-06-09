// Agent-authored skills — TS port of the relevant parts of Hermes `tools/skill_manager_tool.py`
// and `tools/skills_tool.py`. Exposes skill_manage (create/patch/edit/write_file/remove_file/
// delete), skill_view, and skills_list. Skills are procedural memory: reusable `.codeforge/skills/
// <name>/SKILL.md` documents (+ references/templates/scripts/assets) the agent builds and refines.
//
// Provenance: a create only marks the skill `created_by: "agent"` (curator-eligible) when it
// originates from the background self-improvement review — main-loop, user-directed skills stay
// user-owned. Delete archives (never destroys): the skill directory moves to .archive/ and can be
// restored. Pinned skills refuse delete (but accept patch/edit).

import { parseMarkdownFile, isSafeExtensionName } from "./localExtensions";
import { SkillUsageTracker } from "./skillUsage";
import {
  archivedSkillDirPath,
  flatSkillPath,
  isAllowedSupportFile,
  skillDirPath,
  skillMdPath,
  SkillIo
} from "./skillIo";

export interface SkillManageContext {
  /** True when invoked from the background self-improvement review fork (marks curator-eligible). */
  readonly markAgentCreated?: boolean;
}

const MAX_SKILL_BYTES = 100000;
const MAX_SUPPORT_FILE_BYTES = 1024 * 1024;

export class SkillManager {
  constructor(private readonly io: SkillIo, private readonly usage: SkillUsageTracker) {}

  async handleManage(args: Record<string, unknown>, ctx: SkillManageContext = {}): Promise<string> {
    const action = String(args.action ?? "");
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name || !isSafeExtensionName(name)) {
      return err("Invalid or missing skill name. Use lowercase letters, digits, hyphens, or underscores (<=64 chars).");
    }
    switch (action) {
      case "create":
        return this.create(name, str(args.content), Boolean(ctx.markAgentCreated));
      case "edit":
        return this.edit(name, str(args.content));
      case "patch":
        return this.patch(name, str(args.old_string), str(args.new_string), str(args.file_path), Boolean(args.replace_all));
      case "write_file":
        return this.writeFile(name, str(args.file_path), str(args.file_content));
      case "remove_file":
        return this.removeFile(name, str(args.file_path));
      case "delete":
        return this.delete(name, typeof args.absorbed_into === "string" ? args.absorbed_into : undefined);
      default:
        return err(`Unknown action '${action}'. Use: create, patch, edit, delete, write_file, remove_file.`);
    }
  }

  async handleView(args: Record<string, unknown>): Promise<string> {
    const name = typeof args.name === "string" ? args.name.trim() : "";
    if (!name) {
      return err("name is required.");
    }
    const filePath = str(args.file_path);
    if (filePath) {
      if (!isAllowedSupportFile(filePath)) {
        return err("file_path must be under references/, templates/, scripts/, or assets/.");
      }
      const content = await this.io.read(`${skillDirPath(name)}/${filePath}`);
      if (content === undefined) {
        return err(`No file '${filePath}' in skill '${name}'.`);
      }
      await this.usage.bumpView(name);
      return ok({ name, file_path: filePath, content });
    }
    const md = await this.findSkillMd(name);
    if (!md) {
      return err(`No skill named '${name}'.`);
    }
    const content = (await this.io.read(md)) ?? "";
    await this.usage.bumpView(name);
    return ok({ name, content });
  }

  async handleList(): Promise<string> {
    const names = await this.io.listSkillNames();
    const skills: { name: string; description: string }[] = [];
    for (const name of [...names].sort()) {
      const md = await this.findSkillMd(name);
      if (!md) {
        continue;
      }
      const raw = await this.io.read(md);
      const description = raw ? parseMarkdownFile(raw).metadata.description ?? "" : "";
      skills.push({ name, description });
    }
    return ok({ skills, count: skills.length });
  }

  // -- skill_manage actions -------------------------------------------------

  private async create(name: string, content: string, markAgentCreated: boolean): Promise<string> {
    if (!content.trim()) {
      return err("content is required for 'create' (full SKILL.md with YAML frontmatter).");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      return err(`SKILL.md is too large (> ${MAX_SKILL_BYTES} bytes).`);
    }
    const frontmatterError = validateFrontmatter(content);
    if (frontmatterError) {
      return err(frontmatterError);
    }
    if (await this.findSkillMd(name)) {
      return err(`A skill named '${name}' already exists. Use 'edit' or 'patch' to change it.`);
    }
    await this.io.write(skillMdPath(name), ensureTrailingNewline(content));
    await this.usage.ensure(name);
    if (markAgentCreated) {
      await this.usage.markAgentCreated(name);
    }
    return ok({ action: "create", name, path: skillMdPath(name), message: `Created skill '${name}'.` });
  }

  private async edit(name: string, content: string): Promise<string> {
    if (!content.trim()) {
      return err("content is required for 'edit' (the full updated SKILL.md).");
    }
    if (Buffer.byteLength(content, "utf8") > MAX_SKILL_BYTES) {
      return err(`SKILL.md is too large (> ${MAX_SKILL_BYTES} bytes).`);
    }
    const frontmatterError = validateFrontmatter(content);
    if (frontmatterError) {
      return err(frontmatterError);
    }
    const md = await this.findSkillMd(name);
    if (!md) {
      return err(`No skill named '${name}'.`);
    }
    await this.io.write(md, ensureTrailingNewline(content));
    await this.usage.bumpPatch(name);
    return ok({ action: "edit", name, path: md, message: `Rewrote skill '${name}'.` });
  }

  private async patch(name: string, oldString: string, newString: string, filePath: string, replaceAll: boolean): Promise<string> {
    if (!oldString) {
      return err("old_string is required for 'patch'.");
    }
    const target = filePath
      ? (isAllowedSupportFile(filePath) ? `${skillDirPath(name)}/${filePath}` : undefined)
      : await this.findSkillMd(name);
    if (!target) {
      return err(filePath ? "file_path must be under references/, templates/, scripts/, or assets/." : `No skill named '${name}'.`);
    }
    const current = await this.io.read(target);
    if (current === undefined) {
      return err(`No file to patch at '${target}'.`);
    }
    const occurrences = current.split(oldString).length - 1;
    if (occurrences === 0) {
      return err(`old_string not found in '${target}'.`);
    }
    if (occurrences > 1 && !replaceAll) {
      return err(`old_string matches ${occurrences} places — add surrounding context for a unique match, or set replace_all.`);
    }
    const next = replaceAll ? current.split(oldString).join(newString) : current.replace(oldString, newString);
    await this.io.write(target, next);
    await this.usage.bumpPatch(name);
    return ok({ action: "patch", name, path: target, message: `Patched '${target}'.` });
  }

  private async writeFile(name: string, filePath: string, fileContent: string): Promise<string> {
    if (!filePath || !isAllowedSupportFile(filePath)) {
      return err("file_path must be under references/, templates/, scripts/, or assets/.");
    }
    if (fileContent === "") {
      return err("file_content is required for 'write_file'.");
    }
    if (Buffer.byteLength(fileContent, "utf8") > MAX_SUPPORT_FILE_BYTES) {
      return err("Support file is too large (> 1 MiB).");
    }
    if (!(await this.findSkillMd(name))) {
      return err(`No skill named '${name}'. Create it before adding support files.`);
    }
    await this.io.write(`${skillDirPath(name)}/${filePath}`, fileContent);
    await this.usage.bumpPatch(name);
    return ok({ action: "write_file", name, path: `${skillDirPath(name)}/${filePath}`, message: `Wrote '${filePath}' under '${name}'.` });
  }

  private async removeFile(name: string, filePath: string): Promise<string> {
    if (!filePath || !isAllowedSupportFile(filePath)) {
      return err("file_path must be under references/, templates/, scripts/, or assets/.");
    }
    const target = `${skillDirPath(name)}/${filePath}`;
    if (!(await this.io.exists(target))) {
      return err(`No file '${filePath}' in skill '${name}'.`);
    }
    await this.io.remove(target);
    return ok({ action: "remove_file", name, path: target, message: `Removed '${filePath}' from '${name}'.` });
  }

  private async delete(name: string, absorbedInto: string | undefined): Promise<string> {
    if (await this.usage.isPinned(name)) {
      return err(`Skill '${name}' is pinned and protected from deletion. Unpin it first to archive it.`);
    }
    const dir = skillDirPath(name);
    if (!(await this.io.exists(dir)) && !(await this.io.exists(flatSkillPath(name)))) {
      return err(`No skill named '${name}'.`);
    }
    // Archive (never destroy): move the skill directory into .archive/ so it can be restored.
    if (await this.io.exists(dir)) {
      const archived = archivedSkillDirPath(name);
      if (await this.io.exists(archived)) {
        await this.io.remove(archived);
      }
      await this.io.move(dir, archived);
    } else {
      await this.io.remove(flatSkillPath(name));
    }
    await this.usage.setState(name, "archived");
    const intent = absorbedInto === undefined ? "" : absorbedInto ? ` (absorbed into '${absorbedInto}')` : " (pruned)";
    return ok({ action: "delete", name, archived: true, absorbed_into: absorbedInto ?? null, message: `Archived skill '${name}'${intent}.` });
  }

  private async findSkillMd(name: string): Promise<string | undefined> {
    if (await this.io.exists(skillMdPath(name))) {
      return skillMdPath(name);
    }
    if (await this.io.exists(flatSkillPath(name))) {
      return flatSkillPath(name);
    }
    return undefined;
  }
}

function validateFrontmatter(content: string): string | undefined {
  const parsed = parseMarkdownFile(content);
  if (!parsed.metadata.name) {
    return "SKILL.md must start with YAML frontmatter that includes a 'name:' field.";
  }
  if (!parsed.metadata.description) {
    return "SKILL.md frontmatter must include a 'description:' field.";
  }
  if (!parsed.body.trim()) {
    return "SKILL.md must have a markdown body after the frontmatter.";
  }
  return undefined;
}

function ensureTrailingNewline(content: string): string {
  return content.endsWith("\n") ? content : `${content}\n`;
}

function str(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function ok(payload: Record<string, unknown>): string {
  return JSON.stringify({ success: true, ...payload });
}

function err(message: string): string {
  return JSON.stringify({ success: false, error: message });
}
