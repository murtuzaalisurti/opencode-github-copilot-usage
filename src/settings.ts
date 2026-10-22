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
/** Footer button. Triggering it closes the dialog and resolves with its value. */
export type SelectAction<Value> = { title: string; bind: string; value: Value }

/** The dialogs this flow needs, implemented separately for V1 and V2. */
export interface Dialogs {
  select<Value>(
    title: string,
    options: SelectOption<Value>[],
    extra?: { current?: Value; actions?: SelectAction<Value>[] },
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
  const choice = await dialogs.select(
    "GitHub Copilot usage",
    details(usage).map((row, index) => ({
      title: row.label,
      footer: row.value,
      category: row.category,
      value: `row:${index}`,
    })),
    { actions: [{ title: "settings", bind: "ctrl+s", value: "settings" }] },
  )
  if (choice === "settings") await editSettings(dialogs, settings)
}

async function editSettings(dialogs: Dialogs, settings: SettingsStore) {
  let last: "interval" | "display" | "reset" | undefined
  while (true) {
    const overrides = settings.overrides()
    const current = resolve(settings.config(), overrides)
    const overridden = overrides.interval !== undefined || overrides.display !== undefined
    const choice = await dialogs.select(
      "Copilot usage settings",
      [
        {
          title: "Format",
          value: "display" as const,
          category: "Footer",
          description: SOURCE_LABEL[current.display.source],
          footer: current.display.value,
        },
        {
          title: "Interval",
          value: "interval" as const,
          category: "Refresh",
          description: SOURCE_LABEL[current.interval.source],
          footer: `${current.interval.value}s`,
        },
      ],
      {
        current: last === "reset" ? undefined : last,
        actions: overridden ? [{ title: "reset to config", bind: "ctrl+r", value: "reset" as const }] : [],
      },
    )
    if (choice === undefined) return
    last = choice
    if (choice === "reset") await settings.save({})
    if (choice === "display") {
      const display = await dialogs.select(
        "Footer format",
        [
          { title: "Full", value: "full" as Display, footer: "Copilot 2,000/15,000 cr · 13.3%" },
          { title: "Percent", value: "percent" as Display, footer: "Copilot 13.3%" },
        ],
        { current: current.display.value },
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
      { title: "Custom...", value: 0, footer: custom ? `${current} seconds` : undefined },
    ],
    { current: custom ? 0 : current },
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
