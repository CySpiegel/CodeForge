import { isRecord as isObject } from "../guards";
import { McpCallToolAction } from "../types";
import type { McpResourceSummary, McpToolSummary } from "./types";
import { safeJson, truncate } from "./util";

// Parse + format MCP protocol payloads: tools/resources listings into typed summaries, and
// tools/call / resources/read results into the bounded text the model sees.

export function parseMcpTools(result: unknown): readonly McpToolSummary[] {
  if (!isObject(result) || !Array.isArray(result.tools)) {
    return [];
  }
  return result.tools
    .map((tool): McpToolSummary | undefined => {
      if (!isObject(tool) || typeof tool.name !== "string" || !tool.name.trim()) {
        return undefined;
      }
      return {
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : undefined,
        inputSchema: tool.inputSchema
      };
    })
    .filter((tool): tool is McpToolSummary => Boolean(tool));
}

export function parseMcpResources(result: unknown): readonly McpResourceSummary[] {
  if (!isObject(result) || !Array.isArray(result.resources)) {
    return [];
  }
  return result.resources
    .map((resource): McpResourceSummary | undefined => {
      if (!isObject(resource) || typeof resource.uri !== "string" || !resource.uri.trim()) {
        return undefined;
      }
      return {
        uri: resource.uri,
        name: typeof resource.name === "string" ? resource.name : undefined,
        description: typeof resource.description === "string" ? resource.description : undefined,
        mimeType: typeof resource.mimeType === "string" ? resource.mimeType : undefined
      };
    })
    .filter((resource): resource is McpResourceSummary => Boolean(resource));
}

export function formatMcpResult(result: unknown): string {
  if (isObject(result) && Array.isArray(result.content)) {
    const text = result.content
      .map((item) => isObject(item) && item.type === "text" && typeof item.text === "string" ? item.text : safeJson(item))
      .join("\n");
    return truncate(text || safeJson(result), 50000);
  }
  return truncate(safeJson(result), 50000);
}

export function formatMcpResourceContents(result: unknown): string {
  if (!isObject(result) || !Array.isArray(result.contents)) {
    return truncate(safeJson(result), 50000);
  }

  const parts = result.contents.map((item): string => {
    if (!isObject(item)) {
      return safeJson(item);
    }
    const uri = typeof item.uri === "string" ? item.uri : undefined;
    const mime = typeof item.mimeType === "string" ? item.mimeType : undefined;
    const header = [uri, mime].filter(Boolean).join(" | ");
    if (typeof item.text === "string") {
      return `${header ? `${header}\n` : ""}${item.text}`;
    }
    if (typeof item.blob === "string") {
      return `${header ? `${header}\n` : ""}[Binary MCP resource omitted: ${item.blob.length} base64 characters]`;
    }
    return safeJson(item);
  });
  return truncate(parts.join("\n\n"), 50000);
}

export function mcpError(action: McpCallToolAction, message: string): string {
  return `mcp_call_tool ${action.serverId}/${action.toolName}\n\n<tool_use_error>Error: ${message}</tool_use_error>`;
}
