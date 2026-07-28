/**
 * Wave Compute MCP — Railway SSE Bridge v5.2.0
 * (Multi-User + Rotating JWT Tokens + Backend Handshake)
 * 
 * CHANGES FROM v5.1.0:
 * - Forward raw JWT to backend when credential field present (enables backend handshake)
 * - Surface empty tools/list as diagnostic error instead of silently returning []
 * - Add /diagnose endpoint for debugging auth chain
 * - Log backend response status codes for all forwarded calls
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
const VERSION = "5.2.0";

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

function isJwt(token) {
  if (!token || typeof token !== "string") return false;
  return token.startsWith("ey") && token.split(".").length === 3;
}

function verifyJwt(token) {
  if (!JWT_SECRET) {
    console.warn("JWT_SECRET not configured — cannot verify JWT tokens");
    return null;
  }

  const parts = token.split(".");
  if (parts.length !== 3) return null;

  const [headerB64, payloadB64, sig] = parts;
  const data = `${headerB64}.${payloadB64}`;

  const expectedSig = crypto
    .createHmac("sha256", JWT_SECRET)
    .update(data)
    .digest("base64url");

  if (sig !== expectedSig) {
    console.warn("JWT signature verification failed");
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
  } catch {
    console.warn("JWT payload parse failed");
    return null;
  }

  if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) {
    console.warn(`JWT expired (exp: ${payload.exp}, now: ${Math.floor(Date.now() / 1000)})`);
    return null;
  }

  return payload;
}

/**
 * Resolve a raw token string to the actual auth token for backend forwarding.
 * 
 * v5.2.0: If the JWT has a `credential` field (new handshake mode),
 * return the raw JWT itself — the backend will verify it using JWT_SECRET
 * and use base44.asServiceRole. No inner session token needed.
 * 
 * v5.1.0 compat: If the JWT has `token`/`authToken` (old mode), extract it.
 * Raw tokens pass through unchanged.
 */
function resolveToken(rawToken) {
  if (!rawToken) return null;

  if (isJwt(rawToken)) {
    if (!JWT_SECRET) {
      console.warn("Received JWT but JWT_SECRET not configured");
      return null;
    }
    const payload = verifyJwt(rawToken);
    if (!payload) return null;

    // v5.2.0: Credential-based handshake — forward the JWT itself
    if (payload.credential) {
      console.log("JWT has credential field — forwarding raw JWT to backend (handshake mode)");
      return rawToken; // Backend will verify JWT_SECRET + use asServiceRole
    }

    // v5.1.0 compat: Extract inner session token
    const innerToken = payload.token || payload.authToken;
    if (!innerToken) {
      console.warn("JWT valid but no inner token or credential in payload");
      return null;
    }
    return innerToken;
  }

  // Raw token — backward compatibility
  return rawToken;
}

function extractRawToken(req) {
  const authHeader = req.headers["authorization"];
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7).trim();
    if (token && token.length > 10) return token;
  }

  const waveHeader = req.headers["x-wave-token"];
  if (waveHeader && waveHeader.length > 10) return waveHeader;

  if (req.query && req.query.token && req.query.token.length > 10) {
    return req.query.token;
  }

  return ENV_TOKEN;
}

function extractUserToken(req) {
  const rawToken = extractRawToken(req);
  if (!rawToken) return null;
  if (rawToken === ENV_TOKEN) return ENV_TOKEN;
  return resolveToken(rawToken);
}

function getAuthHeaders(token) {
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
}

// ── Revocation list ──
const revokedJtis = new Set();
const sessionTokens = {};

// ── Eager tool cache ──
let cachedTools = null;

async function prefetchTools() {
  if (!ENV_TOKEN) {
    console.log("Public mode: no ENV_TOKEN — skipping startup prefetch");
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
    console.warn("Prefetch failed:", err.message);
  }
}

prefetchTools();

