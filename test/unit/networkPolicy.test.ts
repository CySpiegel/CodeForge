import test from "node:test";
import assert from "node:assert/strict";
import { allowlistEntryForUrl, isUrlAllowed } from "../../src/core/networkPolicy";

test("allows localhost and private endpoint URLs by default", () => {
  assert.equal(isUrlAllowed("http://127.0.0.1:4000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://localhost:8000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://192.168.1.20:8000/v1", { allowlist: [] }).allowed, true);
  assert.equal(isUrlAllowed("http://10.10.0.5:8000/v1", { allowlist: [] }).allowed, true);
});

test("blocks unconfigured hosts and permits explicit on-prem hostnames", () => {
  assert.equal(isUrlAllowed("https://api.example.com/v1", { allowlist: [] }).allowed, false);
  assert.equal(isUrlAllowed("https://litellm.onprem.local/v1", { allowlist: ["litellm.onprem.local"] }).allowed, true);
  assert.equal(isUrlAllowed("https://vllm.onprem.local/v1", { allowlist: ["https://vllm.onprem.local"] }).allowed, true);
  assert.equal(isUrlAllowed("https://llm.internal.local/v1", { allowlist: ["*.internal.local"] }).allowed, true);
});

test("blocks unconfigured public IP destinations and permits explicit entries", () => {
  assert.equal(isUrlAllowed("https://203.0.113.10/v1", { allowlist: [] }).allowed, false);
  assert.equal(isUrlAllowed("https://203.0.113.10/v1", { allowlist: ["https://203.0.113.10"] }).allowed, true);
  assert.equal(isUrlAllowed("https://203.0.113.10/v1", { allowlist: ["203.0.113.0/24"] }).allowed, true);
});

test("creates allowlist entries for custom endpoint URLs", () => {
  assert.equal(allowlistEntryForUrl("https://llm.example.com/v1"), "https://llm.example.com");
  assert.equal(allowlistEntryForUrl("https://llm.example.com:8443/openai/v1"), "https://llm.example.com:8443");
  assert.equal(allowlistEntryForUrl("https://203.0.113.10/v1"), "https://203.0.113.10");
  assert.equal(allowlistEntryForUrl("http://127.0.0.1:1234/v1"), undefined);
});
