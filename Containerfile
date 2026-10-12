# mcp-server-container-context — the single build artifact.
#
# Multi-stage, digest-pinned, Debian 13 (trixie) + Node.js 24 LTS.
# The final image contains Debian, Node.js, bash, Git, CA certificates and the
# compiled controller with its production dependencies. No init is bundled:
# the controller is PID 1 and handles termination signals itself.
#
# No `# syntax=` frontend directive: nothing here needs a BuildKit-only
# feature, so any Dockerfile-compatible builder (Docker, Podman/Buildah,
# Kaniko) can build it without pulling a Docker-specific parser image.

FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66 AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json vitest.config.ts ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:24-trixie-slim@sha256:173f125896c3b47ddf056734c7ea789d04595a6a08769a8f78e0df642781fb66
RUN apt-get update \
 && apt-get install -y --no-install-recommends bash ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
ENV NODE_ENV=production
WORKDIR /workspace
COPY --from=build /build/node_modules /opt/controller/node_modules
COPY --from=build /build/dist /opt/controller/dist
COPY --from=build /build/package.json /opt/controller/package.json
EXPOSE 8000
ENTRYPOINT ["node", "/opt/controller/dist/index.js"]
