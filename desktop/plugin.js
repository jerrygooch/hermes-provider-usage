import {
  Badge,
  Button,
  Loader,
  RowButton,
  StatusDot,
  Tip,
  host,
  haptic,
  icons,
  useQuery,
  useValue,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ROUTES_AREA,
  SIDEBAR_NAV_AREA,
  PALETTE_AREA
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const REFRESH_MS = 60_000
const HAIRLINE = '1px solid var(--ui-stroke-tertiary)'
// Route the "all providers" full page mounts at (Settings-style workspace page).
const OVERVIEW_ROUTE = '/jg-provider-usage'
const textPrimary = { color: 'var(--ui-text-primary)' }
const textSecondary = { color: 'var(--ui-text-secondary)' }
const lastFocusedProviders = new Map()
// A real profile swap settles on readiness, or after this bounded window when
// the new backend is slow — never an infinite "switching profile" spinner.
const PROFILE_SETTLE_MS = 12_000

function profileScope(profile) {
  const value = String(profile || '').trim()
  return value || '__active__'
}

function normaliseProvider(value) {
  const text = String(value || '').trim().toLowerCase()
  if (text === 'codex') return 'openai-codex'
  if (text === 'supergrok' || text === 'grok-oauth') return 'xai-oauth'
  if (text === 'claude') return 'anthropic'
  if (text === 'nous-portal') return 'nous'
  if (text === 'ollama-cloud' || text === 'ollama_cloud') return 'ollama-cloud'
  if (text === 'go' || text === 'opencode_go' || text === 'opencode-go-sub') return 'opencode-go'
  if (text === 'opencode' || text === 'zen' || text === 'opencode_zen') return 'opencode-zen'
  return text
}

// Connection-qualified source identity for the account ctx.rest actually talks
// to. Two sockets can share a PROFILE name on different connections (a remote
// alias vs. the live socket) — a same-profile remote collides on name, so any
// scope keyed or memoised purely by profile can serve one account's data under
// another's focus. Source-qualify everything that reads an account.
function activeSourceId(connectionId, profile) {
  const connection = String(connectionId || '').trim()
  const scoped = profileScope(profile)
  return connection ? `${connection}::${scoped}` : scoped
}

function rememberProvider(scopedKey, provider) {
  const resolved = normaliseProvider(provider)
  if (resolved) lastFocusedProviders.set(scopedKey, resolved)
  return resolved
}

function rememberedProvider(scopedKey) {
  return lastFocusedProviders.get(scopedKey) || ''
}

// Per chat, not per profile. A profile-wide memory made every chat inherit
// whichever account last emitted an event (a Codex chat stuck the Grok chip
// on Codex until a later event happened to correct it).
const sessionProviders = new Map()

function rememberedSessionProvider(sessionId) {
  return sessionId ? sessionProviders.get(sessionId) || '' : ''
}

function rememberSessionProvider(sessionId, provider) {
  const value = normaliseProvider(provider)
  if (!sessionId || !value) return ''
  sessionProviders.set(sessionId, value)
  return value
}

function providerScopeKey(sourceId, sessionId) {
  return `${sourceId}::${String(sessionId || '__workspace__')}`
}

function connectionKey(value) {
  const text = String(value || '').trim()
  return text === 'local' ? '' : text
}

// ctx.rest always dials the active socket, but the backend can scope credential
// reads to a named local profile. Same machine, different bot: fetch THAT
// profile. A different connection is another machine — a shared profile name
// must not borrow this machine's copy.
function resolveUsageScope({ focusedOwner, hasFocusedOwner, focusedProfile, activeConnectionId, activeProfile }) {
  const active = String(activeProfile || '').trim() || 'default'
  const activeConn = connectionKey(activeConnectionId)
  const alias = String(focusedProfile || '').trim()
  let focus = alias || active
  let focusConn = activeConn
  let focusConnKnown = false
  let ambiguous = false

  if (hasFocusedOwner) {
    if (!focusedOwner || typeof focusedOwner?.profile !== 'string') {
      // The SDK publishes the owner atom but cannot resolve the focused chat to
      // one owner. The profile-only alias is NOT authority: another connection
      // can use the same profile name, so fail closed and gate.
      ambiguous = true
      focus = alias || active
    } else {
      focus = String(focusedOwner.profile).trim() || alias || active
      focusConnKnown = focusedOwner.connectionId != null && String(focusedOwner.connectionId).trim() !== ''
      focusConn = focusConnKnown ? connectionKey(focusedOwner.connectionId) : activeConn
    }
  }

  const otherMachine = focusConnKnown && focusConn !== activeConn
  const unreachable = otherMachine || ambiguous
  const fetchProfile = unreachable ? active : focus
  const ownerConnection = otherMachine ? String(activeConnectionId || '').trim() : String((focusConnKnown ? focusedOwner.connectionId : activeConnectionId) || '').trim()
  return {
    activeProfile: active,
    fetchProfile,
    focusProfile: focus,
    diverged: unreachable,
    unreachable,
    ambiguous,
    source: otherMachine ? 'remote' : ambiguous ? 'ambiguous' : fetchProfile === active ? 'active' : 'focused-profile',
    sourceId: activeSourceId(unreachable ? activeConnectionId : ownerConnection, fetchProfile),
    ownerConnection
  }
}

// The key must NEVER include the gateway state: a reconnecting socket on the
// same account would otherwise change the key and lose the already-cached rows,
// making the "reconnecting keeps the last data" claim false. The stable source
// (connection+profile) is what identifies the account, and it survives reconnects.
function providerUsageQueryKey(fetchProfile, source) {
  // One cache per account. Chat switches must not refetch or flash another
  // provider's cached query — the chip picks the row client-side.
  return [
    'jg-provider-usage',
    'overview',
    profileScope(fetchProfile),
    source || profileScope(fetchProfile)
  ]
}

function gatewayReady(gateway) {
  const state = String(gateway || '').toLowerCase()
  return !state || state === 'open' || state === 'connected' || state === 'ready'
}

// Profile-switch detection: ONLY a change in the ACTIVE profile value is a
// switch. A closed/reconnecting socket against the same profile is a
// reconnection, never a "switching profile" story.
function shouldEnterProfileSwitch(prevProfile, profile) {
  return profileScope(prevProfile) !== profileScope(profile)
}

function shouldSettleProfileSwitch(gatewayNowReady, switching, elapsedMs, settleMs) {
  if (!switching) return false
  if (gatewayNowReady) return true
  return elapsedMs >= settleMs
}

function payloadFromResponse(response) {
  return response?.payload || response?.result?.payload || response?.result || response?.data || response || {}
}

// ctx.rest 404s when the plugin's Python backend namespace isn't enabled or
// installed in the ACTIVE profile. Surface that explicitly and NEVER try to
// auto-enable/install it — no edits to real profiles.
function isBackendNotEnabled(error) {
  if (!error) return false
  if (typeof error === 'object') {
    const status = error?.status ?? error?.status_code ?? error?.code ?? error?.response?.status ?? error?.payload?.status_code
    if (status === 404) return true
    const text = [error?.message, error?.detail, error?.error, error?.reason, error?.response?.data]
      .filter(value => typeof value === 'string')
      .join(' ')
    if (/not (enabled|installed|mounted)|namespace[^"]*?not (found|enabled|installed)|no plugin backend/i.test(text)) return true
  }
  return /not (enabled|installed|mounted)|namespace.*404/i.test(String(error?.message ?? error ?? ''))
}

// Extract a provider id from a session payload (`provider` field, or the
// `Model: ... (provider)` status line). Returns '' when none is attributable.
function providerFromPayload(payload) {
  const statusMatch = typeof payload?.output === 'string'
    ? payload.output.match(/^Model:\s+.*\(([^()]*)\)\s*$/m)
    : null
  const value = payload?.provider || payload?.info?.provider || statusMatch?.[1]
  return typeof value === 'string' && value.trim() ? normaliseProvider(value) : ''
}

// A session.info event is only OURS when it names our focused session AND, if
// it carries source attribution, that source matches the scope we are mounted
// for. Anonymous events (missing ids) are never accepted — a late cross-profile
// callback must not contaminate remembered provider state.
function eventOwns(event, sessionId, ownerSource, ownerProfile) {
  const payload = event?.payload || event || {}
  const eventSession = event?.session_id || payload?.session_id
  const evSource = String(event?.connection_id || event?.connectionId || payload?.connection_id || payload?.connectionId || '').trim()
  const evProfile = String(event?.profile || payload?.profile || '').trim()
  const ownerConflict = Boolean(evSource || evProfile) &&
    (evSource !== String(ownerSource || '').trim() || evProfile !== String(ownerProfile || '').trim())
  if (sessionId) {
    if (eventSession && eventSession !== sessionId) return false
    if (!eventSession) return false // unidentifiable event -> fail closed
    return !ownerConflict
  }
  // No focused session id: require explicit source attribution that matches us.
  return Boolean(evSource) && Boolean(evProfile) && !ownerConflict
}

function useActiveProvider(sessionId, initialProvider = '', ownerProfile = '', ownerSource = '', ownerScopedKey = '') {
  const scope = providerScopeKey(ownerScopedKey || ownerSource || profileScope(ownerProfile), sessionId)
  const seeded = rememberedSessionProvider(sessionId) || (!sessionId ? rememberedProvider(ownerScopedKey) || normaliseProvider(initialProvider) : '')
  const [state, setState] = useState(() => ({ scope, provider: seeded }))

  useEffect(() => {
    let alive = true
    // A known chat keeps its own provider across focus changes. Never seed it
    // from another chat's last account, and never from the config default.
    const seed = rememberedSessionProvider(sessionId) || (!sessionId ? rememberedProvider(ownerScopedKey) || normaliseProvider(initialProvider) : '')
    setState({ scope, provider: seed })

    const accept = payload => {
      const reported = payload?.session_id || payload?.info?.session_id
      if (sessionId && reported && reported !== sessionId) return
      const value = providerFromPayload(payload)
      if (!value || !alive) return
      if (sessionId) rememberSessionProvider(sessionId, value)
      else rememberProvider(ownerScopedKey, value)
      setState({ scope, provider: value })
    }

    const dispose = host.onEvent('session.info', event => {
      if (!eventOwns(event, sessionId, ownerSource, ownerProfile)) return
      accept(event?.payload || {})
    })

    if (sessionId) {
      // session.status prints "Model: name" with no provider. session.info is
      // the call that actually returns one, so a chat switch doesn't wait on
      // the next random event.
      void host
        .request('session.info', { session_id: sessionId })
        .then(response => {
          if (!alive) return
          accept(payloadFromResponse(response))
        })
        .catch(() => {})
    }

    return () => {
      alive = false
      dispose()
    }
  }, [sessionId, ownerProfile, ownerSource, ownerScopedKey, scope, initialProvider])

  if (state.scope === scope) return state.provider
  return rememberedSessionProvider(sessionId)
}

// Set by the two manual refresh controls: the next overview fetch also asks
// the backend to re-check the published vendor pages (peak schedules and rate
// tables). The 60 s auto-poll and interval refetches never set it, so routine
// traffic never hits vendor pages.
let requestSourcesRefresh = false

function useOverview(ctx, provider, model, fetchProfile, gateway, source) {
  return useQuery({
    queryKey: providerUsageQueryKey(fetchProfile, source),
    queryFn: () => {
      const body = {
        active_provider: provider || null,
        active_model: model || null,
        profile: fetchProfile || null
      }
      if (requestSourcesRefresh) {
        body.refresh_sources = true
        requestSourcesRefresh = false
      }
      return ctx.rest('/overview', { method: 'POST', body, timeoutMs: 25_000 })
    },
    enabled: gatewayReady(gateway) && Boolean(fetchProfile),
    staleTime: 15_000,
    refetchInterval: REFRESH_MS,
    retry: 1
  })
}

// A real profile swap (the ACTIVE profile value changed) is "switching". It
// settles as soon as the gateway is ready again, or after the bounded
// PROFILE_SETTLE_MS window. A merely reconnecting socket on the SAME profile is
// never labelled a switch.
function useSwitchingOverride(profile, gatewayNowReady) {
  const [switching, setSwitching] = useState(false)
  const lastProfile = useRef(profileScope(profile))
  const enteredAt = useRef(0)

  useEffect(() => {
    if (shouldEnterProfileSwitch(lastProfile.current, profile)) {
      lastProfile.current = profileScope(profile)
      enteredAt.current = Date.now()
      setSwitching(true)
    }
  }, [profile])

  useEffect(() => {
    if (shouldSettleProfileSwitch(gatewayNowReady, switching, Date.now() - enteredAt.current, PROFILE_SETTLE_MS)) {
      setSwitching(false)
    }
  }, [gatewayNowReady, switching])

  useEffect(() => {
    if (!switching) return undefined
    const remaining = Math.max(0, PROFILE_SETTLE_MS - (Date.now() - enteredAt.current))
    if (remaining <= 0) {
      setSwitching(false)
      return undefined
    }
    const timer = setTimeout(() => setSwitching(false), remaining)
    return () => clearTimeout(timer)
  }, [switching, profile])

  return switching
}

function providerRow(data, provider) {
  const rows = Array.isArray(data?.providers) ? data.providers : []
  return rows.find(row => row?.id === provider) || null
}

function activeRow(data, provider) {
  // Never fall back to the response's active provider. An empty request makes
  // the backend fill that with the config default (often Codex), which is how
  // a Grok chat's popup opened on the wrong account.
  if (!provider) return null
  return providerRow(data, provider)
}

function accountMatches(data, fetchProfile, activeProfile) {
  const reported = String(data?.account_profile || '').trim()
  if (reported) return profileScope(reported) === profileScope(fetchProfile)
  // An untagged response is the active socket's accounts. Don't present those
  // as another bot's until the backend confirms which profile it read.
  return profileScope(fetchProfile) === profileScope(activeProfile)
}

function mergeOpenCodeRows(rows, activeProvider = '') {
  const openCodeRows = rows.filter(row => row?.id === 'opencode-go' || row?.id === 'opencode-zen')
  if (openCodeRows.length <= 1) return rows
  const base = openCodeRows.find(row => row.id === activeProvider) || openCodeRows.find(row => row.id === 'opencode-go') || openCodeRows[0]
  const products = new Map()
  for (const row of openCodeRows) {
    const candidates = Array.isArray(row.products) && row.products.length > 0
      ? row.products
      : [{
          id: row.id === 'opencode-go' ? 'go' : 'zen',
          label: row.id === 'opencode-go' ? 'Go subscription' : 'Zen API credits',
          kind: row.id === 'opencode-go' ? 'subscription' : 'balance',
          available: row.available,
          limits: row.limits,
          balances: row.balances,
          details: row.details,
          unavailable_reason: row.unavailable_reason
        }]
    for (const product of candidates) {
      const existing = products.get(product.id)
      if (!existing || (!existing.available && product.available)) products.set(product.id, product)
    }
  }
  const merged = { ...base, label: 'OpenCode', products: [...products.values()] }
  const firstIndex = rows.findIndex(row => row?.id === 'opencode-go' || row?.id === 'opencode-zen')
  const withoutProducts = rows.filter(row => row?.id !== 'opencode-go' && row?.id !== 'opencode-zen')
  withoutProducts.splice(firstIndex, 0, merged)
  return withoutProducts
}

// Null and '' mean "not reported", never zero. Number(null) === 0 is the
// classic way an unknown allowance turns into a fabricated exhausted meter.
function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

function round(value) {
  const number = finiteNumber(value)
  return number == null ? null : Math.round(number)
}

// "in 3h 12m" — the glanceable form of a reset time (absolute shown beside it).
function formatCountdown(value) {
  if (!value) return null
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const ms = date.getTime() - Date.now()
  if (ms > -45_000 && ms <= 45_000) return 'now'
  if (ms < 0) return null
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  const restMin = minutes % 60
  if (hours < 24) return restMin ? `${hours}h ${restMin}m` : `${hours}h`
  const days = Math.floor(hours / 24)
  const restHrs = hours % 24
  return restHrs ? `${days}d ${restHrs}h` : `${days}d`
}

// "Tue 3:00 PM", widening to include the day once the date leaves this week.
function formatWhen(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const withinAWeek = date.getTime() - Date.now() < 6.5 * 24 * 3600 * 1000
  return date.toLocaleString([], withinAWeek
    ? { weekday: 'short', hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}

// USD-per-1M-token amounts: two decimals, three below a cent so cheap models
// never render as $0.00.
function rateAmount(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  return `$${number >= 0.01 ? number.toFixed(2) : number.toFixed(3)}`
}

function formatAmount(amount) {
  return Number.isFinite(amount) ? amount.toFixed(2) : '—'
}

function money(balance) {
  const amount = Number(balance?.amount)
  if (!Number.isFinite(amount)) return '—'
  const unit = String(balance?.unit || 'currency').toLowerCase()
  if (unit !== 'currency') {
    const label = balance?.unitLabel || (unit === 'custom' ? 'units' : unit)
    const value = Math.abs(amount - Math.round(amount)) < 1e-9
      ? Math.round(amount).toLocaleString()
      : amount.toFixed(2)
    return `${value} ${label}`
  }
  const currency = String(balance?.currency || '').trim().toUpperCase()
  // Missing currency is NOT USD. An unknown code stays visibly unknown instead
  // of borrowing the dollar sign and overstating what the provider reported.
  if (!currency) return `${formatAmount(amount)} (currency not reported)`
  return currency === 'USD' ? `$${formatAmount(amount)}` : `${currency} ${formatAmount(amount)}`
}

function compactProviderLabel(row) {
  const labels = {
    'openai-codex': 'Codex',
    'xai-oauth': 'Grok',
    openrouter: 'OpenRouter',
    deepseek: 'DeepSeek',
    'opencode-go': 'OpenCode',
    'opencode-zen': 'OpenCode',
    'ollama-cloud': 'Ollama',
    anthropic: 'Claude',
    nous: 'Nous'
  }
  return labels[row?.id] || String(row?.label || row?.id || 'Provider').split(' / ')[0]
}

function isSparkModel(model) {
  return String(model || '').toLowerCase().includes('spark')
}

function windowKind(window) {
  const explicit = String(window?.kind || '').toLowerCase()
  if (explicit === 'five_hour' || explicit === 'five-hour') return '5-hour'
  if (explicit === 'daily' || explicit === 'weekly' || explicit === 'monthly' || explicit === 'rolling' || explicit === 'custom') return explicit
  const label = String(window?.label || '').toLowerCase()
  if (label.includes('week') || label.includes('7-day')) return 'weekly'
  if (label.includes('5-hour') || label.includes('session')) return '5-hour'
  if (label.includes('month') || label.includes('30-day')) return 'monthly'
  return label || 'limit'
}

function shortWindowLabel(window) {
  const kind = windowKind(window)
  if (kind === 'weekly') return 'wk'
  if (kind === '5-hour') return '5h'
  if (kind === 'monthly') return 'mo'
  const label = String(window?.label || 'limit').replace(/^.*·\s*/, '')
  if (/^subscription/i.test(label)) return 'subscription'
  if (/^(allowance|limit)$/i.test(label)) return label.toLowerCase()
  return label.slice(0, 10)
}

function cleanWindowLabel(window) {
  return String(window?.label || 'Allowance').replace(/^.*·\s*/, '')
}

function selectLimit(row, model) {
  const limits = Array.isArray(row?.limits) ? row.limits : []
  if (limits.length === 0) return null

  if (isSparkModel(model)) {
    return limits.find(limit => `${limit?.id} ${limit?.label}`.toLowerCase().includes('spark')) || null
  }

  if (row?.id === 'openai-codex') return limits.find(limit => limit?.id === 'default') || null
  return limits.find(limit => limit?.id === 'default') || (limits.length === 1 ? limits[0] : null)
}

function governingWindows(row, model) {
  const limit = selectLimit(row, model)
  const windows = Array.isArray(limit?.windows)
    ? limit.windows.filter(window => round(window?.remaining_percent) != null)
    : []
  if (windows.length <= 1) return { limit, windows }

  if (row?.id === 'openai-codex' && !isSparkModel(model)) {
    const plan = String(row?.plan || '').toLowerCase()
    if (plan.includes('pro')) {
      const weekly = windows.find(window => windowKind(window) === 'weekly')
      return { limit, windows: weekly ? [weekly] : [windows[0]] }
    }
    if (plan.includes('plus')) {
      const session = windows.find(window => windowKind(window) === '5-hour')
      return { limit, windows: session ? [session] : [windows[0]] }
    }
  }

  return { limit, windows }
}

function preferredBalance(row) {
  const balances = Array.isArray(row?.balances) ? row.balances : []
  if (row?.id === 'openai-codex') {
    return balances.find(balance => /extra|api/i.test(String(balance?.label || ''))) || balances[0] || null
  }
  return balances[0] || null
}

function fundingState(row, model) {
  if (!row) return { kind: 'unknown', windows: [], balance: null, exhausted: false, fallback: false }
  const { limit, windows } = governingWindows(row, model)
  const balance = preferredBalance(row)
  const exhausted = windows.length > 0 && windows.some(window => {
    const remaining = finiteNumber(window?.remaining_percent)
    return remaining != null && remaining <= 0
  })

  if (windows.length > 0 && !exhausted) {
    return { kind: 'subscription', limit, windows, balance, exhausted: false, fallback: false }
  }
  if (balance) {
    return { kind: 'balance', limit, windows, balance, exhausted, fallback: exhausted }
  }
  if (windows.length > 0) {
    return { kind: 'subscription', limit, windows, balance: null, exhausted, fallback: false }
  }
  return { kind: row?.available ? 'details' : 'unavailable', limit: null, windows: [], balance: null, exhausted: false, fallback: false }
}

function dollarWindow(row) {
  const limits = Array.isArray(row?.limits) ? row.limits : []
  for (const limit of limits) {
    const windows = Array.isArray(limit?.windows) ? limit.windows : []
    const found = windows.find(window => finiteNumber(window?.spent_usd) != null && finiteNumber(window?.remaining_usd) != null)
    if (found) return found
  }
  return null
}

function dollarWindowSummary(window) {
  if (!window) return null
  const spent = finiteNumber(window.spent_usd)
  const left = finiteNumber(window.remaining_usd)
  if (spent == null || left == null) return null
  const allowance = finiteNumber(window.allowance_usd)
  const cap = allowance == null ? '' : ` of $${allowance.toFixed(allowance === Math.round(allowance) ? 0 : 2)}`
  return `$${spent.toFixed(2)} spent · $${left.toFixed(2)}${cap} left`
}

function rowHasFunding(row) {
  if (row?.available) return true
  if (Array.isArray(row?.balances) && row.balances.length > 0) return true
  if (Array.isArray(row?.limits) && row.limits.some(limit => Array.isArray(limit?.windows) && limit.windows.length > 0)) return true
  if (row?.key_usage && typeof row.key_usage === 'object') return true
  if (row?.activity && typeof row.activity === 'object') return true
  return false
}

function compactFundingSummary(row, model) {
  const dollars = dollarWindowSummary(dollarWindow(row))
  if (dollars) return dollars
  const state = fundingState(row, model)
  // A healthy free-model meter must not hide the credit balance. That is how
  // OpenRouter's remaining credits disappeared behind "limited data".
  if (state.balance && (row?.id === 'openrouter' || state.kind === 'balance')) {
    return state.fallback ? `${money(state.balance)} extra` : money(state.balance)
  }
  if (state.kind === 'subscription') {
    if (state.windows.length === 1) {
      const window = state.windows[0]
      const label = shortWindowLabel(window)
      const remaining = round(window.remaining_percent)
      if (remaining == null) return `${label} unavailable`
      return /^(subscription|allowance|limit)$/i.test(label) ? `${remaining}% left` : `${label} ${remaining}%`
    }
    return state.windows
      .map(window => {
        const remaining = round(window.remaining_percent)
        return remaining == null ? `${shortWindowLabel(window)} unavailable` : `${shortWindowLabel(window)} ${remaining}%`
      })
      .join(' · ')
  }
  if (row?.id === 'opencode-zen') return 'Zen balance unavailable'
  if (state.balance) return money(state.balance)
  if (row?.available && row?.details?.[0]) return String(row.details[0]).slice(0, 24)
  return row?.available ? 'available' : 'limited data'
}

function statusFundingSummary(row, model) {
  const state = fundingState(row, model)
  if (row?.id === 'opencode-go' && state.kind === 'subscription') {
    // Keep the revenue-relevant 5-hour + weekly meters, compress a healthy
    // monthly away, but NEVER hide a blocking/exhausted window. Order the
    // blocking (exhausted) meters FIRST so the chip's trailing truncation cuts
    // a healthy meter, never the one blocking requests. The pane keeps the full
    // set via AllProviderMetrics regardless.
    const shown = state.windows.filter(window => {
      const remaining = round(window?.remaining_percent)
      if (remaining == null) return false
      const label = shortWindowLabel(window)
      if (label === 'mo' && remaining > 0) return false // healthy monthly compresses away
      return label === '5h' || label === 'wk' || remaining <= 0 // 5h/wk + any blocker
    })
    if (shown.length > 0) {
      const blocked = window => (round(window?.remaining_percent) ?? 0) <= 0
      const ordered = [...shown.filter(blocked), ...shown.filter(window => !blocked(window))]
      return ordered.map(window => `${shortWindowLabel(window)} ${round(window.remaining_percent)}%`).join(' · ')
    }
  }
  return compactFundingSummary(row, model)
}

function chipDescription(row, model, data, switching, ready, refetchError, scope, backendGone) {
  if (switching) return `Switching profile — ${scope.fetchProfile} usage will refresh when the new profile is ready.`
  const updated = data?.fetched_at ? new Date(data.fetched_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'not yet'
  const accountNote = scope?.fetchProfile && scope.fetchProfile !== scope.activeProfile
    ? ` Accounts on ${scope.fetchProfile}.`
    : ''
  if (backendGone) {
    // The active profile's socket has no provider-usage backend installed (its
    // /overview 404s). Surfacing just "unavailable" would hide the cause; the
    // toolbar must say the backend isn't there and never auto-install it.
    return `Provider usage isn't enabled on the active profile (${scope.activeProfile || scope.fetchProfile}), so this machine can't read the accounts. Enable the plugin there; Hermes never edits profiles automatically.`
  }
  if (!ready) {
    return row
      ? `Provider usage for ${scope.fetchProfile} is from ${updated}; reconnecting.${accountNote}`
      : `Provider usage for ${scope.fetchProfile}. Reconnecting.${accountNote}`
  }
  if (refetchError) {
    return row
      ? `Provider usage for ${scope.fetchProfile} could not be refreshed — showing ${updated}.${accountNote}`
      : `Provider usage for ${scope.fetchProfile}. Could not refresh.${accountNote}`
  }
  if (!row) return `Provider usage for ${scope.fetchProfile}. Last updated ${updated}.${accountNote}`
  const modelName = model ? ` Active model ${model}.` : ''
  return `${row.label}: ${statusFundingSummary(row, model)}.${modelName}${accountNote} Open the Provider Usage pane for every reported window. Updated ${updated}.`
}

// ── Running agents (delegated children of THIS chat) ─────────────────────────
// Identity is the gateway's session-scoped, owner-checked `subagent.list` read.
// Its rows publish the child's id, goal, model, status, start time, and — on a
// backend with the running-agents metadata seam — the provider its runtime
// actually resolved plus a stable non-secret account id. A model slug is NOT
// proof of a provider; neither is the popover's active provider. Usage is
// attached only when the row publishes an account id AND this account's cached
// inventory row names exactly one matching account identity (same credential,
// same profile/connection scope). Anything else shows `—`, never a borrowed
// balance. The pool is always the provider's shared pool, never per-agent spend.
const RUNNING_AGENTS_REFRESH_MS = 5_000
const RUNNING_AGENT_TERMINAL = new Set(['completed', 'failed', 'interrupted', 'cancelled', 'canceled', 'timeout', 'error'])

function runningAgentsQueryKey(sourceId, sessionId) {
  // Session + connection-qualified: two chats, or the same chat name on another
  // source, must never share a running-agent snapshot.
  return ['jg-provider-usage', 'running-agents', sourceId || '', sessionId || '']
}

function normaliseRunningAgents(payload, sessionId) {
  const bound = String(payload?.session_id || payload?.sessionId || '').trim()
  // A late payload for a conversation we already left is discarded outright.
  if (bound && sessionId && bound !== sessionId) return []
  const rows = Array.isArray(payload?.subagents) ? payload.subagents : []
  const seen = new Set()
  return rows
    .map(row => ({
      id: String(row?.subagent_id || '').trim(),
      goal: typeof row?.goal === 'string' ? row.goal : '',
      model: typeof row?.model === 'string' ? row.model.trim() : '',
      provider: typeof row?.provider === 'string' ? row.provider.trim() : '',
      providerAccountId: typeof row?.provider_account_id === 'string' ? row.provider_account_id.trim() : '',
      status: String(row?.status || 'running').trim().toLowerCase(),
      depth: finiteNumber(row?.depth),
      startedAt: finiteNumber(row?.started_at)
    }))
    .filter(row => {
      if (!row.id || RUNNING_AGENT_TERMINAL.has(row.status) || seen.has(row.id)) return false
      seen.add(row.id)
      return true
    })
}

// Provider truth is only what the backend publishes. A provider-qualified model
// slug (`openrouter/...`) is a model namespace, not an executed route: the same
// slug can be served by another gateway/account, so it never verifies a pool.
function runningAgentProvider(agent) {
  return normaliseProvider(agent?.provider)
}

function runningAgentAccountId(agent) {
  return String(agent?.providerAccountId || '').trim()
}

function inventoryAccount(entry) {
  if (!entry || typeof entry !== 'object') return null
  const id = String(entry.identity_id || entry.account_id || entry.id || '').trim()
  if (!id) return null
  return { id, label: String(entry.label || entry.name || '').trim() }
}

// The account identity a cached provider row actually belongs to. A row may
// carry one `accounts` entry (core `ProviderUsageAccount`, key `id`) or the
// flat `identity_id` from `list_account_usage_identities`. The provider `id` is
// never treated as an account id.
function providerInventoryAccounts(row) {
  const seen = new Set()
  const accounts = []
  const listed = Array.isArray(row?.accounts) ? row.accounts : []
  for (const entry of listed) {
    const account = inventoryAccount(entry)
    if (account && !seen.has(account.id)) { seen.add(account.id); accounts.push(account) }
  }
  const direct = String(row?.identity_id || row?.account_id || '').trim()
  if (direct && !seen.has(direct)) accounts.push({ id: direct, label: String(row?.account_label || '').trim() })
  return accounts
}

// Only a row that belongs to exactly one account can prove its cached pool is
// the child's pool. A multi-account row (or none) is ambiguous by construction:
// attaching its figure could show another credential's quota, so it stays unknown.
function runningAgentAccount(agent, row) {
  const wanted = runningAgentAccountId(agent)
  if (!wanted || !row) return null
  const accounts = providerInventoryAccounts(row)
  return accounts.length === 1 && accounts[0].id === wanted ? accounts[0] : null
}

function sharedPoolUsage(row, model) {
  if (!row || row.available === false) return null
  const text = String(compactFundingSummary(row, model) || '').trim()
  if (!text || text === '—') return null
  // Only a quantified figure is usage. "available" / "limited data" / a prose
  // detail line are not a percentage or a credit balance.
  if (!(/%/.test(text) || /\$/.test(text) || /^\d/.test(text))) return null
  return { text, exhausted: Boolean(fundingState(row, model).exhausted) }
}

function runningAgentGroups(rows, { providerRows } = {}) {
  const inventory = new Map()
  for (const entry of Array.isArray(providerRows) ? providerRows : []) {
    const id = normaliseProvider(entry?.id)
    if (id) inventory.set(id, entry)
  }
  const groups = new Map()
  for (const agent of Array.isArray(rows) ? rows : []) {
    if (!agent || !agent.id) continue
    const provider = runningAgentProvider(agent)
    const model = String(agent.model || '').trim()
    const accountId = provider ? runningAgentAccountId(agent) : ''
    // A published (even unverified) account id is part of identity: two workers
    // on different credentials must not collapse into one row. No provider means
    // no account claim at all, so the model-only group stays anonymous.
    const accountKey = accountId ? `a:${accountId}` : 'a:?'
    const key = provider ? `p:${provider}::${accountKey}::${model}` : model ? `m:${model}` : 'identity-unknown'
    let group = groups.get(key)
    if (!group) {
      group = {
        key, provider, providerLabel: '', model, accountId, accountLabel: '',
        accountVerified: false, count: 0, goals: [], usage: null, exhausted: false
      }
      groups.set(key, group)
    }
    group.count += 1
    if (agent.goal) group.goals.push(agent.goal)
  }
  for (const group of groups.values()) {
    if (!group.provider) continue
    const row = inventory.get(group.provider)
    if (row) group.providerLabel = String(row.label || row.name || group.provider)
    const account = runningAgentAccount({ providerAccountId: group.accountId }, row)
    group.accountVerified = Boolean(account)
    group.accountLabel = account?.label || ''
    if (!account) continue
    const usage = sharedPoolUsage(row, group.model)
    group.usage = usage ? usage.text : null
    group.exhausted = Boolean(usage?.exhausted)
  }
  return [...groups.values()]
}

function runningAgentTotal(groups) {
  return (Array.isArray(groups) ? groups : [])
    .reduce((sum, group) => sum + (group && group.count > 0 ? group.count : 0), 0)
}

function RunningAgentRow({ group }) {
  const modelText = group.model || 'model not reported'
  const providerText = group.provider
    ? [group.providerLabel || group.provider, group.accountLabel].filter(Boolean).join(' · ')
    : 'provider not reported'
  const usageText = group.usage || '—'
  const tip = [
    group.count > 1 ? `${group.count} running` : 'Running',
    ...group.goals.slice(0, 3),
    group.provider
      ? group.accountVerified
        ? `Shared ${group.providerLabel || group.provider} pool${group.usage ? `: ${group.usage}` : ': usage unknown'}${group.accountLabel ? ` for ${group.accountLabel}` : ''}`
        : 'The backend reports this child’s provider but not a matching account for this profile, so usage is unavailable.'
      : 'This backend does not report the child’s provider, so no account is attributed.'
  ].join('\n')
  return jsx(Tip, {
    label: tip,
    children: jsxs('div', {
      'data-running-agent': group.key,
      style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, fontSize: 10.5, lineHeight: 1.35 },
      children: [
        jsx(StatusDot, { tone: group.exhausted ? 'warn' : group.usage ? 'good' : 'muted', style: { flex: '0 0 auto' } }, 'dot'),
        jsxs('span', {
          style: { flex: '1 1 auto', minWidth: 0, display: 'flex', gap: 4, alignItems: 'baseline', overflow: 'hidden', whiteSpace: 'nowrap', textOverflow: 'ellipsis' },
          children: [
            group.count > 1
              ? jsx('span', { style: { ...textSecondary, fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }, children: `${group.count}×` }, 'count')
              : null,
            jsx('span', { style: { ...textSecondary, overflow: 'hidden', textOverflow: 'ellipsis' }, children: modelText }, 'model'),
            jsx('span', { style: { color: 'var(--ui-text-tertiary)', flex: '0 1 auto', overflow: 'hidden', textOverflow: 'ellipsis' }, children: `· ${providerText}` }, 'provider')
          ]
        }),
        jsx('span', {
          'aria-label': group.usage
            ? `Shared pool ${group.usage}`
            : group.provider
              ? 'Shared pool usage unavailable: account not verified'
              : 'Shared pool usage unknown',
          style: { flex: '0 0 auto', fontSize: 10, fontVariantNumeric: 'tabular-nums', color: group.exhausted ? 'var(--ui-orange)' : 'var(--ui-text-tertiary)' },
          children: usageText
        }, 'usage')
      ]
    })
  })
}

function RunningAgentsSection({ groups }) {
  const rows = Array.isArray(groups) ? groups.filter(group => group && group.count > 0) : []
  if (rows.length === 0) return null
  const total = runningAgentTotal(rows)
  return jsxs('section', {
    'aria-label': `Running agents: ${total}`,
    'data-running-agents': String(total),
    style: { display: 'grid', gap: 5, borderTop: HAIRLINE, paddingTop: 9, marginTop: 1 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8 },
        children: [
          jsx('span', { style: { ...textSecondary, fontSize: 10, fontWeight: 600 }, children: 'Running agents' }, 'label'),
          jsx('span', { style: { ...textSecondary, fontSize: 10, fontVariantNumeric: 'tabular-nums' }, children: total === 1 ? '1 agent' : `${total} agents` }, 'count')
        ]
      }),
      ...rows.map(group => jsx(RunningAgentRow, { group }, group.key))
    ]
  })
}

// Query wrapper: ONE `subagent.list` read for the whole footer (never one per
// agent), only while the popover is actually open on a ready socket. Polling
// stops the moment either stops being true, so a closed popover is silent.
function RunningAgentsFooter({ sessionId, active, gateway, sourceId, providerRows }) {
  const enabled = Boolean(active && sessionId) && gatewayReady(gateway)
  const agents = useQuery({
    queryKey: runningAgentsQueryKey(sourceId, sessionId),
    enabled,
    staleTime: 4_000,
    refetchInterval: RUNNING_AGENTS_REFRESH_MS,
    retry: 1,
    queryFn: async () => normaliseRunningAgents(
      await host.request('subagent.list', { session_id: sessionId }),
      sessionId
    )
  })
  const rows = enabled && Array.isArray(agents.data) ? agents.data : []
  const groups = runningAgentGroups(rows, { providerRows })
  return jsx(RunningAgentsSection, { groups })
}

function formatReset(value) {
  if (!value) return 'Reset time unavailable'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Reset time unavailable'
  return `Resets ${date.toLocaleString([], {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit'
  })}`
}

function formatUpdated(value) {
  if (!value) return 'Not updated yet'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return 'Not updated yet'
  return `Updated ${date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

function windowMeta(window) {
  const resetAt = window?.reset_at || window?.resets_at || window?.renewal_at || null
  const detail = typeof window?.detail === 'string' && window.detail.trim() ? window.detail.trim() : null
  const countdown = resetAt ? formatCountdown(resetAt) : null
  const when = resetAt ? formatWhen(resetAt) : null
  const resetPart = resetAt
    ? countdown
      ? `Resets in ${countdown} · ${when}`
      : `Resets ${when}`
    : window?.rolling
      ? 'Rolling window'
      : 'Reset time not reported'
  const parts = [resetPart, detail].filter(Boolean)
  return parts.join(' • ')
}

function progressWidth(window) {
  const remaining = Number(window?.remaining_percent)
  if (!Number.isFinite(remaining)) return '0%'
  return `${Math.max(0, Math.min(100, remaining))}%`
}

function windowUnitLabel(window) {
  const unit = String(window?.unit || '').toLowerCase()
  if (!unit || unit === 'percent') return '%'
  if (unit === 'custom') return 'units'
  return window?.unitLabel || unit
}

function formatWindowQuantity(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (Math.abs(number - Math.round(number)) < 1e-9) return Math.round(number).toLocaleString()
  if (Math.abs(number) >= 100) return number.toLocaleString(undefined, { maximumFractionDigits: 0 })
  return number.toLocaleString(undefined, { maximumFractionDigits: 2 })
}

// Percent is the primary reading. When a definition only supplies absolute
// values (used/limit or remaining), show those rather than a fabricated 0%.
function windowValueSummary(window) {
  const dollars = dollarWindowSummary(window)
  if (dollars) return dollars
  const remaining = round(window?.remaining_percent)
  if (remaining != null) return `${remaining}% left`
  const used = finiteNumber(window?.used)
  const limit = finiteNumber(window?.limit)
  const left = finiteNumber(window?.remaining)
  if (limit != null && limit === 0) return 'No allowance'
  if (used != null && limit != null && limit > 0) {
    return `${formatWindowQuantity(used)} / ${formatWindowQuantity(limit)} ${windowUnitLabel(window)}`
  }
  if (used != null) return `${formatWindowQuantity(used)} ${windowUnitLabel(window)} used`
  if (left != null) return `${formatWindowQuantity(left)} ${windowUnitLabel(window)} left`
  return 'Unavailable'
}

function UsageMeter({ window, compact = false }) {
  const remaining = round(window?.remaining_percent)
  const exhausted = remaining != null && remaining <= 0
  const low = remaining != null && remaining > 0 && remaining <= 15
  const meterTone = exhausted
    ? 'var(--dt-destructive)'
    : low
      ? 'var(--ui-orange)'
      : 'var(--ui-accent)'
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 6 : 7, padding: compact ? '7px 0' : '9px 0' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
        children: [
          jsx('span', { style: { ...textSecondary, fontSize: compact ? 11 : 12, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: cleanWindowLabel(window) }),
          jsx('strong', {
            style: { ...textPrimary, color: exhausted || low ? meterTone : textPrimary.color, fontSize: compact ? 11.5 : 12.5, fontWeight: 650, fontVariantNumeric: 'tabular-nums' },
            children: windowValueSummary(window)
          })
        ]
      }),
      jsx('div', {
        role: 'progressbar',
        'aria-label': `${cleanWindowLabel(window)} remaining`,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': remaining == null ? undefined : remaining,
        style: { height: compact ? 5 : 6, borderRadius: 999, overflow: 'hidden', background: 'var(--ui-bg-quaternary)' },
        children: jsx('div', {
          style: {
            width: progressWidth(window),
            height: '100%',
            borderRadius: 999,
            background: meterTone,
            transition: 'width 180ms ease-out'
          }
        })
      }),
      jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: dollarWindowSummary(window) ? (window?.reset_at ? formatReset(window.reset_at) : 'Resets with the plan') : windowMeta(window) })
    ]
  })
}

function BalanceMetric({ balance, prominent = false, subdued = false }) {
  const total = Number(balance?.total)
  const used = Number(balance?.used)
  const granted = Number(balance?.granted)
  const toppedUp = Number(balance?.topped_up)
  const usedRatio = Number.isFinite(total) && total > 0 && Number.isFinite(used)
    ? Math.max(0, Math.min(1, used / total))
    : null
  const unit = String(balance?.unit || 'currency').toLowerCase()
  const currency = String(balance?.currency || '').trim().toUpperCase()
  const unknownCurrency = unit === 'currency' && !currency
  const moneyValue = amount => unknownCurrency
    ? formatAmount(amount)
    : money({ amount, currency, unit: balance?.unit, unitLabel: balance?.unitLabel })
  const detail = typeof balance?.detail === 'string' ? balance.detail.trim() : ''
  const details = [
    Number.isFinite(total) && Number.isFinite(used)
      ? `${moneyValue(used)} used of ${moneyValue(total)}`
      : null,
    Number.isFinite(granted)
      ? `${moneyValue(granted)} granted`
      : null,
    Number.isFinite(toppedUp)
      ? `${moneyValue(toppedUp)} topped up`
      : null,
    detail || null,
    balance?.expires_at ? `Expires ${new Date(balance.expires_at).toLocaleString()}` : null
  ].filter(Boolean)
  return jsxs('div', {
    style: { display: 'grid', gap: 2, padding: prominent ? '1px 0' : '7px 0' },
    children: [
      jsx('span', { style: { ...textSecondary, fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: balance?.label || 'Balance' }),
      jsx('strong', {
        style: { ...(subdued ? textSecondary : textPrimary), fontSize: prominent ? 27 : subdued ? 12 : 20, fontWeight: subdued ? 550 : 650, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
        children: money(balance)
      }),
      usedRatio != null
        ? jsx('div', {
            role: 'progressbar',
            'aria-label': `${balance?.label || 'Balance'} used`,
            'aria-valuemin': 0,
            'aria-valuemax': 100,
            'aria-valuenow': Math.round(usedRatio * 100),
            style: { height: 4, borderRadius: 999, overflow: 'hidden', background: 'var(--ui-bg-quaternary)', margin: '5px 0 3px' },
            children: jsx('div', { style: { width: `${Math.round(usedRatio * 100)}%`, height: '100%', borderRadius: 999, background: 'var(--ui-accent)' } })
          })
        : null,
      details.length > 0
        ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.5, overflowWrap: 'anywhere' }, children: details.join(' · ') })
        : null
    ]
  })
}

function cleanDetails(row) {
  const hasLimits = Array.isArray(row?.limits) && row.limits.length > 0
  const hasBalances = Array.isArray(row?.balances) && row.balances.length > 0
  return (Array.isArray(row?.details) ? row.details : []).filter(detail => {
    const text = String(detail || '')
    if (hasLimits && (/^\d+% remaining$/i.test(text) || /^resets:/i.test(text))) return false
    if (hasBalances && (/^(?:[A-Z]{3} )?balance:|^credits (?:remaining|balance):/i.test(text) || /granted|topped up/i.test(text))) return false
    if (/^account available: yes$/i.test(text)) return false
    if (Array.isArray(row?.breakdown) && row.breakdown.length > 0 && /^one shared pool/i.test(text)) return false
    if (row?.activity && (/^\$[\d,.]+ · .+ requests$/i.test(text) || /^tokens in the last /i.test(text))) return false
    return true
  })
}

function SectionLabel({ children, aside = null }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
    children: [
      jsx('h3', {
        style: { ...textSecondary, margin: 0, fontSize: 10, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.07em' },
        children
      }),
      aside ? jsx('span', { style: { ...textSecondary, fontSize: 9 }, children: aside }) : null
    ]
  })
}

// Sentence-case section title for the reading sections (the settings-style
// uppercase SectionLabel stays for small captions).
function SectionTitle({ children, aside = null }) {
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
    children: [
      jsx('h3', { style: { ...textPrimary, margin: 0, fontSize: 12, lineHeight: 1.35, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children }),
      aside ? jsx('span', { style: { ...textSecondary, fontSize: 10 }, children: aside }) : null
    ]
  })
}

function LimitGroup({ rowId, limit, grouped = false }) {
  const windows = Array.isArray(limit?.windows) ? limit.windows : []
  if (windows.length === 0) return null
  const blocked = limit?.limit_reached === true || limit?.allowed === false
  const exhaustedWindows = windows
    .filter(window => round(window?.remaining_percent) !== null && round(window?.remaining_percent) <= 0)
    .map(window => cleanWindowLabel(window))
  const blockedLabel = exhaustedWindows.length > 0 ? `${exhaustedWindows.join(' + ')} exhausted` : 'Blocked'
  return jsxs('div', {
    style: { display: 'grid', gap: 1, paddingTop: grouped ? 10 : 0, borderTop: grouped ? HAIRLINE : 'none' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
        children: [
          jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.4, fontWeight: 600 }, children: limit?.label || 'Account limit' }),
          limit?.allowed != null || limit?.limit_reached != null
            ? jsx('span', {
                style: { ...textSecondary, color: blocked ? 'var(--dt-destructive)' : undefined, fontSize: 9, fontWeight: blocked ? 650 : 500, textTransform: 'uppercase', letterSpacing: '0.05em' },
                children: blocked ? blockedLabel : 'Available'
              })
            : null
        ]
      }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: windows.length > 1 ? 'repeat(auto-fit, minmax(200px, 1fr))' : '1fr', columnGap: 18, rowGap: 1 },
        children: windows.map(window => jsx(UsageMeter, { window, compact: true }, `${rowId}-${limit?.id}-${window?.label}`))
      })
    ]
  })
}

function rateSummary(entry) {
  const parts = [
    [rateAmount(entry?.input), 'in'],
    [rateAmount(entry?.output), 'out'],
    [rateAmount(entry?.cache_read), 'cache-read'],
    [rateAmount(entry?.cache_write), 'cache-write']
  ].filter(([amount]) => Boolean(amount)).map(([amount, label]) => `${amount} ${label}`)
  return parts.join(' · ')
}

function formatCheckStamp(value) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return null
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  return date.toDateString() === new Date().toDateString()
    ? `today ${time}`
    : `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}

function rateSourceLine(pricing) {
  const versions = [...new Set(pricing.map(entry => entry?.pricing_version).filter(Boolean))]
  const hosts = [...new Set(pricing.map(entry => {
    if (!entry?.source_url) return null
    try {
      return new URL(entry.source_url).hostname
    } catch {
      return null
    }
  }).filter(Boolean))]
  const checked = [...new Set(pricing.map(entry => entry?.checked_at).filter(Boolean))].sort().pop() || null
  const parts = []
  if (versions.length > 0) parts.push(versions.join(' · '))
  if (hosts.length > 0) parts.push(...hosts)
  if (checked) {
    const stamp = formatCheckStamp(checked)
    if (stamp) parts.push(`page-checked ${stamp}`)
  }
  return parts.length > 0 ? `Rate card: ${parts.join(' · ')}` : null
}

function PeakNote({ peak, separated = false }) {
  if (!peak || typeof peak !== 'object') return null
  const isPeak = peak.mode === 'peak'
  const multiplier = Number.isFinite(Number(peak.multiplier)) ? ` · ${round(Number(peak.multiplier))}×` : ''
  const countdown = peak.next_change_at ? formatCountdown(peak.next_change_at) : null
  const when = peak.next_change_at ? formatWhen(peak.next_change_at) : null
  const hint = countdown ? `peak ${isPeak ? 'ends' : 'starts'} in ${countdown}${when ? ` · ${when}` : ''}` : null
  return jsxs('div', {
    style: { display: 'grid', gap: 5, paddingTop: separated ? 9 : 0, borderTop: separated ? HAIRLINE : 'none' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
        children: [
          jsx(Badge, { variant: isPeak ? 'warn' : 'success', size: 'xs', children: isPeak ? `Peak now${multiplier}` : 'Off-peak now' }, 'badge'),
          hint ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }, children: hint }, 'hint') : null
        ]
      }),
      peak.schedule_local || peak.schedule
        ? jsx('span', {
            style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, overflowWrap: 'anywhere' },
            title: peak.schedule_local
              ? [
                  `Published schedule (UTC): ${peak.schedule}`,
                  peak.schedule_fetched_at
                    ? `Auto-checked ${new Date(peak.schedule_fetched_at).toLocaleString()}`
                    : 'Bundled copy — auto-check pending'
                ].join('\n')
              : undefined,
            children: peak.schedule_local || peak.schedule
          }, 'schedule')
        : null
    ]
  })
}

