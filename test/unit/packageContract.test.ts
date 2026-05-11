import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { codeForgeTools } from "../../src/core/toolRegistry";

interface PackageJson {
  readonly bin?: unknown;
  readonly dependencies?: Record<string, unknown>;
  readonly activationEvents?: readonly string[];
  readonly contributes?: {
    readonly commands?: readonly { readonly command?: string; readonly title?: string; readonly category?: string }[];
    readonly views?: Record<string, readonly { readonly type?: string }[]>;
  };
  readonly scripts?: Record<string, string>;
}

test("extension package stays VS Code only and offline first", () => {
  const packageJson = readPackageJson();

  assert.equal(packageJson.bin, undefined);
  assert.deepEqual(packageJson.dependencies ?? {}, {});
  assert.ok(packageJson.activationEvents?.every((event) => !event.startsWith("onUri")), "extension should not expose URI/network activation");
  assert.ok(packageJson.contributes?.commands?.every((command) => command.command?.startsWith("codeforge.")), "commands should stay in the codeforge namespace");
  assert.ok(packageJson.contributes?.commands?.every((command) => !/cli/i.test(`${command.title ?? ""} ${command.category ?? ""}`)), "package should not advertise a CLI surface");
  assert.ok(packageJson.scripts?.package?.includes("vsce package --allow-missing-repository --no-dependencies"));
});

test("internal tool registry does not expose public web tools", () => {
  const forbiddenTools = new Set(["web_search", "fetch_url", "http_request", "browser_open"]);
  for (const tool of codeForgeTools) {
    assert.equal(forbiddenTools.has(tool.name), false, `${tool.name} should not be exposed`);
  }
});

function readPackageJson(): PackageJson {
  const root = path.resolve(__dirname, "../../..");
  return JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")) as PackageJson;
}
