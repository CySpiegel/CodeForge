import test from "node:test";
import assert from "node:assert/strict";
import { formatDoctorReport, worstDoctorStatus } from "../../src/core/doctor";

test("doctor report groups checks and surfaces worst status", () => {
  const checks = [
    { category: "Endpoint", name: "Network policy", status: "pass" as const, detail: "localhost allowed." },
    { category: "Endpoint", name: "Native tool calls", status: "warn" as const, detail: "fallback enabled.", recommendation: "Enable native tools." },
    { category: "Repo Folder", name: "File discovery", status: "pass" as const, detail: "files found." }
  ];

  assert.equal(worstDoctorStatus(checks), "warn");
  const report = formatDoctorReport(checks);
  assert.match(report, /^CodeForge Doctor: WARN/);
  assert.match(report, /Endpoint\n\[pass\] Network policy: localhost allowed\./);
  assert.match(report, /Fix: Enable native tools\./);
  assert.match(report, /Repo Folder\n\[pass\] File discovery: files found\./);
});

test("doctor worst status fails when any check fails", () => {
  assert.equal(worstDoctorStatus([
    { category: "Endpoint", name: "A", status: "warn", detail: "warning" },
    { category: "Repo Folder", name: "B", status: "fail", detail: "failure" }
  ]), "fail");
});