function RatesPanel({ row, always = false, compact = false }) {
  const pricing = Array.isArray(row?.pricing) ? row.pricing : []
  const peak = row?.peak && typeof row.peak === 'object' ? row.peak : null
  if (!always && pricing.length === 0 && !peak) return null
  const source = pricing.length > 0 ? rateSourceLine(pricing) : null
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 8 : 9, paddingTop: compact ? 11 : 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, { aside: pricing.length > 0 ? 'per 1M tokens' : null, children: compact ? 'Rates' : 'Rates & peak pricing' }, 'title'),
      pricing.length > 0
        ? jsx('div', {
            style: { display: 'grid', gap: compact ? 6 : 7 },
            children: pricing.map((entry, index) => jsxs('div', {
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: '2px 10px', flexWrap: 'wrap' },
              children: [
                jsxs('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: '1 1 90px' }, children: [
                  jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry?.model || 'Model' }, 'model'),
                  entry?.active ? jsx(Badge, { variant: 'outline', size: 'xs', children: 'current' }, 'current') : null
                ] }, 'name'),
                jsx('span', { style: { ...textPrimary, fontSize: 11, fontWeight: 550, fontVariantNumeric: 'tabular-nums', textAlign: 'right', marginLeft: 'auto', overflowWrap: 'anywhere' }, children: rateSummary(entry) || '—' }, 'rates')
              ]
            }, `rate-${index}`))
          }, 'rows')
        : jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: 'No published token-rate card is available for this provider yet.' }, 'empty'),
      source ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: source }, 'source') : null,
      pricing.some(entry => entry?.changed_from_card)
        ? jsx('span', {
            style: { color: 'var(--ui-orange)', fontSize: 9.5, lineHeight: 1.45, fontWeight: 550 },
            children: "Refreshed from the vendor page — Hermes' own cost tracker still uses its bundled card until core updates."
          }, 'diverged')
        : null,
      jsx(PeakNote, { peak }, 'peak')
    ]
  })
}

