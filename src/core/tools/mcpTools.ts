import type { CodeForgeTool } from "../toolRegistry";
import { isRecord } from "../guards";
import { invalidToolType, isSafeMcpName, optionalString } from "../toolValidation";

export const mcpTools: readonly CodeForgeTool[] = [
  {
    name: "mcp_list_resources",
    description: "List resources from explicitly configured MCP servers.",
    searchHint: "list mcp resources",
    risk: "service",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        reason: { type: "string" }
      },
      additionalProperties: false
    },
    parse(input) {
      return { type: "mcp_list_resources", serverId: optionalString(input.serverId), reason: optionalString(input.reason) };
    },
    validate(action) {
      if (action.type !== "mcp_list_resources") {
        return invalidToolType(action, "mcp_list_resources");
      }
      return action.serverId && !isSafeMcpName(action.serverId)
        ? { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." }
        : { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_list_resources" ? `List MCP resources${action.serverId ? ` on ${action.serverId}` : ""}` : "List MCP resources";
    }
  },
  {
    name: "mcp_read_resource",
    description: "Read a resource from an explicitly configured MCP server.",
    searchHint: "read mcp resource",
    risk: "service",
    concurrencySafe: true,
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        uri: { type: "string" },
        reason: { type: "string" }
      },
      required: ["serverId", "uri"],
      additionalProperties: false
    },
    parse(input) {
      return typeof input.serverId === "string" && typeof input.uri === "string"
        ? { type: "mcp_read_resource", serverId: input.serverId, uri: input.uri, reason: optionalString(input.reason) }
        : undefined;
    },
    validate(action) {
      if (action.type !== "mcp_read_resource") {
        return invalidToolType(action, "mcp_read_resource");
      }
      if (!isSafeMcpName(action.serverId)) {
        return { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." };
      }
      if (!action.uri.trim() || action.uri.includes("\0") || action.uri.length > 4000) {
        return { ok: false, message: "MCP resource URI is invalid." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_read_resource" ? `Read MCP resource ${action.serverId}:${action.uri}` : "Read MCP resource";
    }
  },
  {
    name: "mcp_call_tool",
    description: "Call a tool on an explicitly configured MCP server after permission approval.",
    searchHint: "call mcp tool",
    risk: "command",
    concurrencySafe: false,
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        serverId: { type: "string" },
        toolName: { type: "string" },
        arguments: { type: "object" },
        reason: { type: "string" }
      },
      required: ["serverId", "toolName"],
      additionalProperties: false
    },
    parse(input) {
      const args = input.arguments;
      return typeof input.serverId === "string" && typeof input.toolName === "string"
        ? {
          type: "mcp_call_tool",
          serverId: input.serverId,
          toolName: input.toolName,
          arguments: args === undefined ? undefined : isRecord(args) ? args : undefined,
          reason: optionalString(input.reason)
        }
        : undefined;
    },
    validate(action) {
      if (action.type !== "mcp_call_tool") {
        return invalidToolType(action, "mcp_call_tool");
      }
      if (!isSafeMcpName(action.serverId)) {
        return { ok: false, message: "MCP serverId must contain only letters, numbers, dots, underscores, or dashes." };
      }
      if (!isSafeMcpName(action.toolName)) {
        return { ok: false, message: "MCP toolName must contain only letters, numbers, dots, slashes, underscores, or dashes." };
      }
      return { ok: true };
    },
    summarize(action) {
      return action.type === "mcp_call_tool" ? `Call MCP ${action.serverId}/${action.toolName}` : "Call MCP tool";
    }
  }
];
