// SQLite-backed holographic fact store — TS port of Hermes `plugins/memory/holographic/store.py`,
// using sql.js (wasm). Tables: facts (content UNIQUE, category, tags, trust, counters, timestamps,
// hrr_vector BLOB), entities, fact_entities (link), memory_banks (per-category HRR superposition).
// The prebuilt sql.js wasm has no FTS5, so the keyword component of retrieval is computed in TS
// (see retrieval.ts); the rest of the schema and the compositional HRR ops are faithful.

import { bundle, bytesToPhases, encodeFact, phasesToBytes } from "./hrr";
import { BinaryStore, Database, loadSqlJs } from "./sqlite";

export const TRUST_HELPFUL = 0.05;
export const TRUST_UNHELPFUL = -0.1;

export interface HolographicFact {
  id: number;
  content: string;
  category: string;
  tags: string[];
  trust: number;
  retrievalCount: number;
  helpfulCount: number;
  createdAt: number;
  updatedAt: number;
  entities: string[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  fact_id INTEGER PRIMARY KEY AUTOINCREMENT,
  content TEXT NOT NULL UNIQUE,
  category TEXT NOT NULL DEFAULT 'general',
  tags TEXT NOT NULL DEFAULT '',
  trust_score REAL NOT NULL DEFAULT 0.5,
  retrieval_count INTEGER NOT NULL DEFAULT 0,
  helpful_count INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  hrr_vector BLOB
);
CREATE TABLE IF NOT EXISTS entities (
  entity_id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL UNIQUE,
  entity_type TEXT NOT NULL DEFAULT 'general'
);
CREATE TABLE IF NOT EXISTS fact_entities (
  fact_id INTEGER NOT NULL,
  entity_id INTEGER NOT NULL,
  PRIMARY KEY (fact_id, entity_id)
);
CREATE TABLE IF NOT EXISTS memory_banks (
  bank_name TEXT PRIMARY KEY,
  vector BLOB NOT NULL,
  fact_count INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_facts_category ON facts(category);
CREATE INDEX IF NOT EXISTS idx_fact_entities_entity ON fact_entities(entity_id);
`;

export class HolographicStore {
  private db!: Database;
  private readonly vectors = new Map<number, Float64Array>();
  private loaded = false;

  constructor(private readonly persistence: BinaryStore, private readonly now: () => number = () => Date.now()) {}

  async load(): Promise<void> {
    if (this.loaded) {
      return;
    }
    const SQL = await loadSqlJs();
    const bytes = await this.persistence.load();
    this.db = bytes ? new SQL.Database(bytes) : new SQL.Database();
    this.db.run(SCHEMA);
    for (const row of this.query("SELECT fact_id, content, hrr_vector FROM facts")) {
      const blob = row.hrr_vector as Uint8Array | null;
      const id = Number(row.fact_id);
      this.vectors.set(id, blob ? bytesToPhases(blob) : encodeFact(String(row.content), this.entitiesOf(id)));
    }
    this.loaded = true;
  }

  get size(): number {
    return this.vectors.size;
  }

  vectorFor(id: number): Float64Array | undefined {
    return this.vectors.get(id);
  }

  list(): HolographicFact[] {
    return this.query("SELECT * FROM facts ORDER BY fact_id").map((row) => this.toFact(row));
  }

  getFact(id: number): HolographicFact | undefined {
    const rows = this.query("SELECT * FROM facts WHERE fact_id = ?", [id]);
    return rows.length ? this.toFact(rows[0]) : undefined;
  }

  bankVector(category: string): Float64Array | undefined {
    const rows = this.query("SELECT vector FROM memory_banks WHERE bank_name = ?", [`cat:${category}`]);
    return rows.length ? bytesToPhases(rows[0].vector as Uint8Array) : undefined;
  }

  async addFact(content: string, category = "general", tags: readonly string[] = []): Promise<HolographicFact | undefined> {
    const text = content.trim();
    if (!text) {
      return undefined;
    }
    const existing = this.query("SELECT fact_id FROM facts WHERE content = ?", [text]);
    if (existing.length) {
      return this.getFact(Number(existing[0].fact_id));
    }
    const entities = extractEntities(text);
    const vector = encodeFact(text, entities);
    const now = this.now();
    this.run(
      "INSERT INTO facts(content, category, tags, trust_score, retrieval_count, helpful_count, created_at, updated_at, hrr_vector) VALUES (?,?,?,?,0,0,?,?,?)",
      [text, category, tags.join(","), 0.5, now, now, phasesToBytes(vector)]
    );
    const factId = Number(this.scalar("SELECT last_insert_rowid()"));
    this.vectors.set(factId, vector);
    for (const entity of entities) {
      const name = entity.toLowerCase();
      this.run("INSERT OR IGNORE INTO entities(name) VALUES (?)", [name]);
      const entityId = Number(this.scalar("SELECT entity_id FROM entities WHERE name = ?", [name]));
      this.run("INSERT OR IGNORE INTO fact_entities(fact_id, entity_id) VALUES (?, ?)", [factId, entityId]);
    }
    this.rebuildBank(category);
    await this.persist();
    return this.getFact(factId);
  }

  async removeFact(id: number): Promise<boolean> {
    const fact = this.getFact(id);
    if (!fact) {
      return false;
    }
    this.run("DELETE FROM facts WHERE fact_id = ?", [id]);
    this.run("DELETE FROM fact_entities WHERE fact_id = ?", [id]);
    this.vectors.delete(id);
    this.rebuildBank(fact.category);
    await this.persist();
    return true;
  }

  async recordFeedback(id: number, helpful: boolean): Promise<boolean> {
    const fact = this.getFact(id);
    if (!fact) {
      return false;
    }
    const trust = clamp01(fact.trust + (helpful ? TRUST_HELPFUL : TRUST_UNHELPFUL));
    this.run("UPDATE facts SET trust_score = ?, helpful_count = helpful_count + ?, updated_at = ? WHERE fact_id = ?", [
      trust,
      helpful ? 1 : 0,
      this.now(),
      id
    ]);
    await this.persist();
    return true;
  }

  async noteRetrieved(ids: readonly number[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    for (const id of ids) {
      this.run("UPDATE facts SET retrieval_count = retrieval_count + 1 WHERE fact_id = ?", [id]);
    }
    await this.persist();
  }

  // -- internals ----------------------------------------------------------

  private entitiesOf(factId: number): string[] {
    return this.query(
      "SELECT e.name FROM entities e JOIN fact_entities fe ON fe.entity_id = e.entity_id WHERE fe.fact_id = ?",
      [factId]
    ).map((row) => String(row.name));
  }

  private rebuildBank(category: string): void {
    const ids = this.query("SELECT fact_id FROM facts WHERE category = ?", [category]).map((row) => Number(row.fact_id));
    const vecs = ids.map((id) => this.vectors.get(id)).filter((v): v is Float64Array => Boolean(v));
    if (vecs.length === 0) {
      this.run("DELETE FROM memory_banks WHERE bank_name = ?", [`cat:${category}`]);
      return;
    }
    this.run("INSERT OR REPLACE INTO memory_banks(bank_name, vector, fact_count, updated_at) VALUES (?,?,?,?)", [
      `cat:${category}`,
      phasesToBytes(bundle(vecs)),
      vecs.length,
      this.now()
    ]);
  }

  private toFact(row: Record<string, unknown>): HolographicFact {
    const id = Number(row.fact_id);
    return {
      id,
      content: String(row.content),
      category: String(row.category),
      tags: String(row.tags || "").split(",").map((t) => t.trim()).filter(Boolean),
      trust: Number(row.trust_score),
      retrievalCount: Number(row.retrieval_count),
      helpfulCount: Number(row.helpful_count),
      createdAt: Number(row.created_at),
      updatedAt: Number(row.updated_at),
      entities: this.entitiesOf(id)
    };
  }

  private async persist(): Promise<void> {
    await this.persistence.save(this.db.export());
  }

  private query(sql: string, params: unknown[] = []): Record<string, unknown>[] {
    const stmt = this.db.prepare(sql);
    try {
      stmt.bind(params as never[]);
      const rows: Record<string, unknown>[] = [];
      while (stmt.step()) {
        rows.push(stmt.getAsObject());
      }
      return rows;
    } finally {
      stmt.free();
    }
  }

  private run(sql: string, params: unknown[] = []): void {
    this.db.run(sql, params as never[]);
  }

  private scalar(sql: string, params: unknown[] = []): unknown {
    const rows = this.query(sql, params);
    return rows.length ? Object.values(rows[0])[0] : undefined;
  }
}

export function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

// Lightweight entity extraction: capitalized words/phrases and quoted terms.
export function extractEntities(text: string): string[] {
  const entities = new Set<string>();
  for (const match of text.matchAll(/\b([A-Z][a-zA-Z0-9]+(?:\s+[A-Z][a-zA-Z0-9]+)*)\b/g)) {
    entities.add(match[1].trim());
  }
  for (const match of text.matchAll(/["'`]([^"'`]{2,40})["'`]/g)) {
    entities.add(match[1].trim());
  }
  return [...entities].slice(0, 12);
}
