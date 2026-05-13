import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import type { McpCall, McpToolResult } from './notion.ts';

const CLIENT_NAME = 'forge';
const CLIENT_VERSION = '0.2.2';

export interface StdioMcpCallOptions {
  command: string;
  args?: readonly string[];
  env?: Record<string, string>;
  cwd?: string;
}

export interface StdioMcpHandle {
  call: McpCall;
  close: () => Promise<void>;
}

// Spawns the MCP server via stdio and returns a McpCall closure plus a close
// hook for lifecycle management. The connection is lazy: the server process is
// only spawned on the first call. Callers (orchestrator) own the handle and
// are responsible for invoking close() on shutdown.
//
// Failure semantics: if connect() fails or the underlying server dies, the
// next call() spawns a fresh server. Without this, withRetry would loop
// forever on a permanently-broken connection promise.
export function createStdioMcpCall(opts: StdioMcpCallOptions): StdioMcpHandle {
  let connected: Promise<Client> | undefined;

  const reset = (): void => {
    connected = undefined;
  };

  const connect = (): Promise<Client> => {
    if (connected !== undefined) return connected;
    const attempt = (async () => {
      const transport = new StdioClientTransport({
        command: opts.command,
        args: opts.args ? [...opts.args] : [],
        env: { ...process.env, ...(opts.env ?? {}) } as Record<string, string>,
        ...(opts.cwd !== undefined ? { cwd: opts.cwd } : {}),
        stderr: 'inherit',
      });
      const client = new Client(
        { name: CLIENT_NAME, version: CLIENT_VERSION },
        { capabilities: {} },
      );
      // Reset on either side of the lifecycle: if transport closes (server
      // died, parent killed it) or errors, drop the cached promise so the
      // next call respawns.
      transport.onclose = () => reset();
      transport.onerror = () => reset();
      await client.connect(transport);
      return client;
    })().catch((err) => {
      // Connect failed (e.g. ENOENT on the launch command, MCP handshake
      // error). Reset before re-throwing so retries spawn fresh.
      reset();
      throw err;
    });
    connected = attempt;
    return attempt;
  };

  const call: McpCall = async (toolName, args) => {
    const client = await connect();
    try {
      const result = await client.callTool({
        name: toolName,
        arguments: args,
      });
      return result as McpToolResult;
    } catch (err) {
      // Transport-level failures (process died mid-call) — let the next
      // call() spawn fresh. SDK throws McpError with negative code on these.
      if (isTransportLikeError(err)) reset();
      throw err;
    }
  };

  const close = async (): Promise<void> => {
    if (connected === undefined) return;
    const cached = connected;
    connected = undefined;
    try {
      const client = await cached;
      await client.close();
    } catch {
      // Swallow close errors — connection is already done.
    }
  };

  return { call, close };
}

function isTransportLikeError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const code = (err as { code?: number }).code;
  if (typeof code !== 'number') return false;
  // JSON-RPC: ConnectionClosed (-32000), RequestTimeout (-32001).
  return code === -32000 || code === -32001;
}
