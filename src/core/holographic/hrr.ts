// Holographic Reduced Representations (HRR) — TS port of the math in Hermes
// `plugins/memory/holographic/holographic.py`, adapted to run without numpy.
//
// Phase vectors live on the unit circle: each dimension is an angle in [0, 2π). Binding is angle
// addition, unbinding is subtraction, bundling (superposition) is the circular mean, and similarity
// is the mean cosine of the angle difference. Atoms are deterministic from a word (SHA-256 seed →
// PRNG), so encodings are stable across runs. This gives compositional recall ("facts about X")
// without embeddings or a vector DB.

import { createHash } from "crypto";

const TWO_PI = Math.PI * 2;
export const HRR_DIM = 512;

function seedFor(word: string): number {
  const digest = createHash("sha256").update(word).digest();
  return (digest[0] | (digest[1] << 8) | (digest[2] << 16) | (digest[3] << 24)) >>> 0;
}

// Small deterministic PRNG (mulberry32) — one SHA-256 seed expands to HRR_DIM uniform phases.
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const atomCache = new Map<string, Float64Array>();

export function encodeAtom(word: string): Float64Array {
  const cached = atomCache.get(word);
  if (cached) {
    return cached;
  }
  const rng = mulberry32(seedFor(word));
  const vector = new Float64Array(HRR_DIM);
  for (let i = 0; i < HRR_DIM; i++) {
    vector[i] = rng() * TWO_PI;
  }
  atomCache.set(word, vector);
  return vector;
}

function mod2pi(value: number): number {
  const r = value % TWO_PI;
  return r < 0 ? r + TWO_PI : r;
}

export function bind(a: Float64Array, b: Float64Array): Float64Array {
  const out = new Float64Array(a.length);
  for (let i = 0; i < a.length; i++) {
    out[i] = mod2pi(a[i] + b[i]);
  }
  return out;
}

export function unbind(mem: Float64Array, key: Float64Array): Float64Array {
  const out = new Float64Array(mem.length);
  for (let i = 0; i < mem.length; i++) {
    out[i] = mod2pi(mem[i] - key[i]);
  }
  return out;
}

export function bundle(vectors: readonly Float64Array[]): Float64Array {
  const out = new Float64Array(HRR_DIM);
  if (vectors.length === 0) {
    return out;
  }
  for (let i = 0; i < HRR_DIM; i++) {
    let cx = 0;
    let cy = 0;
    for (const vector of vectors) {
      cx += Math.cos(vector[i]);
      cy += Math.sin(vector[i]);
    }
    out[i] = mod2pi(Math.atan2(cy, cx));
  }
  return out;
}

/** Mean cosine of the per-dimension angle difference. Range [-1, 1]; 1 for identical vectors. */
export function similarity(a: Float64Array, b: Float64Array): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += Math.cos(a[i] - b[i]);
  }
  return sum / a.length;
}

const TOKEN_RE = /[a-z0-9_]+/g;

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(TOKEN_RE) ?? []).filter((token) => token.length > 1);
}

export const ROLE_CONTENT = encodeAtom("__hrr_role_content__");
export const ROLE_ENTITY = encodeAtom("__hrr_role_entity__");

export function encodeText(text: string): Float64Array {
  const tokens = [...new Set(tokenize(text))];
  if (tokens.length === 0) {
    return new Float64Array(HRR_DIM);
  }
  return bundle(tokens.map(encodeAtom));
}

/** Structured fact encoding: bind content to a content role, each entity to an entity role, bundle. */
export function encodeFact(content: string, entities: readonly string[]): Float64Array {
  const parts: Float64Array[] = [bind(encodeText(content), ROLE_CONTENT)];
  for (const entity of entities) {
    parts.push(bind(encodeAtom(entity.toLowerCase()), ROLE_ENTITY));
  }
  return bundle(parts);
}

/** Role-bound probe key for an entity: bind(entity-atom, ROLE_ENTITY). Used by probe()/reason(). */
export function encodeEntityProbe(entity: string): Float64Array {
  return bind(encodeAtom(entity.toLowerCase()), ROLE_ENTITY);
}

// -- BLOB serialization for SQLite storage --------------------------------

export function phasesToBytes(vector: Float64Array): Uint8Array {
  return new Uint8Array(vector.buffer.slice(vector.byteOffset, vector.byteOffset + vector.byteLength));
}

export function bytesToPhases(bytes: Uint8Array): Float64Array {
  // Copy into a fresh, 8-byte-aligned buffer before viewing as Float64.
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return new Float64Array(copy.buffer);
}
