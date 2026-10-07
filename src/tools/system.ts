import { defineTool } from "./define.js";

export const health = defineTool({
  name: "pb_health",
  title: "Check PocketBase health",
  kind: "read",
  description: "Check that the PocketBase instance is reachable and the superuser credentials work.",
  input: {},
  run: async (_args, { client, config }) => {
    const status = await client.pb.health.check();
    await client.ensureAuth();
    return { url: client.baseUrl, health: status, authenticated: client.pb.authStore.isValid, readOnly: config.readOnly };
  },
});

export const systemTools = [health];
