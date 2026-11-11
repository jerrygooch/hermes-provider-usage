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
const OVERVIEW_ROUTE = '/provider-usage'
const textPrimary = { color: 'var(--ui-text-primary)' }
const textSecondary = { color: 'var(--ui-text-secondary)' }
const textTertiary = { color: 'var(--ui-text-tertiary)' }
const textQuaternary = { color: 'var(--ui-text-quaternary)' }
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
    'provider-usage',
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
  const currency = String(balance?.currency || 'USD').toUpperCase()
  return currency === 'USD' ? `$${amount.toFixed(2)}` : `${currency} ${amount.toFixed(2)}`
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
      jsx('span', { style: { ...textTertiary, fontSize: 10.5, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: dollarWindowSummary(window) ? (window?.reset_at ? formatReset(window.reset_at) : 'Resets with the plan') : windowMeta(window) })
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
  const details = [
    Number.isFinite(total) && Number.isFinite(used)
      ? `${money({ amount: used, currency: balance?.currency })} used of ${money({ amount: total, currency: balance?.currency })}`
      : null,
    Number.isFinite(granted)
      ? `${money({ amount: granted, currency: balance?.currency })} granted`
      : null,
    Number.isFinite(toppedUp)
      ? `${money({ amount: toppedUp, currency: balance?.currency })} topped up`
      : null,
    balance?.expires_at ? `Expires ${new Date(balance.expires_at).toLocaleString()}` : null
  ].filter(Boolean)
  return jsxs('div', {
    style: { display: 'grid', gap: 2, padding: prominent ? '1px 0' : '7px 0' },
    children: [
      jsx('span', { style: { ...(subdued ? textQuaternary : textTertiary), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: balance?.label || 'Balance' }),
      jsx('strong', {
        style: { ...(subdued ? textTertiary : textPrimary), fontSize: prominent ? 27 : subdued ? 12 : 20, fontWeight: subdued ? 550 : 650, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
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
        ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.5 }, children: details.join(' · ') })
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
        style: { ...textTertiary, margin: 0, fontSize: 10, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.07em' },
        children
      }),
      aside ? jsx('span', { style: { ...textQuaternary, fontSize: 9 }, children: aside }) : null
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
      aside ? jsx('span', { style: { ...textQuaternary, fontSize: 10 }, children: aside }) : null
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
                style: { ...(blocked ? textSecondary : textQuaternary), color: blocked ? 'var(--dt-destructive)' : undefined, fontSize: 9, fontWeight: blocked ? 650 : 500, textTransform: 'uppercase', letterSpacing: '0.05em' },
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
          hint ? jsx('span', { style: { ...textTertiary, fontSize: 10.5, fontVariantNumeric: 'tabular-nums' }, children: hint }, 'hint') : null
        ]
      }),
      peak.schedule_local || peak.schedule
        ? jsx('span', {
            style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 },
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
              style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
              children: [
                jsxs('span', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }, children: [
                  jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry?.model || 'Model' }, 'model'),
                  entry?.active ? jsx(Badge, { variant: 'outline', size: 'xs', children: 'current' }, 'current') : null
                ] }, 'name'),
                jsx('span', { style: { ...textPrimary, fontSize: 11, fontWeight: 550, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, children: rateSummary(entry) || '—' }, 'rates')
              ]
            }, `rate-${index}`))
          }, 'rows')
        : jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: 'No published token-rate card is available for this provider yet.' }, 'empty'),
      source ? jsx('span', { style: { ...textQuaternary, fontSize: 9.5, lineHeight: 1.45 }, children: source }, 'source') : null,
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
        ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: row.breakdown_note }, 'note')
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
      jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: meta }, 'meta')
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
      tokens ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' }, children: tokens }, 'meta') : null
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
            jsx('span', { style: { ...textQuaternary, textAlign: 'right' }, children: status })
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
  const facts = [
    renewalAt
      ? `Subscription renews ${new Date(renewalAt).toLocaleString()}`
      : complete && row?.plan ? 'Subscription renewal date is not exposed by this provider.' : null,
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
              jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.4 }, children: entry.label }, `label-${index}`),
              jsx('span', { style: { ...textSecondary, fontSize: 11, lineHeight: 1.4, overflowWrap: 'anywhere' }, children: entry.value }, `value-${index}`)
            ]
          : [jsx('span', { style: { ...textTertiary, gridColumn: '1 / -1', fontSize: 11, lineHeight: 1.4 }, children: entry.value }, `full-${index}`)])
      })
    ]
  })
}

