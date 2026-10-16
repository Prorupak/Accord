# Edge protection and abuse limits

This page covers what the API's own limits do, what they cannot do, and what a public deployment
needs at the edge. There is no Cloudflare deployment today: commit `f5b6cba` removed the gateway
Worker, the static-export target and the Cloudflare runbook. The Cloudflare section below is
guidance for a future public deploy.

## What the API does (in-process)

| Control | Default | Setting |
| --- | --- | --- |
| `POST /api/map` | 6 requests / rolling minute | `RATE_LIMIT_MAP_PER_MINUTE` (1–1000) |
| `POST /api/suggest` | 12 requests / rolling minute | `RATE_LIMIT_SUGGEST_PER_MINUTE` (1–1000) |
| OpenRouter attempts, both routes | 30 / rolling 24 h | `PROVIDER_ATTEMPTS_PER_DAY` (1–100000) |

When a limit is hit, the API returns 429 `RATE_LIMITED` with `retryAfterSeconds` and a matching
`Retry-After` header. Route limits run after the Host/Origin guard and before the body is read,
so `requestId` is `""` (the same as 413/415). Rejections from the provider budget happen inside
inference and echo the request's `requestId`. The provider budget counts every attempt, including
transient retries and the schema repair. It is reserved before each call and never refunded.

These limits stack with the controls that already existed: the 64 KiB body cap, the JSON content
type, the Host/Origin guard, one inference at a time (409 `BUSY`), the 45 s deadline and at most
3 attempts per request. Uvicorn in Docker runs with `--no-proxy-headers`,
`--limit-concurrency 32` (503 above that) and `--timeout-keep-alive 5`.

### Limitations

- **One shared bucket, not per client.** Every request reaches the API through a proxy (the Next
  rewrite in dev and Docker, or Vercel), so the API cannot verify who the caller is.
  `X-Forwarded-For`, `X-Real-IP` and `CF-Connecting-IP` can be set by any client, so the API
  ignores them. One heavy caller can therefore use up the minute for everyone.
- **In memory, per process.** Counters reset on restart or redeploy. Separate processes or Vercel
  function instances each keep their own counters. A daily budget of 30 on N instances allows up
  to 30 × N attempts.
- **No protection against volumetric DDoS.** By the time a request reaches the limiter, it has
  already used bandwidth, a connection and an event-loop turn. The limiter protects the provider
  quota, not the server. Flood protection has to happen upstream.
- The web UI shows its existing `RATE_LIMITED` message, which mentions the AI provider. It is
  also shown for these server-side limits.

## Cloudflare for a public deploy

1. **Proxy the hostname** (orange cloud) so traffic reaches the origin only through Cloudflare.
   Cloudflare's DDoS mitigation applies only to proxied traffic.
2. **WAF managed rules**: enable the Cloudflare Managed Ruleset. Add a custom rule that blocks
   `POST` requests to `/api/*` without `Content-Type: application/json`, and block request bodies
   over 64 KiB, so the origin never sees them.
3. **Rate-limiting rules** (per IP, which the edge can see):
   - `http.request.uri.path eq "/api/map" and http.request.method eq "POST"`: about 6 per minute,
     block for 10 minutes.
   - `http.request.uri.path eq "/api/suggest" and http.request.method eq "POST"`: about 12 per
     minute, block for 10 minutes.
   These limit each client separately. The app limits stay as a global backstop.
4. **Bot Fight Mode** (or Super Bot Fight Mode) on the hostname.
5. **Spend cap at the provider**: set a credit limit on the OpenRouter key. It is the only limit
   that holds across restarts and instances.

### Preventing origin bypass

Edge rules do nothing if clients can reach the origin directly. Choose one of these:

- **Cloudflare Tunnel (preferred).** `cloudflared` makes an outbound connection, so the origin has
  no inbound port. Keep the API unpublished, as Compose does today (`expose`, no `ports`).
- **Firewall plus mTLS.** Allow inbound 443 only from
  [Cloudflare's IP ranges](https://www.cloudflare.com/ips/) and turn on Authenticated Origin Pulls,
  so the origin accepts only connections that present Cloudflare's client certificate.

Only after one of these is in place could the origin treat `CF-Connecting-IP` as the real client,
and only on connections that came through Cloudflare. This phase does not do that. Turning on
forwarded-header trust globally (for example `--forwarded-allow-ips '*'`) would let any client
choose its own identity.
