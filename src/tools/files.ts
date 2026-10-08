import { writeFile } from "node:fs/promises";
import { z } from "zod";
import type PocketBase from "pocketbase";
import type { RecordModel } from "pocketbase";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  INLINE_IMAGE_TYPES,
  MAX_INLINE_BYTES,
  formatBytes,
  isTextType,
  loadSource,
  mimeFromName,
  validateSource,
  type FilesDir,
  type LoadedFile,
} from "../files.js";
import { RawResult, defineTool } from "./define.js";
import { diffFields, truncateValues } from "./util.js";

const collection = z.string().min(1).describe("Collection name or id");
const recordId = z.string().min(1).describe("Record id");
const field = z.string().min(1).describe("Name of the file field");
const thumb = z
  .string()
  .regex(/^\d+x\d+[tbf]?$/)
  .optional()
  .describe(
    "Image thumbnail size such as `100x100`, `0x300` or `200x200f`. PocketBase serves the original unless the size is listed in the field's thumbs (100x100 always works).",
  );

/** Text returned inline is cut beyond this many characters. */
const MAX_INLINE_TEXT = 100_000;

interface FileField {
  name: string;
  type: string;
  maxSelect?: number;
  maxSize?: number;
  mimeTypes?: string[];
  protected?: boolean;
  thumbs?: string[];
}

async function getFileField(pb: PocketBase, coll: string, name: string): Promise<FileField> {
  const model = await pb.collections.getOne(coll);
  const fields = model.fields as unknown as FileField[];
  const found = fields.find((f) => f.name === name);
  const fileFields = fields.filter((f) => f.type === "file").map((f) => f.name);
  if (!found || found.type !== "file") {
    throw new Error(
      `${name} is not a file field of ${model.name}. File fields: ${fileFields.length ? fileFields.join(", ") : "none"}`,
    );
  }
  return found;
}

const isMultiple = (f: FileField) => (f.maxSelect ?? 1) > 1;

function filesOf(record: RecordModel, name: string): string[] {
  const value = record[name];
  if (Array.isArray(value)) return value as string[];
  return typeof value === "string" && value ? [value] : [];
}

function pickFile(files: string[], filename: string | undefined, fieldName: string): string {
  if (filename) {
    if (!files.includes(filename)) {
      throw new Error(`${filename} is not in ${fieldName}. Files: ${files.join(", ") || "none"}`);
    }
    return filename;
  }
  if (files.length === 1) return files[0];
  if (files.length === 0) throw new Error(`${fieldName} has no file`);
  throw new Error(`${fieldName} has ${files.length} files, set filename to one of: ${files.join(", ")}`);
}

async function fileUrls(
  pb: PocketBase,
  record: RecordModel,
  f: FileField,
  names: string[],
  thumbSize?: string,
): Promise<{ filename: string; url: string }[]> {
  const token = f.protected && names.length ? await pb.files.getToken() : undefined;
  return names.map((filename) => ({ filename, url: pb.files.getURL(record, filename, { thumb: thumbSize, token }) }));
}

export const getFileUrl = defineTool({
  name: "pb_get_file_url",
  title: "Get file URL",
  kind: "read",
  description:
    "Get the URL of the files stored in a record's file field (all of them, or one by filename). URLs of protected fields carry a short-lived access token.",
  input: {
    collection,
    recordId,
    field,
    filename: z.string().optional().describe("One file of the field; omit to get every file"),
    thumb,
  },
  run: async (args, { client }) =>
    client.run(async (pb) => {
      const f = await getFileField(pb, args.collection, args.field);
      const record = await pb.collection(args.collection).getOne(args.recordId);
      const all = filesOf(record, args.field);
      const names = args.filename ? [pickFile(all, args.filename, args.field)] : all;
      return {
        protected: Boolean(f.protected),
        note: f.protected ? "These URLs embed a file token that expires after a few minutes." : undefined,
        files: await fileUrls(pb, record, f, names, args.thumb),
      };
    }),
});

async function extractPdfText(data: Buffer): Promise<{ pages: number; text: string }> {
  const { extractText, getDocumentProxy } = await import("unpdf");
  const pdf = await getDocumentProxy(new Uint8Array(data));
  const { totalPages, text } = await extractText(pdf, { mergePages: true });
  return { pages: totalPages, text };
}

async function saveFile(dir: FilesDir, relative: string, data: Buffer): Promise<string> {
  const target = await dir.resolveForWrite(relative);
  await writeFile(target, data, { flag: "wx" });
  return target;
}

