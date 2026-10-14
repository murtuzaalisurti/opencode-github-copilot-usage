import type { Rpc } from "@opencode/plugin/rpc"

// Plain object instead of Rpc.define so the TUI module stays importable from OpenCode V1,
// which does not ship @opencode/plugin
export const CopilotUsage = {
  id: "copilot-usage",
  methods: {
    get: {
      input: {
        type: "object",
        properties: { refresh: { type: "boolean" } },
        additionalProperties: false,
      },
      output: { type: "object" },
    },
  },
  events: {
    updated: { schema: { type: "object" } },
  },
} as const satisfies Rpc.PortableDefinition
