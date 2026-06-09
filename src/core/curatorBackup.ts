// Curator backups — pre-run snapshots of the skill library so a curator pass is always reversible.
// Ported in spirit from Hermes `agent/curator_backup.py` (tar.gz there; here a dir copy under
// .codeforge/skills/.curator_backups/<id>/, since Node/VS Code has no stdlib tar).

import { CURATOR_BACKUPS, SkillIo, SKILLS_ROOT } from "./skillIo";

export interface BackupInfo {
  readonly id: string;
  readonly fileCount: number;
}

function backupId(nowMs: number): string {
  return new Date(nowMs).toISOString().replace(/[:.]/g, "-");
}

function relUnder(path: string, root: string): string {
  return path.slice(root.length + 1);
}

/** Snapshot every skill file (excluding existing backups) into a new timestamped backup dir. */
export async function snapshotSkills(io: SkillIo, nowMs: number, keep: number): Promise<BackupInfo> {
  const id = backupId(nowMs);
  const dest = `${CURATOR_BACKUPS}/${id}`;
  let fileCount = 0;
  for (const path of await io.listAll(SKILLS_ROOT)) {
    if (path === CURATOR_BACKUPS || path.startsWith(`${CURATOR_BACKUPS}/`)) {
      continue;
    }
    const content = await io.read(path);
    if (content === undefined) {
      continue;
    }
    await io.write(`${dest}/${relUnder(path, SKILLS_ROOT)}`, content);
    fileCount += 1;
  }
  await pruneBackups(io, keep);
  return { id, fileCount };
}

export async function listBackups(io: SkillIo): Promise<readonly string[]> {
  const ids = new Set<string>();
  for (const path of await io.listAll(CURATOR_BACKUPS)) {
    const id = relUnder(path, CURATOR_BACKUPS).split("/")[0];
    if (id) {
      ids.add(id);
    }
  }
  return [...ids].sort();
}

/** Keep the newest `keep` backups; remove older ones. */
export async function pruneBackups(io: SkillIo, keep: number): Promise<void> {
  const ids = await listBackups(io);
  const excess = ids.length - Math.max(1, keep);
  for (let i = 0; i < excess; i++) {
    await io.remove(`${CURATOR_BACKUPS}/${ids[i]}`);
  }
}

/** Restore the skill library from a backup. Takes a safety snapshot of the current state first. */
export async function rollbackSkills(io: SkillIo, id: string, nowMs: number, keep: number): Promise<{ readonly ok: boolean; readonly restored: number; readonly message: string }> {
  const backupDir = `${CURATOR_BACKUPS}/${id}`;
  const files = await io.listAll(backupDir);
  if (files.length === 0) {
    return { ok: false, restored: 0, message: `No backup '${id}'.` };
  }
  // Safety snapshot so the rollback itself is undoable.
  await snapshotSkills(io, nowMs, keep);
  // Clear the current library (except the backups directory), then restore.
  for (const path of await io.listAll(SKILLS_ROOT)) {
    if (path === CURATOR_BACKUPS || path.startsWith(`${CURATOR_BACKUPS}/`)) {
      continue;
    }
    await io.remove(path);
  }
  let restored = 0;
  for (const path of files) {
    const content = await io.read(path);
    if (content === undefined) {
      continue;
    }
    await io.write(`${SKILLS_ROOT}/${relUnder(path, backupDir)}`, content);
    restored += 1;
  }
  return { ok: true, restored, message: `Restored ${restored} file(s) from backup ${id}.` };
}
