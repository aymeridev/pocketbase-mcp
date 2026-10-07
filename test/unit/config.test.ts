import { describe, expect, it } from "vitest";
import { loadConfig } from "../../src/config.js";

describe("loadConfig", () => {
  it("requires a URL and credentials", () => {
    expect(() => loadConfig({})).toThrow(/PB_URL/);
    expect(() => loadConfig({ PB_URL: "http://x" })).toThrow(/PB_SUPERUSER_EMAIL/);
  });

  it("parses flags with safe defaults", () => {
    const config = loadConfig({ PB_URL: "http://x/", PB_SUPERUSER_EMAIL: "a@b.c", PB_SUPERUSER_PASSWORD: "p" });
    expect(config).toMatchObject({ url: "http://x", readOnly: false, requireConfirmation: true, confirmationTtlMs: 300_000 });
    const ro = loadConfig({ PB_URL: "http://x", PB_SUPERUSER_TOKEN: "t", PB_READ_ONLY: "true", PB_REQUIRE_CONFIRMATION: "false" });
    expect(ro).toMatchObject({ readOnly: true, requireConfirmation: false });
  });
});
