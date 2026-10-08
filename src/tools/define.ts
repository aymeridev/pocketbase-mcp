import { ClientResponseError } from "pocketbase";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Config } from "../config.js";
import type { ConfirmationStore } from "../confirmation.js";
import type { FilesDir } from "../files.js";
import type { PocketBaseClient } from "../pocketbase.js";

export interface ToolContext {
  client: PocketBaseClient;
  config: Config;
  confirmations: ConfirmationStore;
  files: FilesDir;
}

/** Returned by a tool's `run` to send MCP content (e.g. images) as is instead of JSON. */
export class RawResult {
  constructor(readonly result: CallToolResult) {}
}

/**
 * - `read`: never changes data, always exposed.
 * - `write`: creates or modifies data; hidden in read-only mode, needs confirmation.
 * - `destructive`: deletes or may lose data; same as `write`, flagged as destructive to the client.
 */
export type ToolKind = "read" | "write" | "destructive";

export interface ToolDefinition<S extends z.ZodRawShape = z.ZodRawShape> {
  name: string;
  title: string;
  description: string;
  kind: ToolKind;
  input: S;
  /** Describes what a write operation will do, shown to the user before confirming. */
  preview?: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
  run: (args: z.infer<z.ZodObject<S>>, ctx: ToolContext) => Promise<unknown>;
}

export function defineTool<S extends z.ZodRawShape>(def: ToolDefinition<S>): ToolDefinition<S> {
  return def;
}

function json(value: unknown, isError = false): CallToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

export function formatError(err: unknown): CallToolResult {
  if (err instanceof ClientResponseError) {
    return json(
      {
        error: err.message || "PocketBase request failed",
        status: err.status,
        url: err.url || undefined,
        details: Object.keys(err.response?.data ?? {}).length ? err.response.data : undefined,
      },
      true,
    );
  }
  return json({ error: err instanceof Error ? err.message : String(err) }, true);
}

const CONFIRMATION_FIELD = "confirmationToken";

export function registerTools(server: McpServer, ctx: ToolContext, defs: ToolDefinition<any>[]): string[] {
  const registered: string[] = [];
  for (const def of defs) {
    const isWrite = def.kind !== "read";
    if (isWrite && ctx.config.readOnly) continue;

    const needsConfirmation = isWrite && ctx.config.requireConfirmation;
    const input: z.ZodRawShape = needsConfirmation
      ? {
          ...def.input,
          [CONFIRMATION_FIELD]: z
            .string()
            .optional()
            .describe(
              "Leave empty on the first call to get a preview. After the user approves the preview, call again with the same arguments and this token.",
            ),
        }
      : def.input;

    const description = needsConfirmation
      ? `${def.description}\n\nThis operation requires confirmation: the first call returns a preview and a confirmationToken. Show the preview to the user, and only call again with the token once they explicitly approve.`
      : def.description;

    server.registerTool(
      def.name,
      {
        title: def.title,
        description,
        inputSchema: input,
        annotations: {
          title: def.title,
          readOnlyHint: !isWrite,
          destructiveHint: def.kind === "destructive",
          idempotentHint: def.kind === "read",
          openWorldHint: false,
        },
      },
      async (rawArgs: Record<string, unknown>) => {
        try {
          const { [CONFIRMATION_FIELD]: token, ...args } = rawArgs;
          if (needsConfirmation) {
            if (typeof token !== "string" || token === "") {
              const preview = def.preview ? await def.preview(args, ctx) : { arguments: args };
              const issued = ctx.confirmations.issue(def.name, args);
              return json({
                status: "confirmation_required",
                operation: def.name,
                preview,
                confirmationToken: issued.token,
                expiresAt: issued.expiresAt,
                instructions:
                  "Nothing has been changed yet. Present this preview to the user and wait for their explicit approval before calling this tool again with the same arguments plus confirmationToken.",
              });
            }
            const problem = ctx.confirmations.consume(token, def.name, args);
            if (problem) return json({ error: problem }, true);
          }
          const output = await def.run(args, ctx);
          return output instanceof RawResult ? output.result : json(output);
        } catch (err) {
          return formatError(err);
        }
      },
    );
    registered.push(def.name);
  }
  return registered;
}
