import type { Logger } from "../../src/logging.js";

/** A logger that discards everything, for tests that do not assert on logs. */
export function silentLogger(): Logger {
  const logger: Logger = {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => logger,
  };
  return logger;
}
