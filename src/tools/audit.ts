import { z } from "zod";
import { auditCollection, type AuditableCollection } from "../audit.js";
import { defineTool } from "./define.js";

export const auditRules = defineTool({
  name: "pb_audit_collection_rules",
  title: "Audit API rules",
  kind: "read",
  description:
    "Audit the API rules (permissions) and sensitive fields of one collection, or of all non-system collections when `collection` is omitted. Returns the raw rules and findings ranked by severity (critical, high, medium, low, info). Explain the findings to the user and suggest fixes; do not apply them without asking.",
  input: {
    collection: z.string().optional().describe("Collection name or id; omit to audit every non-system collection"),
  },
  run: async (args, { client }) =>
    client.run(async (pb) => {
      const targets = args.collection
        ? [await pb.collections.getOne(args.collection)]
        : (await pb.collections.getFullList({ sort: "name" })).filter((c) => !c.system);
      const reports = targets.map((c) => auditCollection(c as unknown as AuditableCollection));
      const counts: Record<string, number> = {};
      for (const r of reports) for (const f of r.findings) counts[f.severity] = (counts[f.severity] ?? 0) + 1;
      return { summary: counts, collections: reports };
    }),
});

export const auditTools = [auditRules];
