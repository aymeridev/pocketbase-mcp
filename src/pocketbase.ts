import PocketBase, { ClientResponseError } from "pocketbase";
import type { Config } from "./config.js";

/**
 * Wraps a PocketBase SDK client authenticated as a superuser.
 * Authentication is lazy so the MCP server can start even when the instance is unreachable.
 */
export class PocketBaseClient {
  readonly pb: PocketBase;
  private authPromise?: Promise<void>;
  private resolvePromise?: Promise<void>;
  /** Set when PB_URL redirects elsewhere (typically http -> https). */
  redirectWarning?: string;

  constructor(private readonly config: Config) {
    this.pb = new PocketBase(config.url);
    this.pb.autoCancellation(false);
    if (config.token) {
      this.pb.authStore.save(config.token, null);
    }
  }

  get baseUrl(): string {
    return this.pb.baseURL;
  }

  /**
   * Follows redirects on PB_URL once and talks to the final URL directly.
   * fetch drops the Authorization header on cross-origin redirects (e.g. http -> https),
   * which makes every authenticated request fail with 401 even though login succeeded.
   */
  private async resolveBaseUrl(): Promise<void> {
    const response = await fetch(`${this.config.url}/api/health`);
    const finalUrl = new URL(response.url);
    finalUrl.pathname = finalUrl.pathname.replace(/\/api\/health\/?$/, "");
    finalUrl.search = "";
    const resolved = finalUrl.toString().replace(/\/+$/, "");
    if (resolved !== this.config.url) {
      this.pb.baseURL = resolved;
      this.redirectWarning = `PB_URL ${this.config.url} redirects to ${resolved}; using ${resolved}. Update PB_URL to avoid the extra redirect.`;
      console.error(`pocketbase-mcp: ${this.redirectWarning}`);
    }
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
    this.resolvePromise ??= this.resolveBaseUrl().catch((err) => {
      this.resolvePromise = undefined;
      throw err;
    });
    await this.resolvePromise;
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
