# mcp-server-container-context

A remote MCP controller that exposes exactly four tools — `read`, `write`,
`edit`, `bash` — and runs inside the environment it operates on. It speaks MCP
Streamable HTTP, is reached through Cloudflare Access with Managed OAuth, and
validates the Cloudflare Access assertion itself before any tool runs.

The only build artifact that matters is [`container/Containerfile`](container/Containerfile).

```text
MCP client → Cloudflare Access (login, OAuth, policy) → container :8000
                                                          POST/GET/DELETE /mcp
                                                          GET /healthz
                                                          validate Cf-Access-Jwt-Assertion
                                                          read · write · edit · bash
```

## Configuration

Environment-driven, validated once at startup. Missing or malformed production
configuration aborts the process (non-zero exit). There is no "auth disabled"
switch.

| Variable | Required | Default | Purpose |
| -------- | -------- | ------- | ------- |
| `TEAM_DOMAIN` | yes | — | Bare team domain, e.g. `team-name.cloudflareaccess.com`. Issuer `https://<TEAM_DOMAIN>`, JWKS `https://<TEAM_DOMAIN>/cdn-cgi/access/certs`. |
| `APPLICATION_AUD` | yes | — | Access application AUD tag (`aud` claim). |
| `MCP_DOMAIN` | yes | — | Bare public host, e.g. `mcp.example.com`; used for `Host`/`Origin` checks. |
| `MCP_HOST` | no | `0.0.0.0` | Listen host. |
| `MCP_PORT` | no | `8000` | Listen port. |
| `WORKSPACE_DIR` | no | `/workspace` | Base for relative tool paths; `bash` cwd. |
| `MCP_SESSION_SWEEP_MS` | no | `0` (off) | Optional idle-session sweep; never cancels active tool work. |
| `LOG_LEVEL` | no | `info` | `debug` / `info` / `warn` / `error`; logs go to stderr. |

`/.well-known/*` is not served by the controller — Cloudflare provides OAuth
discovery. An unauthenticated non-browser request gets `401` with
`WWW-Authenticate: Bearer realm="mcp"`.

## Build and run

```bash
npm ci
npm run typecheck
npm run build
TEAM_DOMAIN=... APPLICATION_AUD=... MCP_DOMAIN=... npm start
```

The container runs the controller as PID 1 with no init:

```bash
docker build -f container/Containerfile -t mcp-server-container-context .
docker run --rm -p 8000:8000 \
  -e TEAM_DOMAIN=team-name.cloudflareaccess.com \
  -e APPLICATION_AUD=your-aud-tag \
  -e MCP_DOMAIN=mcp.example.com \
  mcp-server-container-context
```

## Tests

Tests run against the TypeScript source through Vitest and never depend on a
prior build.

| Script | Contents |
| ------ | -------- |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
| `npm test` | full local suite |
| `npm run test:unit` | `tests/unit`, `tests/tools`, `tests/auth` |
| `npm run test:mcp` | `tests/mcp` (real HTTP server + SDK client) |

Covered: tool contracts (UTF-8-safe truncation, atomic writes, symlink/mode
handling, edit matching), `bash` process-group lifecycle and cancellation, the
Access assertion verifier (including real JWKS caching/rotation), and HTTP
session identity/cancellation/isolation.

## Verification status

- **Executed and green:** `npm run typecheck`, `npm run build`, `npm test`
  (110 tests, 8 files).
- **Not executed — no container runtime available here:** building and running
  `container/Containerfile`, PID 1 behaviour, image contents, `/healthz` and
  `/mcp` inside the image, SIGTERM shutdown.
- **Not executed — no Zero Trust environment available:** live Cloudflare
  Access acceptance (browser login, opaque token, assertion forwarding, policy
  denial, long SSE limits).

These are reported as **not executed**, never as passed.