function definitionStateMeta(row) {
  if (!row?.definition) return null
  const state = String(row?.state || '')
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn', tone: 'warn' }
  if (state === 'not_connected') return { label: 'Not connected', variant: 'muted' }
  if (state === 'unavailable') return { label: 'Unavailable', variant: 'muted' }
  if (state === 'unverified') return { label: 'Unverified mapping', variant: 'warn' }
  if (state === 'stale') return { label: 'Stale data', variant: 'warn' }
  if (state === 'invalid_definition') return { label: 'Invalid definition', variant: 'destructive' }
  return null
}

function DefinitionBadge({ row }) {
  if (!row?.definition) return null
  const meta = definitionStateMeta(row)
  return jsx(Badge, {
    variant: meta?.variant || 'outline',
    size: 'xs',
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
        : 'fresh fetch'
  const source = prov.definition_source === 'profile' ? 'Profile definition' : 'Bundled definition'
  const override = prov.overrides ? ' · overrides bundled copy' : ''
  const error = prov.error || (row.state && row.state !== 'ok' ? row.unavailable_reason : null)
  return jsxs('section', {
    style: { display: 'grid', gap: 3, paddingTop: 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionLabel, { aside: `${prov.endpoint_host || ''}`, children: 'Data source' }, 'label'),
      jsx('span', {
        style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' },
        children: `${source} ${prov.definition_id} v${prov.definition_version}${override}`
      }, 'definition'),
      jsx('span', {
        style: { ...textQuaternary, fontSize: 10, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums' },
        children: [
          cache,
          ageText,
          `TTL ${prov.ttl_seconds || 0}s`,
          `scope ${prov.scope || 'active'}`,
          prov.definition_file ? prov.definition_file : null
        ].filter(Boolean).join(' · ')
      }, 'freshness'),
      prov.docs_url
        ? jsx('span', {
            style: { ...textQuaternary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere' },
            children: prov.docs_url
          }, 'docs')
        : null,
      error
        ? jsx('span', { style: { ...textTertiary, fontSize: 10, lineHeight: 1.45, color: 'var(--ui-orange)' }, children: error }, 'error')
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
                : jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: product.unavailable_reason || 'This product does not expose usage data.' })
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
            style: { ...textTertiary, fontSize: 11, lineHeight: 1.45, fontVariantNumeric: 'tabular-nums' },
            children: `Banked resets: ${row.reset_credits.available ?? 0} saved, ${row.reset_credits.applicable ?? 0} usable now`
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

function ActiveProvider({ row, model }) {
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
      ? `${plan} subscription allowance`
      : state.kind === 'balance'
        ? 'Requests are billed from this provider balance.'
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
                style: { ...textTertiary, fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
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
          jsx('span', { style: { ...textTertiary, fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.07em' }, children: 'Current request funding' }),
          jsx('strong', { style: { ...textPrimary, fontSize: codexFallback ? 16 : 18, lineHeight: 1.3, fontVariantNumeric: 'tabular-nums' }, children: fundingHeadline }),
          jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: fundingDetail }),
          row?.id === 'xai-oauth' && legacyPlanNote(row?.plan)
            ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: legacyPlanNote(row.plan) })
            : null
        ]
      }),
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

function ProviderDisclosure({ row }) {
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
                jsx('span', { style: { ...textQuaternary, paddingLeft: 13, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.plan || (row.capability === 'balance' ? 'API credits' : 'Account usage') })
              ]
            }),
            jsx('strong', { style: { ...textSecondary, fontSize: 11, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }, children: summary }),
            jsx(open ? icons.ChevronDown : icons.ChevronRight, { 'aria-hidden': true, style: { width: 14, height: 14, color: 'var(--ui-text-quaternary)' } })
          ]
        })
      }),
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
          style: { display: 'flex', alignItems: 'center', gap: 7, ...textTertiary, fontSize: 11 },
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
                  jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.4 }, children: row.unavailable_reason || 'This provider does not expose usage or balance data.' })
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
    host.openWorkspace('provider-usage-overview', {
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
  const label = row ? compactProviderLabel(row) : 'Usage'

  let summary = 'unavailable'
  if (switching) summary = 'switching'
  else if (backendGone) summary = 'plugin not enabled'
  else if (!provider && sessionId) summary = 'checking'
  else if (row) summary = statusFundingSummary(row, model)
  else if (ready && (query.isLoading || !matched)) summary = 'checking'
  else if (ready) summary = 'unavailable'
  if (refetchError) summary = `${summary} · not refreshed`

  const description = chipDescription(row, model, matched, switching, ready, refetchError, scope, backendGone)
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
          onRequestClose: () => setPopoverOpen(false)
        })
      })
    ]
  })
}

