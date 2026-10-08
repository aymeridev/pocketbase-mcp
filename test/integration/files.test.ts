import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { createServer as createHttpServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "../../src/config.js";
import { createServer } from "../../src/server.js";

// Requires a running PocketBase: PB_TEST_URL, PB_TEST_EMAIL, PB_TEST_PASSWORD (see scripts/test-pocketbase.sh).
const url = process.env.PB_TEST_URL;
const COLLECTION = `mcp_files_${Date.now()}`;
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
  "base64",
);

function minimalPdf(text: string): Buffer {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 100] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${`BT /F1 12 Tf 10 50 Td (${text}) Tj ET`.length} >>\nstream\nBT /F1 12 Tf 10 50 Td (${text}) Tj ET\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  out += offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe.skipIf(!url)("file tools against a live PocketBase", () => {
  let client: Client;
  let filesDir: string;
  let imageServer: Server;
  let imageUrl: string;

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const content = result.content as { type: string; text?: string; data?: string; mimeType?: string }[];
    return { isError: Boolean(result.isError), body: JSON.parse(content[0].text!), content };
  };
  const confirmed = async (name: string, args: Record<string, unknown>) => {
    const first = await call(name, args);
    expect(first.isError, JSON.stringify(first.body)).toBe(false);
    expect(first.body.status).toBe("confirmation_required");
    const second = await call(name, { ...args, confirmationToken: first.body.confirmationToken });
    expect(second.isError, JSON.stringify(second.body)).toBe(false);
    return { preview: first.body.preview, ...second };
  };

  beforeAll(async () => {
    filesDir = await mkdtemp(path.join(tmpdir(), "pbmcp-files-"));
    const { server } = createServer(
      loadConfig({
        PB_URL: url,
        PB_SUPERUSER_EMAIL: process.env.PB_TEST_EMAIL,
        PB_SUPERUSER_PASSWORD: process.env.PB_TEST_PASSWORD,
        PB_FILES_DIR: filesDir,
      }),
    );
    client = new Client({ name: "test", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Stands in for an image found on the web.
    imageServer = createHttpServer((_req, res) => {
      res.writeHead(200, { "content-type": "image/png" });
      res.end(PNG);
    });
    await new Promise<void>((resolve) => imageServer.listen(0, "127.0.0.1", resolve));
    imageUrl = `http://127.0.0.1:${(imageServer.address() as AddressInfo).port}/images/maison`;

    await confirmed("pb_create_collection", {
      definition: {
        name: COLLECTION,
        type: "base",
        fields: [
          { name: "title", type: "text" },
          { name: "cover", type: "file", maxSelect: 1, mimeTypes: ["image/png", "image/jpeg"] },
          { name: "docs", type: "file", maxSelect: 5, protected: true },
        ],
      },
    });
  });

  afterAll(async () => {
    await confirmed("pb_delete_collection", { collection: COLLECTION }).catch(() => undefined);
    imageServer?.close();
    await client?.close();
  });

  let recordId: string;

  it("creates a record with an image downloaded from a URL", async () => {
    const result = await confirmed("pb_upload_file", {
      collection: COLLECTION,
      field: "cover",
      files: [{ url: imageUrl }],
      data: { title: "Maison" },
    });
    expect(result.preview.files[0]).toMatchObject({ name: "maison.png", type: "image/png" });
    expect(result.body.created).toBe(true);
    expect(result.body.uploaded[0].url).toMatch(/maison_\w+\.png$/);
    recordId = result.body.recordId;
  });

  it("returns images inline so the model can see them", async () => {
    const { body, content } = await call("pb_download_file", { collection: COLLECTION, recordId, field: "cover" });
    expect(body.type).toBe("image/png");
    expect(content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(Buffer.from(content[1].data!, "base64").equals(PNG)).toBe(true);
  });

  it("appends to a protected multi-file field from local and inline sources", async () => {
    await writeFile(path.join(filesDir, "notes.txt"), "Bonjour depuis le disque");
    const first = await confirmed("pb_upload_file", {
      collection: COLLECTION,
      recordId,
      field: "docs",
      files: [{ path: "notes.txt" }, { base64: minimalPdf("Hello PDF").toString("base64"), filename: "rapport.pdf" }],
    });
    expect(first.body.files).toHaveLength(2);

    const second = await confirmed("pb_upload_file", {
      collection: COLLECTION,
      recordId,
      field: "docs",
      files: [{ base64: "data:text/csv;base64,YSxiCjEsMg==", filename: "data" }],
    });
    expect(second.preview.keptFiles).toHaveLength(2);
    expect(second.body.files).toHaveLength(3);
  });

  it("rejects local paths outside the files folder", async () => {
    const { isError, body } = await call("pb_upload_file", {
      collection: COLLECTION,
      recordId,
      field: "docs",
      files: [{ path: "/etc/hostname" }],
    });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/outside/);
  });

  it("gives tokenized URLs for protected files", async () => {
    const { body } = await call("pb_get_file_url", { collection: COLLECTION, recordId, field: "docs" });
    expect(body.protected).toBe(true);
    expect(body.files).toHaveLength(3);
    expect(body.files[0].url).toMatch(/token=/);
    expect((await fetch(body.files[0].url)).status).toBe(200);
  });

  it("downloads text and PDF content, and saves to disk", async () => {
    const { body: urls } = await call("pb_get_file_url", { collection: COLLECTION, recordId, field: "docs" });
    const names: string[] = urls.files.map((f: { filename: string }) => f.filename);
    const txt = names.find((n) => n.startsWith("notes"))!;
    const pdf = names.find((n) => n.startsWith("rapport"))!;

    const text = await call("pb_download_file", { collection: COLLECTION, recordId, field: "docs", filename: txt, save: true });
    expect(text.content[1].text).toBe("Bonjour depuis le disque");
    expect(await readFile(text.body.savedTo, "utf8")).toBe("Bonjour depuis le disque");
    expect(path.dirname(text.body.savedTo)).toBe(await import("node:fs/promises").then((fs) => fs.realpath(filesDir)));

    const doc = await call("pb_download_file", { collection: COLLECTION, recordId, field: "docs", filename: pdf });
    expect(doc.content[1].text).toContain("Hello PDF");

    const ambiguous = await call("pb_download_file", { collection: COLLECTION, recordId, field: "docs" });
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.body.error).toMatch(/set filename/);
  });

  it("deletes one file, then empties a field", async () => {
    const { body: urls } = await call("pb_get_file_url", { collection: COLLECTION, recordId, field: "docs" });
    const first = urls.files[0].filename;
    const one = await confirmed("pb_delete_file", { collection: COLLECTION, recordId, field: "docs", filenames: [first] });
    expect(one.preview.keeping).toHaveLength(2);
    expect(one.body.files).toHaveLength(2);
    expect(one.body.files).not.toContain(first);

    const cover = await confirmed("pb_delete_file", { collection: COLLECTION, recordId, field: "cover" });
    expect(cover.body.files).toEqual([]);
  });

  it("explains which fields hold files", async () => {
    const { isError, body } = await call("pb_get_file_url", { collection: COLLECTION, recordId, field: "title" });
    expect(isError).toBe(true);
    expect(body.error).toMatch(/File fields: cover, docs/);
  });
});
