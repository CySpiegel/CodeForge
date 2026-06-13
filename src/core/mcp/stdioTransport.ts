import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { createInterface, Interface as ReadlineInterface } from "readline";
import { McpServerConfig } from "../types";
import { isJsonRpcResponseArray, parseJsonRpc } from "./jsonRpc";
import type { JsonRpcRequest, JsonRpcResponse, McpTransport } from "./types";
import { mcpEnvironment, requestId, throwIfAborted, truncate, withoutUndefined } from "./util";

const defaultRequestTimeoutMs = 30_000;

// Stdio MCP transport: spawn the server as a child process (with a sanitized env), exchange newline-
// delimited JSON-RPC over stdin/stdout, correlate responses by id with per-request timeouts, and
// reject all pending requests if the process errors or exits.
export class StdioMcpTransport implements McpTransport {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly lines: ReadlineInterface;
  private readonly pending = new Map<string, {
    readonly resolve: (response: JsonRpcResponse) => void;
    readonly reject: (error: Error) => void;
    readonly timer: NodeJS.Timeout;
  }>();
  private stderr = "";
  private closed = false;

  private constructor(child: ChildProcessWithoutNullStreams) {
    this.child = child;
    this.lines = createInterface({ input: child.stdout });
    this.lines.on("line", (line) => this.handleLine(line));
    child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = truncate(`${this.stderr}${chunk.toString("utf8")}`, 4000);
    });
    child.on("error", (error) => this.rejectAll(error));
    child.on("close", (code, signal) => {
      if (!this.closed) {
        this.rejectAll(new Error(`MCP stdio server exited with ${code ?? signal ?? "unknown"}${this.stderr ? `: ${this.stderr.trim()}` : ""}`));
      }
    });
  }

  static start(server: McpServerConfig, signal?: AbortSignal): StdioMcpTransport {
    if (!server.command) {
      throw new Error("MCP stdio server requires a command.");
    }
    throwIfAborted(signal);
    const child = spawn(server.command, [...server.args ?? []], {
      cwd: server.cwd?.trim() || process.cwd(),
      windowsHide: true,
      env: mcpEnvironment(process.env)
    });
    const transport = new StdioMcpTransport(child);
    if (signal?.aborted) {
      transport.close();
      throw new Error("MCP stdio start was cancelled.");
    }
    signal?.addEventListener("abort", () => transport.close(), { once: true });
    return transport;
  }

  request(method: string, params?: unknown, signal?: AbortSignal): Promise<JsonRpcResponse> {
    const id = requestId();
    return new Promise<JsonRpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP stdio request ${method} timed out.`));
      }, defaultRequestTimeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.write({ jsonrpc: "2.0", id, method, params });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (signal?.aborted) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(new Error(`MCP stdio request ${method} was cancelled.`));
      }
    });
  }

  async notify(method: string, params?: unknown): Promise<void> {
    this.write({ jsonrpc: "2.0", method, params });
  }

  close(): void {
    this.closed = true;
    this.lines.close();
    this.rejectAll(new Error("MCP stdio transport closed."));
    if (!this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  private write(message: JsonRpcRequest): void {
    if (this.child.stdin.destroyed) {
      throw new Error("MCP stdio server stdin is closed.");
    }
    this.child.stdin.write(`${JSON.stringify(withoutUndefined(message))}\n`, "utf8");
  }

  private handleLine(line: string): void {
    const parsed = parseJsonRpc(line);
    if (isJsonRpcResponseArray(parsed)) {
      for (const item of parsed) {
        this.resolveResponse(item);
      }
      return;
    }
    this.resolveResponse(parsed);
  }

  private resolveResponse(response: JsonRpcResponse): void {
    if (response.id === undefined || response.id === null) {
      return;
    }
    const pending = this.pending.get(String(response.id));
    if (!pending) {
      return;
    }
    this.pending.delete(String(response.id));
    clearTimeout(pending.timer);
    pending.resolve(response);
  }

  private rejectAll(error: Error): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(error);
      this.pending.delete(id);
    }
  }
}
