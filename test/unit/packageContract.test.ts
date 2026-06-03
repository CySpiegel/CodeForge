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
    readonly configuration?: {
      readonly properties?: Record<string, { readonly type?: string; readonly default?: unknown; readonly enum?: readonly string[] }>;
    };
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

test("learning settings are declared in configuration with safe defaults", () => {
  const properties = readPackageJson().contributes?.configuration?.properties ?? {};
  const expected: Record<string, { type: string; default: unknown }> = {
    "codeforge.learning.enabled": { type: "boolean", default: true },
    "codeforge.learning.autonomy": { type: "string", default: "review" },
    "codeforge.learning.scope": { type: "string", default: "split" },
    "codeforge.learning.auditCadence": { type: "number", default: 15 },
    "codeforge.learning.maxLessons": { type: "number", default: 60 },
    "codeforge.learning.maxLessonBytes": { type: "number", default: 24000 },
    "codeforge.learning.skills.enabled": { type: "boolean", default: true },
    "codeforge.learning.skills.minRepeats": { type: "number", default: 3 },
    "codeforge.learning.embeddings.enabled": { type: "boolean", default: false }
  };
  for (const [key, spec] of Object.entries(expected)) {
    const property = properties[key];
    assert.ok(property, `${key} should be declared in package.json configuration`);
    assert.equal(property.type, spec.type, `${key} should be a ${spec.type}`);
    assert.equal(property.default, spec.default, `${key} default`);
  }
  assert.deepEqual(properties["codeforge.learning.autonomy"].enum, ["review", "hybrid", "auto"]);
  assert.deepEqual(properties["codeforge.learning.scope"].enum, ["split", "repo", "global"]);
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
