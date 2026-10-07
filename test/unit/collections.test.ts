import { describe, expect, it } from "vitest";
import { removedFields } from "../../src/tools/collections.js";

describe("removedFields", () => {
  it("detects non-system fields missing from the new list", () => {
    const current = [
      { id: "1", name: "id", type: "text", system: true },
      { id: "2", name: "title", type: "text" },
      { id: "3", name: "body", type: "editor" },
    ];
    expect(removedFields(current, [{ id: "2", name: "headline", type: "text" }]).map((f) => f.name)).toEqual(["body"]);
    expect(removedFields(current, [{ name: "title" }, { name: "body" }])).toEqual([]);
  });
});
