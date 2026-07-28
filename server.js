/**
 * Wave Compute MCP — Railway SSE Bridge v5.0.0 (Multi-User)
 * 
 * Supports both StreamableHTTP (POST /sse) and legacy SSE (GET /sse)
 * 
 * AUTH MODEL (dual-mode):
 * 1. Per-user token: reads from Authorization header, X-Wave-Token header, or ?token= query param
 * 2. Env var fallback: uses WAVE_API_TOKEN if no per-request token is present (Eddie's private mode)
 * 
 * If WAVE_API_TOKEN is NOT set and no per-request token is provided → 401 with clear error
 * This allows deploying a "public" Railway service with no env token — forces per-user auth.
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
const VERSION = "5.0.0";

// ── BACKEND URL ──
const STALE_URL = "https://oswave.io/api/functions/mcpRouter";
const CORRECT_URL = "https://app.oswave.io/api/functions/mcpRouter";
const MCP_BACKEND_URL =
  process.env.MCP_BACKEND_URL && process.env.MCP_BACKEND_URL !== STALE_URL
    ? process.env.MCP_BACKEND_URL
    : CORRECT_URL;

// ── AUTH ──
// Env var token — Eddie's private mode. If not set, public mode (requires per-request token).
const ENV_TOKEN = process.env.WAVE_API_TOKEN || null;

/**
 * Extract the user's API token from the incoming request.
 * Priority: Authorization Bearer header > X-Wave-Token header > ?token= query param > env var
 * Returns null if no token found (public mode with no user token = reject).
 */
function extractUserToken(req) {
  // 1. Authorization: Bearer xxx
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token && token.length > 10) return token;
  }

  // 2. X-Wave-Token header
  const waveHeader = req.headers["x-wave-token"];
  if (waveHeader && waveHeader.length > 10) return waveHeader;

  // 3. ?token= query param
  if (req.query && req.query.token && req.query.token.length > 10) {
    return req.query.token;
  }

  // 4. Fallback to env var (Eddie's private mode)
  return ENV_TOKEN;
}

function getAuthHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Per-session token storage (for legacy SSE GET connections) ──
// When a user connects via GET /sse?token=xxx, we store the token for that session
const sessionTokens = {};

// ── Eager tool cache on startup (only works if ENV_TOKEN is set) ──
let cachedTools = null;

async function prefetchTools() {
  if (!ENV_TOKEN) {
    console.log("Public mode: no ENV_TOKEN — skipping startup prefetch (tools will load per-user)");
    return;
  }
  try {
    const resp = await fetch(MCP_BACKEND_URL, {
      method: "POST",
      headers: getAuthHeaders(ENV_TOKEN),
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "prefetch",
        method: "tools/list",
        params: {},
      }),
    });
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    const data = await resp.json();
    if (data && data.result && data.result.tools) {
      cachedTools = data.result.tools;
      console.log(`Prefetched ${cachedTools.length} tools on startup (env token)`);
    }
  } catch (err) {
    console.warn("Prefetch failed (will retry per-request):", err.message);
  }
}

prefetchTools();

// ── Forward JSON-RPC to Base44 backend (with per-user auth) ──
async function forwardToBackend(method, params, id, token) {
  if (!token) {
    throw new Error(
      "No Wave API token provided. Get yours at app.oswave.io → Settings → Developer, then add it to your Cursor MCP config."
    );
  }

  const resp = await fetch(MCP_BACKEND_URL, {
    method: "POST",
    headers: getAuthHeaders(token),
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: id || "rail-1",
      method,
      params: params || {},
    }),
  });

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      `Authentication failed (HTTP ${resp.status}). Your Wave API token may be invalid or expired. Get a fresh one at app.oswave.io → Settings → Developer.`
    );
  }

  if (!resp.ok) {
    throw new Error(`Backend returned HTTP ${resp.status} for ${method}`);
  }

  const data = await resp.json();

  if (data && data.result) return data.result;
  if (data && data.error) {
    const msg = data.error.message || data.error.code || "Backend error";
    throw new Error(msg);
  }

  throw new Error("No result or error in backend response");
}

// ── Fetch tools for a specific user ──
async function fetchUserTools(token) {
  const result = await forwardToBackend("tools/list", {}, "tools-list", token);
  return result?.tools || [];
}

// ── MCP Server factory (per-user) ──
function createMcpServer(userToken) {
  const server = new Server(
    { name: "wave-compute", version: VERSION },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(InitializeRequestSchema, async (request) => ({
    protocolVersion: request.params?.protocolVersion || "2024-11-05",
    capabilities: { tools: {} },
    serverInfo: { name: "wave-compute", version: VERSION },
  }));

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    // Use cached tools (env token mode) or fetch per-user
    if (cachedTools && !userToken) {
      return { tools: cachedTools };
    }
    if (userToken) {
      const tools = await fetchUserTools(userToken);
      return { tools };
    }
    return { tools: [] };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const result = await forwardToBackend(
      "tools/call",
      { name, arguments: args || {} },
      request.id,
      userToken
    );
    return result;
  });

  return server;
}

