export type QuotaSnapshot = {
  entitlement: number
  remaining: number
  used: number
  percentUsed: number
  percentRemaining: number
  unlimited: boolean
  overage: number
  overagePermitted: boolean
}

export type Usage = {
  login?: string
  plan?: string
  tokenBasedBilling: boolean
  quotaType?: "chat"
  resetDate?: string
  premium?: QuotaSnapshot
  fetchedAt: number
  error?: string
}

export const PROVIDER_IDS = ["github-copilot", "github-copilot-enterprise"]
export const TURN_REFRESH_DELAY_MS = 3_000

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)
const clean = (value: number) => Number(value.toPrecision(12))

const firstNum = (raw: Record<string, unknown>, ...keys: string[]) => {
  for (const key of keys) {
    const value = num(raw[key])
    if (value !== undefined) return value
  }
}

function apiBase(enterpriseUrl: unknown) {
  if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return "https://api.github.com"
  return `https://api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
}

function parseSnapshot(raw: any): QuotaSnapshot | undefined {
  if (!raw || typeof raw !== "object") return
  const rawEntitlement = firstNum(raw, "entitlement", "entitlement_requests", "entitlementRequests")
  const unlimited = raw.unlimited === true || rawEntitlement === -1
  const entitlement = rawEntitlement !== undefined && rawEntitlement >= 0 ? rawEntitlement : 0
  const reportedCreditsUsed = firstNum(raw, "credits_used")
  const reportedUsedRequests = firstNum(raw, "used_requests", "usedRequests")
  const reportedRemaining = firstNum(raw, "quota_remaining", "remaining", "remaining_requests", "remainingRequests")
  const reportedPercent = firstNum(raw, "percent_remaining", "remaining_percentage", "remainingPercentage")
  const remaining =
    reportedRemaining ??
    (reportedUsedRequests !== undefined ? Math.max(0, entitlement - reportedUsedRequests) :
      reportedPercent !== undefined ? (entitlement * reportedPercent) / 100 : 0)
  const percentRemaining = Math.min(
    100,
    Math.max(0, reportedPercent ?? (entitlement > 0 ? (remaining / entitlement) * 100 : 100)),
  )
  return {
    entitlement,
    remaining,
    // credits_used is reported under token-based billing; older plans only expose remaining
    used:
      reportedCreditsUsed ??
      (reportedRemaining !== undefined
        ? clean(Math.max(0, entitlement - reportedRemaining))
        : reportedUsedRequests ?? Math.max(0, entitlement - remaining)),
    percentRemaining,
    percentUsed: 100 - percentRemaining,
    unlimited,
    overage: firstNum(raw, "overage_count", "overageCount") ?? 0,
    overagePermitted: raw.overage_permitted === true,
  }
}

export const failure = (error: unknown): Usage => ({
  tokenBasedBilling: false,
  fetchedAt: Date.now(),
  error: error instanceof Error ? error.message : String(error),
})

/** `token` must be the GitHub OAuth token, not the short-lived Copilot API token. */
export async function fetchUsage(token: string, enterpriseUrl?: unknown): Promise<Usage> {
  try {
    const response = await fetch(`${apiBase(enterpriseUrl)}/copilot_internal/user`, {
      signal: AbortSignal.timeout(10_000),
      headers: {
        Accept: "application/json",
        Authorization: `token ${token}`,
        "User-Agent": "GitHubCopilotChat/0.26.7",
        "Editor-Version": "vscode/1.96.2",
        "Editor-Plugin-Version": "copilot-chat/0.26.7",
        "X-GitHub-Api-Version": "2025-04-01",
      },
    })
    if (!response.ok) throw new Error(`GitHub API returned ${response.status}`)
    const body = (await response.json()) as any
    const premium = parseSnapshot(body.quota_snapshots?.premium_interactions)
    const chat = parseSnapshot(body.quota_snapshots?.chat)
    const hasPremiumQuota = premium?.unlimited || (premium?.entitlement ?? 0) > 0
    const useChatQuota =
      !hasPremiumQuota && chat !== undefined && (chat.unlimited || chat.entitlement > 0)
    const selected = useChatQuota ? chat : premium
    return {
      login: body.login,
      plan: body.copilot_plan ?? body.access_type_sku,
      tokenBasedBilling: body.token_based_billing === true,
      resetDate: body.quota_reset_date_utc ?? body.quota_reset_date,
      premium:
        useChatQuota && chat && !chat.unlimited
          ? { ...chat, used: clean(Math.max(0, chat.entitlement - chat.remaining)) }
          : selected,
      quotaType: useChatQuota ? "chat" : undefined,
      fetchedAt: Date.now(),
    }
  } catch (error) {
    return failure(error)
  }
}

const fmt = (value: number) => value.toLocaleString("en-US", { maximumFractionDigits: 1 })
const pct = (value: number) => `${value.toFixed(1)}%`
const DAY_MS = 86_400_000

/**
 * Days until the quota runs out at the average daily rate since the cycle began.
 * Infinity when it lasts past the reset date. Undefined when there is nothing to forecast.
 */
export function daysLeft(usage: Usage | undefined, now = Date.now()) {
  const premium = usage?.premium
  if (!usage?.resetDate || !premium || premium.unlimited || premium.used <= 0) return
  const reset = new Date(usage.resetDate)
  if (Number.isNaN(reset.getTime())) return
  // shortcut: assumes monthly cycles ending at resetDate; the API exposes no cycle start
  const start = new Date(reset)
  start.setUTCMonth(start.getUTCMonth() - 1)
  const elapsed = now - start.getTime()
  if (elapsed <= 0) return
  const days = premium.remaining / (premium.used / (elapsed / DAY_MS))
  return now + days * DAY_MS >= reset.getTime() ? Infinity : days
}

const forecastText = (days: number) => (days === Infinity ? "lasts until reset" : `~${Math.floor(days)}d left`)

export function label(usage: Usage | undefined, display: unknown = "full") {
  const premium = usage?.premium
  if (!usage || usage.error || !premium) return ""
  if (premium.unlimited) return "Copilot: unlimited"
  if (display === "percent") return `Copilot ${pct(premium.percentUsed)}`
  const unit = usage.tokenBasedBilling && usage.quotaType !== "chat" ? " cr" : " req"
  return `Copilot ${fmt(premium.used)}/${fmt(premium.entitlement)}${unit} · ${pct(premium.percentUsed)}`
}

export function forecastLabel(usage: Usage | undefined, forecast: unknown) {
  const days = forecast === true && !usage?.error ? daysLeft(usage) : undefined
  return days === undefined ? "" : forecastText(days)
}

export function level(usage: Usage | undefined): "normal" | "warning" | "error" {
  const used = usage?.premium?.percentUsed ?? 0
  if (used >= 90) return "error"
  if (used >= 75) return "warning"
  return "normal"
}

export type DetailRow = { category: string; label: string; value: string }

export function details(usage: Usage | undefined, forecast: unknown = false): DetailRow[] {
  if (!usage) return [{ category: "Status", label: "Loading...", value: "" }]
  if (usage.error) return [{ category: "Status", label: usage.error, value: "" }]
  const premium = usage.premium
  const rows: DetailRow[] = [
    { category: "Account", label: "Login", value: usage.login ?? "unknown" },
    { category: "Account", label: "Plan", value: usage.plan ?? "unknown" },
    {
      category: "Account",
      label: "Billing",
      value: usage.quotaType === "chat" ? "chat requests" : usage.tokenBasedBilling ? "AI credits" : "premium requests",
    },
  ]
  const quota = (label: string, value: string) => rows.push({ category: "Quota", label, value })
  if (!premium) quota("Usage", "no premium quota reported")
  else if (premium.unlimited) quota("Usage", "unlimited")
  else {
    quota("Used", `${fmt(premium.used)} / ${fmt(premium.entitlement)} (${pct(premium.percentUsed)})`)
    quota("Remaining", `${fmt(premium.remaining)} (${pct(premium.percentRemaining)})`)
    quota("Overage", `${fmt(premium.overage)}${premium.overagePermitted ? " (permitted)" : " (not permitted)"}`)
  }
  const days = forecast === true ? daysLeft(usage) : undefined
  if (days !== undefined) quota("Forecast", `${forecastText(days)} at current pace`)
  if (usage.resetDate) quota("Resets", new Date(usage.resetDate).toLocaleDateString())
  quota("Updated", new Date(usage.fetchedAt).toLocaleTimeString())
  return rows
}
