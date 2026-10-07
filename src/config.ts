export interface Config {
  url: string;
  email?: string;
  password?: string;
  token?: string;
  readOnly: boolean;
  requireConfirmation: boolean;
  confirmationTtlMs: number;
}

function parseBool(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  return ["1", "true", "yes", "on"].includes(value.trim().toLowerCase());
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const url = env.PB_URL?.trim();
  if (!url) {
    throw new Error("PB_URL is required (e.g. https://pb.example.com)");
  }

  const email = env.PB_SUPERUSER_EMAIL?.trim() || undefined;
  const password = env.PB_SUPERUSER_PASSWORD || undefined;
  const token = env.PB_SUPERUSER_TOKEN?.trim() || undefined;
  if (!token && !(email && password)) {
    throw new Error(
      "Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD (or PB_SUPERUSER_TOKEN) to authenticate as a superuser",
    );
  }

  const ttlSeconds = Number(env.PB_CONFIRMATION_TTL_SECONDS ?? "300");

  return {
    url: url.replace(/\/+$/, ""),
    email,
    password,
    token,
    readOnly: parseBool(env.PB_READ_ONLY, false),
    requireConfirmation: parseBool(env.PB_REQUIRE_CONFIRMATION, true),
    confirmationTtlMs: (Number.isFinite(ttlSeconds) && ttlSeconds > 0 ? ttlSeconds : 300) * 1000,
  };
}