function legacyPlanNote(plan) {
  if (!/supergrok/i.test(String(plan || ''))) return null
  return 'API still uses this SuperGrok name. X Ultra replaces it; Cursor shows up in the split when the API starts sending it.'
}

function BreakdownPanel({ row, compact = false }) {
  const rows = Array.isArray(row?.breakdown)
    ? row.breakdown.filter(item => Number.isFinite(Number(item?.used_percent)))
    : []
  if (rows.length === 0) return null
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 6 : 7, paddingTop: compact ? 11 : 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, { aside: 'one pool', children: compact ? 'Breakdown' : 'Usage breakdown' }, 'title'),
      jsx('div', {
        style: { display: 'grid', gap: compact ? 5 : 6 },
        children: rows.map(item => {
          const used = Math.max(0, Math.min(100, Number(item.used_percent)))
          return jsxs('div', {
            style: { display: 'grid', gap: 3 },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
                children: [
                  jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 550 }, title: item.id ? `API product: ${item.id}` : undefined, children: item.label || 'Product' }, 'label'),
                  jsx('span', { style: { ...textPrimary, fontSize: 11, fontVariantNumeric: 'tabular-nums' }, children: `${round(used)}%` }, 'pct')
                ]
              }, 'row'),
              jsx('div', {
                role: 'progressbar',
                'aria-label': `${item.label || 'Product'} share of the pool`,
                'aria-valuemin': 0,
                'aria-valuemax': 100,
                'aria-valuenow': Math.round(used),
                style: { height: 4, borderRadius: 999, overflow: 'hidden', background: 'var(--ui-bg-quaternary)' },
                children: jsx('div', { style: { width: `${used > 0 ? Math.max(2, used) : 0}%`, height: '100%', borderRadius: 999, background: 'var(--ui-accent)' } })
              }, 'bar')
            ]
          }, item.id || item.label)
        })
      }, 'rows'),
      row.breakdown_note
        ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: row.breakdown_note }, 'note')
        : null
    ]
  })
}

