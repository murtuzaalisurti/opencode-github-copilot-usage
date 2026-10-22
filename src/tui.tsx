/** @jsxImportSource @opentui/solid */
// One module serves both OpenCode versions: V2 calls `setup`, V1 calls `tui`.
// Keep runtime imports free of @opencode/plugin so V1 can load it.
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { join } from "node:path"
import { createRenderEffect, createRoot, createSignal, onCleanup } from "solid-js"
import type { KeyEvent } from "@opentui/core"
import type { JSX } from "@opentui/solid"
import type { Definition as V2Definition } from "@opencode/plugin/tui/plugin"
import type { TuiDialogSelectOption, TuiPlugin as V1TuiPlugin } from "@opencode-ai/plugin/tui"
import { CopilotUsage } from "./rpc"
import {
  resolve,
  showUsage,
  type Dialogs,
  type Overrides,
  type SelectAction,
  type SelectOption,
  type SettingsStore,
} from "./settings"
import { PROVIDER_IDS, TURN_REFRESH_DELAY_MS, failure, fetchUsage, label, level, type Usage } from "./usage"

const ID = "copilot-usage.tui"
const COMMAND_ID = "copilot-usage.show"
const COMMAND_TITLE = "Show GitHub Copilot usage"
const SETTINGS_KEY = "copilot-usage.settings"

/** Polls on the current interval, restarting the timer when it changes. Returns a disposer. */
function poll(seconds: () => number, tick: () => void) {
  return createRoot((dispose) => {
    createRenderEffect(() => {
      const timer = setInterval(tick, seconds() * 1000)
      onCleanup(() => clearInterval(timer))
    })
    return dispose
  })
}

const setup: V2Definition["setup"] = async (context) => {
  const rpc = context.client.rpc(CopilotUsage)
  const [state, setState] = context.storage.memory<{ usage?: Usage }>("usage", { initial: {} })
  // cli.json options win over opencode.json(c) options, which only the server receives
  const serverOptions = (await rpc.options({}).catch(() => ({}))) as Record<string, unknown>
  const config = { ...serverOptions, ...context.options }
  // Durable and live-synced, so a change in one TUI applies to all of them
  const [overrides, setOverrides] = context.storage.store<Overrides>("settings", { initial: {} })
  const settings = () => resolve(config, overrides)
  const store: SettingsStore = {
    config: () => config,
    overrides: () => ({ interval: overrides.interval, display: overrides.display }),
    save: (next) =>
      setOverrides((draft) => {
        delete draft.interval
        delete draft.display
        Object.assign(draft, next)
      }),
  }
  const dialogs: Dialogs = {
    async select<Value>(
      title: string,
      options: () => SelectOption<Value>[],
      extra?: { current?: Value; actions?: () => SelectAction<Value>[] },
    ) {
      // Closing actions clear the dialog, which resolves the select with undefined
      let triggered: { value: Value } | undefined
      // Actions don't receive the key, so note it before the keymap handles it
      let pressed: string | undefined
      const onKey = (event: KeyEvent) => {
        pressed = event.name
      }
      context.renderer.keyInput.prependListener("keypress", onKey)
      const chosen = await context.ui.dialog.select({
        title,
        // Getters so the host re-reads them when settings change
        get options() {
          return options()
        },
        current: extra?.current,
        get actions() {
          return extra?.actions?.().map((action) =>
            "run" in action
              ? action.selection === "none"
                ? { ...action, side: "right" as const, onTrigger: () => void action.run() }
                : { ...action, side: "right" as const, onTrigger: (selected: Value) => void action.run(selected, pressed) }
              : {
                  title: action.title,
                  bind: action.bind,
                  side: "right" as const,
                  selection: "none" as const,
                  onTrigger: () => {
                    triggered = { value: action.value }
                    context.ui.dialog.clear()
                  },
                },
          )
        },
      }).finally(() => context.renderer.keyInput.off("keypress", onKey))
      return triggered ? triggered.value : chosen
    },
    prompt: (title, description, value) => context.ui.dialog.prompt({ title, description, value }),
    alert: (title, message) => context.ui.dialog.alert({ title, message }),
  }

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
  const stopPoll = poll(
    () => settings().interval.value,
    () => {
      if (active()) void refresh()
    },
  )

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
        slash: { name: "copilot-usage" },
        run: async () => {
          await refresh(true)
          await showUsage(dialogs, state.usage, store)
        },
      },
    ],
  }))

  const text = () => (active() ? label(state.usage, settings().display.value) : "")
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
    stopPoll()
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

/** V1 dialogs take callbacks; settle on choice or dismissal, whichever comes first. */
function v1Dialogs(api: Parameters<V1TuiPlugin>[0]): Dialogs {
  const { dialog, DialogAlert, DialogPrompt, DialogSelect } = api.ui
  const open = <Value,>(render: (done: (value?: Value) => void) => JSX.Element) =>
    new Promise<Value | undefined>((resolve) => {
      let settled = false
      const done = (value?: Value) => {
        if (settled) return
        settled = true
        dialog.clear()
        resolve(value)
      }
      dialog.replace(() => render(done), () => done())
    })
  return {
    // V1 selects have no footer actions, so list the ones that don't act on the selected option
    select<Value>(
      title: string,
      options: () => SelectOption<Value>[],
      extra?: { current?: Value; actions?: () => SelectAction<Value>[] },
    ) {
      const rows = (): TuiDialogSelectOption<Value | undefined>[] => [
        ...options(),
        ...(extra?.actions?.() ?? []).flatMap((action): TuiDialogSelectOption<Value | undefined>[] => {
          if ("value" in action) return [{ title: action.title, value: action.value, category: "Actions" }]
          if (action.selection !== "none") return []
          return [{ title: action.title, value: undefined, category: "Actions", onSelect: () => void action.run() }]
        }),
      ]
      return open<Value>((done) => (
        <DialogSelect
          title={title}
          options={rows()}
          current={extra?.current}
          onSelect={(option) => {
            if (!option.onSelect) done(option.value)
          }}
        />
      ))
    },
    prompt: (title, description, value) =>
      open((done) => (
        <DialogPrompt
          title={title}
          description={() => <text fg={api.theme.current.textMuted}>{description}</text>}
          value={value}
          onConfirm={(next) => done(next)}
          onCancel={() => done()}
        />
      )),
    alert: (title, message) =>
      open<void>((done) => <DialogAlert title={title} message={message} onConfirm={() => done()} />).then(() => {}),
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

  // kv may not notify Solid on writes from this plugin, so track them with a signal
  const [saved, setSaved] = createSignal(0)
  const config = { ...options }
  const store: SettingsStore = {
    config: () => config,
    overrides: () => (saved(), api.kv.get<Overrides>(SETTINGS_KEY, {})),
    save: (next) => {
      api.kv.set(SETTINGS_KEY, next)
      setSaved((count) => count + 1)
    },
  }
  const settings = () => resolve(config, store.overrides())

  void refresh()
  const stopPoll = poll(
    () => settings().interval.value,
    () => {
      if (active()) void refresh()
    },
  )

  let pending: ReturnType<typeof setTimeout> | undefined
  api.event.on("session.idle", () => {
    if (!active()) return
    clearTimeout(pending)
    pending = setTimeout(() => void refresh(), TURN_REFRESH_DELAY_MS)
  })

  api.lifecycle.onDispose(() => {
    stopPoll()
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
        slashName: "copilot-usage",
        async run() {
          await refresh()
          await showUsage(v1Dialogs(api), usage(), store)
        },
      },
    ],
  })

  const text = () => (active() ? label(usage(), settings().display.value) : "")
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
