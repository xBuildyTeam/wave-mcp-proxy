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

const WAVE_POOL_TARGET = "https://wave-pool.base44.app";
const WAVE_POOL_HOST = "dependable-energy-production.up.railway.app";

async function proxyToWavePool(req, res, { stripPrefix, rewrite, injectAuth }) {
  const targetPath = stripPrefix
    ? (req.originalUrl.replace(/^\/wave-pool/, "") || "/")
    : req.originalUrl;
  const targetUrl = WAVE_POOL_TARGET + targetPath;

  try {
    const headers = { ...req.headers };
    headers.host = "wave-pool.base44.app";
    headers.origin = WAVE_POOL_TARGET;
    delete headers["x-forwarded-for"];
    delete headers["x-forwarded-proto"];
    delete headers["x-forwarded-host"];

    const fetchOpts = { method: req.method, headers };
    if (req.method !== "GET" && req.method !== "HEAD") {
      fetchOpts.body = JSON.stringify(req.body);
    }

    const response = await fetch(targetUrl, fetchOpts);

    const responseHeaders = {};
    response.headers.forEach((value, key) => {
      if (!["x-frame-options", "content-security-policy", "content-security-policy-report-only", "content-encoding", "content-length", "transfer-encoding"].includes(key.toLowerCase())) {
        responseHeaders[key] = value;
      }
    });

    if (responseHeaders["set-cookie"]) {
      const cookies = Array.isArray(responseHeaders["set-cookie"])
        ? responseHeaders["set-cookie"]
        : [responseHeaders["set-cookie"]];
      responseHeaders["set-cookie"] = cookies.map(c =>
        c.replace(/;\s*Domain=[^;]+/gi, "").replace(/;\s*SameSite=[^;]*/gi, "; SameSite=None; Secure")
      );
    }

    res.status(response.status);
    for (const [key, value] of Object.entries(responseHeaders)) {
      res.setHeader(key, value);
    }

    const contentType = (responseHeaders["content-type"] || "").toLowerCase();
    let body = await response.arrayBuffer();

    if (rewrite && contentType.includes("text/html")) {
      let html = Buffer.from(body).toString("utf-8");
      html = html.replace(/<head>/i, '<head><base href="/wave-pool/">');
      html = html.replace(/(src|href|action)=(["'])(\/[^"']*["'])/gi, (match, attr, quote, path) => {
        if (path.startsWith("/wave-pool") || path.startsWith("//")) return match;
        return `${attr}=${quote}/wave-pool${path}`;
      });
      html = html.replace(/fetch\((["'])(\/[^"']*)["']/gi, 'fetch($1/wave-pool$2"');
      body = Buffer.from(html, "utf-8");
    } else if (rewrite && (contentType.includes("javascript") || contentType.includes("css"))) {
      let text = Buffer.from(body).toString("utf-8");
      text = text.replace(/(["'])(\/assets\/[^"']*)["']/gi, '$1/wave-pool$2"');
      text = text.replace(/(["'])(\/api\/[^"']*)["']/gi, '$1/wave-pool$2"');
      text = text.replace(/url\((["']?)(\/[^"')]*["')]?\))/gi, 'url($1/wave-pool$2');
      body = Buffer.from(text, "utf-8");
    }

    if (injectAuth && contentType.includes("text/html")) {
      let html = Buffer.from(body).toString("utf-8");
      const AUTH_BRIDGE = '<script>' +
        '(function(){' +
        // Phase 1: Try to use token from postMessage (works if cross-app auth is enabled)
        'window.addEventListener("message",function(e){' +
        'if(e.data&&e.data.type==="WAVE_OS_AUTH"&&e.data.token){' +
        'try{localStorage.setItem("base44_access_token",e.data.token);}catch(err){}' +
        // Don't store appId — let Wave Pool use its own default
        'window.location.reload();' +
        '}' +
        // Phase 2: If email is provided, pre-fill the login form
        'if(e.data&&e.data.type==="WAVE_OS_AUTH"&&e.data.email&&!e.data.token){' +
        'function fillEmail(){var el=document.querySelector("input[type=email],input[name=email],input[placeholder*=email i]");' +
        'if(el){el.value=e.data.email;el.dispatchEvent(new Event("input",{bubbles:true}));' +
        'var pw=document.querySelector("input[type=password],input[name=password]");' +
        'if(pw)pw.focus();}else{setTimeout(fillEmail,200);}}' +
        'fillEmail();' +
        '}' +
        '});' +
        // Also check URL param for initial load
        'var p=new URLSearchParams(window.location.search);' +
        'var t=p.get("access_token");' +
        'if(t){' +
        'try{localStorage.setItem("base44_access_token",t);}catch(err){}' +
        'p.delete("access_token");' +
        'var nu=window.location.pathname+(p.toString()?"?"+p.toString():"")+window.location.hash;' +
        'window.history.replaceState({},document.title,nu);' +
        '}' +
        // Pre-fill email from URL param as fallback
        'var em=p.get("bridge_email");' +
        'if(em){' +
        'function fillEmailUrl(){var el=document.querySelector("input[type=email],input[name=email],input[placeholder*=email i]");' +
        'if(el){el.value=em;el.dispatchEvent(new Event("input",{bubbles:true}));' +
        'var pw=document.querySelector("input[type=password],input[name=password]");' +
        'if(pw)pw.focus();}else{setTimeout(fillEmailUrl,200);}}' +
        'fillEmailUrl();' +
        '}' +
        '})();' +
        '</scr' + 'ipt>';
      html = html.replace(/<head>/i, '<head>' + AUTH_BRIDGE);
      body = Buffer.from(html, "utf-8");
    }

    res.send(Buffer.from(body));
  } catch (err) {
    console.error("Wave Pool proxy error:", err.message);
    res.status(502).send("Wave Pool proxy error: " + err.message);
  }
}

// Host-based passthrough — MUST be registered before the path-based /wave-pool
// mount below, and must check hostname on every request regardless of path.
app.use((req, res, next) => {
  const host = (req.headers.host || "").split(":")[0];
  if (host === WAVE_POOL_HOST) {
    return proxyToWavePool(req, res, { stripPrefix: false, rewrite: false, injectAuth: true });
  }
  next();
});


const PORT = process.env.PORT || 3000;
const VERSION = "5.6.3";

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

// POST /mcp — Standard StreamableHTTP endpoint (Base44 workspace MCP compatibility)
// Base44 MCP tester POSTs to /mcp with JSON-RPC. Mirrors /sse POST logic but returns JSON not SSE.
app.post("/mcp", async (req, res) => {
  const body = req.body;
  const method = body.method;
  const id = body.id;

  let rawToken = extractRawToken(req);
  if (!rawToken && body._waveToken && body._waveToken.length > 10) {
    rawToken = body._waveToken;
  }

  res.setHeader("Content-Type", "application/json");
  res.setHeader("Access-Control-Allow-Origin", "*");

  if (method === "notifications/initialized") {
    res.json({ jsonrpc: "2.0", id, result: {} });
    return;
  }

  if (rawToken && rawToken !== ENV_TOKEN && isRevokedJwt(rawToken)) {
    res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32001, message: "Token revoked." } });
    return;
  }

  const userToken = rawToken ? (rawToken === ENV_TOKEN ? ENV_TOKEN : resolveToken(rawToken)) : null;

  if (!userToken) {
    res.status(401).json({ jsonrpc: "2.0", id, error: { code: -32001, message: "No valid MCP token. Pass via Authorization header. Generate at app.oswave.io → Settings → MCP Setup." } });
    return;
  }

  const isEnvToken = userToken === ENV_TOKEN;
  console.log(`MCP POST from ${req.ip} method: ${method} — auth: ${isEnvToken ? "env" : "user"}`);

  try {
    let result;
    if (method === "initialize") {
      result = { protocolVersion: body.params?.protocolVersion || "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "wave-compute", version: VERSION } };
    } else if (method === "tools/list") {
      result = { tools: isEnvToken && cachedTools ? cachedTools : await fetchUserTools(userToken) };
    } else if (method === "tools/call") {
      result = await forwardToBackend("tools/call", body.params || {}, id, userToken);
    } else {
      res.json({ jsonrpc: "2.0", id, error: { code: -32601, message: "Unknown method: " + method } });
      return;
    }
    res.json({ jsonrpc: "2.0", id, result });
  } catch (err) {
    console.error(`MCP error ${method}:`, err.message);
    res.json({ jsonrpc: "2.0", id, error: { code: -32603, message: err.message } });
  }
});

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
    wavePoolProxy: "/wave-pool — iframe-safe proxy for wave-pool.base44.app",
  })
);