function formatTokens(value) {
  const number = Number(value)
  if (!Number.isFinite(number)) return null
  if (number >= 1_000_000_000) return `${(number / 1_000_000_000).toFixed(1)}B`
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`
  if (number >= 1_000) return `${(number / 1_000).toFixed(0)}K`
  return `${Math.round(number)}`
}

function CachePanel({ cache, compact = false }) {
  if (!cache || typeof cache !== 'object') return null
  const hitRate = Number(cache.hit_rate)
  const read = Number(cache.cache_read_tokens)
  const prompt = Number(cache.prompt_tokens)
  if (!Number.isFinite(hitRate) || !Number.isFinite(read) || read <= 0 || !Number.isFinite(prompt) || prompt <= 0) return null
  const pct = Math.round(hitRate * 1000) / 10
  const saved = Number(cache.saved_usd)
  const meta = [
    `${formatTokens(read)} of ${formatTokens(prompt)} prompt tokens served from cache`,
    Number(cache.cache_write_tokens) > 0 ? `${formatTokens(cache.cache_write_tokens)} written to cache` : null
  ].filter(Boolean).join(' · ')
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 7 : 8, paddingTop: compact ? 11 : 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, { aside: `last ${Number(cache.days) || 7} days`, children: compact ? 'Cache' : 'Prompt cache' }, 'title'),
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
        children: [
          jsx('strong', { style: { ...textPrimary, fontSize: compact ? 14 : 15, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }, children: `${pct}% hit rate` }, 'rate'),
          Number.isFinite(saved) && saved > 0
            ? jsx('span', {
                style: { ...textSecondary, fontSize: 11, fontVariantNumeric: 'tabular-nums' },
                children: `est. saved ${money({ amount: saved, currency: 'USD' })}${cache.saved_partial ? '+' : ''}`
              }, 'saved')
            : null
        ]
      }),
      jsx('div', {
        role: 'progressbar',
        'aria-label': 'prompt cache hit rate',
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': Math.round(hitRate * 100),
        style: { height: compact ? 4 : 5, borderRadius: 999, overflow: 'hidden', background: 'var(--ui-bg-quaternary)' },
        children: jsx('div', { style: { width: `${Math.max(2, Math.round(hitRate * 100))}%`, height: '100%', borderRadius: 999, background: 'var(--ui-accent)' } })
      }, 'bar'),
      jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: meta }, 'meta')
    ]
  })
}

function ActivityPanel({ activity, compact = false }) {
  if (!activity || typeof activity !== 'object') return null
  const requests = Number(activity.requests)
  const usd = Number(activity.usd)
  const buckets = Array.isArray(activity.buckets) ? activity.buckets.filter(entry => entry && typeof entry === 'object') : []
  if ((!Number.isFinite(requests) || requests <= 0) && (!Number.isFinite(usd) || usd <= 0) && buckets.length === 0) return null
  const peak = Math.max(0, ...buckets.map(entry => Number(entry.usd) || 0))
  const headline = [
    Number.isFinite(usd) ? money({ amount: usd, currency: 'USD' }) : null,
    Number.isFinite(requests) ? `${requests.toLocaleString()} requests` : null
  ].filter(Boolean).join(' · ')
  const tokens = [
    Number.isFinite(Number(activity.input_tokens)) ? `${formatTokens(activity.input_tokens)} in` : null,
    Number.isFinite(Number(activity.output_tokens)) ? `${formatTokens(activity.output_tokens)} out` : null,
    Number.isFinite(Number(activity.cached_tokens))
      ? `${formatTokens(activity.cached_tokens)} cached${Number.isFinite(Number(activity.hit_rate)) ? ` (${Math.round(Number(activity.hit_rate) * 100)}%)` : ''}`
      : null
  ].filter(Boolean).join(' · ')
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 7 : 8, paddingTop: compact ? 11 : 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, { aside: `last ${activity.range || '7d'}`, children: 'Activity' }, 'title'),
      headline
        ? jsx('strong', { style: { ...textPrimary, fontSize: compact ? 14 : 15, fontWeight: 650, fontVariantNumeric: 'tabular-nums' }, children: headline }, 'headline')
        : null,
      buckets.length > 0
        ? jsx('div', {
            style: { display: 'flex', alignItems: 'flex-end', gap: 3, height: compact ? 22 : 28 },
            children: buckets.map((entry, index) => {
              const value = Number(entry.usd) || 0
              const ratio = peak > 0 ? value / peak : 0
              const when = entry.from ? new Date(entry.from).toLocaleDateString([], { month: 'short', day: 'numeric' }) : null
              const count = Number(entry.requests)
              const tip = [
                when,
                value > 0 ? money({ amount: value, currency: 'USD' }) : 'no usage',
                Number.isFinite(count) && count > 0 ? `${count.toLocaleString()} requests` : null
              ].filter(Boolean).join(' · ')
              return jsx('div', {
                title: tip,
                style: {
                  flex: 1,
                  minHeight: 2,
                  height: value > 0 ? `${Math.max(8, Math.round(ratio * 100))}%` : 3,
                  borderRadius: 3,
                  background: value > 0 ? 'var(--ui-accent)' : 'var(--ui-bg-quaternary)',
                  opacity: index === buckets.length - 1 ? 1 : 0.65
                }
              }, `activity-${index}`)
            })
          }, 'spark')
        : null,
      tokens ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: tokens }, 'meta') : null
    ]
  })
}

function KeyUsagePanel({ keyUsage, compact = false }) {
  if (!keyUsage || typeof keyUsage !== 'object') return null
  const total = Number(keyUsage.total)
  const rows = [
    { label: 'Today', amount: Number(keyUsage.daily) },
    { label: 'This week', amount: Number(keyUsage.weekly) },
    { label: 'This month', amount: Number(keyUsage.monthly) },
    { label: 'BYOK', amount: Number(keyUsage.byok_total) }
  ].filter(row => Number.isFinite(row.amount) && (row.label !== 'BYOK' || row.amount > 0))
  if (!Number.isFinite(total) && rows.length === 0) return null
  return jsxs('div', {
    style: { display: 'grid', gap: compact ? 7 : 8, paddingTop: compact ? 11 : 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, {
        aside: Number.isFinite(total) ? `${money({ amount: total, currency: 'USD' })} on this key` : null,
        children: compact ? 'Key usage' : 'API key usage'
      }, 'title'),
      rows.length > 0
        ? jsx('div', {
            style: { display: 'grid', gap: 5 },
            children: rows.map(row => jsxs('div', {
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
              children: [
                jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 550 }, children: row.label }, 'label'),
                jsx('span', { style: { ...textPrimary, fontSize: 11, fontVariantNumeric: 'tabular-nums' }, children: money({ amount: row.amount, currency: 'USD' }) }, 'amount')
              ]
            }, `key-${row.label}`))
          }, 'rows')
        : null
    ]
  })
}

function messageRange(value) {
  if (!Array.isArray(value) || value.length === 0) return null
  const numbers = value.map(Number).filter(Number.isFinite)
  if (numbers.length === 0) return null
  const low = Math.min(...numbers)
  const high = Math.max(...numbers)
  return low === high ? `${low}` : `${low}–${high}`
}

function ModelAccess({ row }) {
  const models = Array.isArray(row?.model_access) ? row.model_access : []
  if (models.length === 0) return null
  return jsxs('div', {
    style: { display: 'grid', gap: 5, paddingTop: 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionLabel, { children: 'Model access' }),
      models.map((entry, index) => {
        const available = entry?.available === true
        const status = available
          ? 'Available'
          : entry?.available_at
            ? `Available ${new Date(entry.available_at).toLocaleString()}`
            : entry?.credits_would_enable
              ? 'Paid credits required'
              : 'Unavailable'
        return jsxs('div', {
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 10, lineHeight: 1.45 },
          children: [
            jsx('span', { style: { ...textSecondary, fontWeight: 500 }, children: entry?.model || 'Model' }),
            jsx('span', { style: { ...textSecondary, textAlign: 'right' }, children: status })
          ]
        }, `${entry?.model}-${index}`)
      })
    ]
  })
}

function ProviderNotes({ row, complete = false }) {
  const details = cleanDetails(row)
  const renewalAt = row?.renewal_at || row?.subscription?.renewal_at || null
  const creditStatus = row?.credit_status
  const spendControl = row?.spend_control
  const localMessages = messageRange(creditStatus?.approx_local_messages)
  const cloudMessages = messageRange(creditStatus?.approx_cloud_messages)
  // A declarative usage definition (e.g. GitHub's rate-limit window) is not a
  // subscription or inference balance. Do not invent renewal/billing copy for
  // it unless the row actually carries billing metadata.
  const hasBillingMetadata = Boolean(
    renewalAt || creditStatus || spendControl || row?.subscription
  )
  const facts = [
    renewalAt
      ? `Subscription renews ${new Date(renewalAt).toLocaleString()}`
      : complete && row?.plan && (!row?.definition || hasBillingMetadata) ? 'Subscription renewal date is not exposed by this provider.' : null,
    creditStatus?.unlimited
      ? 'Extra usage is unlimited.'
      : creditStatus
        ? `Extra usage: ${creditStatus.enabled ? 'funded' : 'not funded'}${creditStatus.overage_limit_reached ? ' • overage limit reached' : ''}`
        : null,
    localMessages != null || cloudMessages != null
      ? `Estimated messages from current paid balance: ${localMessages ?? '—'} local / ${cloudMessages ?? '—'} cloud`
      : null,
    spendControl
      ? `Spend control: ${spendControl.reached ? 'limit reached' : 'within limit'}${Number.isFinite(Number(spendControl.individual_limit)) ? ` • individual limit ${money({ amount: spendControl.individual_limit, currency: 'USD' })}` : ''}`
      : null,
    complete && row?.id === 'openai-codex' ? 'Usage scope: shared across every Codex session on this account.' : null,
    ...details
  ].filter(Boolean)
  if (facts.length === 0) return null
  const entries = facts.map((fact) => {
    const separator = fact.indexOf(':')
    return separator > 0
      ? { label: fact.slice(0, separator).trim(), value: fact.slice(separator + 1).trim() }
      : { label: '', value: fact }
  })
  return jsxs('div', {
    style: { display: 'grid', gap: 6, paddingTop: 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionLabel, { children: 'Account notes' }),
      jsx('div', {
        style: { display: 'grid', gridTemplateColumns: 'minmax(132px, 0.38fr) minmax(0, 1fr)', columnGap: 16, rowGap: 6 },
        children: entries.flatMap((entry, index) => entry.label
          ? [
              jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.4 }, children: entry.label }, `label-${index}`),
              jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.4, overflowWrap: 'anywhere' }, children: entry.value }, `value-${index}`)
            ]
          : [jsx('span', { style: { ...textSecondary, gridColumn: '1 / -1', fontSize: 11, lineHeight: 1.4 }, children: entry.value }, `full-${index}`)])
      })
    ]
  })
}

function definitionStateMeta(row) {
  if (!row?.definition) return null
  const state = String(row?.state || '').toLowerCase()
  // Positive green is reserved for an explicitly reported successful state.
  // Unknown, future, or locally blocked states must never borrow "Connected".
  if (state === 'connected' || state === 'ok') return { label: 'Connected', variant: 'success' }
  if (state === 'untrusted' || state === 'requires_approval') return { label: 'Approval required', variant: 'warn', tone: 'warn' }
  if (state === 'blocked') return { label: 'Blocked', variant: 'destructive' }
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn', tone: 'warn' }
  if (state === 'not_connected') return { label: 'Not connected', variant: 'muted' }
  if (state === 'unavailable') return { label: 'Unavailable', variant: 'muted' }
  if (state === 'unverified') return { label: 'Unverified mapping', variant: 'warn' }
  if (state === 'stale') return { label: 'Stale data', variant: 'warn' }
  if (state === 'invalid_definition' || state === 'invalid') return { label: 'Invalid definition', variant: 'destructive' }
  return { label: 'Unknown state', variant: 'muted' }
}

function DefinitionBadge({ row }) {
  if (!row?.definition) return null
  const meta = definitionStateMeta(row)
  const neutral = !meta?.variant || meta.variant === 'outline' || meta.variant === 'muted'
  return jsx(Badge, {
    variant: meta?.variant || 'outline',
    size: 'xs',
    style: neutral ? { color: 'var(--ui-text-secondary)' } : undefined,
    children: meta?.label || 'Definition'
  })
}

function DefinitionPanel({ row }) {
  if (!row?.definition || !row?.provenance) return null
  const prov = row.provenance
  const freshness = row?.freshness || {}
  const age = finiteNumber(freshness.age_seconds)
  const ageText = age == null
    ? null
    : age < 90
      ? `checked ${age}s ago`
      : age < 7200
        ? `checked ${Math.round(age / 60)}m ago`
        : `checked ${Math.round(age / 3600)}h ago`
  const cache = prov.cache === 'hit'
    ? 'cached response'
    : prov.cache === 'stale'
      ? 'stale cached response'
      : prov.cache === 'none'
        ? 'not fetched'
        : 'cache state not reported'
  const source = prov.definition_source === 'profile'
    ? 'Profile definition'
    : prov.definition_source === 'bundled'
      ? 'Bundled definition'
      : 'Definition source not reported'
  const override = prov.overrides ? ' · overrides bundled copy' : ''
  const version = prov.definition_version != null ? ` v${prov.definition_version}` : ''
  const credentialRefs = credentialRefsOf({
    credential_refs: row?.approval?.credential_refs || prov.credential_refs
  })
  const rowState = String(row?.state || '').toLowerCase()
  const error = prov.error || (rowState && rowState !== 'ok' && rowState !== 'connected' ? row.unavailable_reason : null)
  return jsxs('section', {
    style: { display: 'grid', gap: 3, paddingTop: 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionLabel, { aside: prov.endpoint_host ? `Destination ${prov.endpoint_host}` : null, children: 'Data source' }, 'label'),
      jsx('span', {
        style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' },
        children: `${source} ${prov.definition_id || 'definition'}${version}${override}`
      }, 'definition'),
      credentialRefs.length > 0
        ? jsx('span', {
            style: { ...textSecondary, fontSize: 10, lineHeight: 1.5 },
            children: `Credentials: ${credentialRefs.map(ref => ref.label).join(' · ')}`
          }, 'credentials')
        : null,
      jsx('span', {
        style: { ...textSecondary, fontSize: 10, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' },
        children: [
          cache,
          ageText,
          prov.ttl_seconds != null ? `TTL ${prov.ttl_seconds}s` : null,
          `scope ${prov.scope || 'active'}`,
          prov.definition_file ? prov.definition_file : null
        ].filter(Boolean).join(' · ')
      }, 'freshness'),
      prov.docs_url
        ? jsx('span', {
            style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' },
            children: prov.docs_url
          }, 'docs')
        : null,
      error
        ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, color: 'var(--ui-orange)' }, children: error }, 'error')
        : null
    ]
  })
}

function AllProviderMetrics({ row, complete = false }) {
  const limits = Array.isArray(row?.limits) ? row.limits : []
  const balances = Array.isArray(row?.balances) ? row.balances : []
  const products = Array.isArray(row?.products) ? row.products : []
  if (products.length > 0) {
    return jsxs('div', {
      style: { display: 'grid', gap: 10 },
      children: [
        products.map((product, index) =>
          jsxs('section', {
            style: { display: 'grid', gap: 8, paddingTop: index > 0 ? 11 : 0, borderTop: index > 0 ? HAIRLINE : 'none' },
            children: [
              jsx(SectionLabel, { aside: product.kind === 'subscription' ? 'Subscription' : 'API credits', children: product.label }),
              product.available
                ? jsx(AllProviderMetrics, { row: { ...product, id: `${row.id}-${product.id}`, products: [] } })
                : jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: product.unavailable_reason || 'This product does not expose usage data.' })
            ]
          }, `${row.id}-${product.id}`)
        ),
        jsx(ModelAccess, { row }),
        jsx(ProviderNotes, { row, complete }),
        jsx(KeyUsagePanel, { keyUsage: row?.key_usage }),
        jsx(ActivityPanel, { activity: row?.activity }),
        jsx(CachePanel, { cache: row?.cache }),
        jsx(RatesPanel, { row }),
        jsx(DefinitionPanel, { row })
      ]
    })
  }
  return jsxs('div', {
    style: { display: 'grid', gap: 10 },
    children: [
      limits.length > 0 ? jsx(SectionLabel, { aside: `${limits.length} ${limits.length === 1 ? 'limit group' : 'limit groups'}`, children: 'Limits' }) : null,
      limits.map((limit, index) => jsx(LimitGroup, { rowId: row.id, limit, grouped: index > 0 }, `${row.id}-${limit.id}`)),
      jsx(BreakdownPanel, { row }),
      row?.reset_credits
        ? jsx('span', {
            style: { ...textSecondary, fontSize: 11, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' },
            children: `Banked resets: ${bankedResetCount(row.reset_credits.available)} saved, ${bankedResetCount(row.reset_credits.applicable)} usable now`
          })
        : null,
      balances.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 4, paddingTop: limits.length > 0 ? 10 : 0, borderTop: limits.length > 0 ? HAIRLINE : 'none' },
            children: [
              jsx(SectionLabel, { children: row?.id === 'openai-codex' ? 'Paid fallback' : 'Balance' }),
              jsx('div', {
                style: { display: 'grid', gridTemplateColumns: balances.length > 1 ? 'repeat(auto-fit, minmax(130px, 1fr))' : '1fr', gap: 12 },
                children: balances.map(balance => jsx(BalanceMetric, { balance, subdued: row?.id === 'openai-codex' }, `${balance.label}-${balance.currency}`))
              })
            ]
          })
        : null,
      jsx(ModelAccess, { row }),
      jsx(ProviderNotes, { row, complete }),
      jsx(KeyUsagePanel, { keyUsage: row?.key_usage }),
      jsx(ActivityPanel, { activity: row?.activity }),
      jsx(CachePanel, { cache: row?.cache }),
      jsx(RatesPanel, { row }),
      jsx(DefinitionPanel, { row })
    ]
  })
}

const RESET_INTENT = 'redeem_one_banked_codex_reset'

// A missing count is not zero. Keep an explicit numeric 0 as a real reading.
function bankedResetCount(value) {
  return typeof value === 'number' && Number.isFinite(value) ? String(value) : 'not reported'
}

function safeExternalUrl(value) {
  try {
    const parsed = new URL(String(value || ''))
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password) return ''
    return parsed.toString()
  } catch {
    return ''
  }
}

function ManageLinks({ links, ctx, label = 'Account' }) {
  const items = (Array.isArray(links) ? links : [])
    .map(link => ({ ...link, url: safeExternalUrl(link?.url) }))
    .filter(link => link.url)
  if (items.length === 0) return null
  const open = (event, url) => {
    haptic('tap')
    if (ctx?.os?.openExternal) {
      event.preventDefault()
      void ctx.os.openExternal(url)
    }
  }
  return jsxs('div', {
    style: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', minWidth: 0 },
    children: [
      jsx('span', {
        style: { ...textSecondary, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' },
        children: label
      }, 'label'),
      ...items.map((link, index) => jsx('a', {
        href: link.url,
        target: '_blank',
        rel: 'noopener noreferrer',
        title: link.product ? `${link.label || 'Manage account'} — ${link.product}` : (link.label || 'Manage account'),
        'aria-label': link.product ? `${link.label || 'Manage account'} — ${link.product}` : (link.label || 'Manage account'),
        onClick: event => open(event, link.url),
        style: {
          color: 'var(--ui-accent)',
          fontSize: 10.5,
          lineHeight: 1.45,
          textDecoration: 'none',
          whiteSpace: 'nowrap'
        },
        children: link.label || 'Manage account'
      }, `manage-${index}`))
    ]
  })
}

function resetStateMeta(summary) {
  const state = String(summary?.state || '').toLowerCase()
  if (state === 'ready') return { label: 'Resets available', variant: 'success' }
  if (state === 'no_banked_resets') return { label: 'None banked', variant: 'outline' }
  if (state === 'not_applicable' || state === 'not_exhausted') return { label: 'Not redeemable now', variant: 'warn' }
  if (state === 'count_unknown') return { label: 'Count unavailable', variant: 'warn' }
  if (state === 'account_unverified') return { label: 'Account unverified', variant: 'warn' }
  if (state === 'account_changed') return { label: 'Account changed', variant: 'warn' }
  if (state === 'reset_unsupported') return { label: 'Reset unavailable', variant: 'muted' }
  return { label: 'Unavailable', variant: 'muted' }
}

// Reset is a separately gated account mutation, not a refresh. It is rendered
// only for Codex rows with a verified account identity; the two-step preview /
// confirm flow is the only path to core's banked-reset operation.
function CodexResetPanel({ row, ctx, profile }) {
  const [summary, setSummary] = useState(null)
  const [preview, setPreview] = useState(null)
  const [result, setResult] = useState(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const clickLock = useRef(false)

  useEffect(() => {
    setSummary(null)
    setPreview(null)
    setResult(null)
    setError('')
  }, [row?.id])

  if (!ctx?.rest) return null

  const call = async (path, body) => {
    if (clickLock.current) return null
    clickLock.current = true
    setBusy(true)
    setError('')
    try {
      return await ctx.rest(path, { method: 'POST', body, timeoutMs: 45_000 })
    } catch (err) {
      setError(String(err?.message || err || 'Reset request failed.'))
      return null
    } finally {
      clickLock.current = false
      setBusy(false)
    }
  }
  const check = async () => {
    const data = await call('/reset/summary', { profile: profile || '' })
    if (data) {
      setSummary(data)
      setPreview(null)
      setResult(null)
    }
  }
  const startPreview = async () => {
    const identity = String(summary?.identity_id || '').trim()
    if (!identity) return
    const data = await call('/reset/preview', { profile: profile || '', identity_id: identity })
    if (data) {
      setPreview(data)
      setSummary(data.summary || summary)
      setResult(null)
    }
  }
  const confirmReset = async () => {
    const confirmation = preview?.confirmation
    if (!confirmation || clickLock.current) return
    const data = await call('/reset/confirm', {
      profile: profile || '',
      identity_id: confirmation.identity_id,
      token: confirmation.token,
      confirmed_account: confirmation.identity_id,
      confirmed_intent: RESET_INTENT
    })
    if (data) {
      setResult(data)
      setPreview(null)
      setSummary(null)
    }
  }
  const recheck = async () => {
    const identity = String(result?.identity_id || summary?.identity_id || '').trim()
    const body = { profile: profile || '' }
    if (identity) body.identity_id = identity
    const data = await call('/reset/readback', body)
    if (data) setResult(previous => ({ ...(previous || {}), readback: data, needs_reconcile: !data.ok }))
  }

  const state = summary ? resetStateMeta(summary) : null
  const identity = String(summary?.identity_id || '').trim()
  return jsxs('section', {
    'aria-label': 'Codex banked reset credits',
    style: { border: HAIRLINE, borderRadius: 8, padding: '9px 11px', display: 'grid', gap: 6, marginTop: 10, minWidth: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
        children: [
          jsx('span', { style: { ...textPrimary, fontSize: 10.5, fontWeight: 600 }, children: 'Banked reset credits' }, 'title'),
          state ? jsx(Badge, { variant: state.variant, size: 'xs', style: state.variant === 'outline' || state.variant === 'muted' ? { color: 'var(--ui-text-secondary)' } : undefined, children: state.label }, 'state') : null
        ]
      }),
      jsx('span', {
        style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45 },
        children: 'Redeems only the active Codex account Hermes is signed in to. This never purchases or spends paid API credits.'
      }, 'note'),
      identity
        ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: `Active account: ${summary?.account_label || identity}` }, 'account')
        : null,
      summary
        ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.5 }, children: summary.message }, 'summary')
        : null,
      summary?.inventory_detail
        ? jsx('span', { style: { ...textSecondary, fontSize: 9, lineHeight: 1.4 }, children: summary.inventory_detail }, 'inventory-detail')
        : null,
      summary?.entries?.length
        ? jsxs('div', {
            style: { display: 'grid', gap: 2 },
            children: [
              jsx('span', { style: { ...textSecondary, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: 'Provider-reported reset inventory' }, 'inventory-title'),
              ...summary.entries.slice(0, 4).map((entry, index) => jsx('span', {
                style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.4, overflowWrap: 'anywhere' },
                children: `${entry.title || entry.reset_type || 'Banked reset'} · ${entry.status || 'status not reported'} · ${entry.expires_at ? `expires ${entry.expires_at}` : 'No expiry reported'}`
              }, `reset-entry-${index}`)),
              summary.entries.length > 4
                ? jsx('span', { style: { ...textSecondary, fontSize: 9 }, children: `+${summary.entries.length - 4} more reported credit rows` }, 'inventory-more')
                : null
            ]
          }, 'inventory')
        : null,
      summary && summary.state === 'ready' && summary.reset_executable && !preview
        ? jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', disabled: busy || !identity, onClick: () => void startPreview(), children: 'Preview reset' }, 'preview')
        : null,
      !summary && !preview && !result
        ? jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', disabled: busy, onClick: () => void check(), children: 'Check reset credits' }, 'check')
        : null,
      preview && !preview.confirmation
        ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45 }, children: preview.message || 'Reset preview did not produce a confirmation. Nothing was spent.' }, 'preview-refused')
        : null,
      preview?.confirmation
        ? jsxs('div', {
            style: { display: 'grid', gap: 6, paddingTop: 7, borderTop: HAIRLINE },
            children: [
              jsx('span', { style: { ...textPrimary, fontSize: 10.5, fontWeight: 550, overflowWrap: 'anywhere' }, children: `Confirm ${preview.confirmation.account_label || preview.confirmation.identity_id}` }, 'confirm-account'),
              jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45 }, children: `${preview.confirmation.available_count} banked; ${preview.confirmation.applicable_count == null ? 'unknown' : preview.confirmation.applicable_count} usable now. The server selects the reset credit.` }, 'confirm-counts'),
              jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45 }, children: 'This spends one banked reset, not a purchase or paid API credit. It is single-use and expires shortly.' }, 'confirm-note'),
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
                children: [
                  jsx(Button, { type: 'button', size: 'xs', disabled: busy, onClick: () => void confirmReset(), children: `Confirm reset on ${preview.confirmation.account_label || preview.confirmation.identity_id}` }, 'confirm'),
                  jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', disabled: busy, onClick: () => setPreview(null), children: 'Cancel' }, 'cancel')
                ]
              })
            ]
          }, 'confirmation')
        : null,
      result
        ? jsxs('div', {
            style: { display: 'grid', gap: 5, paddingTop: 7, borderTop: HAIRLINE },
            children: [
              jsx('span', {
                style: { ...textSecondary, fontSize: 10, lineHeight: 1.5, color: result.ok ? 'var(--ui-text-primary)' : 'var(--ui-text-secondary)' },
                children: result.message
              }, 'result'),
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' },
                children: [
                  jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', disabled: busy, onClick: () => void recheck(), children: 'Re-check account' }, 'recheck'),
                  jsx('span', { style: { ...textSecondary, fontSize: 9 }, children: result.credit_consumed === 'unknown' ? 'Do not retry before re-checking.' : result.credit_consumed === 'yes' ? 'One banked reset recorded.' : 'Nothing spent.' }, 'consumed')
                ]
              })
            ]
          }, 'result')
        : null,
      error
        ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, color: 'var(--dt-destructive)' }, children: error }, 'error')
        : null
    ]
  })
}

function ActiveProvider({ row, model, ctx, profile }) {
  const state = fundingState(row, model)
  const plan = row?.plan || (state.kind === 'balance' ? 'API credits' : 'Account usage')
  const codexFallback = row?.id === 'openai-codex' && state.kind === 'balance' && state.fallback
  const fundingHeadline = codexFallback
    ? 'Subscription allowance exhausted'
    : state.kind === 'balance'
      ? money(state.balance)
      : state.kind === 'subscription'
        ? compactFundingSummary(row, model)
        : row?.available ? 'Account connected' : 'Usage unavailable'
  const fundingDetail = codexFallback
    ? `${money(state.balance)} extra usage available for the next request`
    : state.kind === 'subscription'
      ? row?.definition
        ? `${plan} · read-only definition`
        : `${plan} subscription allowance`
      : state.kind === 'balance'
        ? row?.definition
          ? `${plan} · read-only definition`
          : 'Requests are billed from this provider balance.'
        : row?.unavailable_reason || 'No usage data is exposed.'

  return jsxs('section', {
    'aria-labelledby': 'provider-usage-active-heading',
    style: { borderBottom: HAIRLINE, padding: '18px' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 },
        children: [
          jsxs('div', {
            style: { minWidth: 0, display: 'grid', gap: 4 },
            children: [
              jsxs('div', {
                style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
                children: [
                  jsx(StatusDot, { tone: row?.available ? 'good' : 'muted' }),
                  jsx('h2', {
                    id: 'provider-usage-active-heading',
                    style: { ...textPrimary, margin: 0, fontSize: 15, lineHeight: 1.3, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                    children: row?.label || 'Active provider'
                  }),
                  jsx(DefinitionBadge, { row }, 'definition-state')
                ]
              }),
              jsx('div', {
                style: { ...textSecondary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
                children: model || 'Active model unavailable'
              })
            ]
          }),
          jsx(Badge, { variant: 'default', size: 'xs', children: 'ACTIVE' })
        ]
      }),
      jsxs('div', {
        style: { borderLeft: '2px solid var(--ui-accent)', marginTop: 15, padding: '2px 0 2px 12px', display: 'grid', gap: 2 },
        children: [
          jsx('span', { style: { ...textSecondary, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.07em' }, children: 'Current request funding' }),
          jsx('strong', { style: { ...textPrimary, fontSize: codexFallback ? 16 : 18, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums' }, children: fundingHeadline }),
          jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: fundingDetail }),
          row?.id === 'xai-oauth' && legacyPlanNote(row?.plan)
            ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: legacyPlanNote(row.plan) })
            : null
        ]
      }),
      jsx(ManageLinks, { links: row?.manage_links, ctx }, 'manage'),
      row?.id === 'openai-codex'
        ? jsx(CodexResetPanel, { row, ctx, profile }, 'codex-reset')
        : null,
      jsxs('div', {
        style: { display: 'grid', gap: 10, marginTop: 17 },
        children: [
          jsx(SectionLabel, { aside: plan, children: 'Account limits & credits' }),
          jsx(AllProviderMetrics, { row, complete: true })
        ]
      })
    ]
  })
}

function ProviderDisclosure({ row, ctx, profile }) {
  const [open, setOpen] = useState(false)
  const summary = compactFundingSummary(row, '')
  return jsxs('div', {
    style: { border: '1px solid var(--ui-stroke-tertiary)', borderRadius: 8, background: 'var(--ui-bg-card)', overflow: 'hidden' },
    children: [
      jsx(RowButton, {
        'aria-expanded': open,
        'aria-label': `${open ? 'Collapse' : 'Expand'} ${row.label}`,
        onClick: () => {
          haptic('tap')
          setOpen(value => !value)
        },
        style: {
          width: '100%',
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr) auto auto',
          alignItems: 'center',
          gap: 10,
          padding: '11px 13px',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left'
        },
        children: jsxs('div', {
          style: { display: 'contents' },
          children: [
            jsxs('span', {
              style: { minWidth: 0, display: 'grid', gap: 2 },
              children: [
                jsxs('span', {
                  style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 },
                  children: [
                    jsx(StatusDot, { tone: row.available ? 'good' : 'muted' }),
                    jsx('span', { style: { ...textPrimary, fontSize: 12, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.label }),
                    jsx(DefinitionBadge, { row }, 'definition-state')
                  ]
                }),
                jsx('span', { style: { ...textSecondary, paddingLeft: 13, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.plan || (row.capability === 'balance' ? 'API credits' : 'Account usage') })
              ]
            }),
            jsx('strong', { style: { ...textSecondary, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, children: summary }),
            jsx(open ? icons.ChevronDown : icons.ChevronRight, { 'aria-hidden': true, style: { width: 14, height: 14, color: 'var(--ui-text-quaternary)' } })
          ]
        })
      }),
      jsx('div', { style: { padding: '0 13px 8px' }, children: jsx(ManageLinks, { links: row?.manage_links, ctx }) }, 'manage'),
      row?.id === 'openai-codex'
        ? jsx('div', { style: { padding: '0 13px 10px' }, children: jsx(CodexResetPanel, { row, ctx, profile }) }, 'codex-reset')
        : null,
      open
        ? jsx('div', { style: { padding: '0 13px 13px' }, children: jsx(AllProviderMetrics, { row }) })
        : null
    ]
  })
}

function LimitedProviders({ rows }) {
  const [open, setOpen] = useState(false)
  if (rows.length === 0) return null
  return jsxs('section', {
    style: { paddingTop: 7 },
    children: [
      jsx(RowButton, {
        'aria-expanded': open,
        'aria-label': `${open ? 'Hide' : 'Show'} providers with limited usage data`,
        onClick: () => setOpen(value => !value),
        style: {
          width: '100%',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 10,
          padding: '8px 0',
          border: 0,
          background: 'transparent',
          color: 'inherit',
          cursor: 'pointer',
          textAlign: 'left'
        },
        children: jsxs('span', {
          style: { display: 'flex', alignItems: 'center', gap: 7, ...textSecondary, fontSize: 11 },
          children: [jsx(open ? icons.ChevronDown : icons.ChevronRight, { 'aria-hidden': true, style: { width: 13, height: 13 } }, 'chevron'), jsx('span', { children: `Limited data (${rows.length})` }, 'label')]
        })
      }),
      open
        ? jsx('div', {
            style: { display: 'grid', gap: 10, padding: '5px 0 12px 20px' },
            children: rows.map(row =>
              jsxs('div', {
                style: { display: 'grid', gap: 2 },
                children: [
                  jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 500 }, children: row.label }),
                  jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.4 }, children: row.unavailable_reason || 'This provider does not expose usage or balance data.' })
                ]
              }, row.id)
            )
          })
        : null
    ]
  })
}

function openOverview(ctx) {
  // Full workspace page (Settings-style): every provider, all windows, resets,
  // balances, and metadata. Feature-detect navigate; older builds fall back to
  // a docked workspace tab. Do not stamp the chat's provider onto the profile
  // — that is what made the next chat open on the previous account.
  if (typeof host.navigate === 'function') {
    host.navigate(OVERVIEW_ROUTE)
    return
  }
  if (typeof host.openWorkspace === 'function') {
    host.openWorkspace('jg-provider-usage-overview', {
      title: 'Provider usage',
      minWidth: 400,
      render: () => jsx(ProviderUsagePage, { ctx })
    })
    return
  }
  host.notify({ kind: 'info', message: 'Provider usage is available in the Provider Usage page.' })
}

function ActiveUsageChip({ ctx }) {
  const model = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const activeProfile = useValue(host.state.profile)
  const activeConnectionId = host.state.connectionId !== undefined ? useValue(host.state.connectionId) : ''
  const hasFocusedOwner = host.state.focusedSessionOwner !== undefined
  const focusedOwner = hasFocusedOwner ? useValue(host.state.focusedSessionOwner) : null
  const focusedProfile = host.state.focusedSessionProfile !== undefined ? useValue(host.state.focusedSessionProfile) : ''
  const gateway = useValue(host.state.gateway)
  const scope = resolveUsageScope({ focusedOwner, hasFocusedOwner, focusedProfile, activeConnectionId, activeProfile })

  // Another machine only. A local bot's profile is fetched, not gated.
  if (scope.unreachable) {
    return jsx(GatedUsageChip, { scope })
  }
  return jsx(ActiveUsageChipBody, { ctx, model, sessionId, gateway, scope })
}

function GatedUsageChip({ scope }) {
  const focusProfile = scope.focusProfile
  const description = scope.ambiguous
    ? `The focused chat's account could not be identified (${focusProfile}). This gateway will not guess which account that chat uses.`
    : `The focused chat is on another connection (${focusProfile}). This gateway can read profiles on this machine, not that one.`
  return jsx(Tip, {
    label: description,
    children: jsx(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'micro',
      'aria-label': description,
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: scope.ambiguous
          ? `That chat's account could not be identified, so usage is not shown rather than guessed.`
          : `That chat is on another connection. Usage here can read this machine's profiles, not ${focusProfile} on that connection.` })
      },
      style: { maxWidth: 230 },
      children: [jsx(icons.Activity, { 'aria-hidden': true }, 'icon'), jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: 'Other connection' }, 'label')]
    })
  })
}

