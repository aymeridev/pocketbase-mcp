import PocketBase, { ClientResponseError } from "pocketbase";
import type { Config } from "./config.js";

/**
 * Wraps a PocketBase SDK client authenticated as a superuser.
 * Authentication is lazy so the MCP server can start even when the instance is unreachable.
 */
export class PocketBaseClient {
  readonly pb: PocketBase;
  private authPromise?: Promise<void>;

  constructor(private readonly config: Config) {
    this.pb = new PocketBase(config.url);
    this.pb.autoCancellation(false);
    if (config.token) {
      this.pb.authStore.save(config.token, null);
    }
  }

  get baseUrl(): string {
    return this.config.url;
  }

  private async authenticate(): Promise<void> {
    if (this.config.email && this.config.password) {
      await this.pb
        .collection("_superusers")
        .authWithPassword(this.config.email, this.config.password, {
          // Re-authenticates automatically when the token is about to expire.
          autoRefreshThreshold: 30 * 60,
        });
      return;
    }
    // Token-only mode: nothing to refresh, PocketBase will reject it once expired.
    if (!this.pb.authStore.isValid) {
      throw new Error("PB_SUPERUSER_TOKEN is invalid or expired");
    }
  }

  async ensureAuth(): Promise<void> {
    if (this.pb.authStore.isValid) return;
    this.authPromise ??= this.authenticate().finally(() => {
      this.authPromise = undefined;
    });
    await this.authPromise;
  }

  /** Runs `fn` with an authenticated client, re-authenticating once on 401. */
  async run<T>(fn: (pb: PocketBase) => Promise<T>): Promise<T> {
    await this.ensureAuth();
    try {
      return await fn(this.pb);
    } catch (err) {
      if (err instanceof ClientResponseError && err.status === 401 && this.config.email) {
        this.pb.authStore.clear();
        await this.ensureAuth();
        return await fn(this.pb);
      }
      throw err;
    }
  }
}
