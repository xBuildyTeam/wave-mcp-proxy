/**
 * Wave Compute MCP — Railway SSE Bridge v4.3.0
 * Supports both StreamableHTTP (POST /sse) and legacy SSE (GET /sse)
 */

import express from "express";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  InitializeRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const MCP_BACKEND_URL = process.env.MCP_BACKEND_URL ||
  "https://oswave.io/api/functions/mcpRouter";

// ── Forward JSON-RPC to Base44 backend ──
async function forwardToBackend(method, params, id) {
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(process.env.WAVE_API_TOKEN ? { "Authorization": "Bearer " + process.env.WAVE_API_TOKEN } : {}) },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: id || "rail-1",
        method,
        params: params || {},
      }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data && data.result) return data.result;
    if (data && data.error) throw new Error(data.error.message || "Backend error");
    throw new Error("No result in response");
  } catch (err) {
    return {
      content: [{ type: "text", text: "Wave Compute error: " + err.message }],
      isError: true,
    };
  }
}

// ── MCP Server factory ──
function createMcpServer() {
  const server = new Server(
    { name: "wave-compute", version: "4.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(InitializeRequestSchema, async (request) => ({
    protocolVersion: request.params.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "wave-compute", version: "4.3.0" },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return await forwardToBackend("tools/list", {});
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return await forwardToBackend("tools/call", { name, arguments: args || {} }, request.id);
  });

  return server;
}

// ── SSE sessions ──
const transports = {};

// GET /sse — legacy SSE connection (Cursor fallback)
app.get("/sse", async (req, res) => {
  console.log("SSE GET connection from", req.ip);
  const server = createMcpServer();
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => { delete transports[transport.sessionId]; });
  await server.connect(transport);
});

// POST /sse — StreamableHTTP single-endpoint (Cursor primary mode)
// Cursor POSTs JSON-RPC here and expects SSE response stream
app.post("/sse", async (req, res) => {
  console.log("SSE POST (StreamableHTTP) from", req.ip);
  // For StreamableHTTP, handle as a single request/response over SSE
  const body = req.body;

  // Set SSE headers
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sendEvent = (data) => {
    res.write("data: " + JSON.stringify(data) + "\n\n");
  };

  try {
    let result;
    const method = body.method;
    const id = body.id;

    if (method === "initialize") {
      result = {
        protocolVersion: body.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "wave-compute", version: "4.3.0" },
      };
    } else if (method === "tools/list") {
      result = await forwardToBackend("tools/list", body.params || {}, id);
    } else if (method === "tools/call") {
      result = await forwardToBackend("tools/call", body.params || {}, id);
    } else {
      result = { error: "Unknown method: " + method };
    }

    sendEvent({ jsonrpc: "2.0", id, result });
  } catch (err) {
    sendEvent({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: err.message } });
  }

  res.end();
});

// POST /messages — session-based messages for legacy SSE
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(400).json({ error: "No transport for session " + sessionId });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// OPTIONS — CORS preflight
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.sendStatus(200);
});

// Health
app.get("/health", (req, res) => res.json({ ok: true }));
app.get("/", (req, res) => res.json({
  status: "ok", service: "wave-compute-mcp", version: "4.3.0",
  backend: MCP_BACKEND_URL, sessions: Object.keys(transports).length,
}));

app.listen(PORT, () => {
  console.log("Wave Compute MCP SSE bridge v4.1.0 running on port " + PORT);
  console.log("SSE endpoint: http://localhost:" + PORT + "/sse");
  console.log("Backend: " + MCP_BACKEND_URL);
});
