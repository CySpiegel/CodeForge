import { errorMessage } from "../guards";
import type { JsonRpcResponse } from "./types";
import { safeJson } from "./util";

// JSON-RPC 2.0 response handling shared by the MCP transports: tolerant parsing (single or batched),
// id matching across a batch, and result extraction that turns a protocol error into a thrown Error.

export function parseJsonRpc(text: string): JsonRpcResponse | readonly JsonRpcResponse[] {
  try {
    const parsed = JSON.parse(text) as JsonRpcResponse | readonly JsonRpcResponse[];
    if (Array.isArray(parsed)) {
      return parsed;
    }
    return parsed && typeof parsed === "object" ? parsed : { error: { message: "MCP response was not a JSON-RPC object." } };
  } catch (error) {
    return { error: { message: `MCP response was not valid JSON: ${errorMessage(error)}` } };
  }
}

export function responseWithId(parsed: JsonRpcResponse | readonly JsonRpcResponse[], id: string): JsonRpcResponse | undefined {
  if (isJsonRpcResponseArray(parsed)) {
    return parsed.find((item) => String(item.id) === id);
  }
  return String(parsed.id) === id ? parsed : undefined;
}

export function isJsonRpcResponseArray(value: JsonRpcResponse | readonly JsonRpcResponse[]): value is readonly JsonRpcResponse[] {
  return Array.isArray(value);
}

export function checkedResult(response: JsonRpcResponse): unknown {
  if (response.error) {
    const code = response.error.code === undefined ? "" : ` ${response.error.code}`;
    throw new Error(`MCP tool error${code}: ${response.error.message ?? "Unknown MCP error"}${response.error.data === undefined ? "" : `\n${safeJson(response.error.data)}`}`);
  }
  return response.result;
}
