import test from "node:test";
import assert from "node:assert/strict";
import { resolveProviderKind } from "../../src/core/providerKind";

test("api.anthropic.com and *.anthropic.com resolve to the Anthropic protocol", () => {
  assert.equal(resolveProviderKind("https://api.anthropic.com"), "anthropic");
  assert.equal(resolveProviderKind("https://api.anthropic.com/v1"), "anthropic");
  assert.equal(resolveProviderKind("https://anthropic.com"), "anthropic");
  assert.equal(resolveProviderKind("https://gateway.anthropic.com/proxy"), "anthropic");
  assert.equal(resolveProviderKind("  https://API.Anthropic.com  "), "anthropic");
});

test("a gateway whose base path ends in /anthropic resolves to the Messages API (e.g. AskSage)", () => {
  assert.equal(resolveProviderKind("https://api.asksage.ai/server/anthropic"), "anthropic");
  assert.equal(resolveProviderKind("https://api.asksage.ai/server/anthropic/"), "anthropic");
  assert.equal(resolveProviderKind("https://my-proxy.example.com/anthropic"), "anthropic");
});

test("a #anthropic fragment opts a same-origin local endpoint into the Messages API (e.g. LM Studio)", () => {
  assert.equal(resolveProviderKind("http://localhost:1234#anthropic"), "anthropic");
  assert.equal(resolveProviderKind("http://127.0.0.1:1234#anthropic"), "anthropic");
  // the same host WITHOUT the marker stays OpenAI (LM Studio's default OpenAI API)
  assert.equal(resolveProviderKind("http://localhost:1234"), "openai");
});

test("local and OpenAI-shaped endpoints resolve to the OpenAI protocol", () => {
  assert.equal(resolveProviderKind("http://127.0.0.1:1234"), "openai");
  assert.equal(resolveProviderKind("http://localhost:4000/v1"), "openai");
  assert.equal(resolveProviderKind("https://my-litellm.example.com"), "openai");
  // a look-alike host must not match
  assert.equal(resolveProviderKind("https://anthropic.com.evil.example"), "openai");
});

test("an unparseable base URL defaults to the OpenAI protocol", () => {
  assert.equal(resolveProviderKind("not a url"), "openai");
  assert.equal(resolveProviderKind(""), "openai");
});
