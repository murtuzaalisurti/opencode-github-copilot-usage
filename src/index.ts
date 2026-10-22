import { Plugin } from "@opencode/plugin"
import { CopilotUsage } from "./rpc"
import { failure, fetchUsage, type Usage } from "./usage"

const INTEGRATION_ID = "github-copilot"
const CACHE_MS = 10_000

export default Plugin.define({
  id: "copilot-usage",
  async setup(ctx) {
    let cache: Usage | undefined
    let inflight: Promise<Usage> | undefined

    async function load(): Promise<Usage> {
      try {
        const connection = await ctx.integration.connection.active(INTEGRATION_ID)
        if (!connection) throw new Error("GitHub Copilot not connected")
        const credential = (await ctx.integration.connection.resolve(connection)) as any
        if (!credential) throw new Error("GitHub Copilot credential unavailable")
        // For Copilot OAuth, `refresh` holds the GitHub token; `access` is the short-lived Copilot token
        const token: string | undefined =
          credential.type === "oauth" ? credential.refresh || credential.access : credential.key
        if (!token) throw new Error("GitHub Copilot token missing")
        return await fetchUsage(token, credential.metadata?.enterpriseUrl)
      } catch (error) {
        return failure(error)
      }
    }

    const registration = await ctx.rpc.register(CopilotUsage, {
      get: async (input) => {
        const refresh = (input as { refresh?: boolean } | undefined)?.refresh === true
        if (!refresh && cache && !cache.error && Date.now() - cache.fetchedAt < CACHE_MS) return cache
        inflight ??= load().finally(() => (inflight = undefined))
        cache = await inflight
        await registration.events.emit("updated", cache)
        return cache
      },
      // The CLI loads the TUI entry without opencode.json(c) options, so hand them over here
      options: async () => ({ ...ctx.options }),
    })
  },
})
