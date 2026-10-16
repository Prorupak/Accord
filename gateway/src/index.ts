// Public gateway: the only public way to reach Accord inference. It forwards to the private
// Python Worker (service binding API) only for the built-in synthetic sample, and only while a
// global daily quota (Durable Object) has room. Error bodies use the API's §8.3 envelope and codes.
import { isSampleMap, isSampleSuggest } from "./sample";
import type { Quota } from "./quota";

export { Quota } from "./quota";

export interface Env {
  API: Fetcher;
  QUOTA: DurableObjectNamespace<Quota>;
  ENVIRONMENT: string;
  DAILY_UNITS: string; // provider attempts allowed per UTC day, across all clients
  ALLOWED_ORIGINS: string; // comma-separated exact origins; CORS only, never authentication
  PUBLIC_AI_ENABLED?: string; // secret; kill switch: inference runs only when exactly "true"
  GIT_SHA?: string;
}

const MAX_BODY_BYTES = 64 * 1024; // api/app/schemas.py MAX_BODY_BYTES
const UNITS_PER_CALL = 3; // api/app/schemas.py MAX_PROVIDER_ATTEMPTS: reserve the worst case up front
const API_ORIGIN = "http://accord-api:8000"; // Host the Python Worker's guard accepts (API_INTERNAL_HOST:API_PORT)
const AI_ROUTES: Record<string, (body: unknown) => boolean> = { "/api/map": isSampleMap, "/api/suggest": isSampleSuggest };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Code = "INVALID_INPUT" | "PAYLOAD_TOO_LARGE" | "NOT_CONFIGURED" | "RATE_LIMITED" | "UPSTREAM_ERROR";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const { pathname } = new URL(request.url);
    const origin = request.headers.get("origin");
    const allowed = env.ALLOWED_ORIGINS.split(",").map((o) => o.trim()).filter(Boolean);
    const cors: Record<string, string> =
      origin !== null && allowed.includes(origin) ? { "access-control-allow-origin": origin, vary: "Origin" } : { vary: "Origin" };
    const log = (status: number, code: string | null, extra: Record<string, unknown> = {}) =>
      console.log(JSON.stringify({ env: env.ENVIRONMENT, sha: env.GIT_SHA ?? null, route: pathname, method: request.method, status, code, ...extra }));
    const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
      Response.json(body, { status, headers: { ...cors, "cache-control": "no-store", ...headers } });
    const fail = (status: number, code: Code, message: string, requestId = "", extra: Record<string, string> = {}) => {
      log(status, code);
      const retryAfter = extra["retry-after"];
      const error = { code, message, retryable: status === 429 || status === 502, requestId, ...(retryAfter ? { retryAfterSeconds: Number(retryAfter) } : {}) };
      return json(status, { error }, extra);
    };

    if (origin !== null && !allowed.includes(origin)) return fail(403, "INVALID_INPUT", "Origin not allowed.");

    if (request.method === "GET" && pathname === "/health") {
      // Also proves the service binding reaches the private Worker.
      const api = await env.API.fetch(`${API_ORIGIN}/health`).then((r) => (r.ok ? "ok" : `status ${r.status}`), () => "unreachable");
      log(200, null, { api });
      return json(200, { status: "ok", service: "accord-gateway", environment: env.ENVIRONMENT, version: env.GIT_SHA ?? null, api });
    }
    if (request.method === "GET" && pathname === "/api/capabilities") {
      log(200, null);
      return json(200, { enabled: env.PUBLIC_AI_ENABLED === "true", sampleOnly: true, maxBodyBytes: MAX_BODY_BYTES });
    }

    const sampleOnly = AI_ROUTES[pathname];
    if (!sampleOnly) return fail(404, "INVALID_INPUT", "Not found.");
    if (request.method === "OPTIONS") {
      return new Response(null, {
        status: 204,
        headers: { ...cors, "access-control-allow-methods": "POST", "access-control-allow-headers": "content-type", "access-control-max-age": "600" },
      });
    }
    if (request.method !== "POST") return fail(405, "INVALID_INPUT", "Method not allowed.", "", { allow: "POST, OPTIONS" });
    if (env.PUBLIC_AI_ENABLED !== "true") return fail(503, "NOT_CONFIGURED", "AI suggestions are switched off on this deployment.");
    if ((request.headers.get("content-type") ?? "").split(";")[0].trim() !== "application/json")
      return fail(415, "INVALID_INPUT", "Content-Type must be application/json.");

    const raw = await readCapped(request);
    if (raw === null) return fail(413, "PAYLOAD_TOO_LARGE", `Request body exceeds ${MAX_BODY_BYTES} bytes.`);
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, "INVALID_INPUT", "Invalid JSON.");
    }
    const rid = (body as { requestId?: unknown })?.requestId;
    const requestId = typeof rid === "string" && UUID.test(rid) ? rid : "";
    if (!requestId) return fail(400, "INVALID_INPUT", "requestId must be a UUID.");
    if (!sampleOnly(body)) return fail(403, "INVALID_INPUT", "Hosted AI runs only on the built-in sample data.", requestId);

    // Reserve before any model-backed attempt. Any storage failure fails closed.
    const day = new Date().toISOString().slice(0, 10);
    let quota: { granted: boolean; used: number };
    try {
      quota = await env.QUOTA.get(env.QUOTA.idFromName("global")).reserve(day, UNITS_PER_CALL, Number(env.DAILY_UNITS) || 0);
    } catch {
      return fail(502, "UPSTREAM_ERROR", "Usage accounting is unavailable.", requestId);
    }
    if (!quota.granted) {
      const midnight = Date.parse(`${day}T00:00:00Z`) + 86_400_000;
      return fail(429, "RATE_LIMITED", "Today's hosted AI budget is used up. Try again after 00:00 UTC.", requestId, {
        "retry-after": String(Math.ceil((midnight - Date.now()) / 1000)),
      });
    }

    let upstream: Response;
    try {
      upstream = await env.API.fetch(`${API_ORIGIN}${pathname}`, { method: "POST", headers: { "content-type": "application/json" }, body: raw });
    } catch {
      return fail(502, "UPSTREAM_ERROR", "The inference service is unreachable.", requestId);
    }
    log(upstream.status, null, { requestId, quotaUsed: quota.used });
    const headers: Record<string, string> = { "content-type": upstream.headers.get("content-type") ?? "application/json" };
    const retryAfter = upstream.headers.get("retry-after");
    if (retryAfter) headers["retry-after"] = retryAfter;
    return new Response(upstream.body, { status: upstream.status, headers: { ...cors, "cache-control": "no-store", ...headers } });
  },
} satisfies ExportedHandler<Env>;

// Reads at most MAX_BODY_BYTES; null when the body is larger (declared or actual).
async function readCapped(request: Request): Promise<string | null> {
  const declared = Number(request.headers.get("content-length") ?? "0");
  if (declared > MAX_BODY_BYTES) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) all.set(c, (at += c.byteLength) - c.byteLength);
  return new TextDecoder().decode(all);
}
