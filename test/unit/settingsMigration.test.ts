import test from "node:test";
import assert from "node:assert/strict";
import { normalizeSettingsPermissionMode } from "../../src/core/settingsMigration";

test("normalizes legacy permission modes into phase 10 approval modes", () => {
  assert.equal(normalizeSettingsPermissionMode("manual"), "manual");
  assert.equal(normalizeSettingsPermissionMode("review"), "manual");
  assert.equal(normalizeSettingsPermissionMode("readOnly"), "manual");
  assert.equal(normalizeSettingsPermissionMode("smart"), "smart");
  assert.equal(normalizeSettingsPermissionMode("default"), "smart");
  assert.equal(normalizeSettingsPermissionMode("acceptEdits"), "smart");
  assert.equal(normalizeSettingsPermissionMode("fullAuto"), "fullAuto");
  assert.equal(normalizeSettingsPermissionMode("workspaceTrusted"), "fullAuto");
  assert.equal(normalizeSettingsPermissionMode("unknown"), "smart");
  assert.equal(normalizeSettingsPermissionMode(undefined), "smart");
});