function ChipUsagePopover({ ctx, model, scope, row, state, query, backendGone, provider, onRequestClose }) {
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
    style: { width: '100%', justifyContent: 'center' },
    children: [
      jsx(icons.BarChart3, { 'aria-hidden': true, style: { width: 12, height: 12 } }, 'icon'),
      jsx('span', { children: 'View all providers' })
    ]
  })

  if (backendGone) {
    return jsxs('div', {
      style: { display: 'grid', gap: 12, padding: 16 },
      children: [
        jsx('div', { style: { display: 'flex', alignItems: 'center', gap: 8 }, children: [jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 15, height: 15, color: 'var(--ui-text-tertiary)' } }, 'icon'), jsx('strong', { style: { ...textPrimary, fontSize: 12, fontWeight: 600 }, children: `Not enabled in ${scope.fetchProfile}` }, 'title')] }),
        jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: 'Enable or install this plugin in that profile to see usage. Hermes never edits profiles automatically.' }),
        viewAll
      ]
    })
  }

  if (!row) {
    const waiting = !provider || query.isLoading
    return jsxs('div', {
      style: { display: 'grid', gap: 12, padding: 16 },
      children: [
        jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: waiting ? 'Checking which account this chat is using…' : query.isError ? 'Provider data could not be loaded.' : 'No usage is being reported for the current provider.' }),
        viewAll
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
            jsx('span', { style: { ...textQuaternary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: [model, scope.fetchProfile !== scope.activeProfile ? scope.fetchProfile : null].filter(Boolean).join(' · ') || scope.fetchProfile }, 'model')
          ] }, 'identity'),
          refreshButton
        ]
      }),
      jsxs('div', {
        style: { display: 'grid', gap: 13, padding: '13px 14px 12px' },
        children: [
          row?.id === 'xai-oauth' && legacyPlanNote(row?.plan)
            ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: legacyPlanNote(row.plan) }, 'plan-lag')
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
            ? jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: row?.available ? 'No usage windows or balance are reported for this provider.' : (row?.unavailable_reason || 'Usage unavailable.') }, 'empty')
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
            style: { display: 'grid', gap: 8, borderTop: HAIRLINE, paddingTop: 11, marginTop: 1 },
            children: [
              viewAll,
              updated
                ? jsx('span', { style: { ...textQuaternary, fontSize: 9.5, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }, children: `Updated ${updated}` }, 'updated')
                : null
            ]
          }, 'footer')
        ]
      })
    ]
  })
}

function catalogStateMeta(entry) {
  const state = String(entry?.state || '')
  if (state === 'available') return { label: 'Available to connect', variant: 'outline' }
  if (state === 'ready') return { label: 'Ready to read', variant: 'success' }
  if (state === 'invalid') return { label: 'Invalid definition', variant: 'destructive' }
  if (state === 'unverified') return { label: 'Unverified mapping', variant: 'warn' }
  if (state === 'needs_permission') return { label: 'Permission needed', variant: 'warn' }
  if (state === 'unavailable') return { label: 'Unavailable', variant: 'muted' }
  if (state === 'stale') return { label: 'Stale data', variant: 'warn' }
  return { label: 'Connected', variant: 'success' }
}

function catalogSetupText(entry) {
  const setup = entry?.setup || {}
  const missing = Array.isArray(entry?.missing_credentials) ? entry.missing_credentials : []
  const file = setup.file || `${entry?.id || 'definition'}.json`
  const directory = setup.directory || '$HERMES_HOME/provider-usage/providers'
  return [
    `Provider Usage definition: ${entry?.name || entry?.id || 'definition'} (${entry?.id || 'unknown'} v${entry?.version || 1})`,
    `Save as: ${directory}/${file}`,
    missing.length ? `Credentials (environment): ${missing.join(', ')}` : 'No credential required.',
    Array.isArray(entry?.errors) && entry.errors.length ? `Fix: ${entry.errors.slice(0, 2).join(' | ')}` : 'Validate: python scripts/validate_definition.py <file>',
    entry?.docs_url ? `Docs: ${entry.docs_url}` : null
  ].filter(Boolean).join('\n')
}

