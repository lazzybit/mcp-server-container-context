import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

export interface TestClient {
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  close(): Promise<void>;
}

export interface ConnectClientOptions {
  readonly headers?: Record<string, string>;
  readonly sessionId?: string;
}

/** Connect an SDK client to the test server, sending the Access assertion header. */
export async function connectClient(
  baseUrl: string,
  assertion: string,
  options: ConnectClientOptions = {},
): Promise<TestClient> {
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(`${baseUrl}/mcp`), {
    requestInit: {
      headers: {
        "cf-access-jwt-assertion": assertion,
        ...(options.headers ?? {}),
      },
    },
    ...(options.sessionId !== undefined ? { sessionId: options.sessionId } : {}),
  });
  await client.connect(transport);
  return {
    client,
    transport,
    close: async () => {
      await client.close().catch(() => undefined);
    },
  };
}
