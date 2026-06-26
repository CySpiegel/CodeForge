// Local models frequently truncate tool-call arguments mid-string (server-side max_tokens cutoff or a
// quiet-stream timeout). The raw, malformed `argumentsJson` is still recorded on the assistant turn so
// the parse failure surfaces to the model, but it must never be replayed verbatim: OpenAI-compatible
// backends (e.g. LiteLLM) `json.loads` the `arguments` string and reject the whole request with HTTP
// 400 "Unterminated string". Sanitize to valid JSON at the serialization boundary so every outbound
// request is well-formed regardless of how the tool call entered history.
export function sanitizeToolArgumentsJson(raw: string | undefined): string {
  const text = (raw ?? "").trim();
  if (!text) {
    return "{}";
  }
  if (isJsonObjectString(text)) {
    return text;
  }
  const repaired = repairTruncatedJsonObject(text);
  if (repaired && isJsonObjectString(repaired)) {
    return repaired;
  }
  return "{}";
}

// Inbound counterpart to sanitizeToolArgumentsJson: recover a freshly-received tool call's `arguments`
// before executing it. Per the OpenAI tool-calling spec the model-generated `arguments` string is not
// guaranteed to be valid JSON, and streamed local backends routinely truncate it mid-string. Try a
// strict parse, then the same best-effort repair used on the outbound path, and only report failure
// when the arguments cannot be recovered into a JSON object. Never throws.
export type ToolArgumentsParse =
  | { readonly ok: true; readonly value: Record<string, unknown> }
  | { readonly ok: false };

export function parseToolArguments(raw: string | undefined): ToolArgumentsParse {
  const text = (raw ?? "").trim();
  if (!text) {
    return { ok: true, value: {} };
  }
  const repaired = repairTruncatedJsonObject(text);
  for (const candidate of repaired ? [text, repaired] : [text]) {
    try {
      const parsed = JSON.parse(candidate);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        return { ok: true, value: parsed as Record<string, unknown> };
      }
    } catch {
      // Strict parse failed; fall through to the repaired candidate, then give up.
    }
  }
  return { ok: false };
}

function isJsonObjectString(text: string): boolean {
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed);
  } catch {
    return false;
  }
}

// Best-effort completion of a truncated JSON object: close an open string, drop a dangling escape or
// trailing separator, and balance the remaining brackets. Returns undefined when there is nothing to
// repair. Callers must re-validate the result; on failure they fall back to "{}".
function repairTruncatedJsonObject(text: string): string | undefined {
  const closers: string[] = [];
  let inString = false;
  let escaped = false;

  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === "\"") {
        inString = false;
      }
      continue;
    }
    if (ch === "\"") {
      inString = true;
    } else if (ch === "{") {
      closers.push("}");
    } else if (ch === "[") {
      closers.push("]");
    } else if (ch === "}" || ch === "]") {
      closers.pop();
    }
  }

  let result = escaped ? text.slice(0, -1) : text;
  if (inString) {
    result += "\"";
  }
  // A trailing object/array separator or dangling key (e.g. `{"a":1,` or `{"a":1,"b"`) cannot be
  // completed into a valid value, so trim it back to the last complete entry before balancing.
  result = result.replace(/,\s*$/, "").replace(/(:\s*|,\s*"[^"]*"\s*)$/, "");
  for (let i = closers.length - 1; i >= 0; i--) {
    result += closers[i];
  }
  return result === text ? undefined : result;
}