function CatalogCard({ entry }) {
  const state = catalogStateMeta(entry)
  const missing = Array.isArray(entry?.missing_credentials) ? entry.missing_credentials : []
  const errors = Array.isArray(entry?.errors) ? entry.errors : []
  const setup = entry?.setup || {}
  const docs = entry?.docs_url
  const copy = () => {
    haptic('tap')
    const text = catalogSetupText(entry)
    try {
      if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
        void navigator.clipboard.writeText(text)
        host.notify({ kind: 'info', message: 'Setup copied. Keep credentials in the environment, never in the JSON.' })
        return
      }
    } catch {
      // Fall through to a plain notice when the clipboard is unavailable.
    }
    host.notify({ kind: 'info', message: 'Copy the setup from the definition docs; credentials stay in the environment.' })
  }
  return jsxs('div', {
    style: { border: '1px solid var(--ui-stroke-tertiary)', borderRadius: 8, background: 'var(--ui-bg-card)', padding: '11px 13px', display: 'grid', gap: 5 },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap', minWidth: 0 },
        children: [
          jsx('span', { style: { ...textPrimary, fontSize: 12, fontWeight: 600, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: entry?.name || entry?.id || 'Definition' }, 'name'),
          jsx(Badge, { variant: state.variant, size: 'xs', children: state.label }, 'state'),
          jsx(Badge, { variant: entry?.source === 'profile' ? 'outline' : 'muted', size: 'xs', children: entry?.source === 'profile' ? 'Profile' : 'Bundled' }, 'source'),
          entry?.stability === 'experimental' ? jsx(Badge, { variant: 'warn', size: 'xs', children: 'Experimental' }, 'stability') : null
        ]
      }),
      entry?.description
        ? jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: entry.description }, 'description')
        : null,
      jsxs('span', {
        style: { ...textQuaternary, fontSize: 10, lineHeight: 1.5, fontVariantNumeric: 'tabular-nums', overflowWrap: 'anywhere' },
        children: [
          entry?.host || null,
          entry?.version ? `v${entry.version}` : null,
          setup.file || null,
          entry?.last_error || null
        ].filter(Boolean).join(' · ')
      }, 'meta'),
      missing.length
        ? jsx('span', { style: { ...textSecondary, fontSize: 10.5, lineHeight: 1.45 }, children: `Needs ${missing.join(', ')} in the environment (never in the JSON).` }, 'missing')
        : entry?.state === 'invalid'
          ? jsx('span', { style: { ...textQuaternary, fontSize: 10.5, lineHeight: 1.45 }, children: 'Fix the validation errors below, then refresh.' }, 'invalid-help')
          : jsx('span', { style: { ...textQuaternary, fontSize: 10.5, lineHeight: 1.45 }, children: 'No credential required for this definition.' }, 'no-credential'),
      errors.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 2, paddingTop: 2 },
            children: errors.slice(0, 3).map((error, index) =>
              jsx('span', { style: { ...textTertiary, fontSize: 10, lineHeight: 1.4, color: 'var(--dt-destructive)', overflowWrap: 'anywhere' }, children: String(error) }, `error-${index}`)
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
            children: 'Copy setup'
          }, 'copy'),
          docs
            ? jsx('span', { style: { ...textQuaternary, fontSize: 9.5, lineHeight: 1.45, overflowWrap: 'anywhere', minWidth: 0 }, children: docs }, 'docs')
            : null
        ]
      })
    ]
  })
}

