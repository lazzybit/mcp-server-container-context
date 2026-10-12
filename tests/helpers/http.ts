export interface RawMcpResponse {
  readonly status: number;
  readonly headers: Headers;
  readonly text: string;
  readonly messages: unknown[];
}

export interface RawMcpOptions {
  readonly assertion?: string;
  readonly sessionId?: string;
  readonly origin?: string;
  readonly method?: string;
  readonly extraHeaders?: Record<string, string>;
}

function parseMessages(contentType: string | null, text: string): unknown[] {
  if (contentType !== null && contentType.includes("text/event-stream")) {
    const messages: unknown[] = [];
    for (const line of text.split("\n")) {
      const trimmed = line.trimStart();
      if (!trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data.length === 0) {
        continue;
      }
      try {
        messages.push(JSON.parse(data));
      } catch {
        // Ignore non-JSON keep-alive payloads.
      }
    }
    return messages;
  }
  if (text.trim().length === 0) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

/** Send a raw request to `/mcp` and parse its JSON or SSE body. */
export async function rawMcp(
  baseUrl: string,
  body: unknown,
  options: RawMcpOptions = {},
): Promise<RawMcpResponse> {
  const headers: Record<string, string> = {
    accept: "application/json, text/event-stream",
    ...(options.extraHeaders ?? {}),
  };
  if (body !== undefined && options.method !== "GET" && options.method !== "DELETE") {
    headers["content-type"] = "application/json";
  }
  if (options.assertion !== undefined) {
    headers["cf-access-jwt-assertion"] = options.assertion;
  }
  if (options.sessionId !== undefined) {
    headers["mcp-session-id"] = options.sessionId;
  }
  if (options.origin !== undefined) {
    headers["origin"] = options.origin;
  }

  const method = options.method ?? "POST";
  const response = await fetch(`${baseUrl}/mcp`, {
    method,
    headers,
    ...(body !== undefined && method !== "GET" && method !== "DELETE"
      ? { body: JSON.stringify(body) }
      : {}),
  });
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    messages: parseMessages(response.headers.get("content-type"), text),
  };
}

export interface RawSession {
  readonly sessionId: string;
  readonly init: unknown;
}

/** Initialize a raw MCP session and mark it initialized. */
export async function initializeRawSession(baseUrl: string, assertion: string): Promise<RawSession> {
  const response = await rawMcp(
    baseUrl,
    {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-11-25",
        capabilities: {},
        clientInfo: { name: "raw-test", version: "1.0.0" },
      },
    },
    { assertion },
  );
  const sessionId = response.headers.get("mcp-session-id");
  if (sessionId === null) {
    throw new Error(`initialize did not return a session id (status ${response.status})`);
  }
  await rawMcp(
    baseUrl,
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { assertion, sessionId },
  );
  return { sessionId, init: response.messages[0] };
}

export function toolCall(id: number, name: string, args: Record<string, unknown>): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
