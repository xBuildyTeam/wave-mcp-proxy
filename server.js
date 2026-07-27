/**
 * Wave Compute MCP — Railway SSE Bridge v4.3.0
 * Supports both StreamableHTTP (POST /sse) and legacy SSE (GET /sse)
 * Auth: forwards WAVE_API_TOKEN as Bearer header to mcpRouter
 *
 * v4.3.0 changes:
 * - Hardcoded backend URL to app.oswave.io (overrides stale env var)
 * - Fixed tools/list error handling (returns proper JSON-RPC error, not content-wrapped)
 * - Added startup tool cache to prevent race condition with Cursor
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

// ── BACKEND URL ──
// Hardcode the correct URL. Ignore stale MCP_BACKEND_URL env var if it points to old domain.
const STALE_URL = "https://oswave.io/api/functions/mcpRouter";
const CORRECT_URL = "https://app.oswave.io/api/functions/mcpRouter";
const MCP_BACKEND_URL = (process.env.MCP_BACKEND_URL && process.env.MCP_BACKEND_URL !== STALE_URL)
  ? process.env.MCP_BACKEND_URL
  : CORRECT_URL;

// ── AUTH ──
const WAVE_API_TOKEN = process.env.WAVE_API_TOKEN;

if (!WAVE_API_TOKEN) {
  console.warn("WARNING: WAVE_API_TOKEN not set — tools/list will return empty and tools/call will be blocked.");
}

function getAuthHeaders() {
  const headers = { "Content-Type": "application/json" };
  if (WAVE_API_TOKEN) {
    headers["Authorization"] = "Bearer " + WAVE_API_TOKEN;
  }
  return headers;
}

// ── Eager tool cache on startup ──
let cachedTools = null;

async function prefetchTools() {
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: getAuthHeaders(),
      body: JSON.stringify({ jsonrpc: "2.0", id: "prefetch", method: "tools/list", params: {} }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data && data.result && data.result.tools) {
      cachedTools = data.result.tools;
      console.log("Prefetched " + cachedTools.length + " tools on startup");
    } else {
      console.warn("Prefetch: no tools in response:", JSON.stringify(data).slice(0, 200));
    }
  } catch (err) {
    console.warn("Prefetch failed (will retry on first request):", err.message);
  }
}

// Fire prefetch immediately
prefetchTools();

// ── Forward JSON-RPC to Base44 backend (with auth) ──
async function forwardToBackend(method, params, id) {
  const resp = await fetch(MCP_BACKEND_URL, {
    method: "POST",
    headers: getAuthHeaders(),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: id || "rail-1",
      method,
      params: params || {},
    }),
  });

  if (!resp.ok) {
    throw new Error("Backend returned HTTP " + resp.status + " for " + method);
  }

  const data = await resp.json();

  if (data && data.result) {
    return data.result;
  }
  if (data && data.error) {
    const msg = data.error.message || data.error.code || "Backend error";
    throw new Error(msg);
  }

  throw new Error("No result or error in backend response");
}

// ── MCP Server factory ──
function createMcpServer() {
  const server = new Server(
    { name: "wave-compute", version: "4.3.0" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(InitializeRequestSchema, async (request) => ({
    protocolVersion: request.params?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "wave-compute", version: "4.3.0" },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Return cached tools if available (prevents race with Cursor)
    if (cachedTools) {
      return { tools: cachedTools };
    }
    // Otherwise fetch from backend
    const result = await forwardToBackend("tools/list", {});
    if (result && result.tools) {
      cachedTools = result.tools;
      return { tools: result.tools };
    }
    // Fallback: return empty tools array (NOT content-wrapped error)
    return { tools: [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await forwardToBackend("tools/call", { name, arguments: args || {} }, request.id);
    return result;
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
app.post("/sse", async (req, res) => {
  console.log("SSE POST from", req.ip, "method:", req.body?.method);
  const body = req.body;

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
      // Return cached tools if available (prevents race with Cursor)
      if (cachedTools) {
        result = { tools: cachedTools };
      } else {
        // Fetch from backend
        const backendResult = await forwardToBackend("tools/list", body.params || {}, id);
        if (backendResult && backendResult.tools) {
          cachedTools = backendResult.tools;
          result = { tools: backendResult.tools };
        } else {
          // CRITICAL: return empty tools array, NOT content-wrapped error
          // Cursor expects result.tools to be an array
          result = { tools: [] };
        }
      }
    } else if (method === "tools/call") {
      result = await forwardToBackend("tools/call", body.params || {}, id);
    } else if (method === "notifications/initialized") {
      // Cursor sends this after initialize — just acknowledge
      res.end();
      return;
    } else {
      sendEvent({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method: " + method } });
      res.end();
      return;
    }

    sendEvent({ jsonrpc: "2.0", id, result });
  } catch (err) {
    console.error("Error handling", body?.method, ":", err.message);
    // For tools/list errors, return proper JSON-RPC error (not content-wrapped)
    if (body?.method === "tools/list") {
      sendEvent({ jsonrpc: "2.0", id: body.id, error: { code: -32603, message: "Failed to list tools: " + err.message } });
    } else {
      // For tools/call errors, return content-wrapped error (valid MCP response)
      sendEvent({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Wave Compute error: " + err.message }], isError: true } });
    }
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
app.get("/health", (req, res) => res.json({ ok: true, version: "4.3.0", auth: WAVE_API_TOKEN ? "enabled" : "disabled", tools: cachedTools?.length || 0 }));
app.get("/", (req, res) => res.json({
  status: "ok", service: "wave-compute-mcp", version: "4.3.0",
  backend: MCP_BACKEND_URL, auth: WAVE_API_TOKEN ? "enabled" : "disabled",
  tools: cachedTools?.length || 0,
  sessions: Object.keys(transports).length,
}));

app.listen(PORT, () => {
  console.log("Wave Compute MCP SSE bridge v4.3.0 running on port " + PORT);
  console.log("Auth: " + (WAVE_API_TOKEN ? "ENABLED" : "DISABLED — set WAVE_API_TOKEN!"));
  console.log("Backend: " + MCP_BACKEND_URL);
});
