import { SkillIo, SKILLS_ROOT } from "../../../src/core/skillIo";

export interface FakeSkillIo extends SkillIo {
  readonly files: Map<string, string>;
}

// In-memory SkillIo for tests. Models files as a flat path→content map; directories are implicit.
export function fakeSkillIo(initial: Record<string, string> = {}): FakeSkillIo {
  const files = new Map<string, string>(Object.entries(initial));
  const isUnder = (key: string, prefix: string): boolean => key === prefix || key.startsWith(`${prefix}/`);
  return {
    files,
    async read(relPath) {
      return files.get(relPath);
    },
    async write(relPath, content) {
      files.set(relPath, content);
    },
    async remove(relPath) {
      for (const key of [...files.keys()]) {
        if (isUnder(key, relPath)) {
          files.delete(key);
        }
      }
    },
    async move(fromRel, toRel) {
      for (const key of [...files.keys()]) {
        if (isUnder(key, fromRel)) {
          const content = files.get(key)!;
          files.set(toRel + key.slice(fromRel.length), content);
          files.delete(key);
        }
      }
    },
    async exists(relPath) {
      return files.has(relPath) || [...files.keys()].some((key) => key.startsWith(`${relPath}/`));
    },
    async listAll(relPath) {
      const prefix = relPath.replace(/\/+$/, "");
      return [...files.keys()].filter((key) => key === prefix || key.startsWith(`${prefix}/`));
    },
    async listSkillNames() {
      const names = new Set<string>();
      for (const key of files.keys()) {
        const dir = key.match(new RegExp(`^${SKILLS_ROOT}/([^/.][^/]*)/SKILL\\.md$`));
        if (dir) {
          names.add(dir[1]);
        }
        const flat = key.match(new RegExp(`^${SKILLS_ROOT}/([^/.][^/]*)\\.md$`));
        if (flat) {
          names.add(flat[1]);
        }
      }
      return [...names];
    }
  };
}
