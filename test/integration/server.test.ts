import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import PocketBase from "pocketbase";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Requires a running PocketBase: PB_TEST_URL, PB_TEST_EMAIL, PB_TEST_PASSWORD (see scripts/test-pocketbase.sh).
const url = process.env.PB_TEST_URL;
const env = {
  PB_URL: url,
  PB_SUPERUSER_EMAIL: process.env.PB_TEST_EMAIL,
  PB_SUPERUSER_PASSWORD: process.env.PB_TEST_PASSWORD,
};
const COLLECTION = `mcp_test_${Date.now()}`;

async function connect(extraEnv: Record<string, string> = {}) {
  const { server } = createServer(loadConfig({ ...env, ...extraEnv }));
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[])[0].text;
    return { isError: Boolean(result.isError), body: JSON.parse(text) };
  };
  /** Runs a write tool through both confirmation steps. */
  const confirmed = async (name: string, args: Record<string, unknown>) => {
    const first = await call(name, args);
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    expect(first.body.status).toBe("confirmation_required");
    return call(name, { ...args, confirmationToken: first.body.confirmationToken });
  };
  return { client, call, confirmed };
}

describe.skipIf(!url)("pocketbase-mcp against a live PocketBase", () => {
  let mcp: Awaited<ReturnType<typeof connect>>;

  beforeAll(async () => {
    mcp = await connect();
  });

  afterAll(async () => {
    await mcp?.confirmed("pb_delete_collection", { collection: COLLECTION }).catch(() => undefined);
    await mcp?.client.close();
  });

  it("reports health", async () => {
    const { body } = await mcp.call("pb_health");
    expect(body.authenticated).toBe(true);
  });

  it("creates a collection only after confirmation", async () => {
    const definition = {
      name: COLLECTION,
      type: "base",
      listRule: "",
      createRule: "",
      fields: [
        { name: "title", type: "text", required: true },
        { name: "content", type: "text" },
        { name: "api_key", type: "text" },
      ],
    };
    const preview = await mcp.call("pb_create_collection", { definition });
    expect(preview.body.status).toBe("confirmation_required");
    const before = await mcp.call("pb_list_collections");
    expect(before.body.map((c: { name: string }) => c.name)).not.toContain(COLLECTION);

    const created = await mcp.call("pb_create_collection", { definition, confirmationToken: preview.body.confirmationToken });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    expect(created.body.name).toBe(COLLECTION);
  });

  it("rejects a token reused with different arguments", async () => {
    const preview = await mcp.call("pb_create_record", { collection: COLLECTION, data: { title: "a" } });
    const tampered = await mcp.call("pb_create_record", {
      collection: COLLECTION,
      data: { title: "b" },
      confirmationToken: preview.body.confirmationToken,
    });
    expect(tampered.isError).toBe(true);
  });

  it("creates, lists, updates and deletes records", async () => {
    const created = await mcp.confirmed("pb_create_record", { collection: COLLECTION, data: { title: "Bonjour", content: "Salut le monde" } });
    expect(created.isError, JSON.stringify(created.body)).toBe(false);
    const id = created.body.id;

    const list = await mcp.call("pb_list_records", { collection: COLLECTION, filter: 'title = "Bonjour"' });
    expect(list.body.totalItems).toBe(1);

    const updatePreview = await mcp.call("pb_update_record", { collection: COLLECTION, id, data: { content: "Hello world" } });
    expect(updatePreview.body.preview.changes).toEqual({ content: { before: "Salut le monde", after: "Hello world" } });
    const updated = await mcp.call("pb_update_record", {
      collection: COLLECTION,
      id,
      data: { content: "Hello world" },
      confirmationToken: updatePreview.body.confirmationToken,
    });
    expect(updated.body.content).toBe("Hello world");

    const deleted = await mcp.confirmed("pb_delete_record", { collection: COLLECTION, id });
    expect(deleted.body.deleted).toBe(true);
  });

  it("runs batch updates, sequentially when the Batch API is disabled", async () => {
    const ids: string[] = [];
    for (const title of ["un", "deux", "trois"]) {
      const r = await mcp.confirmed("pb_create_record", { collection: COLLECTION, data: { title, content: title } });
      ids.push(r.body.id);
    }
    const operations = ids.map((id, i) => ({ action: "update", collection: COLLECTION, id, data: { content: ["one", "two", "three"][i] } }));
    const preview = await mcp.call("pb_batch", { operations });
    expect(preview.body.preview.total).toBe(3);
    expect(preview.body.preview.details[0].changes.content).toEqual({ before: "un", after: "one" });

    const result = await mcp.call("pb_batch", { operations, confirmationToken: preview.body.confirmationToken });
    expect(result.isError, JSON.stringify(result.body)).toBe(false);
    expect(result.body.succeeded).toBe(3);

    expect(result.body.mode).toBe("sequential");

    const list = await mcp.call("pb_list_records", { collection: COLLECTION, sort: "content", fields: "content" });
    expect(list.isError, JSON.stringify(list.body)).toBe(false);
    expect(list.body.items.map((r: { content: string }) => r.content)).toEqual(["one", "three", "two"]);
  });

  it("runs batch operations atomically when the Batch API is enabled", async () => {
    const pb = new PocketBase(url);
    await pb.collection("_superusers").authWithPassword(env.PB_SUPERUSER_EMAIL!, env.PB_SUPERUSER_PASSWORD!);
    await pb.settings.update({ batch: { enabled: true, maxRequests: 50, timeout: 3, maxBodySize: 0 } });
    try {
      const operations = [
        { action: "create", collection: COLLECTION, data: { title: "ok" } },
        { action: "create", collection: COLLECTION, data: { content: "missing required title" } },
      ];
      const preview = await mcp.call("pb_batch", { operations });
      expect(preview.body.preview.mode).toMatch(/atomic/);
      const result = await mcp.call("pb_batch", { operations, confirmationToken: preview.body.confirmationToken });
      expect(result.isError).toBe(true);
      const list = await mcp.call("pb_list_records", { collection: COLLECTION, filter: 'title = "ok"' });
      expect(list.body.totalItems).toBe(0);
    } finally {
      await pb.settings.update({ batch: { enabled: false } });
    }
  });

  it("warns before dropping fields", async () => {
    const schema = await mcp.call("pb_get_collection", { collection: COLLECTION });
    const fields = schema.body.fields.filter((f: { name: string }) => f.name !== "api_key");
    const preview = await mcp.call("pb_update_collection", { collection: COLLECTION, changes: { fields } });
    expect(preview.body.preview.fieldsRemoved).toEqual(["api_key:text"]);
  });

  it("audits rules", async () => {
    const { body } = await mcp.call("pb_audit_collection_rules", { collection: COLLECTION });
    const findings = body.collections[0].findings;
    expect(findings.find((f: { target: string }) => f.target === "createRule").severity).toBe("critical");
    expect(findings.find((f: { target: string }) => f.target === "field:api_key").severity).toBe("medium");
  });

  it("hides write tools in read-only mode", async () => {
    const ro = await connect({ PB_READ_ONLY: "true" });
    const { tools } = await ro.client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("pb_list_records");
    expect(names).not.toContain("pb_delete_record");
    expect(names).not.toContain("pb_batch");
    expect(tools.every((t) => t.annotations?.readOnlyHint)).toBe(true);
    await ro.client.close();
  });

  it("follows a cross-origin redirect on PB_URL without losing the auth header", async () => {
    // Redirects every request to the same instance on another origin, like an http -> https redirect.
    const target = new URL(url!);
    target.hostname = target.hostname === "localhost" ? "127.0.0.1" : "localhost";
    const proxy = createHttpServer((req, res) => {
      res.writeHead(308, { location: `${target.origin}${req.url}` });
      res.end();
    });
    await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
    const port = (proxy.address() as AddressInfo).port;
    try {
      const redirected = await connect({ PB_URL: `http://127.0.0.1:${port}` });
      const health = await redirected.call("pb_health");
      expect(health.isError, JSON.stringify(health.body)).toBe(false);
      expect(health.body.warning).toMatch(/redirects to/);
      const list = await redirected.call("pb_list_collections");
      expect(list.isError, JSON.stringify(list.body)).toBe(false);
      await redirected.client.close();
    } finally {
      proxy.close();
    }
  });

  it("marks destructive tools for the client", async () => {
    const { tools } = await mcp.client.listTools();
    const del = tools.find((t) => t.name === "pb_delete_record");
    expect(del?.annotations?.destructiveHint).toBe(true);
    expect(del?.inputSchema.properties).toHaveProperty("confirmationToken");
  });
});
