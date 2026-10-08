import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Config } from "./config.js";
import { ConfirmationStore } from "./confirmation.js";
import { FilesDir } from "./files.js";
import { PocketBaseClient } from "./pocketbase.js";
import { auditTools } from "./tools/audit.js";
import { collectionTools } from "./tools/collections.js";
import { fileTools } from "./tools/files.js";
import { registerTools, type ToolContext } from "./tools/define.js";
import { recordTools } from "./tools/records.js";
import { systemTools } from "./tools/system.js";

export const VERSION = "0.1.0";

export function createServer(config: Config): { server: McpServer; context: ToolContext; tools: string[] } {
  const server = new McpServer(
    { name: "pocketbase-mcp", version: VERSION },
    {
      instructions: [
        `Tools to manage the PocketBase instance at ${config.url} as a superuser.`,
        config.readOnly
          ? "Read-only mode is on: write tools are not available."
          : config.requireConfirmation
            ? "Write tools use a two-step confirmation: show the returned preview to the user and only re-call with confirmationToken after they explicitly approve."
            : "",
        "Inspect a collection schema with pb_get_collection before writing to it. Prefer pb_batch for changes spanning many records.",
        `File tools read local uploads from and save downloads to ${config.filesDir}. To attach an image found on the web, pass its URL to pb_upload_file.`,
      ]
        .filter(Boolean)
        .join("\n"),
    },
  );
  const context: ToolContext = {
    config,
    client: new PocketBaseClient(config),
    confirmations: new ConfirmationStore(config.confirmationTtlMs),
    files: new FilesDir(config.filesDir),
  };
  const tools = registerTools(server, context, [...systemTools, ...recordTools, ...collectionTools, ...fileTools, ...auditTools]);
  return { server, context, tools };
}
