/**
 * Environment-driven configuration. Validated once at startup; missing or
 * malformed production configuration aborts the process. There is no
 * "authentication disabled" switch.
 */

export interface Config {
  /** Bare team domain, e.g. `team-name.cloudflareaccess.com`. */
  readonly teamDomain: string;
  /** JWT issuer derived from `teamDomain`: `https://<teamDomain>`. */
  readonly issuer: string;
  /** Access application AUD tag. */
  readonly applicationAud: string;
  /** Bare public host, e.g. `mcp.example.com`; used for Host/Origin checks. */
  readonly mcpDomain: string;
  /** Listen host. */
  readonly host: string;
  /** Listen port. */
  readonly port: number;
  /** Base for relative tool paths and the `bash` working directory. */
  readonly workspaceDir: string;
  /** Optional idle-session sweep interval in ms; `0` disables it. */
  readonly sessionSweepMs: number;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 8000;
const DEFAULT_WORKSPACE_DIR = "/workspace";
const DEFAULT_SESSION_SWEEP_MS = 0;

/** Strip a leading scheme and trailing slashes so `TEAM_DOMAIN` stays bare. */
function bareDomain(raw: string, variable: string): string {
  let value = raw.trim();
  value = value.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//, "");
  value = value.replace(/\/+$/, "");
  if (value.length === 0 || value.includes("/") || /\s/.test(value)) {
    throw new ConfigError(`${variable} must be a bare host name`);
  }
  return value;
}

function requireString(env: NodeJS.ProcessEnv, variable: string): string {
  const raw = env[variable];
  if (raw === undefined || raw.trim().length === 0) {
    throw new ConfigError(`${variable} is required`);
  }
  return raw.trim();
}

function parseInteger(raw: string, variable: string, min: number, max: number): number {
  if (!/^[0-9]+$/.test(raw.trim())) {
    throw new ConfigError(`${variable} must be an integer`);
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (value < min || value > max) {
    throw new ConfigError(`${variable} must be between ${min} and ${max}`);
  }
  return value;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const teamDomain = bareDomain(requireString(env, "TEAM_DOMAIN"), "TEAM_DOMAIN");
  const applicationAud = requireString(env, "APPLICATION_AUD");
  const mcpDomain = bareDomain(requireString(env, "MCP_DOMAIN"), "MCP_DOMAIN");

  const host = env["MCP_HOST"]?.trim() || DEFAULT_HOST;
  const port = parseInteger(env["MCP_PORT"] ?? String(DEFAULT_PORT), "MCP_PORT", 1, 65535);
  const workspaceDir = env["WORKSPACE_DIR"]?.trim() || DEFAULT_WORKSPACE_DIR;
  const sessionSweepMs = parseInteger(
    env["MCP_SESSION_SWEEP_MS"] ?? String(DEFAULT_SESSION_SWEEP_MS),
    "MCP_SESSION_SWEEP_MS",
    0,
    Number.MAX_SAFE_INTEGER,
  );

  return {
    teamDomain,
    issuer: `https://${teamDomain}`,
    applicationAud,
    mcpDomain,
    host,
    port,
    workspaceDir,
    sessionSweepMs,
  };
}
