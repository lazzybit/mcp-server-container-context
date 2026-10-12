import { AccessAssertionVerifier } from "./auth/access.js";
import { loadConfig, ConfigError } from "./config.js";
import { createHttpServer } from "./http/server.js";
import { createLogger } from "./logging.js";
import { McpSessionRegistry } from "./mcp/sessions.js";

async function main(): Promise<void> {
  const logger = createLogger();

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    logger.error("invalid configuration", {
      message: error instanceof ConfigError ? error.message : String(error),
    });
    process.exitCode = 1;
    return;
  }

  const shutdownController = new AbortController();
  const verifier = AccessAssertionVerifier.fromConfig(config);
  const sessions = new McpSessionRegistry({
    config,
    logger,
    shutdownSignal: shutdownController.signal,
  });
  const server = createHttpServer({ config, logger, verifier, sessions });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error): void => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(config.port, config.host);
  });

  logger.info("listening", { host: config.host, port: config.port, workspace: config.workspaceDir });

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    logger.info("shutting down", { signal });
    shutdownController.abort();
    await sessions.shutdown();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    process.exit(0);
  };

  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("SIGINT", () => void shutdown("SIGINT"));
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${JSON.stringify({
      time: new Date().toISOString(),
      level: "error",
      message: "fatal error",
      error: error instanceof Error ? error.message : String(error),
    })}\n`,
  );
  process.exit(1);
});
