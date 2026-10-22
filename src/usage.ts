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
  resetDate?: string
  premium?: QuotaSnapshot
  fetchedAt: number
  error?: string
}

export const PROVIDER_IDS = ["github-copilot", "github-copilot-enterprise"]
export const TURN_REFRESH_DELAY_MS = 3_000

const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : undefined)

function apiBase(enterpriseUrl: unknown) {
  if (typeof enterpriseUrl !== "string" || !enterpriseUrl) return "https://api.github.com"
  return `https://api.${enterpriseUrl.replace(/^https?:\/\//, "").replace(/\/+$/, "")}`
}

function parseSnapshot(raw: any): QuotaSnapshot | undefined {
  if (!raw || typeof raw !== "object") return
  const entitlement = num(raw.entitlement) ?? 0
  const remaining = num(raw.quota_remaining) ?? num(raw.remaining) ?? 0
  const percentRemaining = Math.min(
    100,
    Math.max(0, num(raw.percent_remaining) ?? (entitlement > 0 ? (remaining / entitlement) * 100 : 100)),
  )
  return {
    entitlement,
    remaining,
    // credits_used is reported under token-based billing; older plans only expose remaining
    used: num(raw.credits_used) ?? Math.max(0, entitlement - remaining),
    percentRemaining,
    percentUsed: 100 - percentRemaining,
    unlimited: raw.unlimited === true,
    overage: num(raw.overage_count) ?? 0,
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
    return {
      login: body.login,
      plan: body.copilot_plan ?? body.access_type_sku,
      tokenBasedBilling: body.token_based_billing === true,
      resetDate: body.quota_reset_date_utc ?? body.quota_reset_date,
      premium: parseSnapshot(body.quota_snapshots?.premium_interactions),
      fetchedAt: Date.now(),
    }
  } catch (error) {
    return failure(error)
  }
}

const fmt = (value: number) => Math.round(value).toLocaleString("en-US")
const pct = (value: number) => `${value.toFixed(1)}%`

export function label(usage: Usage | undefined, display: unknown = "full") {
  const premium = usage?.premium
  if (!usage || usage.error || !premium) return ""
  if (premium.unlimited) return "Copilot: unlimited"
  if (display === "percent") return `Copilot ${pct(premium.percentUsed)}`
  const unit = usage.tokenBasedBilling ? " cr" : " req"
  return `Copilot ${fmt(premium.used)}/${fmt(premium.entitlement)}${unit} · ${pct(premium.percentUsed)}`
}

export function level(usage: Usage | undefined): "normal" | "warning" | "error" {
  const used = usage?.premium?.percentUsed ?? 0
  if (used >= 90) return "error"
  if (used >= 75) return "warning"
  return "normal"
}

export function details(usage: Usage | undefined) {
  if (!usage) return "Loading..."
  if (usage.error) return usage.error
  const premium = usage.premium
  const lines = [
    `Account:   ${usage.login ?? "unknown"} (${usage.plan ?? "unknown plan"})`,
    `Billing:   ${usage.tokenBasedBilling ? "AI credits" : "premium requests"}`,
  ]
  if (!premium) lines.push("Usage:     no premium quota reported")
  else if (premium.unlimited) lines.push("Usage:     unlimited")
  else
    lines.push(
      `Used:      ${fmt(premium.used)} / ${fmt(premium.entitlement)} (${pct(premium.percentUsed)})`,
      `Remaining: ${fmt(premium.remaining)} (${pct(premium.percentRemaining)})`,
      `Overage:   ${fmt(premium.overage)}${premium.overagePermitted ? " (permitted)" : " (not permitted)"}`,
    )
  if (usage.resetDate) lines.push(`Resets:    ${new Date(usage.resetDate).toLocaleDateString()}`)
  lines.push(`Updated:   ${new Date(usage.fetchedAt).toLocaleTimeString()}`)
  return lines.join("\n")
}
