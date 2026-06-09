import test from "node:test";
import assert from "node:assert/strict";
import { bind, bundle, bytesToPhases, encodeAtom, encodeFact, encodeText, phasesToBytes, similarity, unbind } from "../../src/core/holographic/hrr";

test("encodeAtom is deterministic and self-similar", () => {
  const a = encodeAtom("alpha");
  const a2 = encodeAtom("alpha");
  assert.ok(Math.abs(similarity(a, a2) - 1) < 1e-9);
  assert.ok(similarity(a, encodeAtom("beta")) < 0.2);
});

test("bind/unbind is an exact inverse", () => {
  const a = encodeAtom("content-vector");
  const key = encodeAtom("role-key");
  const recovered = unbind(bind(a, key), key);
  assert.ok(similarity(recovered, a) > 0.999);
});

test("bundle keeps its components recoverable above noise", () => {
  const a = encodeAtom("authentication");
  const b = encodeAtom("database");
  const c = encodeAtom("kubernetes");
  const sup = bundle([a, b]);
  assert.ok(similarity(sup, a) > 0.2);
  assert.ok(similarity(sup, b) > 0.2);
  assert.ok(similarity(sup, a) > similarity(sup, c) + 0.1);
});

test("encodeText recall matches on shared tokens", () => {
  const docVec = encodeText("the build uses esbuild and runs tests with node");
  const close = encodeText("esbuild build tests");
  const far = encodeText("kubernetes ingress controller");
  assert.ok(similarity(docVec, close) > similarity(docVec, far));
});

test("encodeFact is deterministic for the same content and entities", () => {
  const a = encodeFact("Prefer esbuild for fast bundling", ["esbuild"]);
  const b = encodeFact("Prefer esbuild for fast bundling", ["esbuild"]);
  assert.ok(Math.abs(similarity(a, b) - 1) < 1e-9);
  assert.ok(similarity(a, encodeFact("Use webpack instead", ["webpack"])) < 0.6);
});

test("phase vectors round-trip through BLOB bytes", () => {
  const vector = encodeText("durable fact content with several tokens");
  const restored = bytesToPhases(phasesToBytes(vector));
  assert.equal(restored.length, vector.length);
  assert.ok(similarity(vector, restored) > 0.999999);
});