function ActiveUsageChipBody({ ctx, model, sessionId, gateway, scope }) {
  const ready = gatewayReady(gateway)
  const provider = useActiveProvider(sessionId, '', scope.fetchProfile, scope.ownerConnection, scope.sourceId)
  const query = useOverview(ctx, provider, model, scope.fetchProfile, gateway, scope.sourceId)
  const matched = accountMatches(query.data, scope.fetchProfile, scope.activeProfile) ? query.data : null
  const row = activeRow(matched, provider)
  const state = fundingState(row, model)
  const switching = useSwitchingOverride(scope.fetchProfile, ready)
  const backendGone = ready && Boolean(query.isError) && !row && isBackendNotEnabled(query.error)
  const refetchError = Boolean(query.isError) && Boolean(row)
  // A response can arrive without a row for the chat's provider (an unknown custom
  // endpoint, a renamed id, or a provider the backend did not list). Saying only
  // "unavailable" hides which side is wrong, so name the provider and what shipped.
  const rowIds = matched ? (matched.providers || []).map(item => item?.id).filter(Boolean) : []
  const missingRow = Boolean(matched) && Boolean(provider) && !row
  const label = row ? compactProviderLabel(row) : missingRow ? compactProviderLabel({ id: provider }) : 'Usage'

  let summary = 'unavailable'
  if (switching) summary = 'switching'
  else if (backendGone) summary = 'plugin not enabled'
  else if (!provider && sessionId) summary = 'checking'
  else if (row) summary = statusFundingSummary(row, model)
  else if (ready && (query.isLoading || !matched)) summary = 'checking'
  else if (missingRow) summary = 'no data'
  else if (ready) summary = 'unavailable'
  if (refetchError) summary = `${summary} · not refreshed`

  const description = missingRow
    ? `${provider} is not in this response (it reports: ${rowIds.join(', ') || 'no providers'}). Open Provider usage for the full list.`
    : chipDescription(row, model, matched, switching, ready, refetchError, scope, backendGone)

  const Icon = state.kind === 'balance' ? icons.CreditCard : icons.Activity
  // Controlled so "View all providers" dismisses the popover as the page opens.
  const [popoverOpen, setPopoverOpen] = useState(false)

  return jsxs(Popover, {
    open: popoverOpen,
    onOpenChange: setPopoverOpen,
    children: [
      jsx(Tip, {
        label: description,
        children: jsx(PopoverTrigger, {
          asChild: true,
          children: jsxs(Button, {
            type: 'button',
            variant: 'ghost',
            size: 'micro',
            'aria-label': description,
            onClick: () => haptic('tap'),
            style: { maxWidth: 230, fontVariantNumeric: 'tabular-nums' },
            children: [
              jsx(Icon, { 'aria-hidden': true }, 'icon'),
              jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `${label} · ${summary}` }, 'label')
            ]
          })
        })
      }),
      jsx(PopoverContent, {
        align: 'end',
        side: 'top',
        sideOffset: 8,
        collisionPadding: 8,
        style: { width: 356, maxHeight: 'min(84vh, 520px)', overflowY: 'auto', overflowX: 'hidden', padding: 0 },
        children: jsx(ChipUsagePopover, {
          ctx,
          model,
          scope,
          row,
          state,
          query,
          backendGone,
          provider: provider || row?.id,
          sessionId,
          // `subagent.list` is owner-checked against the socket that commissioned
          // the child. Only the active gateway can prove that here; a chat whose
          // backend is another profile/connection gets no footer rather than a
          // foreign roster (see docs/running-agents-footer.md).
          active: popoverOpen && scope.source === 'active',
          gateway,
          providerRows: matched?.providers,
          onRequestClose: () => setPopoverOpen(false)
        })
      })
    ]
  })
}