// ── WAVE POOL REVERSE PROXY ──
// Two modes:
// 1. HOST-BASED (preferred): requests arriving via the dedicated domain
//    (WAVE_POOL_HOST) are passed through 1:1 with no path prefix — the
//    upstream SPA sees requests exactly as if hitting its own root, so its
//    client-side router, <base> tag, and history API all just work with zero
//    rewriting needed. This avoids the fragility of path-prefix rewriting.
// 2. PATH-BASED (legacy /wave-pool mount): kept for backward compatibility,
//    still does prefix stripping + HTML/asset rewriting.
// Both strip X-Frame-Options / CSP so the app can be iframed.
// Legacy path-based mount (kept for backward compatibility)
app.use("/wave-pool", async (req, res) => {
  return proxyToWavePool(req, res, { stripPrefix: true, rewrite: true });
});
// ── END WAVE POOL REVERSE PROXY ──
app.listen(PORT, () => {
  console.log(`Wave Compute MCP SSE bridge v${VERSION} running on port ${PORT}`);
  console.log(`Mode: ${ENV_TOKEN ? "DUAL" : "PUBLIC"}`);
  console.log(`JWT: ${JWT_SECRET ? "ENABLED" : "DISABLED"}`);
  console.log(`Backend: ${MCP_BACKEND_URL}`);
  if (!ENV_TOKEN) console.log("⚠️  No WAVE_API_TOKEN — per-user tokens required");
  if (!JWT_SECRET) console.log("⚠️  No JWT_SECRET — JWT validation disabled");
});
