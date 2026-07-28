/**
 * Wave Compute MCP — Railway SSE Bridge v5.1.0 (Multi-User + Rotating JWT Tokens)
 * 
 * Supports both StreamableHTTP (POST /sse) and legacy SSE (GET /sse)
 * 
 * AUTH MODEL (dual-mode):
 * 1. Per-user JWT token: short-lived (4h) signed token from Settings → MCP Setup
 *    - Validates signature + expiry
 *    - Extracts inner auth token for backend forwarding
 *    - Revocable via /revoke endpoint
 * 2. Raw API token: backward compatibility with existing static tokens
 * 3. Env var fallback: uses WAVE_API_TOKEN if no per-request token is present (Eddie's private mode)
 * 
 * If WAVE_API_TOKEN is NOT set and no per-request token is provided → 401 with clear error
 */

import express from "express";
import crypto from "crypto";
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
const VERSION = "5.1.0";

// ── BACKEND URL ──
const STALE_URL = "https://oswave.io/api/functions/mcpRouter";
const CORRECT_URL = "https://app.oswave.io/api/functions/mcpRouter";
const MCP_BACKEND_URL =
  process.env.MCP_BACKEND_URL && process.env.MCP_BACKEND_URL !== STALE_URL
    ? process.env.MCP_BACKEND_URL
    : CORRECT_URL;

// ── AUTH ──
const ENV_TOKEN = process.env.WAVE_API_TOKEN || null;
const JWT_SECRET = process.env.JWT_SECRET || null;

// ── JWT FUNCTIONS ──

/**
 * Check if a token string looks like a JWT (starts with "ey" and has 3 base64url parts)
 */
function isJwt(token) {
  if (!token || typeof token !== "string") return false;
  return token.startsWith("ey") && token.split(".").length === 3;
}

/**
 * Verify a JWT signature and return the decoded payload, or null if invalid/expired.
 * Uses HMAC-SHA256 with JWT_SECRET.
 */
function verifyJwt(token) {
  if (!JWT_SECRET) {
    console.warn("JWT_SECRET not configured — cannot verify JWT tokens");
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sig] = parts;
  const data = `${headerB64}.${payloadB64}`;

  // Verify signature
  const expectedSig = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64url");

  if (sig !== expectedSig) {
    console.warn("JWT signature verification failed");
    return null;
  }

  // Parse payload
  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    console.warn("JWT payload parse failed");
    return null;
  }

  // Check expiry
  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    console.warn(`JWT expired (exp: ${payload.exp}, now: ${Math.floor(Date.now() / 1000)})`);
    return null;
  }

  return payload;
}

/**
 * Resolve a raw token string to the actual auth token for backend forwarding.
 * - If it's a valid JWT: extract the inner auth token from the payload
 * - If it's a raw token: return as-is (backward compatibility)
 * - If invalid/expired JWT: return null
 */
function resolveToken(rawToken) {
  if (!rawToken) return null;

  // Check if it's a JWT
  if (isJwt(rawToken)) {
    if (!JWT_SECRET) {
      console.warn("Received JWT but JWT_SECRET not configured");
      return null;
    }
    const payload = verifyJwt(rawToken);
    if (!payload) return null; // Invalid or expired

    // Extract the inner auth token from the JWT payload
    const innerToken = payload.token || payload.authToken;
    if (!innerToken) {
      console.warn("JWT valid but no inner token in payload");
      return null;
    }
    return innerToken;
  }

  // Raw token — backward compatibility with existing static API tokens
  return rawToken;
}

/**
 * Extract the user's raw token from the incoming request (before JWT resolution).
 * Priority: Authorization Bearer header > X-Wave-Token header > ?token= query param > env var
 */
