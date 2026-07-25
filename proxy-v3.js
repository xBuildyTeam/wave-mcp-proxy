/**
 * Wave Compute MCP Proxy v3 — Pure stdio forwarder
 * 
 * Responsibilities:
 * 1. Handle MCP initialize locally (never forward)
 * 2. Forward tools/list and tools/call to cloud mcpRouter
 * 
 * Zero secrets. Zero ports. Zero network servers.
 * Cursor manages this process via stdio — do NOT run manually.
 * 
 * mcp.json:
 * {
 *   "mcpServers": {
 *     "wave-compute": {
 *       "command": "node",
 *       "args": ["C:\\Users\\Eddie\\wave-mcp-proxy\\proxy-v3.js"],
 *       "env": {
 *         "MCP_BACKEND_URL": "https://app.base44.com/api/apps/6a6442fdfedd7c7980f4f40b/functions/mcpRouter"
 *       }
 *     }
 *   }
 * }
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

// ── Config ──
const MCP_BACKEND_URL = process.env.MCP_BACKEND_URL || "https://app.base44.com/api/apps/6a6442fdfedd7c7980f4f40b/functions/mcpRouter";

// ── Forward JSON-RPC to cloud mcpRouter ──
async function forwardToRouter(payload) {
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    if (!resp.ok) {
      throw new Error("mcpRouter HTTP " + resp.status);
    }

    return await resp.json();
  } catch (err) {
    return {
      jsonrpc: "2.0",
      id: payload.id,
      result: {
        content: [{ type: "text", text: "Wave Compute error: " + err.message }],
        isError: true,
      },
    };
  }
}

// ── MCP Server ──
const server = new Server(
  { name: "wave-compute", version: "3.0.0" },
  { capabilities: { tools: {} } }
);

// Handle initialize locally — never forward to backend
server.setRequestHandler(InitializeRequestSchema, async (request) => {
  return {
    protocolVersion: request.params.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "wave-compute", version: "3.0.0" },
  };
});

// Forward tools/list to mcpRouter
server.setRequestHandler(ListToolsRequestSchema, async (request) => {
  const result = await forwardToRouter({
    jsonrpc: "2.0",
    id: request.id || "list-1",
    method: "tools/list",
    params: {},
  });

  if (result && result.result && result.result.tools) {
    return { tools: result.result.tools };
  }
  return { tools: [] };
});

// Forward tools/call to mcpRouter
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  const result = await forwardToRouter({
    jsonrpc: "2.0",
    id: request.id || "call-1",
    method: "tools/call",
    params: { name, arguments: args || {} },
  });

  if (result && result.result) {
    return result.result;
  }

  return {
    content: [{ type: "text", text: "No response from mcpRouter" }],
    isError: true,
  };
});

// ── Start stdio transport ──
const transport = new StdioServerTransport();
await server.connect(transport);
