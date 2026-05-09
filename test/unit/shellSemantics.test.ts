import test from "node:test";
import assert from "node:assert/strict";
import { classifyShellCommand } from "../../src/core/shellSemantics";

test("classifies read and search shell commands", () => {
  assert.deepEqual(
    pick(classifyShellCommand("rg AgentController src | head -20")),
    { isSearch: true, isRead: true, isList: false, isReadOnly: true, isDestructive: false }
  );
  assert.deepEqual(
    pick(classifyShellCommand("ls src && wc -l src/core/types.ts")),
    { isSearch: false, isRead: true, isList: true, isReadOnly: true, isDestructive: false }
  );
});

test("treats redirects and destructive commands as side effects", () => {
  assert.equal(classifyShellCommand("cat README.md > copy.txt").isReadOnly, false);
  assert.equal(classifyShellCommand("rm -rf dist").isDestructive, true);
  assert.equal(classifyShellCommand("git reset --hard HEAD").isDestructive, true);
});

test("detects background, network, and dynamic shell expansion", () => {
  assert.equal(classifyShellCommand("npm test &").usesBackgroundExecution, true);
  assert.equal(classifyShellCommand("curl http://127.0.0.1:4000/v1/models").usesNetwork, true);
  assert.equal(classifyShellCommand("cat $(pwd)/README.md").usesShellExpansion, true);
  assert.equal(classifyShellCommand("cat $(pwd)/README.md").isReadOnly, false);
});

function pick(value: ReturnType<typeof classifyShellCommand>): Pick<ReturnType<typeof classifyShellCommand>, "isSearch" | "isRead" | "isList" | "isReadOnly" | "isDestructive"> {
  return {
    isSearch: value.isSearch,
    isRead: value.isRead,
    isList: value.isList,
    isReadOnly: value.isReadOnly,
    isDestructive: value.isDestructive
  };
}