export const downloadFile = defineTool({
  name: "pb_download_file",
  title: "Download file",
  kind: "read",
  description:
    "Download a file from a record. Images (png, jpeg, gif, webp) are returned so you can see them, text files and PDFs as text. Set save to also write it to the local files folder; formats that cannot be shown (archives, video...) and files over 5 MB are always saved there instead.",
  input: {
    collection,
    recordId,
    field,
    filename: z.string().optional().describe("Required when the field holds several files"),
    thumb,
    save: z.boolean().default(false).describe("Also save the file to the local files folder"),
    saveAs: z.string().optional().describe("Path relative to the files folder; defaults to the stored file name"),
  },
  run: async (args, { client, files }) => {
    const { f, filename, url, data, type } = await client.run(async (pb) => {
      const f = await getFileField(pb, args.collection, args.field);
      const record = await pb.collection(args.collection).getOne(args.recordId);
      const filename = pickFile(filesOf(record, args.field), args.filename, args.field);
      const token = await pb.files.getToken();
      const url = pb.files.getURL(record, filename, { thumb: args.thumb });
      const response = await fetch(pb.files.getURL(record, filename, { thumb: args.thumb, token }));
      if (!response.ok) throw new Error(`Download failed: HTTP ${response.status}`);
      const data = Buffer.from(await response.arrayBuffer());
      const header = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      const type = header && header !== "application/octet-stream" ? header : (mimeFromName(filename) ?? "application/octet-stream");
      return { f, filename, url, data, type };
    });

    const content: CallToolResult["content"] = [];
    const notes: string[] = [];
    let inline = false;
    if (data.length > MAX_INLINE_BYTES) {
      notes.push(`Larger than ${formatBytes(MAX_INLINE_BYTES)}, not returned inline${INLINE_IMAGE_TYPES.has(type) ? "; use thumb for a smaller image" : ""}.`);
    } else if (INLINE_IMAGE_TYPES.has(type)) {
      content.push({ type: "image", data: data.toString("base64"), mimeType: type });
      inline = true;
    } else if (isTextType(type)) {
      const text = data.toString("utf8");
      content.push({ type: "text", text: text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n… (truncated, ${text.length} chars)` : text });
      inline = true;
    } else if (type === "application/pdf") {
      const { pages, text } = await extractPdfText(data);
      if (text.trim()) {
        content.push({ type: "text", text: text.length > MAX_INLINE_TEXT ? `${text.slice(0, MAX_INLINE_TEXT)}\n… (truncated, ${text.length} chars)` : text });
        notes.push(`Text extracted from ${pages} PDF page(s).`);
        inline = true;
      } else {
        notes.push("The PDF has no extractable text (probably scanned).");
      }
    } else {
      notes.push(`${type} cannot be shown inline.`);
    }

    let savedTo: string | undefined;
    if (args.save || !inline) {
      savedTo = await saveFile(files, args.saveAs ?? filename, data);
    }

    const meta = {
      filename,
      type,
      size: formatBytes(data.length),
      protected: Boolean(f.protected),
      url: f.protected ? undefined : url,
      savedTo,
      notes: notes.length ? notes : undefined,
    };
    return new RawResult({ content: [{ type: "text", text: JSON.stringify(meta, null, 2) }, ...content] });
  },
});

const fileSource = z.object({
  path: z.string().optional().describe("Local file, relative to the files folder (PB_FILES_DIR) or absolute inside it"),
  url: z.string().optional().describe("http(s) URL to download the file from, e.g. an image found on the web"),
  base64: z.string().optional().describe("File content as base64 or a data: URL, e.g. a file you generated"),
  filename: z.string().optional().describe("Name to store the file under; required with plain base64"),
});

const uploadInput = {
  collection,
  recordId: z.string().optional().describe("Record to attach the files to. Omit to create a new record."),
  field,
  files: z.array(fileSource).min(1).max(10).describe("Files to upload, each from exactly one of path, url or base64"),
  mode: z
    .enum(["append", "replace"])
    .default("append")
    .describe("For multi-file fields on an existing record: keep the current files (append) or replace them all"),
  data: z
    .record(z.string(), z.unknown())
    .optional()
    .describe("Other field values to set at the same time, e.g. the title of a new record"),
};

type UploadArgs = z.infer<z.ZodObject<typeof uploadInput>>;

async function loadAll(args: UploadArgs, dir: FilesDir): Promise<LoadedFile[]> {
  args.files.forEach((src, i) => validateSource(src, i));
  const loaded: LoadedFile[] = [];
  for (const src of args.files) loaded.push(await loadSource(src, dir));
  return loaded;
}

function uploadPlan(f: FileField, current: string[], incoming: LoadedFile[], args: UploadArgs) {
  const multiple = isMultiple(f);
  if (!multiple && incoming.length > 1) {
    throw new Error(`${f.name} holds a single file, got ${incoming.length}`);
  }
  const replacing = !args.recordId ? [] : !multiple || args.mode === "replace" ? current : [];
  const total = current.length - replacing.length + incoming.length;
  const warnings: string[] = [];
  const maxSize = f.maxSize || 5 * 1024 * 1024;
  for (const file of incoming) {
    if (f.mimeTypes?.length && !f.mimeTypes.includes(file.type)) {
      warnings.push(`${file.name} is ${file.type}, the field only accepts ${f.mimeTypes.join(", ")}`);
    }
    if (file.size > maxSize) {
      warnings.push(`${file.name} is ${formatBytes(file.size)}, over the field limit of ${formatBytes(maxSize)}`);
    }
  }
  if (multiple && f.maxSelect && total > f.maxSelect) {
    warnings.push(`${f.name} would hold ${total} files, over its limit of ${f.maxSelect}`);
  }
  return { multiple, replacing, warnings };
}

export const uploadFile = defineTool({
  name: "pb_upload_file",
  title: "Upload file",
  kind: "write",
  description:
    "Upload files into a record's file field, from a local file, a URL or base64 content. Attaches to an existing record, or creates a new record when recordId is omitted (pass its other fields in data). To add an image found with a web search, pass the image URL.",
  input: uploadInput,
  preview: async (args, { client, files }) => {
    const incoming = await loadAll(args, files);
    return client.run(async (pb) => {
      const f = await getFileField(pb, args.collection, args.field);
      const record = args.recordId ? await pb.collection(args.collection).getOne(args.recordId) : undefined;
      const current = record ? filesOf(record, args.field) : [];
      const plan = uploadPlan(f, current, incoming, args);
      return {
        action: record ? "upload to existing record" : "create record with files",
        collection: args.collection,
        recordId: args.recordId,
        field: args.field,
        files: incoming.map((file) => ({ name: file.name, type: file.type, size: formatBytes(file.size), from: file.origin })),
        replacedFiles: plan.replacing.length ? plan.replacing : undefined,
        keptFiles: record && plan.multiple && args.mode === "append" && current.length ? current : undefined,
        data: args.data ? truncateValues(record ? diffFields(record, args.data) : args.data) : undefined,
        warnings: plan.warnings.length ? plan.warnings : undefined,
      };
    });
  },
  run: async (args, { client, files }) => {
    const incoming = await loadAll(args, files);
    return client.run(async (pb) => {
      const f = await getFileField(pb, args.collection, args.field);
      const service = pb.collection(args.collection);
      const current = args.recordId ? filesOf(await service.getOne(args.recordId), args.field) : [];
      const plan = uploadPlan(f, current, incoming, args);
      const blobs = incoming.map((file) => new File([new Uint8Array(file.data)], file.name, { type: file.type }));
      const body: Record<string, unknown> = { ...args.data };
      if (!plan.multiple) body[args.field] = blobs[0];
      else if (args.recordId && args.mode === "append") body[`${args.field}+`] = blobs;
      else body[args.field] = blobs;

      const record = args.recordId ? await service.update(args.recordId, body) : await service.create(body);
      const after = filesOf(record, args.field);
      const added = after.filter((name) => !current.includes(name));
      return {
        recordId: record.id,
        created: !args.recordId,
        field: args.field,
        uploaded: await fileUrls(pb, record, f, added),
        files: after,
      };
    });
  },
});

export const deleteFile = defineTool({
  name: "pb_delete_file",
  title: "Delete file",
  kind: "destructive",
  description: "Remove files from a record's file field (the record itself is kept). Omit filenames to empty the field.",
  input: {
    collection,
    recordId,
    field,
    filenames: z.array(z.string().min(1)).optional().describe("Stored file names to remove; omit to remove every file"),
  },
  preview: async (args, { client }) =>
    client.run(async (pb) => {
      await getFileField(pb, args.collection, args.field);
      const current = filesOf(await pb.collection(args.collection).getOne(args.recordId), args.field);
      const removing = args.filenames ?? current;
      const missing = removing.filter((name) => !current.includes(name));
      if (missing.length) throw new Error(`Not in ${args.field}: ${missing.join(", ")}. Files: ${current.join(", ") || "none"}`);
      if (!removing.length) throw new Error(`${args.field} has no file to remove`);
      return {
        action: "delete files",
        collection: args.collection,
        recordId: args.recordId,
        field: args.field,
        removing,
        keeping: current.filter((name) => !removing.includes(name)),
      };
    }),
  run: async (args, { client }) =>
    client.run(async (pb) => {
      const f = await getFileField(pb, args.collection, args.field);
      const service = pb.collection(args.collection);
      const body = args.filenames
        ? { [`${args.field}-`]: args.filenames }
        : { [args.field]: isMultiple(f) ? [] : "" };
      const record = await service.update(args.recordId, body);
      return { recordId: record.id, field: args.field, files: filesOf(record, args.field) };
    }),
});

export const fileTools = [getFileUrl, downloadFile, uploadFile, deleteFile];
