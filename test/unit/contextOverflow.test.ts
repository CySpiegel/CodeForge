import test from "node:test";
import assert from "node:assert/strict";
import { isContextOverflowError } from "../../src/agent/agentController";

test("isContextOverflowError detects common overflow phrasings", () => {
  const positives = [
    "Endpoint returned HTTP 400: This model's maximum context length is 4096 tokens. However, you requested 5000 tokens.",
    "context window exceeded",
    "The input exceeds the context length",
    "The prompt is too long",
    "Please reduce the length of the messages",
    "HTTP 413: too many tokens"
  ];
  for (const message of positives) {
    assert.equal(isContextOverflowError(new Error(message)), true, message);
  }
});

test("isContextOverflowError ignores unrelated errors", () => {
  const negatives = [
    "Endpoint returned HTTP 500: internal server error",
    "Endpoint is rate-limited (HTTP 429). Wait for the limit to reset.",
    "ECONNREFUSED 127.0.0.1:1234",
    "Model discovery failed at http://localhost/v1/models"
  ];
  for (const message of negatives) {
    assert.equal(isContextOverflowError(new Error(message)), false, message);
  }
});
