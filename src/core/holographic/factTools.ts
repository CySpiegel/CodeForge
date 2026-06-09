// Tool schemas for the holographic fact store, kept dependency-free (no sql.js) so the tool registry
// can import them without pulling in the SQLite runtime.

import { ToolDefinition } from "../types";

export const FACT_STORE_SCHEMA: ToolDefinition = {
  name: "fact_store",
  description:
    "Durable, searchable long-term memory (the holographic fact store). Actions: save (store a fact " +
    "with optional category/tags), search (hybrid text + structural recall), probe (facts ABOUT an " +
    "entity), related (facts touching an entity), reason (facts relating to ALL given entities), " +
    "contradict (find facts that disagree), delete, list. Facts persist across sessions and are " +
    "recalled automatically into future tasks.",
  parameters: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["save", "search", "probe", "related", "reason", "contradict", "delete", "list"] },
      content: { type: "string", description: "Fact text (save)." },
      category: { type: "string", description: "Optional category (save)." },
      tags: { type: "array", items: { type: "string" }, description: "Optional tags (save)." },
      query: { type: "string", description: "Search query (search)." },
      entity: { type: "string", description: "Entity name (probe/related)." },
      entities: { type: "array", items: { type: "string" }, description: "Entity names (reason)." },
      id: { type: "number", description: "Fact id (delete)." },
      limit: { type: "number", description: "Max results." }
    },
    required: ["action"]
  }
};

export const FACT_FEEDBACK_SCHEMA: ToolDefinition = {
  name: "fact_feedback",
  description: "Adjust a durable fact's trust score: helpful=true nudges it up, helpful=false nudges it down. Use after a recalled fact proved right or wrong.",
  parameters: {
    type: "object",
    properties: {
      id: { type: "number", description: "Fact id." },
      helpful: { type: "boolean", description: "Whether the fact was helpful/correct." }
    },
    required: ["id", "helpful"]
  }
};
