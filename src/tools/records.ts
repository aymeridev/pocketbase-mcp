import { z } from "zod";
import type PocketBase from "pocketbase";
import { defineTool } from "./define.js";
import { diffFields, truncateValues, type Json } from "./util.js";

const collection = z.string().min(1).describe("Collection name or id");
const recordId = z.string().min(1).describe("Record id");
const recordData = z
  .record(z.string(), z.unknown())
  .describe("Field values. Relation fields take record ids; `field+`/`field-` modifiers are supported.");
const expand = z.string().optional().describe("Relations to expand, e.g. `author,comments_via_post`");
const fields = z.string().optional().describe("Comma-separated fields to return, e.g. `id,title,expand.author.name`");

async function getRecordOrNull(pb: PocketBase, coll: string, id: string): Promise<Json | null> {
  try {
    return await pb.collection(coll).getOne(id);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

export const listRecords = defineTool({
  name: "pb_list_records",
  title: "List records",
  kind: "read",
  description:
    "List records of a collection with optional PocketBase filter, sort and pagination. Use `filter` with PocketBase syntax (e.g. `status = \"published\" && created >= \"2024-01-01\"`).",
  input: {
    collection,
    filter: z.string().optional().describe("PocketBase filter expression"),
    sort: z.string().optional().describe("Sort expression, e.g. `-created,title`"),
    page: z.number().int().min(1).default(1),
    perPage: z.number().int().min(1).max(500).default(50),
    expand,
    fields,
    skipTotal: z.boolean().default(false).describe("Skip counting the total (faster on large collections)"),
  },
  run: async (args, { client }) =>
    client.run((pb) =>
      pb.collection(args.collection).getList(args.page, args.perPage, {
        filter: args.filter,
        sort: args.sort,
        expand: args.expand,
        fields: args.fields,
        skipTotal: args.skipTotal,
      }),
    ),
});

export const getRecord = defineTool({
  name: "pb_get_record",
  title: "Get record",
  kind: "read",
  description: "Fetch a single record by id.",
  input: { collection, id: recordId, expand, fields },
  run: async (args, { client }) =>
    client.run((pb) => pb.collection(args.collection).getOne(args.id, { expand: args.expand, fields: args.fields })),
});

export const createRecord = defineTool({
  name: "pb_create_record",
  title: "Create record",
  kind: "write",
  description: "Create a new record in a collection.",
  input: { collection, data: recordData },
  preview: async (args) => ({ action: "create", collection: args.collection, data: truncateValues(args.data) }),
  run: async (args, { client }) => client.run((pb) => pb.collection(args.collection).create(args.data)),
});

export const updateRecord = defineTool({
  name: "pb_update_record",
  title: "Update record",
  kind: "write",
  description: "Update fields of an existing record. Only the provided fields are changed.",
  input: { collection, id: recordId, data: recordData },
  preview: async (args, { client }) => {
    const current = await client.run((pb) => getRecordOrNull(pb, args.collection, args.id));
    if (!current) throw new Error(`Record ${args.id} not found in ${args.collection}`);
    return {
      action: "update",
      collection: args.collection,
      id: args.id,
      changes: truncateValues(diffFields(current, args.data)),
    };
  },
  run: async (args, { client }) => client.run((pb) => pb.collection(args.collection).update(args.id, args.data)),
});

export const deleteRecord = defineTool({
  name: "pb_delete_record",
  title: "Delete record",
  kind: "destructive",
  description: "Permanently delete a record (cascade deletes may apply through relations).",
  input: { collection, id: recordId },
  preview: async (args, { client }) => {
    const current = await client.run((pb) => getRecordOrNull(pb, args.collection, args.id));
    if (!current) throw new Error(`Record ${args.id} not found in ${args.collection}`);
    return { action: "delete", collection: args.collection, record: truncateValues(current) };
  },
  run: async (args, { client }) => {
    await client.run((pb) => pb.collection(args.collection).delete(args.id));
    return { deleted: true, collection: args.collection, id: args.id };
  },
});

const batchOperation = z.object({
  action: z.enum(["create", "update", "upsert", "delete"]),
  collection,
  id: z.string().optional().describe("Required for update and delete"),
  data: z.record(z.string(), z.unknown()).optional().describe("Required for create, update and upsert"),
});
type BatchOperation = z.infer<typeof batchOperation>;

function validateOperations(ops: BatchOperation[]): void {
  ops.forEach((op, i) => {
    if ((op.action === "update" || op.action === "delete") && !op.id) {
      throw new Error(`Operation #${i} (${op.action}) requires an id`);
    }
    if (op.action !== "delete" && !op.data) {
      throw new Error(`Operation #${i} (${op.action}) requires data`);
    }
  });
}

async function batchSettings(pb: PocketBase): Promise<{ enabled: boolean; maxRequests: number }> {
  const settings = (await pb.settings.getAll()) as { batch?: { enabled?: boolean; maxRequests?: number } };
  return { enabled: Boolean(settings.batch?.enabled), maxRequests: settings.batch?.maxRequests ?? 50 };
}

const PREVIEW_DETAIL_LIMIT = 20;

export const batchRecords = defineTool({
  name: "pb_batch",
  title: "Batch record operations",
  kind: "destructive",
  description:
    "Run many create/update/upsert/delete operations at once, e.g. to translate or fix a field across many records. Runs atomically in one transaction when the PocketBase Batch API is enabled and the operation count fits its limit; otherwise runs sequentially and reports each result.",
  input: {
    operations: z.array(batchOperation).min(1).max(1000),
  },
  preview: async (args, { client }) => {
    validateOperations(args.operations);
    return client.run(async (pb) => {
      const { enabled, maxRequests } = await batchSettings(pb);
      const atomic = enabled && args.operations.length <= maxRequests;
      const summary: Record<string, number> = {};
      for (const op of args.operations) {
        const key = `${op.action} ${op.collection}`;
        summary[key] = (summary[key] ?? 0) + 1;
      }
      const details = [];
      for (const op of args.operations.slice(0, PREVIEW_DETAIL_LIMIT)) {
        if (op.action === "update" || op.action === "delete") {
          const current = await getRecordOrNull(pb, op.collection, op.id!);
          if (!current) {
            details.push({ ...op, warning: "record not found" });
          } else if (op.action === "update") {
            details.push({ action: op.action, collection: op.collection, id: op.id, changes: diffFields(current, op.data!) });
          } else {
            details.push({ action: op.action, collection: op.collection, record: current });
          }
        } else {
          details.push(op);
        }
      }
      return {
        total: args.operations.length,
        summary,
        mode: atomic ? "atomic (single transaction)" : "sequential (not atomic)",
        modeReason: atomic
          ? undefined
          : enabled
            ? `More than ${maxRequests} operations (the Batch API limit); split into smaller calls for atomicity.`
            : "The Batch API is disabled in PocketBase settings.",
        details: truncateValues(details),
        detailsOmitted: Math.max(0, args.operations.length - PREVIEW_DETAIL_LIMIT),
      };
    });
  },
  run: async (args, { client }) => {
    validateOperations(args.operations);
    return client.run(async (pb) => {
      const { enabled, maxRequests } = await batchSettings(pb);
      if (enabled && args.operations.length <= maxRequests) {
        const batch = pb.createBatch();
        for (const op of args.operations) {
          const target = batch.collection(op.collection);
          if (op.action === "create") target.create(op.data!);
          else if (op.action === "update") target.update(op.id!, op.data!);
          else if (op.action === "upsert") target.upsert(op.data!);
          else target.delete(op.id!);
        }
        const results = await batch.send();
        return { mode: "atomic", succeeded: results.length, results };
      }

      const results = [];
      for (const [index, op] of args.operations.entries()) {
        try {
          const service = pb.collection(op.collection);
          let body: unknown;
          if (op.action === "create") body = await service.create(op.data!);
          else if (op.action === "update") body = await service.update(op.id!, op.data!);
          else if (op.action === "upsert") {
            const id = op.data!.id as string | undefined;
            const exists = id ? await getRecordOrNull(pb, op.collection, id) : null;
            body = exists ? await service.update(id!, op.data!) : await service.create(op.data!);
          } else {
            await service.delete(op.id!);
            body = { deleted: true };
          }
          results.push({ index, ok: true, id: (body as Json)?.id ?? op.id });
        } catch (err) {
          results.push({ index, ok: false, error: err instanceof Error ? err.message : String(err), details: (err as { response?: { data?: unknown } }).response?.data });
        }
      }
      const failed = results.filter((r) => !r.ok).length;
      return { mode: "sequential", succeeded: results.length - failed, failed, results: failed ? results.filter((r) => !r.ok) : undefined };
    });
  },
});

export const recordTools = [listRecords, getRecord, createRecord, updateRecord, deleteRecord, batchRecords];