// ── SSE sessions ──
const transports = {};

// GET /sse — legacy SSE connection (Cursor fallback)
// Supports ?token=xxx for per-user auth
app.get("/sse", async (req, res) => {
  const userToken = extractUserToken(req);

  if (!userToken) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "No Wave API token. Pass yours via ?token=xxx query param, Authorization header, or X-Wave-Token header. Get one at app.oswave.io → Settings → Developer.",
      },
    });
    return;
  }

  console.log(`SSE GET connection from ${req.ip} — auth: ${userToken === ENV_TOKEN ? "env" : "user"}`);
  const server = createMcpServer(userToken === ENV_TOKEN ? null : userToken);
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  sessionTokens[transport.sessionId] = userToken;
  res.on("close", () => {
    delete transports[transport.sessionId];
    delete sessionTokens[transport.sessionId];
  });
  await server.connect(transport);
});

// POST /sse — StreamableHTTP single-endpoint (Cursor primary mode)
// Reads token from Authorization header or body._waveToken
app.post("/sse", async (req, res) => {
  const body = req.body;
  const method = body.method;
  const id = body.id;

  // Extract token — check headers first, then body._waveToken (for clients that embed it)
  let userToken = extractUserToken(req);
  if (!userToken && body._waveToken && body._waveToken.length > 10) {
    userToken = body._waveToken;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*");

  const sendEvent = (data) => {
    res.write("data: " + JSON.stringify(data) + "\n\n");
  };

  // For notifications/initialized — no token needed
  if (method === "notifications/initialized") {
    res.end();
    return;
  }

  // For all other methods, require a token
  if (!userToken) {
    sendEvent({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message:
          "No Wave API token. Add your token to the mcp.json config (env WAVE_API_TOKEN or Authorization header). Get one at app.oswave.io → Settings → Developer.",
      },
    });
    res.end();
    return;
  }

  const isEnvToken = userToken === ENV_TOKEN;
  const effectiveToken = isEnvToken ? null : userToken;

  console.log(`SSE POST from ${req.ip} method: ${method} — auth: ${isEnvToken ? "env" : "user"}`);

  try {
    let result;

    if (method === "initialize") {
      result = {
        protocolVersion: body.params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "wave-compute", version: VERSION },
      };
    } else if (method === "tools/list") {
      if (cachedTools && isEnvToken) {
        result = { tools: cachedTools };
      } else {
        const tools = await fetchUserTools(userToken);
        result = { tools };
      }
    } else if (method === "tools/call") {
      result = await forwardToBackend(
        "tools/call",
        body.params || {},
        id,
        userToken
      );
    } else {
      sendEvent({
        jsonrpc: "2.0",
        id,
        error: { code: -32601, message: "Unknown method: " + method },
      });
      res.end();
      return;
    }

    sendEvent({ jsonrpc: "2.0", id, result });
  } catch (err) {
    console.error(`Error handling ${method}:`, err.message);
    if (method === "tools/list") {
      sendEvent({
        jsonrpc: "2.0",
        id,
        error: { code: -32603, message: "Failed to list tools: " + err.message },
      });
    } else {
      sendEvent({
        jsonrpc: "2.0",
        id,
        result: {
          content: [{ type: "text", text: "Wave Compute error: " + err.message }],
          isError: true,
        },
      });
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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Wave-Token");
  res.sendStatus(200);
});

// ── Health & info endpoints ──
app.get("/health", (req, res) =>
  res.json({
    ok: true,
    version: VERSION,
    mode: ENV_TOKEN ? "dual" : "public",
    auth: ENV_TOKEN ? "env+user" : "user-only",
    tools: cachedTools?.length || 0,
  })
);

app.get("/", (req, res) =>
  res.json({
    status: "ok",
    service: "wave-compute-mcp",
    version: VERSION,
    backend: MCP_BACKEND_URL,
    mode: ENV_TOKEN ? "dual (env fallback + per-user)" : "public (per-user only)",
    tools: cachedTools?.length || 0,
    sessions: Object.keys(transports).length,
  })
);

app.listen(PORT, () => {
  console.log(`Wave Compute MCP SSE bridge v${VERSION} running on port ${PORT}`);
  console.log(`Mode: ${ENV_TOKEN ? "DUAL (env fallback + per-user tokens)" : "PUBLIC (per-user tokens only)"}`);
  console.log(`Backend: ${MCP_BACKEND_URL}`);
  if (!ENV_TOKEN) {
    console.log("⚠️  No WAVE_API_TOKEN env var — all requests require per-user token");
  }
});
