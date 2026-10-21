/**
 * Theta read-only RPC relay (v1.0.0)
 *
 * Why: Theta's public RPC (eth-rpc-api.thetatoken.org) rate-limits the shared
 * egress IPs of Base44 backends (HTTP 429), which stops Wave OS's publish
 * wizard and Wave Web's waveApi from reading the chain. Railway has its own
 * egress, so Base44 backends can fall back to this relay.
 *
 * Rules:
 * - POST /theta-rpc with a JSON-RPC body (single or batch of up to 20).
 * - Header X-Wave-Relay-Key must match env THETA_RELAY_KEY. No key set = 503.
 * - Read methods only. eth_sendRawTransaction and anything else is refused.
 * - Retries 429/5xx upstream with backoff, honours Retry-After (capped).
 * - Caches answers, dedupes identical in-flight calls, caps upstream concurrency.
 * - GET /theta-rpc/health is public and shows counters only (no params, no keys).
 */

import crypto from "crypto";

const RELAY_VERSION = "1.0.0";
const UPSTREAMS = (process.env.THETA_RPC_UPSTREAMS || "https://eth-rpc-api.thetatoken.org/rpc")
  .split(",").map((s) => s.trim()).filter(Boolean);
const MAX_BATCH = 20;
const MAX_CONCURRENT = 4;
const CACHE_MAX = 3000;

const ALLOWED = new Set([
  "eth_blockNumber", "eth_chainId", "net_version", "eth_gasPrice",
  "eth_call", "eth_estimateGas", "eth_getLogs", "eth_getBalance", "eth_getCode",
  "eth_getTransactionByHash", "eth_getTransactionReceipt", "eth_getTransactionCount",
  "eth_getBlockByNumber", "eth_getBlockByHash", "eth_getStorageAt",
]);

const stats = {
  started: new Date().toISOString(), requests: 0, calls: 0, cacheHits: 0,
  upstreamCalls: 0, upstream429: 0, upstreamErrors: 0, retries: 0, refused: 0,
  last429: null, lastError: null,
};

// ── cache + in-flight dedupe ──
const cache = new Map(); // key -> { exp, value }
const inflight = new Map();

function isHexBlock(v) { return typeof v === "string" && /^0x[0-9a-f]+$/i.test(v); }

function ttlMs(method, params, result) {
  switch (method) {
    case "eth_chainId": case "net_version": return 3600_000;
    case "eth_blockNumber": return 2_000;
    case "eth_gasPrice": return 30_000;
    case "eth_getTransactionByHash":
    case "eth_getTransactionReceipt":
      return result ? 3600_000 : 3_000; // mined txs never change; pending ones do
    case "eth_getBlockByHash": return result ? 3600_000 : 3_000;
    case "eth_getBlockByNumber": return isHexBlock(params?.[0]) && result ? 3600_000 : 2_000;
    case "eth_getLogs": {
      const f = params?.[0] || {};
      // A fixed numeric range (or a blockHash) is history, safe to keep a while.
      return (f.blockHash || (isHexBlock(f.toBlock) && isHexBlock(f.fromBlock))) ? 600_000 : 10_000;
    }
    case "eth_call": case "eth_getStorageAt":
      return isHexBlock(params?.[1]) ? 600_000 : 15_000;
    default: return 15_000;
  }
}

function cacheGet(key) {
  const e = cache.get(key);
  if (!e) return undefined;
  if (e.exp < Date.now()) { cache.delete(key); return undefined; }
  return e.value;
}
function cacheSet(key, value, ttl) {
  if (ttl <= 0) return;
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { exp: Date.now() + ttl, value });
}