// ── Forward JSON-RPC to Base44 backend ──
async function forwardToBackend(method, params, id, token) {
  if (!token) {
    throw new Error(
      "No valid MCP token. Generate one at app.oswave.io → Settings → MCP Setup."
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

  console.log(`Backend ${method}: HTTP ${resp.status}`);

  if (resp.status === 401 || resp.status === 403) {
    throw new Error(
      `Auth failed (HTTP ${resp.status}). Token invalid or expired. Regenerate at app.oswave.io → Settings → MCP Setup.`
    );
  }

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Backend HTTP ${resp.status} for ${method}: ${body.slice(0, 200)}`);
  }

  const data = await resp.json();

  // v5.2.0: Surface backend errors explicitly
  if (data && data.error) {
    const msg = data.error.message || data.error.code || "Backend error";
    throw new Error(`Backend error: ${msg}`);
  }

  if (data && data.result) return data.result;

  // v5.2.0: If we get here, the backend returned something unexpected
  throw new Error(`Unexpected backend response for ${method}: ${JSON.stringify(data).slice(0, 200)}`);
}

// ── Fetch tools with empty-list diagnostic ──
async function fetchUserTools(token) {
  const result = await forwardToBackend("tools/list", {}, "tools-list", token);
  const tools = result?.tools || [];
  
  if (tools.length === 0) {
    console.warn("tools/list returned 0 tools — backend may not recognize this token");
    console.warn("Token type:", isJwt(token) ? "JWT (credential handshake)" : "raw token");
    console.warn("Backend URL:", MCP_BACKEND_URL);
  }
  
  return tools;
}

function isRevokedJwt(rawToken) {
  if (!isJwt(rawToken) || !JWT_SECRET) return false;
  const payload = verifyJwt(rawToken);
  if (!payload) return true;
  if (payload.jti && revokedJtis.has(payload.jti)) return true;
  return false;
}

// ── MCP Server factory ──
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

// GET /sse — legacy SSE
app.get("/sse", async (req, res) => {
  const rawToken = extractRawToken(req);

  if (rawToken && rawToken !== ENV_TOKEN && isRevokedJwt(rawToken)) {
    res.status(401).json({
      jsonrpc: "2.0",
      error: {
        code: -32001,
        message: "Token revoked or expired. Generate a fresh one at app.oswave.io → Settings → MCP Setup.",
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
        message: "No valid MCP token. Use Authorization header, X-Wave-Token, or ?token=. Generate at app.oswave.io → Settings → MCP Setup.",
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

// POST /sse — StreamableHTTP
app.post("/sse", async (req, res) => {
  const body = req.body;
  const method = body.method;
  const id = body.id;

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

  // notifications/initialized — no token needed
  if (method === "notifications/initialized") {
    res.end();
    return;
  }

  // Check revocation
  if (rawToken && rawToken !== ENV_TOKEN && isRevokedJwt(rawToken)) {
    sendEvent({
      jsonrpc: "2.0", id,
      error: { code: -32001, message: "Token revoked or expired. Regenerate at app.oswave.io → Settings → MCP Setup." },
    });
    res.end();
    return;
  }

  // Resolve auth token
  const userToken = rawToken ? (rawToken === ENV_TOKEN ? ENV_TOKEN : resolveToken(rawToken)) : null;

  if (!userToken) {
    sendEvent({
      jsonrpc: "2.0", id,
      error: { code: -32001, message: "No valid MCP token. Add it to mcp.json (Authorization header). Generate at app.oswave.io → Settings → MCP Setup." },
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
        // v5.2.0: Log empty results for debugging
        if (tools.length === 0) {
          console.warn(`⚠️  tools/list returned 0 tools — token may not be recognized by backend`);
          console.warn(`   Token type: ${isJwtToken ? "JWT" : "raw"}, Backend: ${MCP_BACKEND_URL}`);
        }
        result = { tools };
      }
    } else if (method === "tools/call") {
      result = await forwardToBackend("tools/call", body.params || {}, id, userToken);
    } else {
      sendEvent({
        jsonrpc: "2.0", id,
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
        jsonrpc: "2.0", id,
        error: { code: -32603, message: "Failed to list tools: " + err.message },
      });
    } else {
      sendEvent({
        jsonrpc: "2.0", id,
        result: {
          content: [{ type: "text", text: "Wave Compute error: " + err.message }],
          isError: true,
        },
      });
    }
  }

  res.end();
});

// POST /messages — legacy SSE session
app.post("/messages", async (req, res) => {
  const sessionId = req.query.sessionId;
  const transport = transports[sessionId];
  if (!transport) {
    res.status(400).json({ error: "No transport for session " + sessionId });
    return;
  }
  await transport.handlePostMessage(req, res);
});

// ── Token management ──

app.post("/revoke", (req, res) => {
  const { jti, secret } = req.body || {};
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

// GET /validate — validate a JWT
app.get("/validate", (req, res) => {
  const token = req.query.token;
  if (!token) {
    res.json({ valid: false, reason: "No token provided" });
    return;
  }
  if (!isJwt(token)) {
    res.json({ valid: true, type: "raw", note: "Raw token — no expiry validation" });
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
    sub: payload.sub || "n/a",
    hasCredential: !!payload.credential,
    hasInnerToken: !!(payload.token || payload.authToken),
    expiresAt: expDate,
    minutesRemaining: remaining,
  });
});

// GET /diagnose — v5.2.0 full auth chain diagnostic
app.get("/diagnose", async (req, res) => {
  const token = req.query.token;
  const diag = {
    proxy_version: VERSION,
    backend_url: MCP_BACKEND_URL,
    jwt_secret_configured: !!JWT_SECRET,
    env_token_configured: !!ENV_TOKEN,
    mode: ENV_TOKEN ? "dual" : "public",
    cached_tools: cachedTools?.length || 0,
    token: {},
    backend_test: {},
  };

  if (!token) {
    diag.token = { provided: false, message: "Pass ?token=xxx to test full auth chain" };
    res.json(diag);
    return;
  }

  // Step 1: Token analysis
  diag.token.provided = true;
  diag.token.is_jwt = isJwt(token);
  
  if (isJwt(token)) {
    const payload = verifyJwt(token);
    if (!payload) {
      diag.token.valid = false;
      diag.token.reason = "Invalid signature or expired";
      res.json(diag);
      return;
    }
    diag.token.valid = true;
    diag.token.jti = payload.jti;
    diag.token.sub = payload.sub;
    diag.token.has_credential = !!payload.credential;
    diag.token.has_inner_token = !!(payload.token || payload.authToken);
    diag.token.expires_at = payload.exp ? new Date(payload.exp * 1000).toISOString() : "never";
    diag.token.minutes_remaining = payload.exp ? Math.floor((payload.exp - Date.now() / 1000) / 60) : "∞";
    diag.token.revoked = payload.jti && revokedJtis.has(payload.jti);
  } else {
    diag.token.valid = true;
    diag.token.type = "raw";
  }

  // Step 2: Backend test
  const resolvedToken = resolveToken(token);
  diag.backend_test.resolved_token_type = isJwt(resolvedToken) ? "jwt-forwarded" : "raw-token";
  diag.backend_test.resolved_token_present = !!resolvedToken;

  if (resolvedToken) {
    try {
      const resp = await fetch(MCP_BACKEND_URL, {
        method: "POST",
        headers: getAuthHeaders(resolvedToken),
        body: JSON.stringify({ jsonrpc: "2.0", id: "diag", method: "tools/list", params: {} }),
      });
      diag.backend_test.http_status = resp.status;
      const data = await resp.json();
      diag.backend_test.tools_count = data?.result?.tools?.length || 0;
      diag.backend_test.error = data?.error?.message || null;
      diag.backend_test.success = resp.ok && !!data?.result;
    } catch (err) {
      diag.backend_test.error = err.message;
      diag.backend_test.success = false;
    }
  }

  res.json(diag);
});

// OPTIONS — CORS
app.options("*", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Wave-Token");
  res.sendStatus(200);
});

// ── Health & info ──
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
    diagnostic: "/diagnose?token=YOUR_TOKEN — test full auth chain",
  })
);

app.listen(PORT, () => {
  console.log(`Wave Compute MCP SSE bridge v${VERSION} running on port ${PORT}`);
  console.log(`Mode: ${ENV_TOKEN ? "DUAL" : "PUBLIC"}`);
  console.log(`JWT: ${JWT_SECRET ? "ENABLED" : "DISABLED"}`);
  console.log(`Backend: ${MCP_BACKEND_URL}`);
  if (!ENV_TOKEN) console.log("⚠️  No WAVE_API_TOKEN — per-user tokens required");
  if (!JWT_SECRET) console.log("⚠️  No JWT_SECRET — JWT validation disabled");
});