function ChipUsagePopover({ ctx, model, scope, row, state, query, backendGone, provider, sessionId, active, gateway, providerRows, onRequestClose }) {
  // Compact current-provider detail popover. Shows only the ACTIVE provider's
  // extra details (its windows, reset, balance), plus a way to open the full
  // page. Respects the same divergence/back-end state as the chip.
  const viewAll = jsxs(Button, {
    type: 'button',
    variant: 'secondary',
    size: 'xs',
    'aria-label': 'View all providers',
    onClick: () => {
      haptic('tap')
      openOverview(ctx)
      if (typeof onRequestClose === 'function') onRequestClose()
    },
    style: { width: '100%', maxWidth: '100%', justifyContent: 'center', textAlign: 'center' },
    children: [
      jsx(icons.BarChart3, { 'aria-hidden': true, style: { width: 12, height: 12 } }, 'icon'),
      jsx('span', { children: 'View all providers' })
    ]
  })

  // Running children are a gateway fact, independent of whether this profile
  // exposes provider usage, so the footer is offered in every popover state
  // (it hides itself when nothing is running). `active` is already gated to the
  // active source by the chip body.
  const runningAgents = jsx(RunningAgentsFooter, {
    sessionId,
    active,
    gateway,
    sourceId: scope.sourceId,
    providerRows
  }, 'running-agents')

  if (backendGone) {
    return jsxs('div', {
      style: { display: 'grid', gap: 12, padding: 16 },
      children: [
        jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 15, height: 15, color: 'var(--ui-text-tertiary)' } }, 'icon'), jsx('strong', { style: { ...textPrimary, fontSize: 12, fontWeight: 600 }, children: `Not enabled in ${scope.fetchProfile}` }, 'title')] }),
        jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: 'Enable or install this plugin in that profile to see usage. Hermes never edits profiles automatically.' }),
        jsx('div', { style: { display: 'flex', justifyContent: 'center' }, children: viewAll }, 'view-all'),
        runningAgents
      ]
    })
  }

  if (!row) {
    const waiting = !provider || query.isLoading
    return jsxs('div', {
      style: { display: 'grid', gap: 12, padding: 16 },
      children: [
        jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: waiting ? 'Checking which account this chat is using…' : query.isError ? 'Provider data could not be loaded.' : 'No usage is being reported for the current provider.' }),
        jsx('div', { style: { display: 'flex', justifyContent: 'center' }, children: viewAll }, 'view-all'),
        runningAgents
      ]
    })
  }

  const refreshButton = jsx(Tip, {
    label: query.isFetching ? 'Refreshing provider usage' : 'Refresh provider usage',
    children: jsx(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'icon-xs',
      disabled: query.isFetching,
      'aria-label': 'Refresh provider usage',
      onClick: () => {
        haptic('tap')
        requestSourcesRefresh = true
        void query.refetch()
      },
      children: jsx(icons.RefreshCw, { 'aria-hidden': true })
    })
  })

  // Every window of the selected limit (not just the governing one) — the
  // popover has room to show the full picture the chip compresses.
  const limitWindows = (() => {
    const limit = selectLimit(row, model)
    const fromLimit = Array.isArray(limit?.windows)
      ? limit.windows.filter(window => round(window?.remaining_percent) != null)
      : []
    if (fromLimit.length > 0) return fromLimit
    // Several limit groups but no default (e.g. a key quota next to a free-model
    // allowance): show them all rather than picking none.
    const fromAll = (Array.isArray(row?.limits) ? row.limits : [])
      .flatMap(entry => (Array.isArray(entry?.windows) ? entry.windows : []))
      .filter(window => round(window?.remaining_percent) != null)
    if (fromAll.length > 0) return fromAll.slice(0, 4)
    return (state.windows || []).filter(window => round(window?.remaining_percent) != null)
  })()
  const balance = state.balance
  const codexFallback = row?.id === 'openai-codex' && balance && state.fallback
  const planLabel = row?.plan || (row?.capability === 'balance' ? 'API credits' : row?.capability === 'usage' ? 'Subscription' : null)
  const hasRates = Array.isArray(row?.pricing) && row.pricing.length > 0
  const hasPeak = Boolean(row?.peak && typeof row.peak === 'object')
  const updated = query.data?.fetched_at
    ? new Date(query.data.fetched_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    : null

  return jsxs('div', {
    style: { display: 'grid', gap: 0 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '12px 14px', borderBottom: HAIRLINE },
        children: [
          jsxs('div', { style: { minWidth: 0, display: 'grid', gap: 2 }, children: [
            jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 7, minWidth: 0 }, children: [
              jsx(StatusDot, { tone: row.available ? 'good' : 'muted' }, 'dot'),
              jsx('strong', { style: { ...textPrimary, fontSize: 13, fontWeight: 650, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.label }, 'label'),
              planLabel ? jsx(Badge, { variant: 'outline', size: 'xs', children: planLabel }, 'plan') : null
            ] }),
            jsx('span', { style: { ...textSecondary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [model, scope.fetchProfile !== scope.activeProfile ? scope.fetchProfile : null].filter(Boolean).join(' · ') || scope.fetchProfile }, 'model')
          ] }, 'identity'),
          refreshButton
        ]
      }),
      jsxs('div', {
        style: { display: 'grid', gap: 13, padding: '13px 14px 12px' },
        children: [
          row?.id === 'xai-oauth' && legacyPlanNote(row?.plan)
            ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: legacyPlanNote(row.plan) }, 'plan-lag')
            : null,
          codexFallback
            ? jsxs('div', {
                style: { display: 'grid', gap: 10 },
                children: [
                  jsxs('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [
                    jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 14, height: 14, color: 'var(--ui-orange)' } }, 'icon'),
                    jsx('span', { style: { ...textSecondary, fontSize: 11.5, lineHeight: 1.45 }, children: 'Subscription allowance exhausted — requests bill from paid credits.' }, 'text')
                  ] }),
                  jsx(BalanceMetric, { balance, prominent: true }, 'balance')
                ]
              }, 'fallback')
            : null,
          !codexFallback && limitWindows.length > 0
            ? jsx('div', {
                style: { display: 'grid', gap: 10 },
                children: limitWindows.slice(0, 4).map(window => jsx(UsageMeter, { window, compact: true }, `meter-${window?.label}`))
              }, 'meters')
            : null,
          jsx(BreakdownPanel, { row, compact: true }, 'breakdown'),
          !codexFallback && balance
            ? jsx(BalanceMetric, { balance, prominent: true }, 'balance')
            : null,
          row?.key_usage
            ? jsx(KeyUsagePanel, { keyUsage: row.key_usage, compact: true }, 'key-usage')
            : null,
          !codexFallback && limitWindows.length === 0 && !balance && !row?.activity
            ? jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: row?.available ? 'No usage windows or balance are reported for this provider.' : (row?.unavailable_reason || 'Usage unavailable.') }, 'empty')
            : null,
          row?.activity
            ? jsx(ActivityPanel, { activity: row.activity, compact: true }, 'activity')
            : null,
          row?.cache
            ? jsx(CachePanel, { cache: row.cache, compact: true }, 'cache')
            : null,
          hasRates || hasPeak
            ? jsx(RatesPanel, { row, compact: true, always: true }, 'rates')
            : null,
          jsxs('div', {
            style: { display: 'grid', gap: 8, borderTop: HAIRLINE, paddingTop: 11, marginTop: 1, justifyItems: 'stretch' },
            children: [
              jsx('div', { style: { display: 'flex', justifyContent: 'center' }, children: viewAll }, 'view-all'),
              runningAgents,
              updated
                ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }, children: `Updated ${updated}` }, 'updated')
                : null
            ]
          }, 'footer')
        ]
      })
    ]
  })
}

function catalogStateMeta(entry) {
  const state = String(entry?.state || '').toLowerCase()
  // Only an explicit connected state is green. Available/ready mean setup, not
  // a live account; unknown and blocked states stay neutral/negative.
  if (state === 'connected' || state === 'ok') return { label: 'Connected', variant: 'success' }
  if (state === 'available') return { label: 'Available to connect', variant: 'outline' }
  if (state === 'ready') return { label: 'Ready to read', variant: 'outline' }
  if (state === 'untrusted' || state === 'requires_approval') return { label: 'Approval required', variant: 'warn' }
  if (state === 'blocked') return { label: 'Blocked', variant: 'destructive' }
  if (state === 'invalid') return { label: 'Invalid definition', variant: 'destructive' }
  if (state === 'unverified') return { label: 'Unverified mapping', variant: 'warn' }
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn' }
  if (state === 'unavailable') return { label: 'Unavailable', variant: 'muted' }
  if (state === 'stale') return { label: 'Stale data', variant: 'warn' }
  return { label: 'Unknown state', variant: 'muted' }
}