// ── upstream concurrency limiter ──
let active = 0;
const queue = [];
function acquire() {
  if (active < MAX_CONCURRENT) { active++; return Promise.resolve(); }
  return new Promise((r) => queue.push(r));
}
function release() {
  const next = queue.shift();
  if (next) next(); else active--;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function upstreamCall(method, params) {
  const body = JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: params ?? [] });
  const delays = [400, 1200, 3000];
  let lastErr = "unknown";
  for (let attempt = 0; attempt <= delays.length; attempt++) {
    const url = UPSTREAMS[attempt % UPSTREAMS.length];
    await acquire();
    let resp;
    try {
      stats.upstreamCalls++;
      resp = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", "user-agent": "wave-theta-relay/" + RELAY_VERSION },
        body,
        signal: AbortSignal.timeout(25_000),
      });
    } catch (e) {
      lastErr = "network: " + (e?.message || e);
      stats.upstreamErrors++; stats.lastError = { at: new Date().toISOString(), err: lastErr };
      resp = null;
    } finally {
      release();
    }
    if (resp) {
      if (resp.status === 429 || resp.status >= 500) {
        if (resp.status === 429) { stats.upstream429++; stats.last429 = new Date().toISOString(); }
        else stats.upstreamErrors++;
        lastErr = "upstream HTTP " + resp.status;
        const ra = Number(resp.headers.get("retry-after"));
        if (attempt < delays.length) {
          stats.retries++;
          await sleep(Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : delays[attempt], 5000));
          continue;
        }
        break;
      }
      const text = await resp.text();
      let j;
      try { j = JSON.parse(text); } catch { lastErr = "upstream sent non-JSON (HTTP " + resp.status + ")"; break; }
      return j; // includes JSON-RPC errors as-is
    } else if (attempt < delays.length) {
      stats.retries++;
      await sleep(delays[attempt]);
    }
  }
  const err = new Error(lastErr);
  err.relay = true;
  throw err;
}

async function handleOne(call) {
  stats.calls++;
  const id = call?.id ?? null;
  if (!call || call.jsonrpc !== "2.0" || typeof call.method !== "string") {
    return { jsonrpc: "2.0", id, error: { code: -32600, message: "Invalid JSON-RPC request" } };
  }
  if (!ALLOWED.has(call.method)) {
    stats.refused++;
    return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method ${call.method} is not allowed on the read-only relay` } };
  }
  const params = Array.isArray(call.params) ? call.params : [];
  const key = call.method + ":" + JSON.stringify(params);
  const hit = cacheGet(key);
  if (hit !== undefined) { stats.cacheHits++; return { jsonrpc: "2.0", id, ...hit, cached: true }; }

  let p = inflight.get(key);
  if (!p) {
    p = upstreamCall(call.method, params).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  try {
    const j = await p;
    const payload = "error" in j && j.error ? { error: j.error } : { result: j.result ?? null };
    if (!payload.error) cacheSet(key, payload, ttlMs(call.method, params, payload.result));
    return { jsonrpc: "2.0", id, ...payload };
  } catch (e) {
    return { jsonrpc: "2.0", id, error: { code: -32603, message: "Relay could not reach Theta RPC: " + e.message } };
  }
}

function keyOk(req) {
  const want = process.env.THETA_RELAY_KEY || "";
  const got = String(req.headers["x-wave-relay-key"] || "");
  if (!want || !got) return false;
  const a = crypto.createHash("sha256").update(want).digest();
  const b = crypto.createHash("sha256").update(got).digest();
  return crypto.timingSafeEqual(a, b);
}

export function mountThetaRelay(app) {
  app.get("/theta-rpc/health", (req, res) => {
    res.json({
      ok: true, service: "theta-relay", version: RELAY_VERSION,
      enabled: !!process.env.THETA_RELAY_KEY,
      upstreams: UPSTREAMS.length, cacheSize: cache.size, active, queued: queue.length,
      methods: [...ALLOWED], stats,
    });
  });

  app.post("/theta-rpc", async (req, res) => {
    stats.requests++;
    if (!process.env.THETA_RELAY_KEY) return res.status(503).json({ error: "Relay disabled on this service" });
    if (!keyOk(req)) return res.status(401).json({ error: "Missing or wrong X-Wave-Relay-Key" });
    const body = req.body;
    if (Array.isArray(body)) {
      if (body.length === 0 || body.length > MAX_BATCH) {
        return res.status(400).json({ error: `Batch must have 1 to ${MAX_BATCH} calls` });
      }
      const out = await Promise.all(body.map(handleOne));
      return res.json(out);
    }
    if (!body || typeof body !== "object") return res.status(400).json({ error: "JSON-RPC body required" });
    const out = await handleOne(body);
    res.json(out);
  });
}
