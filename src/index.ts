#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig } from "./config.js";
import { createServer } from "./server.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const { server, tools } = createServer(config);
  await server.connect(new StdioServerTransport());
  // stdout carries the MCP protocol, so logs go to stderr.
  console.error(
    `pocketbase-mcp connected to ${config.url} (${tools.length} tools${config.readOnly ? ", read-only" : ""})`,
  );
}

main().catch((err) => {
  console.error(`pocketbase-mcp: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
