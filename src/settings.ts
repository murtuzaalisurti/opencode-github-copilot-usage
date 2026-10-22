import { details, type Usage } from "./usage"

export const DEFAULT_INTERVAL_SECONDS = 15
export const MIN_INTERVAL_SECONDS = 5
const INTERVAL_PRESETS = [15, 30, 60, 120]
const DISPLAYS = ["full", "percent"] as const

export type Display = (typeof DISPLAYS)[number]
/** Values chosen in the TUI. Missing keys fall back to config, then defaults. */
export type Overrides = { interval?: number; display?: Display }
type Source = "tui" | "config" | "default"
type Setting<Value> = { value: Value; source: Source }

const validInterval = (value: unknown) => {
  const seconds = Number(value)
  return Number.isFinite(seconds) && seconds >= MIN_INTERVAL_SECONDS ? seconds : undefined
}
const validDisplay = (value: unknown) => DISPLAYS.find((display) => display === value)

function pick<Value>(override: unknown, config: unknown, fallback: Value, valid: (value: unknown) => Value | undefined) {
  const fromTui = valid(override)
  if (fromTui !== undefined) return { value: fromTui, source: "tui" } as Setting<Value>
  const fromConfig = valid(config)
  if (fromConfig !== undefined) return { value: fromConfig, source: "config" } as Setting<Value>
  return { value: fallback, source: "default" } as Setting<Value>
}

/** Precedence: TUI choice, then plugin options from config, then the default. */
export function resolve(config: Record<string, unknown>, overrides: Overrides) {
  return {
    interval: pick(overrides.interval, config.interval, DEFAULT_INTERVAL_SECONDS, validInterval),
    display: pick(overrides.display, config.display, "full" as Display, validDisplay),
  }
}

export type SelectOption<Value> = { title: string; value: Value; description?: string; footer?: string; category?: string }
/**
 * Footer button. With `value` it closes the dialog and resolves with it; with `run` the dialog stays open,
 * and `run` receives the selected option unless `selection` is "none", plus the name of the key that triggered it.
 */
export type SelectAction<Value> = { title: string; bind: string } & (
  | { value: Value }
  | { selection?: "required"; run: (selected: Value, key?: string) => void | Promise<void> }
  | { selection: "none"; run: () => void | Promise<void> }
)

/** The dialogs this flow needs, implemented separately for V1 and V2. Accessors are read reactively. */
export interface Dialogs {
  select<Value>(
    title: string,
    options: () => SelectOption<Value>[],
    extra?: { current?: Value; actions?: () => SelectAction<Value>[] },
  ): Promise<Value | undefined>
  prompt(title: string, description: string, value: string): Promise<string | undefined>
  alert(title: string, message: string): Promise<void>
}

export type SettingsStore = {
  config: () => Record<string, unknown>
  overrides: () => Overrides
  save: (next: Overrides) => void | Promise<void>
}

const SOURCE_LABEL: Record<Source, string | undefined> = { tui: "set here", config: "from config", default: undefined }

/** Usage details, with a footer button that opens settings. */
export async function showUsage(dialogs: Dialogs, usage: Usage | undefined, settings: SettingsStore) {
  const rows = details(usage).map((row, index) => ({
    title: row.label,
    footer: row.value,
    category: row.category,
    value: `row:${index}`,
  }))
  const choice = await dialogs.select("GitHub Copilot usage", () => rows, {
    actions: () => [{ title: "settings", bind: "ctrl+s", value: "settings" }],
  })
  if (choice === "settings") await editSettings(dialogs, settings)
}

type Key = "display" | "interval"

/** Steps a setting to its previous or next value. Custom intervals step to the nearest preset. */
function cycle(settings: SettingsStore, key: Key, step: 1 | -1) {
  const overrides = settings.overrides()
  const current = resolve(settings.config(), overrides)
  if (key === "display") {
    const index = DISPLAYS.indexOf(current.display.value)
    return settings.save({ ...overrides, display: DISPLAYS[(index + step + DISPLAYS.length) % DISPLAYS.length] })
  }
  const seconds = current.interval.value
  const presets = step > 0 ? INTERVAL_PRESETS : [...INTERVAL_PRESETS].reverse()
  const next = presets.find((preset) => (step > 0 ? preset > seconds : preset < seconds)) ?? presets[0]
  return settings.save({ ...overrides, interval: next })
}

/** Left/right change the selected value in place; enter on Interval asks for a custom value. */
async function editSettings(dialogs: Dialogs, settings: SettingsStore) {
  let last: Key | undefined
  while (true) {
    const choice = await dialogs.select(
      "Copilot usage settings",
      () => {
        const current = resolve(settings.config(), settings.overrides())
        return [
          {
            title: "Format",
            value: "display" as Key,
            category: "Footer",
            description: SOURCE_LABEL[current.display.source],
            footer: current.display.value,
          },
          {
            title: "Interval",
            value: "interval" as Key,
            category: "Refresh",
            description: SOURCE_LABEL[current.interval.source],
            footer: `${current.interval.value}s`,
          },
        ]
      },
      {
        current: last,
        actions: () => {
          const overrides = settings.overrides()
          const actions: SelectAction<Key>[] = [
            {
              title: "change",
              bind: "left,right",
              run: (selected, key) => cycle(settings, selected, key === "left" ? -1 : 1),
            },
          ]
          if (overrides.interval !== undefined || overrides.display !== undefined)
            actions.push({ title: "reset to config", bind: "ctrl+r", selection: "none", run: () => settings.save({}) })
          return actions
        },
      },
    )
    if (choice === undefined) return
    last = choice
    if (choice === "display") await cycle(settings, "display", 1)
    if (choice === "interval") {
      const current = resolve(settings.config(), settings.overrides()).interval.value
      const interval = await customInterval(dialogs, current)
      if (interval !== undefined) await settings.save({ ...settings.overrides(), interval })
    }
  }
}

async function customInterval(dialogs: Dialogs, current: number) {
  let input = String(current)
  while (true) {
    const next = await dialogs.prompt("Poll interval", `Seconds between refreshes (${MIN_INTERVAL_SECONDS} or more)`, input)
    if (next === undefined) return
    const seconds = next.trim() ? validInterval(next.trim()) : undefined
    if (seconds !== undefined) return seconds
    await dialogs.alert("Invalid interval", `Enter a number of seconds, ${MIN_INTERVAL_SECONDS} or more.`)
    input = next
  }
}