// Credential references are data: either the upcoming object contract
// ({source:'env',name} / {source:'hermes_provider',provider,field}) or the
// legacy missing_credentials string list. Normalize both, but never invent a
// source type for a legacy label the backend did not classify.
function credentialRefsOf(entry) {
  const candidates = [entry?.credential_refs, entry?.setup?.credential_refs]
  for (const candidate of candidates) {
    if (!Array.isArray(candidate)) continue
    return candidate.map((ref, index) => {
      if (ref && typeof ref === 'object') {
        const source = String(ref.source || '').trim().toLowerCase()
        if (source === 'env') {
          const name = String(ref.name || '').trim()
          return name ? { key: name, label: `environment variable ${name}`, type: 'env' } : null
        }
        if (source === 'hermes_provider') {
          const provider = String(ref.provider || '').trim()
          const field = String(ref.field || 'api_key').trim()
          return provider
            ? { key: `${provider}.${field}`, label: `Hermes credential ${provider}.${field}`, type: 'hermes_provider' }
            : null
        }
        return { key: `credential-${index}`, label: 'credential reference (type not reported)', type: 'unknown' }
      }
      const text = String(ref || '').trim()
      return text ? { key: text, label: `credential ${text} (type not reported)`, type: 'unknown' } : null
    }).filter(Boolean)
  }
  return []
}

function missingCredentialsOf(entry) {
  const direct = (Array.isArray(entry?.missing_credentials) ? entry.missing_credentials : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
  if (direct.length > 0) return direct
  // Older catalog payloads only carried the same labels under setup.env.
  return (Array.isArray(entry?.setup?.env) ? entry.setup.env : [])
    .map(value => String(value || '').trim())
    .filter(Boolean)
}

function credentialSummary(entry) {
  const refs = credentialRefsOf(entry)
  const missing = missingCredentialsOf(entry)
  if (refs.length > 0) {
    const missingKeys = new Set(missing.map(value => value.toLowerCase()))
    const matchedKeys = new Set()
    const parts = refs.map(ref => {
      const key = String(ref.key || '').toLowerCase()
      if (missingKeys.has(key)) matchedKeys.add(key)
      return missingKeys.has(key) ? `${ref.label} (missing)` : ref.label
    })
    const unmatched = missing.filter(value => !matchedKeys.has(value.toLowerCase()))
    if (unmatched.length > 0) parts.push(`missing: ${unmatched.join(', ')}`)
    const needs = ['available', 'not_connected'].includes(String(entry?.state || '').toLowerCase())
    return `${needs ? 'Needs' : 'Credential'}: ${parts.join(' · ')}`
  }
  if (missing.length > 0) {
    return `Needs ${missing.join(', ')} (credential type not reported by this backend).`
  }
  return null
}

function catalogSetupText(entry) {
  const setup = entry?.setup || {}
  const file = setup.file || `${entry?.id || 'definition'}.json`
  const directory = setup.directory || '$HERMES_HOME/provider-usage/providers'
  const host = String(entry?.host || setup.host || '').trim()
  const credentials = credentialSummary(entry)
  const warnings = Array.isArray(entry?.warnings) ? entry.warnings.map(String).filter(Boolean) : []
  const errors = Array.isArray(entry?.errors) ? entry.errors.map(String).filter(Boolean) : []
  const approve = String(setup.approve || 'python scripts/approve_definition.py <definition.json>').trim()
  return [
    `Provider Usage definition: ${entry?.name || entry?.id || 'definition'} (${entry?.id || 'unknown'} v${entry?.version || 1})`,
    `Save as: ${directory}/${file}`,
    host ? `Destination: ${host}` : null,
    credentials ? credentials.replace(/^Needs /, 'Credentials: ') : null,
    errors.length ? `Fix: ${errors.slice(0, 2).join(' | ')}` : 'Validate: python scripts/validate_definition.py <file>',
    `Approve: ${approve} — review the destination and credential references, then type "approve" at its prompt. Copying or saving does not approve it; this pane never grants trust or fetches data for you.`,
    warnings.length ? `Warnings: ${warnings.slice(0, 3).join(' | ')}` : null,
    entry?.docs_url ? `Docs: ${entry.docs_url}` : null
  ].filter(Boolean).join('\n')
}

function CatalogCard({ entry }) {
  const state = catalogStateMeta(entry)
  const errors = Array.isArray(entry?.errors) ? entry.errors : []
  const warnings = Array.isArray(entry?.warnings) ? entry.warnings.map(String).filter(Boolean) : []
  const setup = entry?.setup || {}
  const docs = entry?.docs_url
  const host = String(entry?.host || setup.host || '').trim()
  const credentials = credentialSummary(entry)
  const sourceLabel = entry?.source === 'profile'
    ? 'Profile'
    : entry?.source === 'bundled'
      ? 'Bundled'
      : 'Source not reported'
  const stateName = String(entry?.state || '').toLowerCase()
  const needsApproval = stateName === 'untrusted' || stateName === 'requires_approval'
  const approvalCommand = String(setup.approve || 'python scripts/approve_definition.py <definition.json>').trim()
  const stateHelp = needsApproval
    ? `Approval is a human CLI step: ${approvalCommand}. This pane never grants trust or fetches.`
    : stateName === 'blocked'
      ? 'The backend blocks this definition. Nothing is fetched or displayed from it.'
      : null
  const copy = () => {
    haptic('tap')
    const text = catalogSetupText(entry)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text)
        host.notify({ kind: 'info', message: 'Setup copied — approve it yourself in the Hermes CLI. This pane never grants trust or fetches. Keep credentials out of the JSON.' })
        return
      }
    } catch {
      // Fall through to a plain notice when the clipboard is unavailable.
    }
    host.notify({ kind: 'info', message: 'Copy the setup from the definition docs; credentials stay in the environment. Approval is a separate human CLI step.' })
  }
  return jsxs('div', {
    style: { border: '1px solid var(--ui-stroke-tertiary)', borderRadius: 8, background: 'var(--ui-bg-card)', padding: '11px 13px', display: 'grid', gap: 5 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', minWidth: 0 },
        children: [
          jsx('span', { style: { ...textPrimary, fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry?.name || entry?.id || 'Definition' }, 'name'),
          jsx(Badge, { variant: state.variant, size: 'xs', style: state.variant === 'outline' || state.variant === 'muted' ? { color: 'var(--ui-text-secondary)' } : undefined, children: state.label }, 'state'),
          jsx(Badge, { variant: 'outline', size: 'xs', style: { color: 'var(--ui-text-secondary)' }, children: sourceLabel }, 'source'),
          entry?.stability === 'experimental' ? jsx(Badge, { variant: 'warn', size: 'xs', children: 'Experimental' }, 'stability') : null
        ]
      }),
      entry?.description
        ? jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: entry.description }, 'description')
        : null,
      jsx('span', {
        style: { ...textSecondary, fontSize: 10, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
        children: [
          entry?.version ? `v${entry.version}` : null,
          setup.file || null,
          !needsApproval && entry?.last_error ? entry.last_error : null
        ].filter(Boolean).join(' · ')
      }, 'meta'),
      host || credentials
        ? jsxs('div', {
            style: { display: 'grid', gap: 1, paddingTop: 1 },
            children: [
              host ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: `Destination: ${host}` }, 'destination') : null,
              credentials ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: credentials }, 'credentials') : null
            ]
          }, 'request')
        : null,
      stateHelp
        ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45 }, children: stateHelp }, 'state-help')
        : stateName === 'invalid'
          ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45 }, children: 'Fix the validation errors below, then refresh.' }, 'invalid-help')
          : null,
      warnings.length > 0
        ? jsx('span', {
            title: warnings.join('\n'),
            style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, overflowWrap: 'anywhere' },
            children: `Warnings: ${warnings.slice(0, 3).join(' · ')}${warnings.length > 3 ? ` · +${warnings.length - 3} more` : ''}`
          }, 'warnings')
        : null,
      errors.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 2, paddingTop: 2 },
            children: errors.slice(0, 3).map((error, index) =>
              jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.4, color: 'var(--dt-destructive)', overflowWrap: 'anywhere' }, children: String(error) }, `error-${index}`)
            )
          }, 'errors')
        : null,
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 3, flexWrap: 'wrap' },
        children: [
          jsx(Button, {
            type: 'button',
            variant: 'secondary',
            size: 'xs',
            onClick: copy,
            children: 'Copy setup steps'
          }, 'copy'),
          docs
            ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere', minWidth: 0 }, children: docs }, 'docs')
            : null
        ]
      })
    ]
  })
}

function connectionStateMeta(entry) {
  const state = String(entry?.state || '').toLowerCase()
  if (state === 'connected') return { label: 'Connected', variant: 'success' }
  if (state === 'connected_no_usage') return { label: 'Connected · usage unavailable', variant: 'outline' }
  if (state === 'not_connected') return { label: 'Not connected', variant: 'muted' }
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn' }
  if (state === 'unavailable') return { label: 'Unavailable', variant: 'muted' }
  return { label: 'Unknown state', variant: 'muted' }
}

function connectionScopeStateMeta(scope) {
  const state = String(scope?.state || '').toLowerCase()
  if (state === 'connected') return { label: 'Connected', variant: 'success' }
  if (state === 'not_connected') return { label: 'Not connected', variant: 'muted' }
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn' }
  if (state === 'unavailable') return { label: 'Not available', variant: 'muted' }
  if (state === 'unverified') return { label: 'Not verified', variant: 'warn' }
  if (state === 'info') return null
  return { label: 'Unknown', variant: 'muted' }
}

function connectionSetupText(entry) {
  const setup = entry?.setup || {}
  const env = Array.isArray(setup.env) ? setup.env.map(String).filter(Boolean) : []
  const links = Array.isArray(entry?.links) ? entry.links : []
  const scopes = Array.isArray(entry?.scopes) ? entry.scopes : []
  return [
    `${entry?.name || entry?.provider || 'Provider'} (${entry?.provider || entry?.id || 'unknown'})`,
    entry?.description ? String(entry.description) : null,
    `Status: ${connectionStateMeta(entry).label}`,
    entry?.state_detail ? String(entry.state_detail) : null,
    ...scopes.map(scope => {
      const meta = connectionScopeStateMeta(scope)
      return `${scope?.label || 'Scope'}${meta ? ` — ${meta.label}` : ''}: ${scope?.detail || ''}`
    }),
    setup.summary ? `Setup: ${setup.summary}` : null,
    env.length ? `Credentials: ${env.join(' or ')}` : null,
    setup.command ? `Command: ${setup.command}` : null,
    ...links.map(link => `${link?.label || 'Docs'}: ${link?.url || ''}`),
    entry?.docs_url ? `Docs: ${entry.docs_url}` : null,
    entry?.verification ? `Verification: ${entry.verification}` : null
  ].filter(Boolean).join('\n')
}

function ConnectionCard({ entry, ctx }) {
  const state = connectionStateMeta(entry)
  const scopes = Array.isArray(entry?.scopes) ? entry.scopes : []
  const setup = entry?.setup || {}
  const env = Array.isArray(setup.env) ? setup.env.map(String).filter(Boolean) : []
  const links = Array.isArray(entry?.links) ? entry.links : []
  const copy = () => {
    haptic('tap')
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(connectionSetupText(entry))
        host.notify({ kind: 'info', message: 'Setup copied. This card never reads credentials or fetches account data for you.' })
        return
      }
    } catch {
      // Fall through to a plain notice when the clipboard is unavailable.
    }
    host.notify({ kind: 'info', message: 'Setup details are shown on the card. Credentials stay in Hermes.' })
  }
  return jsxs('div', {
    style: { border: '1px solid var(--ui-stroke-tertiary)', borderRadius: 8, background: 'var(--ui-bg-card)', padding: '11px 13px', display: 'grid', gap: 7 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', minWidth: 0 },
        children: [
          jsx('span', { style: { ...textPrimary, fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry?.name || entry?.provider || 'Provider' }, 'name'),
          jsx(Badge, { variant: state.variant, size: 'xs', style: state.variant === 'outline' || state.variant === 'muted' ? { color: 'var(--ui-text-secondary)' } : undefined, children: state.label }, 'state'),
          jsx(Badge, { variant: 'outline', size: 'xs', style: { color: 'var(--ui-text-secondary)' }, children: 'Built-in' }, 'source')
        ]
      }),
      entry?.description
        ? jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: entry.description }, 'description')
        : null,
      jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5 }, children: entry?.state_detail || '' }, 'state-detail'),
      jsx(ManageLinks, { links: entry?.manage_links, ctx }, 'manage'),
      scopes.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 6, paddingTop: 8, borderTop: HAIRLINE },
            children: [
              jsx(SectionLabel, { children: 'Supported scopes' }),
              ...scopes.map((scope, index) => {
                const meta = connectionScopeStateMeta(scope)
                return jsxs('div', {
                  style: { display: 'grid', gap: 2 },
                  children: [
                    jsxs('div', {
                      style: { display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' },
                      children: [
                        jsx('span', { style: { ...textPrimary, fontSize: 10.5, fontWeight: 550 }, children: scope?.label || 'Scope' }, `label-${index}`),
                        meta ? jsx(Badge, { variant: meta.variant, size: 'xs', style: meta.variant === 'outline' || meta.variant === 'muted' ? { color: 'var(--ui-text-secondary)' } : undefined, children: meta.label }, `state-${index}`) : null
                      ]
                    }),
                    jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.5, overflowWrap: 'anywhere' }, children: scope?.detail || '' }, `detail-${index}`),
                    scope?.state_detail
                      ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: scope.state_detail }, `state-detail-${index}`)
                      : null,
                    scope?.docs_url
                      ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: scope.docs_url }, `docs-${index}`)
                      : null
                  ]
                }, `${entry?.id || 'connection'}-${scope?.id || index}`)
              })
            ]
          })
        : null,
      jsxs('div', {
        style: { display: 'grid', gap: 3, paddingTop: 8, borderTop: HAIRLINE },
        children: [
          jsx(SectionLabel, { children: 'Setup' }),
          setup.summary
            ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5 }, children: setup.summary }, 'summary')
            : null,
          env.length > 0
            ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45, overflowWrap: 'anywhere' }, children: `Environment: ${env.join(' or ')}` }, 'env')
            : null,
          setup.command
            ? jsx('span', { style: { ...textSecondary, fontSize: 10, lineHeight: 1.45 }, children: `Command: ${setup.command}` }, 'command')
            : null
        ]
      }, 'setup'),
      links.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 2 },
            children: [
              jsx(SectionLabel, { children: 'Official links' }),
              ...links.map((link, index) => jsx('span', {
                style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' },
                children: `${link?.label || 'Docs'}: ${link?.url || ''}`
              }, `link-${index}`))
            ]
          }, 'links')
        : null,
      entry?.verification
        ? jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45 }, children: `Verification: ${entry.verification}` }, 'verification')
        : null,
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 8, paddingTop: 2, flexWrap: 'wrap' },
        children: [
          jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', onClick: copy, children: 'Copy setup steps' }, 'copy'),
          jsx('span', { style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.45, minWidth: 0 }, children: 'No balance or quota is inferred.' }, 'note')
        ]
      })
    ]
  })
}

function ConnectionCardsSection({ connections, ctx }) {
  if (!Array.isArray(connections) || connections.length === 0) return null
  const connected = connections.filter(entry => String(entry?.state || '').toLowerCase() === 'connected').length
  return jsxs('section', {
    'aria-label': 'Popular provider connections',
    style: { padding: '15px 18px 18px', borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, {
        aside: `${connected} of ${connections.length} connected`,
        children: 'Popular providers'
      }, 'title'),
      jsx('span', {
        style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5, paddingTop: 4 },
        children: 'Always listed. Cards report credential presence and supported read paths only; they never invent a balance, quota, or local spend total.'
      }, 'intro'),
      jsx('div', {
        style: { display: 'grid', gap: 8, paddingTop: 10 },
        children: connections.map(entry => jsx(ConnectionCard, { entry, ctx }, entry.id))
      }, 'cards')
    ]
  })
}