function CatalogSection({ catalog }) {
  if (!catalog || !Array.isArray(catalog.definitions)) return null
  const definitions = catalog.definitions
  const pending = definitions.filter(entry => entry?.state !== 'connected')
  const connected = definitions.length - pending.length
  const availableCount = definitions.filter(entry => entry?.state === 'available').length
  const readyCount = definitions.filter(entry => entry?.state === 'ready').length
  const invalidCount = definitions.filter(entry => entry?.state === 'invalid').length
  const setupSummary = [
    availableCount > 0 ? `${availableCount} to connect` : null,
    readyCount > 0 ? `${readyCount} ready` : null,
    invalidCount > 0 ? `${invalidCount} invalid` : null,
    `${connected} connected`
  ].filter(Boolean).join(' · ')
  const directory = catalog.directory || '$HERMES_HOME/provider-usage/providers'
  return jsxs('section', {
    'aria-labelledby': 'provider-usage-catalog-heading',
    style: { padding: '15px 18px 18px', borderTop: HAIRLINE },
    children: [
      jsx(SectionTitle, {
        aside: definitions.length > 0 ? setupSummary : null,
        children: 'Available to connect'
      }, 'title'),
      jsx('span', {
        style: { ...textTertiary, fontSize: 10.5, lineHeight: 1.5, paddingTop: 4 },
        children: 'Read-only JSON definitions. No scripts, no eval, and never a credential value in the file.'
      }, 'intro'),
      pending.length > 0
        ? jsx('div', {
            style: { display: 'grid', gap: 8, paddingTop: 10 },
            children: pending.map(entry => jsx(CatalogCard, { entry }, entry.id))
          }, 'cards')
        : jsx('div', {
            style: { ...textTertiary, fontSize: 11, lineHeight: 1.5, paddingTop: 10 },
            children: definitions.length > 0
              ? 'All catalog definitions are connected. Add another JSON file to extend the list.'
              : 'No declarative definitions yet. Add a JSON file to the folder below, then refresh.'
          }, 'empty'),
      jsxs('div', {
        style: { ...textQuaternary, fontSize: 9, lineHeight: 1.5, paddingTop: 12, overflowWrap: 'anywhere' },
        children: [
          jsx('span', { children: `Folder: ${directory}` }, 'folder'),
          jsx('span', { children: ' · Template: dashboard/definitions/TEMPLATE.json' }, 'template')
        ]
      }, 'footer')
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
        jsx('span', { style: { ...textQuaternary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `Scope ${scope.fetchProfile} · focused ${scope.focusProfile}` })
      ] })
    ]
  })
  const body = jsxs('div', {
    style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center', textAlign: 'center', gap: 12, padding: 24 },
    children: [
      jsx(StatusDot, { tone: 'warn', style: { width: 12, height: 12 } }),
      jsx('strong', { style: { ...textSecondary, fontSize: 13, fontWeight: 600 }, children: scope.ambiguous ? 'Account scope could not be identified' : `${scope.focusProfile} is on another connection` }),
      jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5, maxWidth: 340 }, children: scope.ambiguous
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
          jsx('span', { style: { ...textQuaternary, fontSize: 10, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: scopeSubtitle }, 'subtitle')
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
        jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: `Provider usage for ${scope.fetchProfile} will load when the connection is ready.` }, 'hint')
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
            jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: 'Enable or install this plugin in the profile to see provider usage here. Hermes never edits profiles automatically.' }, 'hint')
          ]
        : [
            jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 22, height: 22, color: 'var(--ui-text-tertiary)' } }, 'icon'),
            jsx('strong', { children: `Provider data for ${scope.fetchProfile} could not be loaded` }, 'title'),
            jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: 'The Hermes backend may need to reload this plugin.' }, 'hint'),
            jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', onClick: () => void query.refetch(), children: 'Try again' }, 'retry')
          ]
    })
  } else {
    body = jsxs('div', {
      style: { height: 'calc(100% - 58px)', overflowY: 'auto', overflowX: 'hidden' },
      children: [
        staleBanner,
        selected
          ? jsx(ActiveProvider, { row: selected, model }, 'active')
          : null,
        jsxs('section', {
          'aria-labelledby': 'provider-usage-accounts-heading',
          style: { padding: '15px 18px 18px' },
          children: [
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: 6 },
              children: [
                jsx('h2', { id: 'provider-usage-accounts-heading', style: { ...textPrimary, margin: 0, fontSize: 11, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: 'Other providers' }, 'heading'),
                jsx('span', { style: { ...textQuaternary, fontSize: 10 }, children: `${available.length} reporting` }, 'count')
              ]
            }, 'accounts-header'),
            available.length > 0
              ? jsx('div', { style: { display: 'grid', gap: 8 }, children: available.map(row => jsx(ProviderDisclosure, { row }, row.id)) }, 'account-cards')
              : jsx('div', { style: { ...textTertiary, fontSize: 11, padding: '10px 0' }, children: 'No other providers are reporting usage.' }, 'empty-accounts'),
            jsx(LimitedProviders, { rows: limited }, 'limited'),
            jsx('footer', {
              style: { ...textQuaternary, fontSize: 9, lineHeight: 1.45, paddingTop: 14 },
              children: `Credentials stay in Hermes. This pane receives balances, percentages, plan names, and reset times only.`
            }, 'footer')
          ]
        }, 'accounts'),
        jsx(CatalogSection, { catalog: matched?.catalog }, 'catalog')
      ]
    })
  }

  return jsxs('div', {
    style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 },
    children: [header, body]
  })
}

export { CatalogSection, DefinitionBadge, DefinitionPanel, activeSourceId, compactFundingSummary, eventOwns, fundingState, governingWindows, isBackendNotEnabled, mergeOpenCodeRows, profileScope, providerFromPayload, providerScopeKey, providerUsageQueryKey, rememberProvider, rememberedProvider, rememberedSessionProvider, resolveUsageScope, shouldEnterProfileSwitch, shouldSettleProfileSwitch, statusFundingSummary }

export default {
  id: 'provider-usage',
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