function extractRawToken(req) {
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

/**
 * Full token extraction + JWT resolution.
 * Returns the actual auth token for backend forwarding, or null if no valid token.
 */
function extractUserToken(req) {
  const rawToken = extractRawToken(req);
  if (!rawToken) return null;

  // If it's the env token, return directly (no JWT resolution needed)
  if (rawToken === ENV_TOKEN) return ENV_TOKEN;

  // Resolve JWT → inner token, or pass through raw token
  return resolveToken(rawToken);
}

function getAuthHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Revocation list (in-memory, checked on connect) ──
// For persistent revocation, tokens also expire via JWT expiry (4h max)
const revokedJtis = new Set();

// ── Per-session token storage ──
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
      "No valid MCP token provided. Generate a fresh one at app.oswave.io → Settings → MCP Setup."
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
      `Authentication failed (HTTP ${resp.status}). Your MCP token may be invalid or expired. Generate a fresh one at app.oswave.io → Settings → MCP Setup.`
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

// ── Check if a raw token is a revoked JWT ──
function isRevokedJwt(rawToken) {
  if (!isJwt(rawToken) || !JWT_SECRET) return false;
  const payload = verifyJwt(rawToken);
  if (!payload) return true; // Invalid JWT = treat as revoked
  if (payload.jti && revokedJtis.has(payload.jti)) return true;
  return false;
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
app.get("/sse", async (req, res) => {
  const rawToken = extractRawToken(req);

  // Check revocation for JWTs
  if (rawToken && rawToken !== ENV_TOKEN && isRevokedJwt(rawToken)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Your MCP token has been revoked or expired. Generate a fresh one at app.oswave.io → Settings → MCP Setup.",
      },
    });
    return;
  }

  const userToken = extractUserToken(req);

  if (!userToken) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message:
          "No valid MCP token. Pass yours via Authorization header, X-Wave-Token header, or ?token= query param. Generate one at app.oswave.io → Settings → MCP Setup.",
      },
    });
    return;
  }

  const isEnvToken = userToken === ENV_TOKEN;
  const isJwtToken = rawToken && isJwt(rawToken);
  console.log(`SSE GET from ${req.ip} — auth: ${isEnvToken ? "env" : isJwtToken ? "jwt" : "raw"}`);

  const server = createMcpServer(isEnvToken ? null : userToken);
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
app.post("/sse", async (req, res) => {
  const body = req.body;
  const method = body.method;
  const id = body.id;

  // Extract raw token — check headers first, then body._waveToken
  let rawToken = extractRawToken(req);
  if (!rawToken && body._waveToken && body._waveToken.length > 10) {
    rawToken = body._waveToken;
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

  // Check revocation for JWTs
  if (rawToken && rawToken !== ENV_TOKEN && isRevokedJwt(rawToken)) {
    sendEvent({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message: "Your MCP token has been revoked or expired. Generate a fresh one at app.oswave.io → Settings → MCP Setup.",
      },
    });
    res.end();
    return;
  }

  // Resolve the actual auth token
  const userToken = rawToken ? (rawToken === ENV_TOKEN ? ENV_TOKEN : resolveToken(rawToken)) : null;

  if (!userToken) {
    sendEvent({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32001,
        message:
          "No valid MCP token. Add your token to the mcp.json config (Authorization header or env var). Generate one at app.oswave.io → Settings → MCP Setup.",
      },
    });
    res.end();
    return;
  }

  const isEnvToken = userToken === ENV_TOKEN;
  const isJwtToken = rawToken && isJwt(rawToken);

  console.log(`SSE POST from ${req.ip} method: ${method} — auth: ${isEnvToken ? "env" : isJwtToken ? "jwt" : "raw"}`);

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

// ── Token management endpoints ──

// POST /revoke — revoke a JWT by its jti
// Called by the Wave OS backend when a user clicks "Revoke" on the MCP Setup page
app.post("/revoke", (req, res) => {
  const { jti, secret } = req.body || {};

  // Simple shared-secret auth to prevent unauthorized revocation
  if (!secret || secret !== JWT_SECRET) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  if (!jti) {
    res.status(400).json({ error: "jti required" });
    return;
  }

  revokedJtis.add(jti);
  console.log(`Token revoked: jti=${jti}. Total revoked: ${revokedJtis.size}`);
  res.json({ ok: true, revoked: jti });
});

// POST /revoke-all — revoke all tokens (clears all jtis)
// Emergency revocation — invalidates ALL JWTs (forces all users to regenerate)
app.post("/revoke-all", (req, res) => {
  const { secret } = req.body || {};

  if (!secret || secret !== JWT_SECRET) {
    res.status(403).json({ error: "Unauthorized" });
    return;
  }

  const count = revokedJtis.size;
  revokedJtis.clear();
  console.log("All tokens revoked (emergency)");
  res.json({ ok: true, message: `Cleared ${count} revoked tokens` });
});

// GET /validate — validate a JWT token (for debugging)
app.get("/validate", (req, res) => {
  const token = req.query.token;
  if (!token) {
    res.json({ valid: false, reason: "No token provided" });
    return;
  }

  if (!isJwt(token)) {
    res.json({ valid: true, type: "raw", note: "Raw token (not JWT) — no expiry validation" });
    return;
  }

  const payload = verifyJwt(token);
  if (!payload) {
    res.json({ valid: false, type: "jwt", reason: "Invalid signature or expired" });
    return;
  }

  if (payload.jti && revokedJtis.has(payload.jti)) {
    res.json({ valid: false, type: "jwt", reason: "Token revoked" });
    return;
  }

  const expDate = payload.exp ? new Date(payload.exp * 1000).toISOString() : "never";
  const remaining = payload.exp ? Math.floor((payload.exp - Date.now() / 1000) / 60) : "∞";
  res.json({
    valid: true,
    type: "jwt",
    jti: payload.jti,
    expiresAt: expDate,
    minutesRemaining: remaining,
  });
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
    jwt: JWT_SECRET ? "enabled" : "disabled",
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
    jwtSupport: JWT_SECRET ? "enabled (4h rotating tokens)" : "disabled",
    tools: cachedTools?.length || 0,
    sessions: Object.keys(transports).length,
  })
);

app.listen(PORT, () => {
  console.log(`Wave Compute MCP SSE bridge v${VERSION} running on port ${PORT}`);
  console.log(`Mode: ${ENV_TOKEN ? "DUAL (env fallback + per-user tokens)" : "PUBLIC (per-user tokens only)"}`);
  console.log(`JWT: ${JWT_SECRET ? "ENABLED (4h rotating tokens)" : "DISABLED"}`);
  console.log(`Backend: ${MCP_BACKEND_URL}`);
  if (!ENV_TOKEN) {
    console.log("⚠️  No WAVE_API_TOKEN env var — all requests require per-user token");
  }
  if (!JWT_SECRET) {
    console.log("⚠️  No JWT_SECRET env var — JWT token validation disabled (raw tokens only)");
  }
});
