import { createHash, randomBytes } from "node:crypto";

interface PendingConfirmation {
  tool: string;
  argsHash: string;
  expiresAt: number;
}

/** Deterministic JSON serialization (sorted object keys) used to bind a token to its exact arguments. */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v === undefined ? null : v)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.keys(value as Record<string, unknown>)
      .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

function hashArgs(args: unknown): string {
  return createHash("sha256").update(stableStringify(args)).digest("hex");
}

/**
 * Two-step confirmation for write operations: the first call returns a preview and a
 * single-use token; the operation only runs when called again with that token and the
 * exact same arguments.
 */
export class ConfirmationStore {
  private readonly pending = new Map<string, PendingConfirmation>();

  constructor(
    private readonly ttlMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  issue(tool: string, args: unknown): { token: string; expiresAt: string } {
    this.prune();
    const token = randomBytes(12).toString("hex");
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { tool, argsHash: hashArgs(args), expiresAt });
    return { token, expiresAt: new Date(expiresAt).toISOString() };
  }

  /** Validates and consumes a token. Returns an error message, or null when valid. */
  consume(token: string, tool: string, args: unknown): string | null {
    this.prune();
    const entry = this.pending.get(token);
    if (!entry) {
      return "Unknown or expired confirmation token. Call the tool again without confirmationToken to get a fresh preview.";
    }
    if (entry.tool !== tool || entry.argsHash !== hashArgs(args)) {
      return "The arguments differ from the previewed operation. Call the tool again without confirmationToken to preview the new arguments.";
    }
    this.pending.delete(token);
    return null;
  }

  private prune(): void {
    const now = this.now();
    for (const [token, entry] of this.pending) {
      if (entry.expiresAt <= now) this.pending.delete(token);
    }
  }
}
