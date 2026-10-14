/** @jsxImportSource @opentui/solid */
// One module serves both OpenCode versions: V2 calls `setup`, V1 calls `tui`.
// Keep runtime imports free of @opencode/plugin so V1 can load it.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import type { Definition as V2Definition } from "@opencode/plugin/tui/plugin"
import type { TuiPlugin as V1TuiPlugin } from "@opencode-ai/plugin/tui"
import { CopilotUsage } from "./rpc"
import {
  PROVIDER_IDS,
  TURN_REFRESH_DELAY_MS,
  details,
  failure,
  fetchUsage,
  intervalMs,
  label,
  level,
  type Usage,
} from "./usage"

const ID = "copilot-usage.tui"
const COMMAND_ID = "copilot-usage.show"
const COMMAND_TITLE = "Show GitHub Copilot usage"

const setup: V2Definition["setup"] = (context) => {
  const rpc = context.client.rpc(CopilotUsage)
  const [state, setState] = context.storage.memory<{ usage?: Usage }>("usage", { initial: {} })

  const refresh = async (force = false) => {
    let usage: Usage
    try {
      usage = (await rpc.get({ refresh: force })) as Usage
    } catch (error) {
      usage = failure(error)
    }
    setState((draft) => {
      draft.usage = usage
    })
  }

  const active = () => PROVIDER_IDS.includes(context.ui.model.current()?.providerID ?? "")

  void refresh()
  // Not forced: the server cache dedupes polls from multiple open TUIs
  const timer = setInterval(() => {
    if (active()) void refresh()
  }, intervalMs(context.options.interval))

  let pending: ReturnType<typeof setTimeout> | undefined
  const stopTurn = context.data.on("session.execution.succeeded", () => {
    if (!active()) return
    clearTimeout(pending)
    pending = setTimeout(() => void refresh(true), TURN_REFRESH_DELAY_MS)
  })
  const stopUpdates = rpc.events.on("updated", (event) => {
    setState((draft) => {
      draft.usage = event.data as Usage
    })
  })

  context.keymap.layer(() => ({
    mode: "global",
    commands: [
      {
        id: COMMAND_ID,
        title: COMMAND_TITLE,
        group: "Copilot",
        palette: true,
        slash: { name: "copilot" },
        run: async () => {
          await refresh(true)
          await context.ui.dialog.alert({ title: "GitHub Copilot usage", message: details(state.usage) })
        },
      },
    ],
  }))

  const text = () => (active() ? label(state.usage) : "")
  const color = () => {
    const current = level(state.usage)
    if (current === "normal") return context.theme.text.muted
    return context.theme.text.feedback[current].base
  }

  context.ui.slot({
    after: "prompt.footer",
    render: () => (
      <box visible={text() !== ""} flexDirection="row" justifyContent="flex-end" flexShrink={0}>
        <text fg={color()}>{text()}</text>
      </box>
    ),
  })

  return () => {
    clearInterval(timer)
    clearTimeout(pending)
    stopTurn()
    stopUpdates()
  }
}

/** V1 has no server-side credential API for TUI plugins, so read OpenCode's auth store directly. */
async function loadV1(): Promise<Usage> {
  try {
    const dataDir = process.env.XDG_DATA_HOME || join(homedir(), ".local", "share")
    const auth = JSON.parse(await readFile(join(dataDir, "opencode", "auth.json"), "utf8"))
    for (const id of PROVIDER_IDS) {
      const entry = auth?.[id]
      const token = entry?.type === "oauth" ? entry.refresh || entry.access : entry?.key
      if (token) return await fetchUsage(token, entry.enterpriseUrl)
    }
    throw new Error("GitHub Copilot not connected")
  } catch (error) {
    return failure(error)
  }
}

const tui: V1TuiPlugin = async (api, options) => {
  const [usage, setUsage] = createSignal<Usage>()
  let inflight: Promise<void> | undefined
  const refresh = () =>
    (inflight ??= loadV1()
      .then((next) => {
        setUsage(next)
      })
      .finally(() => (inflight = undefined)))

  // V1 exposes no selected-model API to plugins; use the provider of the session's latest message
  const active = () => {
    const route = api.route.current
    if (route.name !== "session") return false
    const sessionID = (route.params as { sessionID?: string } | undefined)?.sessionID
    const last = sessionID ? api.state.session.messages(sessionID).at(-1) : undefined
    if (!last) return false
    return PROVIDER_IDS.includes(last.role === "user" ? last.model.providerID : last.providerID)
  }

  void refresh()
  const timer = setInterval(() => {
    if (active()) void refresh()
  }, intervalMs(options?.interval))

  let pending: ReturnType<typeof setTimeout> | undefined
  api.event.on("session.idle", () => {
    if (!active()) return
    clearTimeout(pending)
    pending = setTimeout(() => void refresh(), TURN_REFRESH_DELAY_MS)
  })

  api.lifecycle.onDispose(() => {
    clearInterval(timer)
    clearTimeout(pending)
  })

  api.keymap.registerLayer({
    mode: "base",
    commands: [
      {
        name: COMMAND_ID,
        title: COMMAND_TITLE,
        category: "Copilot",
        namespace: "palette",
        slashName: "copilot",
        async run() {
          await refresh()
          api.ui.dialog.replace(() => (
            <api.ui.DialogAlert
              title="GitHub Copilot usage"
              message={details(usage())}
              onConfirm={() => api.ui.dialog.clear()}
            />
          ))
        },
      },
    ],
  })

  const text = () => (active() ? label(usage()) : "")
  const color = () => {
    const current = level(usage())
    if (current === "error") return api.theme.current.error
    if (current === "warning") return api.theme.current.warning
    return api.theme.current.textMuted
  }

  api.slots.register({
    slots: {
      app_bottom: () => (
        <box visible={text() !== ""} flexDirection="row" justifyContent="flex-end" flexShrink={0} paddingRight={2}>
          <text fg={color()}>{text()}</text>
        </box>
      ),
    },
  })
}

export default { id: ID, setup, tui }