function CatalogSection({ catalog }) {
  if (!catalog || !Array.isArray(catalog.definitions)) return null
  const definitions = catalog.definitions
  const stateOf = entry => String(entry?.state || '').toLowerCase()
  const isConnected = entry => stateOf(entry) === 'connected' || stateOf(entry) === 'ok'
  const pending = definitions.filter(entry => !isConnected(entry))
  // Never count an unknown/missing state as connected.
  const connectedCount = definitions.filter(isConnected).length
  const availableCount = definitions.filter(entry => stateOf(entry) === 'available').length
  const readyCount = definitions.filter(entry => stateOf(entry) === 'ready').length
  const untrustedCount = definitions.filter(entry => stateOf(entry) === 'untrusted' || stateOf(entry) === 'requires_approval').length
  const blockedCount = definitions.filter(entry => stateOf(entry) === 'blocked').length
  const invalidCount = definitions.filter(entry => stateOf(entry) === 'invalid').length
  const setupSummary = [
    availableCount > 0 ? `${availableCount} to connect` : null,
    readyCount > 0 ? `${readyCount} ready` : null,
    untrustedCount > 0 ? `${untrustedCount} approval required` : null,
    blockedCount > 0 ? `${blockedCount} blocked` : null,
    invalidCount > 0 ? `${invalidCount} invalid` : null,
    `${connectedCount} connected`
  ].filter(Boolean).join(' · ')
  const directory = catalog.directory || '$HERMES_HOME/provider-usage/providers'
  return jsxs('section', {
    'aria-label': 'Provider definitions',
    style: { padding: '15px 18px 18px', borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, {
        aside: definitions.length > 0 ? setupSummary : null,
        children: 'Provider definitions'
      }, 'title'),
      jsx('span', {
        style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5, paddingTop: 4 },
        children: 'Read-only JSON definitions. No scripts, no eval, and never a credential value in the file.'
      }, 'intro'),
      pending.length > 0
        ? jsx('div', {
            style: { display: 'grid', gap: 8, paddingTop: 10 },
            children: pending.map(entry => jsx(CatalogCard, { entry }, entry.id))
          }, 'cards')
        : jsx('div', {
            style: { ...textSecondary, fontSize: 11, lineHeight: 1.5, paddingTop: 10 },
            children: definitions.length > 0
              ? 'All catalog definitions are connected. Add another JSON file to extend the list.'
              : 'No declarative definitions yet. Add a JSON file to the folder below, then refresh.'
          }, 'empty'),
      jsxs('div', {
        style: { ...textSecondary, fontSize: 9.5, lineHeight: 1.5, paddingTop: 12, overflowWrap: 'anywhere' },
        children: [
          jsx('span', { children: `Folder: ${directory}` }, 'folder'),
          jsx('span', { children: ' · Template: dashboard/definitions/TEMPLATE.json' }, 'template')
        ]
      }, 'footer')
    ]
  })
}

function SettingsSection({ ctx, onChanged }) {
  const [open, setOpen] = useState(false)
  const [spec, setSpec] = useState([])
  const [values, setValues] = useState({})
  const [saving, setSaving] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!open) return undefined
    let alive = true
    Promise.resolve(ctx.rest('/settings'))
      .then(payload => {
        if (!alive) return
        setSpec(Array.isArray(payload?.spec) ? payload.spec : [])
        setValues(payload?.settings && typeof payload.settings === 'object' ? payload.settings : {})
        setError('')
      })
      .catch(reason => { if (alive) setError(String(reason?.message || reason || 'Settings unavailable')) })
    return () => { alive = false }
  }, [ctx, open])

  const setValue = async (key, next) => {
    const previous = values[key]
    setSaving(key)
    setValues(current => ({ ...current, [key]: next }))
    setError('')
    try {
      const payload = await ctx.rest('/settings', { method: 'PUT', body: { settings: { [key]: next } } })
      if (payload?.ok === false) throw new Error((payload?.errors || ['Setting was refused']).join('; '))
      setValues(current => ({ ...current, ...(payload?.settings || {}) }))
      // A setting can change how providers are read, so the numbers on screen are
      // stale the moment it saves. Refresh instead of asking the user to.
      if (typeof onChanged === 'function') onChanged()
    } catch (reason) {
      setValues(current => ({ ...current, [key]: previous }))
      setError(String(reason?.message || reason || 'Setting was refused'))
    } finally {
      setSaving('')
    }
  }

  const rows = spec.map(item => {
    const checked = values[item.key] === true
    return jsxs('div', {
      style: { display: 'flex', gap: 14, alignItems: 'flex-start', padding: '11px 0', borderTop: HAIRLINE },
      children: [
        jsxs('div', {
          style: { flex: 1, minWidth: 0 },
          children: [
            jsx('div', { style: { ...textPrimary, fontSize: 12, fontWeight: 600 }, children: item.label || item.key }, 'label'),
            item.help ? jsx('p', { style: { ...textSecondary, margin: '3px 0 0', fontSize: 10.5, lineHeight: 1.5 }, children: item.help }, 'help') : null
          ]
        }, 'text'),
        jsx(Button, {
          type: 'button',
          variant: checked ? 'primary' : 'secondary',
          size: 'micro',
          role: 'switch',
          'aria-checked': checked,
          'aria-label': item.label || item.key,
          disabled: saving === item.key,
          onClick: () => { haptic('tap'); void setValue(item.key, !checked) },
          children: checked ? 'On' : 'Off'
        }, 'switch')
      ]
    }, item.key)
  })

  return jsxs('section', {
    style: { borderTop: HAIRLINE, padding: '12px 18px 18px' },
    children: [
      jsxs('button', {
        type: 'button',
        onClick: () => { haptic('tap'); setOpen(current => !current) },
        'aria-expanded': open,
        style: { all: 'unset', boxSizing: 'border-box', cursor: 'pointer', display: 'flex', width: '100%', alignItems: 'center', justifyContent: 'space-between', gap: 10 },
        children: [
          jsx('h2', { style: { ...textPrimary, margin: 0, fontSize: 11, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: 'Settings' }, 'title'),
          jsx('span', { style: { ...textSecondary, fontSize: 11 }, children: open ? 'Hide' : 'Show' }, 'toggle')
        ]
      }, 'button'),
      open ? jsxs('div', { style: { marginTop: 8 }, children: [
        error ? jsx('p', { style: { ...textSecondary, margin: '0 0 6px', fontSize: 10.5, color: 'var(--dt-destructive)' }, children: error }, 'error') : null,
        rows.length ? rows : jsx('p', { style: { ...textSecondary, margin: 0, fontSize: 11 }, children: 'No settings yet.' }, 'empty')
      ] }, 'body') : null
    ]
  })
}

function ProviderUsagePage({ ctx, initialProvider = '' }) {
  const model = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const activeProfile = useValue(host.state.profile)
  const activeConnectionId = host.state.connectionId !== undefined ? useValue(host.state.connectionId) : ''
  const hasFocusedOwner = host.state.focusedSessionOwner !== undefined
  const focusedOwner = hasFocusedOwner ? useValue(host.state.focusedSessionOwner) : null
  const focusedProfile = host.state.focusedSessionProfile !== undefined ? useValue(host.state.focusedSessionProfile) : ''
  const gateway = useValue(host.state.gateway)
  const scope = resolveUsageScope({ focusedOwner, hasFocusedOwner, focusedProfile, activeConnectionId, activeProfile })

  // Another machine only. Local profiles are read directly.
  if (scope.unreachable) {
    return jsx(GatedUsagePage, { scope })
  }
  return jsx(ProviderUsagePageBody, { ctx, initialProvider, model, sessionId, gateway, scope })
}

function GatedUsagePage({ scope }) {
  const header = jsxs('header', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 18px', borderBottom: HAIRLINE },
    children: [
      jsxs('div', { style: { minWidth: 0, display: 'grid', gap: 2 }, children: [
        jsx('h1', { style: { ...textPrimary, margin: 0, fontSize: 13, lineHeight: 1.35, fontWeight: 650 }, children: 'Provider usage' }),
        jsx('span', { style: { ...textSecondary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `Scope ${scope.fetchProfile} · focused ${scope.focusProfile}` })
      ] })
    ]
  })
  const body = jsxs('div', {
    style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center', textAlign: 'center', gap: 12, padding: 24 },
    children: [
      jsx(StatusDot, { tone: 'warn', style: { width: 12, height: 12 } }),
      jsx('strong', { style: { ...textSecondary, fontSize: 13, fontWeight: 600 }, children: scope.ambiguous ? 'Account scope could not be identified' : `${scope.focusProfile} is on another connection` }),
      jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5, maxWidth: 340 }, children: scope.ambiguous
        ? 'The focused chat did not resolve to one account. Provider usage is hidden rather than guessed.'
        : 'This gateway can read provider accounts for profiles on this machine. It cannot read that connection.' })
    ]
  })
  return jsxs('div', { style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 }, children: [header, body] })
}

function ProviderUsagePageBody({ ctx, initialProvider, model, sessionId, gateway, scope }) {
  const ready = gatewayReady(gateway)
  const switching = useSwitchingOverride(scope.fetchProfile, ready)
  const provider = useActiveProvider(sessionId, initialProvider, scope.fetchProfile, scope.ownerConnection, scope.sourceId)
  const query = useOverview(ctx, provider, model, scope.fetchProfile, gateway, scope.sourceId)
  const matched = accountMatches(query.data, scope.fetchProfile, scope.activeProfile) ? query.data : null
  const rawRows = Array.isArray(matched?.providers) ? matched.providers : []
  const rows = mergeOpenCodeRows(rawRows, provider)
  const selected = activeRow({ ...matched, providers: rows }, provider)
  const activeId = selected?.id || ''
  const available = rows.filter(row => rowHasFunding(row) && row.id !== activeId)
  const limited = rows.filter(row => !rowHasFunding(row) && row.id !== activeId)
  const hasRows = rows.length > 0
  const refetchError = Boolean(query.isError) && hasRows
  const backendNotEnabled = ready && Boolean(query.isError) && !hasRows && isBackendNotEnabled(query.error)

  const scopeSubtitle = [
    `Scope ${scope.fetchProfile}`,
    hasRows ? formatUpdated(query.data?.fetched_at) : null
  ].filter(Boolean).join(' · ')

  const refreshButton = jsx(Tip, {
    label: query.isFetching ? 'Refreshing provider usage' : 'Refresh provider usage',
    children: jsx(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'icon-xs',
      disabled: query.isFetching || !ready,
      'aria-label': 'Refresh provider usage',
      onClick: () => {
        haptic('tap')
        requestSourcesRefresh = true
        void query.refetch()
      },
      children: jsx(icons.RefreshCw, { 'aria-hidden': true })
    })
  })

  const header = jsxs('header', {
    style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 18px', borderBottom: HAIRLINE },
    children: [
      jsxs('div', {
        style: { minWidth: 0, display: 'grid', gap: 2 },
        children: [
          jsx('h1', { style: { ...textPrimary, margin: 0, fontSize: 13, lineHeight: 1.35, fontWeight: 650 }, children: 'Provider usage' }, 'title'),
          jsx('span', { style: { ...textSecondary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: scopeSubtitle }, 'subtitle')
        ]
      }, 'title-block'),
      jsx('div', { children: refreshButton }, 'refresh')
    ]
  })

  // Honest recovery states — a real profile swap loads; a reconnect OR a failed
  // refresh keeps the last data visible (stale) instead of wiping it away.
  const staleBanner = switching || !ready || refetchError
    ? jsx('div', {
        style: { display: 'flex', alignItems: 'center', gap: 9, padding: '8px 18px', borderBottom: HAIRLINE, background: 'var(--ui-bg-tertiary)' },
        children: [
          jsx(StatusDot, { tone: switching ? 'muted' : 'warn' }, 'dot'),
          jsx('span', {
            style: { ...textSecondary, fontSize: 11, lineHeight: 1.4 },
            children: switching
              ? `Switching profile — refreshing ${scope.fetchProfile} usage when the new profile is ready.`
              : refetchError
                ? `Could not refresh — showing ${scope.fetchProfile} usage from ${formatUpdated(query.data?.fetched_at) || 'earlier'}.`
                : `Reconnecting — showing ${scope.fetchProfile} usage from ${hasRows ? formatUpdated(query.data?.fetched_at) : 'earlier'}.`
          }, 'text')
        ]
      }, 'stale')
    : null

  let body
  if (switching && !hasRows) {
    body = jsx('div', { style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center' }, children: jsx(Loader, { type: 'lemniscate-bloom', label: `Switching to ${scope.fetchProfile}`, style: { width: 58 } }) })
  } else if (!switching && !ready && !hasRows) {
    body = jsxs('div', {
      style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center', textAlign: 'center', gap: 10 },
      children: [
        jsx(StatusDot, { tone: 'warn', style: { width: 10, height: 10 } }, 'dot'),
        jsx('strong', { style: { ...textSecondary, fontSize: 12, fontWeight: 600 }, children: 'Reconnecting' }, 'title'),
        jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: `Provider usage for ${scope.fetchProfile} will load when the connection is ready.` }, 'hint')
      ]
    })
  } else if (!switching && ready && query.isLoading && !hasRows) {
    body = jsx('div', { style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center' }, children: jsx(Loader, { type: 'lemniscate-bloom', label: 'Checking provider accounts', style: { width: 58 } }) })
  } else if (!switching && ready && query.isError && !hasRows) {
    body = jsxs('div', {
      style: { padding: 24, display: 'grid', placeItems: 'center', textAlign: 'center', gap: 12 },
      children: backendNotEnabled
        ? [
            jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 22, height: 22, color: 'var(--ui-text-tertiary)' } }, 'icon'),
            jsx('strong', { children: `Provider usage isn't enabled or installed in ${scope.fetchProfile}` }, 'title'),
            jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: 'Enable or install this plugin in the profile to see provider usage here. Hermes never edits profiles automatically.' }, 'hint')
          ]
        : [
            jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 22, height: 22, color: 'var(--ui-text-tertiary)' } }, 'icon'),
            jsx('strong', { children: `Provider data for ${scope.fetchProfile} could not be loaded` }, 'title'),
            jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.5 }, children: 'The Hermes backend may need to reload this plugin.' }, 'hint'),
            jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', onClick: () => void query.refetch(), children: 'Try again' }, 'retry')
          ]
    })
  } else {
    body = jsxs('div', {
      style: { height: 'calc(100% - 58px)', overflowY: 'auto', overflowX: 'hidden' },
      children: [
        staleBanner,
        selected
          ? jsx(ActiveProvider, { row: selected, model, ctx, profile: scope.fetchProfile }, 'active')
          : null,
        jsxs('section', {
          'aria-labelledby': 'provider-usage-accounts-heading',
          style: { padding: '15px 18px 18px' },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: 6 },
              children: [
                jsx('h2', { id: 'provider-usage-accounts-heading', style: { ...textPrimary, margin: 0, fontSize: 11, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: 'Other providers' }, 'heading'),
                jsx('span', { style: { ...textSecondary, fontSize: 10 }, children: `${available.length} reporting` }, 'count')
              ]
            }, 'accounts-header'),
            available.length > 0
              ? jsx('div', { style: { display: 'grid', gap: 8 }, children: available.map(row => jsx(ProviderDisclosure, { row, ctx, profile: scope.fetchProfile }, row.id)) }, 'account-cards')
              : jsx('div', { style: { ...textSecondary, fontSize: 11, padding: '10px 0' }, children: 'No other providers are reporting usage.' }, 'empty-accounts'),
            jsx(LimitedProviders, { rows: limited }, 'limited'),
            jsx('footer', {
              style: { ...textSecondary, fontSize: 9, lineHeight: 1.45, paddingTop: 14 },
              children: `Credentials stay in Hermes. This pane receives balances, percentages, plan names, and reset times only.`
            }, 'footer')
          ]
        }, 'accounts'),
        jsx(ConnectionCardsSection, { connections: matched?.connections, ctx }, 'connections'),
        jsx(CatalogSection, { catalog: matched?.catalog }, 'catalog'),
        jsx(SettingsSection, { ctx, onChanged: () => void query.refetch() }, 'settings')
      ]
    })
  }

  return jsxs('div', {
    style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 },
    children: [header, body]
  })
}

export { CatalogSection, SettingsSection, ConnectionCard, ConnectionCardsSection, DefinitionBadge, DefinitionPanel, RunningAgentsFooter, RunningAgentsSection, activeSourceId, catalogSetupText, compactFundingSummary, connectionSetupText, connectionStateMeta, eventOwns, fundingState, governingWindows, isBackendNotEnabled, mergeOpenCodeRows, normaliseRunningAgents, profileScope, providerFromPayload, providerScopeKey, providerUsageQueryKey, rememberProvider, rememberedProvider, rememberedSessionProvider, resolveUsageScope, runningAgentAccount, runningAgentGroups, runningAgentProvider, runningAgentTotal, runningAgentsQueryKey, sharedPoolUsage, shouldEnterProfileSwitch, shouldSettleProfileSwitch, statusFundingSummary }

export default {
  id: 'jg-provider-usage',
  name: 'Provider Usage',
  defaultEnabled: true,
  register(ctx) {
    // Full Settings-style workspace page: every provider, all windows, resets,
    // balances, and metadata. Reachable via the chip popover, the sidebar nav
    // row, and the ⌘K palette — never an always-on pane.
    ctx.register({
      id: 'overview-page',
      area: ROUTES_AREA,
      data: { path: OVERVIEW_ROUTE },
      render: () => jsx(ProviderUsagePage, { ctx })
    })
    ctx.register({
      id: 'nav',
      area: SIDEBAR_NAV_AREA,
      data: { path: OVERVIEW_ROUTE, label: 'Provider Usage', codicon: 'gauge' }
    })
    ctx.register({
      id: 'open',
      area: PALETTE_AREA,
      data: {
        id: 'open-provider-usage',
        label: 'Provider Usage',
        icon: icons.BarChart3,
        keywords: ['usage', 'provider', 'credits', 'balance'],
        run: () => host.navigate(OVERVIEW_ROUTE)
      }
    })
    // Toolbar chip: click to pop the current provider's details; the popover's
    // "View all providers" opens the full page.
    ctx.register({
      id: 'active-chip',
      area: 'statusBar.right',
      order: 125,
      render: () => jsx(ActiveUsageChip, { ctx })
    })
  }
}
