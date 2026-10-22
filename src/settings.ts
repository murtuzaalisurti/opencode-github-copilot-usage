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

export type SelectOption<Value> = { title: string; value: Value; description?: string; disabled?: boolean }

/** The dialogs this flow needs, implemented separately for V1 and V2. */
export interface Dialogs {
  select<Value>(title: string, options: SelectOption<Value>[], current?: Value): Promise<Value | undefined>
  prompt(title: string, description: string, value: string): Promise<string | undefined>
  alert(title: string, message: string): Promise<void>
}

export type SettingsStore = {
  config: () => Record<string, unknown>
  overrides: () => Overrides
  save: (next: Overrides) => void | Promise<void>
}

const SOURCE_LABEL: Record<Source, string> = { tui: "set here", config: "from config", default: "default" }
const describe = (value: string, source: Source) => `${value} (${SOURCE_LABEL[source]})`

/** Usage details with a Settings entry at the end. */
export async function showUsage(dialogs: Dialogs, usage: Usage | undefined, settings: SettingsStore) {
  const rows = details(usage)
    .split("\n")
    .map((line, index) => ({ title: line, value: `line:${index}` }))
  const choice = await dialogs.select("GitHub Copilot usage", [
    ...rows,
    { title: "Settings...", value: "settings", description: "Poll interval and footer format" },
  ])
  if (choice === "settings") await editSettings(dialogs, settings)
}

async function editSettings(dialogs: Dialogs, settings: SettingsStore) {
  while (true) {
    const overrides = settings.overrides()
    const current = resolve(settings.config(), overrides)
    const choice = await dialogs.select("Copilot usage settings", [
      {
        title: "Poll interval",
        value: "interval" as const,
        description: describe(`${current.interval.value}s`, current.interval.source),
      },
      {
        title: "Footer format",
        value: "display" as const,
        description: describe(current.display.value, current.display.source),
      },
      {
        title: "Reset to config",
        value: "reset" as const,
        description: "Drop values set here",
        disabled: overrides.interval === undefined && overrides.display === undefined,
      },
    ])
    if (choice === undefined) return
    if (choice === "reset") await settings.save({})
    if (choice === "display") {
      const display = await dialogs.select(
        "Footer format",
        [
          { title: "Full", value: "full" as Display, description: "Copilot 2,000/15,000 cr · 13.3%" },
          { title: "Percent", value: "percent" as Display, description: "Copilot 13.3%" },
        ],
        current.display.value,
      )
      if (display) await settings.save({ ...overrides, display })
    }
    if (choice === "interval") {
      const interval = await pickInterval(dialogs, current.interval.value)
      if (interval !== undefined) await settings.save({ ...overrides, interval })
    }
  }
}

async function pickInterval(dialogs: Dialogs, current: number) {
  const custom = !INTERVAL_PRESETS.includes(current)
  const choice = await dialogs.select(
    "Poll interval",
    [
      ...INTERVAL_PRESETS.map((seconds) => ({ title: `${seconds} seconds`, value: seconds })),
      { title: "Custom...", value: 0, description: custom ? `${current} seconds` : undefined },
    ],
    custom ? 0 : current,
  )
  if (choice !== 0) return choice
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
