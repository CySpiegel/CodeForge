// Shared type guards + error helper used across every layer (core / adapters / agent / ui). Lives in
// core so all layers can import it without violating the ports-and-adapters direction. Consolidates the
// ~16 previously-duplicated copies of isRecord / isObject / errorMessage — one of which (the model
// discovery isRecord) had drifted to accept arrays. One implementation now, so they can never diverge.

// True for non-null, non-array objects. (isObject is the same guard under a different historical name —
// import it as `{ isRecord as isObject }` rather than reintroducing a second copy.)
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Extract a human-readable message from any thrown value.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
