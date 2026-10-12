import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { hostHeaderValidation, originValidation } from "@modelcontextprotocol/node";

import { AccessVerificationError, type AccessAssertionVerifier, type AccessIdentity } from "../auth/access.js";
import type { Config } from "../config.js";
import type { Logger } from "../logging.js";
import type { McpSessionRegistry } from "../mcp/sessions.js";
import { headerValue, sendJson, sendUnauthorized } from "./respond.js";

export interface HttpServerDeps {
  readonly config: Config;
  readonly logger: Logger;
  readonly verifier: AccessAssertionVerifier;
  readonly sessions: McpSessionRegistry;
}

/**
 * The controller's HTTP surface: `POST`/`GET`/`DELETE /mcp`, `GET /healthz`.
 * `/.well-known/*` is deliberately not implemented (Cloudflare serves it);
 * anything else is a `404`.
 */
export function createHttpServer(deps: HttpServerDeps): Server {
  const validateHost = hostHeaderValidation([deps.config.mcpDomain]);
  const validateOrigin = originValidation([deps.config.mcpDomain]);

  const handle = async (req: IncomingMessage, res: ServerResponse, identity: AccessIdentity): Promise<void> => {
    try {
      await deps.sessions.handleMcpRequest(req, res, identity);
    } catch (error) {
      deps.logger.error("mcp request failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      if (!res.headersSent) {
        sendJson(res, 500, { error: "internal error" });
      } else {
        res.end();
      }
    }
  };

  const onRequest = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

        if (url.pathname === "/healthz") {
          if ((req.method ?? "GET") !== "GET") {
            sendJson(res, 405, { error: "method not allowed" }, { allow: "GET" });
            return;
          }
          sendJson(res, 200, { status: "ok" });
          return;
        }

        if (url.pathname !== "/mcp") {
          sendJson(res, 404, { error: "not found" });
          return;
        }

        // DNS-rebinding protection. Never trust X-Forwarded-* for these decisions.
        if (!validateHost(req, res)) {
          return;
        }
        if (!validateOrigin(req, res)) {
          return;
        }

        const assertion = headerValue(req, "cf-access-jwt-assertion");
        if (assertion === undefined || assertion.trim().length === 0) {
          sendUnauthorized(res);
          return;
        }

        let identity: AccessIdentity;
        try {
          identity = await deps.verifier.verify(assertion);
        } catch (error) {
          deps.logger.warn("access assertion rejected", {
            reason: error instanceof AccessVerificationError ? error.message : "verification failed",
          });
          sendUnauthorized(res);
          return;
        }

        await handle(req, res, identity);
      } catch (error) {
        deps.logger.error("request failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        if (!res.headersSent) {
          sendJson(res, 500, { error: "internal error" });
        } else {
          res.end();
        }
      }
    })();
  };

  return createServer(onRequest);
}
