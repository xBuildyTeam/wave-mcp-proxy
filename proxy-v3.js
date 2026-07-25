/**
 * Wave Compute MCP Proxy v3 — Pure stdio forwarder with eager tool cache
 *
 * Handles initialize locally. Pre-fetches tool list on startup so Cursor
 * never races against a cold backend fetch.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const MCP_BACKEND_URL = process.env.MCP_BACKEND_URL ||
  "https://app.base44.com/api/apps/6a6442fdfedd7c7980f4f40b/functions/mcpRouter";

// ── Eager tool cache — populated before stdio opens ──
let cachedTools = [];

async function fetchTools() {
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: "startup", method: "tools/list", params: {} }),
    });
    if (!resp.ok) return;
    const data = await resp.json();
    if (data && data.result && Array.isArray(data.result.tools)) {
      cachedTools = data.result.tools;
    }
  } catch (_) {
    // silently ignore — will return empty list
  }
}

// ── Forward a tools/call to backend ──
async function forwardCall(name, args, reqId) {
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: reqId || "call-1",
        method: "tools/call",
        params: { name, arguments: args || {} },
      }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data && data.result) return data.result;
    throw new Error("No result in response");
  } catch (err) {
    return {
      content: [{ type: "text", text: "Wave Compute error: " + err.message }],
      isError: true,
    };
  }
}

// ── MCP Server ──
const server = new Server(
  { name: "wave-compute", version: "3.1.0" },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(InitializeRequestSchema, async (request) => {
  return {
    protocolVersion: request.params.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "wave-compute", version: "3.1.0" },
  };
});

server.setRequestHandler(ListToolsRequestSchema, async () => {
  // If cache is empty, try one more fetch (fallback for slow starts)
  if (cachedTools.length === 0) {
    await fetchTools();
  }
  return { tools: cachedTools };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  return await forwardCall(name, args, request.id);
});

// ── Startup: pre-fetch tools THEN open stdio ──
await fetchTools();
const transport = new StdioServerTransport();
await server.connect(transport);
