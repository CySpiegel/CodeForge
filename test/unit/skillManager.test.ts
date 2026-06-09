import test from "node:test";
import assert from "node:assert/strict";
import { SkillManager } from "../../src/core/skillManager";
import { SkillUsageTracker } from "../../src/core/skillUsage";
import { fakeSkillIo, FakeSkillIo } from "./helpers/fakeSkillIo";

function setup(initial: Record<string, string> = {}) {
  const io = fakeSkillIo(initial);
  const usage = new SkillUsageTracker(io, () => new Date(Date.UTC(2026, 0, 1)).toISOString());
  const manager = new SkillManager(io, usage);
  return { io, usage, manager };
}

const skillMd = (name: string) => `---\nname: ${name}\ndescription: Do the thing.\n---\n# ${name}\n\n1. Step one\n2. Step two\n`;

async function call(manager: SkillManager, args: Record<string, unknown>, markAgentCreated = false): Promise<Record<string, unknown>> {
  return JSON.parse(await manager.handleManage(args, { markAgentCreated }));
}

test("create writes SKILL.md and records provenance only for review-fork", async () => {
  const { io, usage, manager } = setup();
  const res = await call(manager, { action: "create", name: "add-a-tool", content: skillMd("add-a-tool") });
  assert.equal(res.success, true);
  assert.ok((io as FakeSkillIo).files.has(".codeforge/skills/add-a-tool/SKILL.md"));
  // Main-loop create is user-directed → not curator-eligible.
  assert.equal(await usage.isCurationEligible("add-a-tool"), false);

  const res2 = await call(manager, { action: "create", name: "from-review", content: skillMd("from-review") }, true);
  assert.equal(res2.success, true);
  assert.equal(await usage.isCurationEligible("from-review"), true);
});

test("create rejects bad frontmatter and duplicates", async () => {
  const { manager } = setup();
  const noDesc = await call(manager, { action: "create", name: "x", content: "---\nname: x\n---\nbody" });
  assert.equal(noDesc.success, false);
  assert.match(String(noDesc.error), /description/);

  await call(manager, { action: "create", name: "dup", content: skillMd("dup") });
  const again = await call(manager, { action: "create", name: "dup", content: skillMd("dup") });
  assert.equal(again.success, false);
  assert.match(String(again.error), /already exists/);
});

test("patch enforces unique match unless replace_all", async () => {
  const { manager } = setup();
  await call(manager, { action: "create", name: "p", content: "---\nname: p\ndescription: d\n---\nstep step done\n" });
  const ambiguous = await call(manager, { action: "patch", name: "p", old_string: "step", new_string: "X" });
  assert.equal(ambiguous.success, false);
  assert.match(String(ambiguous.error), /matches 2 places/);

  const all = await call(manager, { action: "patch", name: "p", old_string: "step", new_string: "X", replace_all: true });
  assert.equal(all.success, true);

  const unique = await call(manager, { action: "patch", name: "p", old_string: "done", new_string: "complete" });
  assert.equal(unique.success, true);
});

test("write_file restricts support files to allowed subdirs", async () => {
  const { io, manager } = setup();
  await call(manager, { action: "create", name: "s", content: skillMd("s") });
  const bad = await call(manager, { action: "write_file", name: "s", file_path: "secrets/x.md", file_content: "nope" });
  assert.equal(bad.success, false);
  const good = await call(manager, { action: "write_file", name: "s", file_path: "references/api.md", file_content: "# API" });
  assert.equal(good.success, true);
  assert.ok((io as FakeSkillIo).files.has(".codeforge/skills/s/references/api.md"));
});

test("delete archives the skill and refuses pinned skills", async () => {
  const { io, usage, manager } = setup();
  await call(manager, { action: "create", name: "old", content: skillMd("old") });

  await usage.setPinned("old", true);
  const refused = await call(manager, { action: "delete", name: "old" });
  assert.equal(refused.success, false);
  assert.match(String(refused.error), /pinned/);

  await usage.setPinned("old", false);
  const archived = await call(manager, { action: "delete", name: "old", absorbed_into: "umbrella" });
  assert.equal(archived.success, true);
  assert.equal(archived.archived, true);
  const files = (io as FakeSkillIo).files;
  assert.ok(!files.has(".codeforge/skills/old/SKILL.md"));
  assert.ok(files.has(".codeforge/skills/.archive/old/SKILL.md"));
  assert.equal((await usage.records()).old.state, "archived");
});

test("skill_view and skills_list read content and inventory", async () => {
  const { manager } = setup();
  await call(manager, { action: "create", name: "viewme", content: skillMd("viewme") });
  const view = JSON.parse(await manager.handleView({ name: "viewme" }));
  assert.equal(view.success, true);
  assert.match(String(view.content), /Step one/);

  const list = JSON.parse(await manager.handleList());
  assert.equal(list.success, true);
  assert.equal(list.count, 1);
  assert.deepEqual(list.skills, [{ name: "viewme", description: "Do the thing." }]);
});
