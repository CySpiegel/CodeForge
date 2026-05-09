import test from "node:test";
import assert from "node:assert/strict";
import { isUrlAllowed } from "../../src/core/networkPolicy";

test("allows localhost and private endpoint URLs by default", () => {
  assert.equal(isUrlAllowed("http://127.0.0.1:4000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://localhost:8000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://192.168.1.20:8000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://10.10.0.5:8000/v1", { allowlist: [] }).allowed, true);
});

test("blocks public hosts unless allowlisted", () => {
  assert.equal(isUrlAllowed("https://api.example.com/v1", { allowlist: [] }).allowed, false);
  assert.equal(isUrlAllowed("https://api.example.com/v1", { allowlist: ["api.example.com"] }).allowed, true);
  assert.equal(isUrlAllowed("https://api.example.com/v1", { allowlist: ["https://api.example.com"] }).allowed, true);
  assert.equal(isUrlAllowed("https://llm.internal.example.com/v1", { allowlist: ["*.internal.example.com"] }).allowed, true);
});

test("supports IPv4 CIDR allowlist entries", () => {
  assert.equal(isUrlAllowed("https://203.0.113.10/v1", { allowlist: ["203.0.113.0/24"] }).allowed, true);
  assert.equal(isUrlAllowed("https://203.0.114.10/v1", { allowlist: ["203.0.113.0/24"] }).allowed, false);
});
