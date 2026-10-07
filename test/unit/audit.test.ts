import { describe, expect, it } from "vitest";
import { auditCollection } from "../../src/audit.js";

const severityOf = (report: ReturnType<typeof auditCollection>, target: string) =>
  report.findings.find((f) => f.target === target)?.severity;

describe("auditCollection", () => {
  it("flags public write rules as critical and locked rules as info", () => {
    const report = auditCollection({
      name: "posts",
      type: "base",
      listRule: "",
      viewRule: "",
      createRule: "",
      updateRule: null,
      deleteRule: null,
    });
    expect(severityOf(report, "createRule")).toBe("critical");
    expect(severityOf(report, "listRule")).toBe("low");
    expect(severityOf(report, "updateRule")).toBe("info");
    expect(report.findings[0].severity).toBe("critical");
  });

  it("flags auth collections exposing users or letting anyone manage them", () => {
    const report = auditCollection({
      name: "users",
      type: "auth",
      listRule: "",
      viewRule: 'id = @request.auth.id',
      createRule: "",
      updateRule: '@request.auth.id != ""',
      deleteRule: "id = @request.auth.id",
      authRule: "",
      manageRule: "",
    });
    expect(severityOf(report, "listRule")).toBe("high");
    expect(severityOf(report, "createRule")).toBe("medium");
    expect(severityOf(report, "updateRule")).toBe("high");
    expect(severityOf(report, "manageRule")).toBe("critical");
    expect(severityOf(report, "authRule")).toBe("info");
  });

  it("flags write rules that ignore the authenticated user", () => {
    const report = auditCollection({ name: "x", type: "base", updateRule: 'status = "draft"' });
    expect(severityOf(report, "updateRule")).toBe("high");
  });

  it("only audits list and view rules on view collections", () => {
    const report = auditCollection({ name: "stats", type: "view", listRule: null, viewRule: null, createRule: "" });
    expect(Object.keys(report.rules)).toEqual(["listRule", "viewRule"]);
  });

  it("flags visible fields with sensitive names", () => {
    const report = auditCollection({
      name: "integrations",
      type: "base",
      fields: [
        { name: "api_key", type: "text" },
        { name: "secret", type: "text", hidden: true },
        { name: "title", type: "text" },
      ],
    });
    expect(severityOf(report, "field:api_key")).toBe("medium");
    expect(severityOf(report, "field:secret")).toBeUndefined();
    expect(severityOf(report, "field:title")).toBeUndefined();
  });
});
