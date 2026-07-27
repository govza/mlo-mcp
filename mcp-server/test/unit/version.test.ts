import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../../src/server.js";
import type { ToolContext } from "../../src/tools/contract.js";

/** Compare the sources against each other — never against a restated literal. */
function manifestVersion(...segments: string[]): string {
  const file = path.resolve(__dirname, "..", "..", ...segments);
  return (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version;
}

/** Registration only reads the tool definitions; no tool is called here. */
const REGISTRATION_ONLY_CTX = {} as ToolContext;

async function connectedClient(): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "version-test", version: "0.0.0" });
  await Promise.all([createMcpServer(REGISTRATION_ONLY_CTX).connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

describe("server version", () => {
  it("reports the shipping package's version to a connected client", async () => {
    // Asserted through a real initialize handshake rather than off the
    // constant, so re-hardcoding a literal in the McpServer constructor —
    // the original defect — fails here instead of only in the MLO-gated E2E.
    const client = await connectedClient();
    try {
      expect(client.getServerVersion()).toEqual({ name: "mlo-mcp", version: manifestVersion("package.json") });
    } finally {
      await client.close();
    }
  });

  it("keeps the hand-maintained manifests in step with it", () => {
    expect(manifestVersion("..", "package.json")).toBe(manifestVersion("package.json"));
    expect(manifestVersion("..", ".claude-plugin", "plugin.json")).toBe(manifestVersion("..", "package.json"));
  });
});
