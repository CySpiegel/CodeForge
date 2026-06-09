// Holographic retrieval — TS port of Hermes `plugins/memory/holographic/retrieval.py`.
//
// search(): hybrid keyword + Jaccard + HRR phase-cosine, trust-weighted. (Keyword stands in for the
// FTS5 component, which the prebuilt sql.js wasm lacks.) probe/related/reason/contradict are the
// distinctive compositional operations: they query by HRR algebraic structure, not just text.

import { encodeAtom, encodeEntityProbe, encodeText, similarity, tokenize } from "./hrr";
import { HolographicFact, HolographicStore } from "./store";

const FTS_WEIGHT = 0.4;
const JACCARD_WEIGHT = 0.3;
const HRR_WEIGHT = 0.3;

export interface FactHit {
  readonly fact: HolographicFact;
  readonly score: number;
}

export interface ContradictionPair {
  readonly a: HolographicFact;
  readonly b: HolographicFact;
  readonly score: number;
}

export class HolographicRetriever {
  constructor(private readonly store: HolographicStore) {}

  /** Hybrid text + structural similarity, weighted by trust. */
  search(query: string, limit = 5): FactHit[] {
    const queryTokens = new Set(tokenize(query));
    if (queryTokens.size === 0) {
      return [];
    }
    const queryVector = encodeText(query);
    return this.rank((fact, vector) => {
      const factTokens = new Set(tokenize(`${fact.content} ${fact.tags.join(" ")}`));
      const fts = keywordScore(queryTokens, factTokens);
      const jac = jaccard(queryTokens, factTokens);
      const hrr = vector ? (similarity(queryVector, vector) + 1) / 2 : 0;
      return (FTS_WEIGHT * fts + JACCARD_WEIGHT * jac + HRR_WEIGHT * hrr) * fact.trust;
    }, limit);
  }

  /** Facts ABOUT an entity — the entity bound to the entity role (compositional). */
  probe(entity: string, limit = 5): FactHit[] {
    const key = encodeEntityProbe(entity);
    return this.rank((_fact, vector) => (vector ? (similarity(key, vector) + 1) / 2 : 0), limit);
  }

  /** Facts related to an entity by its bare atom (also catches content-word matches). */
  related(entity: string, limit = 5): FactHit[] {
    const atom = encodeAtom(entity.toLowerCase());
    return this.rank((_fact, vector) => (vector ? (similarity(atom, vector) + 1) / 2 : 0), limit);
  }

  /** Facts that relate to ALL of the given entities (AND = min of per-entity scores). */
  reason(entities: readonly string[], limit = 5): FactHit[] {
    const keys = entities.map(encodeEntityProbe);
    if (keys.length === 0) {
      return [];
    }
    return this.rank((_fact, vector) => {
      if (!vector) {
        return 0;
      }
      let min = Infinity;
      for (const key of keys) {
        min = Math.min(min, (similarity(key, vector) + 1) / 2);
      }
      return min === Infinity ? 0 : min;
    }, limit);
  }

  /** Memory hygiene: pairs that share entities but disagree in content. */
  contradict(maxPairs = 20): ContradictionPair[] {
    const facts = this.store.list();
    if (facts.length > 500) {
      return []; // O(n^2) guard, matching Hermes
    }
    const out: ContradictionPair[] = [];
    for (let i = 0; i < facts.length; i++) {
      for (let j = i + 1; j < facts.length; j++) {
        const entitiesA = new Set(facts[i].entities.map((e) => e.toLowerCase()));
        const entitiesB = new Set(facts[j].entities.map((e) => e.toLowerCase()));
        const entityOverlap = jaccard(entitiesA, entitiesB);
        if (entityOverlap <= 0.3) {
          continue;
        }
        const va = this.store.vectorFor(facts[i].id);
        const vb = this.store.vectorFor(facts[j].id);
        const contentSim = va && vb ? (similarity(va, vb) + 1) / 2 : 1;
        const score = entityOverlap * (1 - contentSim);
        if (score > 0.1) {
          out.push({ a: facts[i], b: facts[j], score });
        }
      }
    }
    return out.sort((x, y) => y.score - x.score).slice(0, maxPairs);
  }

  private rank(scoreFn: (fact: HolographicFact, vector: Float64Array | undefined) => number, limit: number): FactHit[] {
    return this.store
      .list()
      .map((fact): FactHit => ({ fact, score: scoreFn(fact, this.store.vectorFor(fact.id)) }))
      .filter((hit) => hit.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }
}

function keywordScore(query: Set<string>, fact: Set<string>): number {
  if (query.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const token of query) {
    if (fact.has(token)) {
      shared += 1;
    }
  }
  return shared / query.size;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const token of a) {
    if (b.has(token)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
