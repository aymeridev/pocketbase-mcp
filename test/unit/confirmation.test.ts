import { describe, expect, it } from "vitest";
import { ConfirmationStore, stableStringify } from "../../src/confirmation.js";

describe("stableStringify", () => {
  it("ignores key order and undefined values", () => {
    expect(stableStringify({ b: 1, a: { d: [1, 2], c: undefined } })).toBe(stableStringify({ a: { d: [1, 2] }, b: 1 }));
  });
});

describe("ConfirmationStore", () => {
  it("accepts a token once for the same tool and arguments", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("pb_delete_record", { collection: "posts", id: "a" });
    expect(store.consume(token, "pb_delete_record", { id: "a", collection: "posts" })).toBeNull();
    expect(store.consume(token, "pb_delete_record", { id: "a", collection: "posts" })).toMatch(/Unknown or expired/);
  });

  it("rejects a token used with different arguments or another tool", () => {
    const store = new ConfirmationStore(60_000);
    const { token } = store.issue("pb_delete_record", { collection: "posts", id: "a" });
    expect(store.consume(token, "pb_delete_record", { collection: "posts", id: "b" })).toMatch(/arguments differ/);
    expect(store.consume(token, "pb_delete_collection", { collection: "posts", id: "a" })).toMatch(/arguments differ/);
  });

  it("expires tokens", () => {
    let now = 0;
    const store = new ConfirmationStore(1000, () => now);
    const { token } = store.issue("t", {});
    now = 1001;
    expect(store.consume(token, "t", {})).toMatch(/expired/);
  });
});
