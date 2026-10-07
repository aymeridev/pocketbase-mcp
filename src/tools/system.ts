import { defineTool } from "./define.js";

export const health = defineTool({
  name: "pb_health",
  title: "Check PocketBase health",
  kind: "read",
  description: "Check that the PocketBase instance is reachable and the superuser credentials work.",
  input: {},
  run: async (_args, { client, config }) => {
    await client.ensureAuth();
    const status = await client.pb.health.check();
    // An authenticated call proves the token is actually accepted, not just issued.
    await client.run((pb) => pb.collections.getList(1, 1, { fields: "id", skipTotal: true }));
    return {
      url: client.baseUrl,
      health: status,
      authenticated: true,
      readOnly: config.readOnly,
      warning: client.redirectWarning,
    };
  },
});

export const systemTools = [health];
