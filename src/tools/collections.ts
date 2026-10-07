import { z } from "zod";
import type { CollectionModel } from "pocketbase";
import { defineTool } from "./define.js";
import { diffFields, type Json } from "./util.js";

const collection = z.string().min(1).describe("Collection name or id");

const collectionBody = z
  .record(z.string(), z.unknown())
  .describe(
    "Collection definition as accepted by the PocketBase API: name, type (base|auth|view), fields, indexes, listRule, viewRule, createRule, updateRule, deleteRule (null = superusers only, \"\" = public), viewQuery for view collections, and auth options for auth collections.",
  );

interface FieldLike {
  id?: string;
  name?: string;
  type?: string;
  system?: boolean;
}

/** Fields present in `current` that `nextFields` would drop (data in them is lost). */
export function removedFields(current: FieldLike[], nextFields: FieldLike[]): FieldLike[] {
  return current.filter(
    (f) => !f.system && !nextFields.some((n) => (n.id && n.id === f.id) || (!n.id && n.name === f.name)),
  );
}

export const listCollections = defineTool({
  name: "pb_list_collections",
  title: "List collections",
  kind: "read",
  description: "List collections with their type, field names and record rules summary.",
  input: {
    includeSystem: z.boolean().default(false).describe("Include system collections such as _superusers"),
  },
  run: async (args, { client }) => {
    const all = await client.run((pb) => pb.collections.getFullList({ sort: "name" }));
    return all
      .filter((c) => args.includeSystem || !c.system)
      .map((c) => ({
        id: c.id,
        name: c.name,
        type: c.type,
        system: c.system,
        fields: c.fields.filter((f) => f.name !== "id").map((f) => `${f.name}:${f.type}`),
      }));
  },
});

export const getCollection = defineTool({
  name: "pb_get_collection",
  title: "Get collection schema",
  kind: "read",
  description: "Get the full definition of a collection: fields with their options, indexes, API rules and auth options.",
  input: { collection },
  run: async (args, { client }) => client.run((pb) => pb.collections.getOne(args.collection)),
});

export const createCollection = defineTool({
  name: "pb_create_collection",
  title: "Create collection",
  kind: "write",
  description:
    "Create a new collection. Example: {\"name\":\"posts\",\"type\":\"base\",\"fields\":[{\"name\":\"title\",\"type\":\"text\",\"required\":true}],\"listRule\":\"\"}.",
  input: { definition: collectionBody },
  preview: async (args) => ({ action: "create collection", definition: args.definition }),
  run: async (args, { client }) => client.run((pb) => pb.collections.create(args.definition)),
});

export const updateCollection = defineTool({
  name: "pb_update_collection",
  title: "Update collection",
  kind: "destructive",
  description:
    "Update a collection (rename, rules, indexes, fields, options). Only provided keys change. When passing `fields`, pass the complete list: existing fields left out are deleted with their data. Fetch the schema with pb_get_collection first and keep field ids.",
  input: { collection, changes: collectionBody },
  preview: async (args, { client }) => {
    const current = await client.run((pb) => pb.collections.getOne(args.collection));
    const changes = { ...args.changes };
    const preview: Json = { action: "update collection", collection: current.name };
    if (Array.isArray(changes.fields)) {
      const removed = removedFields(current.fields, changes.fields as FieldLike[]);
      const added = (changes.fields as FieldLike[]).filter(
        (n) => !current.fields.some((f) => (n.id && n.id === f.id) || (!n.id && n.name === f.name)),
      );
      preview.fieldsAdded = added.map((f) => `${f.name}:${f.type}`);
      if (removed.length) {
        preview.fieldsRemoved = removed.map((f) => `${f.name}:${f.type}`);
        preview.warning = "Removed fields are dropped with all their data.";
      }
      preview.fieldsChanged = (changes.fields as FieldLike[])
        .map((n) => {
          const f = current.fields.find((c) => (n.id && n.id === c.id) || (!n.id && n.name === c.name));
          if (!f) return null;
          const d = diffFields(f as unknown as Json, n as Json);
          return Object.keys(d).length ? { field: f.name, changes: d } : null;
        })
        .filter(Boolean);
      delete changes.fields;
    }
    preview.changes = diffFields(current as unknown as Json, changes);
    return preview;
  },
  run: async (args, { client }) => client.run((pb) => pb.collections.update(args.collection, args.changes)),
});

export const deleteCollection = defineTool({
  name: "pb_delete_collection",
  title: "Delete collection",
  kind: "destructive",
  description: "Permanently delete a collection and all of its records.",
  input: { collection },
  preview: async (args, { client }) =>
    client.run(async (pb) => {
      const current: CollectionModel = await pb.collections.getOne(args.collection);
      const count =
        current.type === "view"
          ? undefined
          : (await pb.collection(current.name).getList(1, 1, { fields: "id" })).totalItems;
      return {
        action: "delete collection",
        collection: current.name,
        type: current.type,
        recordsDeleted: count,
        warning: "The collection and all its records will be permanently deleted.",
      };
    }),
  run: async (args, { client }) => {
    await client.run((pb) => pb.collections.delete(args.collection));
    return { deleted: true, collection: args.collection };
  },
});

export const collectionTools = [listCollections, getCollection, createCollection, updateCollection, deleteCollection];
