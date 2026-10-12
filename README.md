# mcp-server-container-context

A remote MCP controller that exposes exactly four tools — `read`, `write`,
`edit`, `bash` — and runs inside the environment it operates on. It speaks MCP
Streamable HTTP, is reached through Cloudflare Access with Managed OAuth, and
validates the Cloudflare Access assertion itself before any tool runs.

The only build artifact that matters is [`Containerfile`](Containerfile).

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
docker build -f Containerfile -t mcp-server-container-context .
docker run --rm -p 8000:8000 \
  -e TEAM_DOMAIN=team-name.cloudflareaccess.com \
  -e APPLICATION_AUD=your-aud-tag \
  -e MCP_DOMAIN=mcp.example.com \
  mcp-server-container-context
```

### Pipeline

`.github/workflows/image.yml` builds `Containerfile` with Podman on the two
native GitHub-hosted runners and publishes a manifest list to
`ghcr.io/lazzybit/mcp-server-container-context`.

| | |
| --- | --- |
| Platforms | `linux/amd64` (`ubuntu-24.04`), `linux/arm64/v8` (`ubuntu-24.04-arm`) |
| Triggers | push to `main`, every pull request, manual `workflow_dispatch` |
| Tags | `sha-<full commit SHA>` always; `latest` only on `main` |
| Pull requests | build and run the `/healthz` smoke test, publish nothing |

Each matrix leg builds its architecture natively, runs the image with
placeholder `localhost` configuration, and asserts `GET /healthz` returns
`{"status":"ok"}` before anything is pushed. The `manifest` job assembles the
two pushed digests into one index (explicit `--os linux --arch amd64` and
`--os linux --arch arm64 --variant v8`), verifies the pushed index with
`skopeo inspect --raw`, and only then moves `latest`.

Publishing uses the workflow's `GITHUB_TOKEN` with `packages: write`; no extra
registry secret is stored. GHCR **package** visibility is separate from
repository visibility: the first published package defaults to private and must
be switched to public in the package settings for anonymous pulls.

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
- **Executed and green — GitHub Actions image pipeline (run
  [38253124242](https://github.com/lazzybit/mcp-server-container-context/actions/runs/38253124242)):**
  both architectures built natively on their runners, both `/healthz` smoke
  tests passed, the per-architecture images were pushed, and the
  `sha-<full SHA>` and `latest` manifests were assembled, pushed, and asserted
  by `skopeo inspect --raw` to contain one `linux/amd64` and one `linux/arm64`
  (`variant: v8`) entry.
- **Not executed — no container runtime available here:** a local container
  build, PID 1 signal handling and SIGTERM shutdown, and `/mcp` inside the image
  (which needs a valid Cloudflare Access assertion). The pipeline's smoke test
  does build and run the image, but it only reaches the unauthenticated
  `/healthz`.
- **Not executed — no Zero Trust environment available:** live Cloudflare
  Access acceptance (browser login, opaque token, assertion forwarding, policy
  denial, long SSE limits).

These are reported as **not executed**, never as passed.
