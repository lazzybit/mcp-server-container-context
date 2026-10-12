import { describe, expect, it } from "vitest";

import { ConfigError, loadConfig } from "../../src/config.js";

const base = {
  CLOUDFLARE_ACCESS_TEAM_DOMAIN: "team-name.cloudflareaccess.com",
  CLOUDFLARE_ACCESS_APPLICATION_AUD: "aud-tag",
  MCP_DOMAIN: "mcp.example.com",
};

describe("loadConfig", () => {
  it("returns a validated config with defaults", () => {
    const config = loadConfig({ ...base });
    expect(config.teamDomain).toBe("team-name.cloudflareaccess.com");
    expect(config.issuer).toBe("https://team-name.cloudflareaccess.com");
    expect(config.applicationAud).toBe("aud-tag");
    expect(config.mcpDomain).toBe("mcp.example.com");
    expect(config.host).toBe("0.0.0.0");
    expect(config.port).toBe(8000);
    expect(config.workspaceDir).toBe("/workspace");
    expect(config.sessionSweepMs).toBe(0);
  });

  it("strips a leading scheme and trailing slash from CLOUDFLARE_ACCESS_TEAM_DOMAIN", () => {
    const config = loadConfig({
      ...base,
      CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://team-name.cloudflareaccess.com/",
    });
    expect(config.teamDomain).toBe("team-name.cloudflareaccess.com");
    expect(config.issuer).toBe("https://team-name.cloudflareaccess.com");
  });

  it("honours explicit host, port, workspace and sweep", () => {
    const config = loadConfig({
      ...base,
      MCP_HOST: "127.0.0.1",
      MCP_PORT: "9001",
      WORKSPACE_DIR: "/srv/work",
      MCP_SESSION_SWEEP_MS: "5000",
    });
    expect(config.host).toBe("127.0.0.1");
    expect(config.port).toBe(9001);
    expect(config.workspaceDir).toBe("/srv/work");
    expect(config.sessionSweepMs).toBe(5000);
  });

  it.each(["CLOUDFLARE_ACCESS_TEAM_DOMAIN", "CLOUDFLARE_ACCESS_APPLICATION_AUD", "MCP_DOMAIN"] as const)(
    "rejects a missing %s",
    (variable) => {
      const env: NodeJS.ProcessEnv = { ...base };
      delete env[variable];
      expect(() => loadConfig(env)).toThrow(ConfigError);
    },
  );

  it("rejects an empty required value", () => {
    expect(() => loadConfig({ ...base, CLOUDFLARE_ACCESS_APPLICATION_AUD: "   " })).toThrow(
      ConfigError,
    );
  });

  it("rejects a CLOUDFLARE_ACCESS_TEAM_DOMAIN that is not a bare host", () => {
    expect(() =>
      loadConfig({ ...base, CLOUDFLARE_ACCESS_TEAM_DOMAIN: "https://team.example.com/path" }),
    ).toThrow(ConfigError);
  });

  it.each([["0"], ["65536"], ["abc"], ["-1"], ["80.5"]])("rejects a malformed MCP_PORT %s", (port) => {
    expect(() => loadConfig({ ...base, MCP_PORT: port })).toThrow(ConfigError);
  });

  it("rejects a malformed sweep interval", () => {
    expect(() => loadConfig({ ...base, MCP_SESSION_SWEEP_MS: "nope" })).toThrow(ConfigError);
  });
});
