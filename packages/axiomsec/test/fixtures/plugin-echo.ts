import { tool } from "@axiomsec/plugin"

export default {
  id: "axiomsec-test-plugin",
  server: async () => ({
    tool: {
      plugin_echo: tool({
        description: "Echo text through the plugin tool wrapper.",
        args: { text: tool.schema.string() },
        side_effects: ["read_only"],
        execute: async (args) => `PLUGIN:${args.text}`,
      }),
    },
  }),
}
