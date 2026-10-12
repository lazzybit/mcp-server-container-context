/**
 * Structured logger. All diagnostics go to stderr so stdout stays free for
 * protocol traffic (the controller is an HTTP server, but keeping output
 * discipline is still useful when the process is run under a supervisor).
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  child(fields: Record<string, unknown>): Logger;
}

function normalizeLevel(value: string | undefined): LogLevel {
  if (value === "debug" || value === "info" || value === "warn" || value === "error") {
    return value;
  }
  return "info";
}

export function createLogger(
  level: LogLevel | string | undefined = process.env.LOG_LEVEL,
  base: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_ORDER[normalizeLevel(level)];

  const emit = (entryLevel: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) {
      return;
    }
    const record: Record<string, unknown> = {
      time: new Date().toISOString(),
      level: entryLevel,
      message,
      ...base,
      ...(fields ?? {}),
    };
    let line: string;
    try {
      line = JSON.stringify(record);
    } catch {
      line = JSON.stringify({ time: record["time"], level: entryLevel, message });
    }
    process.stderr.write(`${line}\n`);
  };

  return {
    debug: (message, fields) => emit("debug", message, fields),
    info: (message, fields) => emit("info", message, fields),
    warn: (message, fields) => emit("warn", message, fields),
    error: (message, fields) => emit("error", message, fields),
    child: (fields) => createLogger(level, { ...base, ...fields }),
  };
}
