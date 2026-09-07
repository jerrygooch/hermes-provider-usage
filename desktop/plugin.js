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
  useValue
} from '@hermes/plugin-sdk'
import { jsx, jsxs } from 'react/jsx-runtime'
import { useEffect, useRef, useState } from 'react'

const REFRESH_MS = 60_000
const HAIRLINE = '1px solid var(--ui-stroke-tertiary)'
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

function providerScopeKey(sourceId, sessionId) {
  return `${sourceId}::${String(sessionId || '__workspace__')}`
}

// The plugin's REST door (ctx.rest) routes on the ACTIVE socket connection and
// profile — it cannot be pinned to the FOCUSED chat's profile. So the fetched
// and cached scope is always the ACTIVE account, identified by its
// connection-qualified source (host.state.connectionId + host.state.profile).
// A focused session is only safe to interpret when its owner (connection +
// profile) matches that active source; otherwise it is a DIVERGENCE and must
// fail closed (gate, no fetch/probe), never guessed — a same-profile remote
// would otherwise show one account's data under another's focus.
function resolveUsageScope({ focusedOwner, hasFocusedOwner, focusedProfile, activeConnectionId, activeProfile }) {
  const active = String(activeProfile || '').trim() || 'default'
  const activeSource = activeSourceId(activeConnectionId, active)
  const ownerConnection = String(activeConnectionId || '').trim()
  // Newer SDK publishes the connection-qualified focus owner atom. Authority is
  // on that atom: an EXPLICIT null means the SDK could not resolve the focused
  // chat to one owner (ambiguous/unresolved id) and fails closed. Never fall
  // back to the profile-only ladder in that case — doing so could fetch a
  // foreign account (or serve one account's data) under the focused chat's
  // ambiguous name.
  if (hasFocusedOwner) {
    if (!focusedOwner || typeof focusedOwner?.profile !== 'string') {
      const focus = String(focusedProfile || '').trim() || active
      return {
        fetchProfile: active,
        focusProfile: focus,
        diverged: true,
        source: 'ambiguous',
        sourceId: activeSource,
        ownerConnection
      }
    }
    const focus = String(focusedOwner.profile).trim() || active
    const focusSource = activeSourceId(focusedOwner?.connectionId, focus)
    const verified = Boolean(activeSource) && focusSource === activeSource
    return {
      fetchProfile: active,
      focusProfile: focus,
      diverged: !verified,
      source: verified ? 'active' : 'foreign',
      sourceId: activeSource,
      ownerConnection
    }
  }
  // Older SDK build with NO focus-owner atom (feature absent): no cross-connection
  // focus exists there, so profile parity is the honest check.
  const alias = String(focusedProfile || '').trim()
  const focus = alias || active
  const diverged = Boolean(alias) && alias !== active
  return {
    fetchProfile: active,
    focusProfile: focus,
    diverged,
    source: diverged ? 'foreign-profile' : 'active',
    sourceId: activeSource,
    ownerConnection
  }
}

// The key must NEVER include the gateway state: a reconnecting socket on the
// same account would otherwise change the key and lose the already-cached rows,
// making the "reconnecting keeps the last data" claim false. The stable source
// (connection+profile) is what identifies the account, and it survives reconnects.
function providerUsageQueryKey(fetchProfile, provider, model, source) {
  return [
    'provider-usage',
    'overview',
    profileScope(fetchProfile),
    provider || '',
    model || '',
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
  const [state, setState] = useState(() => ({
    scope,
    provider: rememberedProvider(ownerScopedKey) || normaliseProvider(initialProvider)
  }))

  useEffect(() => {
    let alive = true
    // Seed from the OWNING account's remembered provider; `initialProvider` is
    // only an open-time hint and must never override real per-source memory.
    const seed = rememberedProvider(ownerScopedKey) || normaliseProvider(initialProvider)
    setState({ scope, provider: seed })

    const accept = payload => {
      const value = providerFromPayload(payload)
      if (value && alive) {
        const resolved = rememberProvider(ownerScopedKey, value)
        if (resolved) setState({ scope, provider: resolved })
      }
    }

    const dispose = host.onEvent('session.info', event => {
      // Exact identity + current ownership: a late event for a foreign session,
      // or an anonymous event, must not contaminate this account's memory.
      if (!eventOwns(event, sessionId, ownerSource, ownerProfile)) return
      accept(event?.payload || {})
    })

    if (sessionId) {
      void host
        .request('session.status', { session_id: sessionId })
        .then(response => {
          const payload = payloadFromResponse(response)
          accept(payload?.info || payload)
        })
        .catch(() => {})
    }

    return () => {
      alive = false
      dispose()
    }
  }, [sessionId, ownerProfile, ownerSource, ownerScopedKey, scope, initialProvider])

  return state.scope === scope ? state.provider : ''
}

function useOverview(ctx, provider, model, fetchProfile, gateway, source) {
  return useQuery({
    queryKey: providerUsageQueryKey(fetchProfile, provider, model, source),
    queryFn: () =>
      ctx.rest('/overview', {
        method: 'POST',
        body: { active_provider: provider || null, active_model: model || null },
        timeoutMs: 25_000
      }),
    enabled: gatewayReady(gateway),
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
  return providerRow(data, provider) || providerRow(data, normaliseProvider(data?.active?.provider)) || null
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

function round(value) {
  const number = Number(value)
  return Number.isFinite(number) ? Math.round(number) : null
}

function money(balance) {
  const amount = Number(balance?.amount)
  if (!Number.isFinite(amount)) return '—'
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
    anthropic: 'Claude',
    nous: 'Nous'
  }
  return labels[row?.id] || String(row?.label || row?.id || 'Provider').split(' / ')[0]
}

function isSparkModel(model) {
  return String(model || '').toLowerCase().includes('spark')
}

function windowKind(window) {
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
  const exhausted = windows.length > 0 && windows.some(window => Number(window?.remaining_percent) <= 0)

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

function compactFundingSummary(row, model) {
  const state = fundingState(row, model)
  if (state.kind === 'balance') return state.fallback ? `${money(state.balance)} extra` : money(state.balance)
  if (state.kind === 'subscription') {
    if (state.windows.length === 1) {
      const window = state.windows[0]
      const label = shortWindowLabel(window)
      const remaining = round(window.remaining_percent)
      return /^(subscription|allowance|limit)$/i.test(label) ? `${remaining}% left` : `${label} ${remaining}%`
    }
    return state.windows
      .map(window => `${shortWindowLabel(window)} ${round(window.remaining_percent)}%`)
      .join(' · ')
  }
  if (row?.id === 'opencode-zen') return 'Zen balance unavailable'
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
  const stateNote = scope?.diverged
    ? ` Shows ${scope.fetchProfile} profile usage; the focused chat is in ${scope.focusProfile}.`
    : ''
  if (backendGone) {
    // The active profile's socket has no provider-usage backend installed (its
    // /overview 404s). Surfacing just "unavailable" would hide the cause; the
    // toolbar must say the backend isn't there and never auto-install it.
    return `Provider usage isn't enabled or installed in ${scope.fetchProfile}. Enable or install this plugin in that profile to see usage; Hermes never edits profiles automatically.${stateNote}`
  }
  if (!ready) {
    return row
      ? `Provider usage for ${scope.fetchProfile} is from ${updated}; reconnecting.${stateNote}`
      : `Provider usage for ${scope.fetchProfile}. Reconnecting.${stateNote}`
  }
  if (refetchError) {
    return row
      ? `Provider usage for ${scope.fetchProfile} could not be refreshed — showing ${updated}.${stateNote}`
      : `Provider usage for ${scope.fetchProfile}. Could not refresh.${stateNote}`
  }
  if (!row) return `Provider usage for ${scope.fetchProfile}. Last updated ${updated}.${stateNote}`
  const modelName = model ? ` Active model ${model}.` : ''
  return `${row.label}: ${statusFundingSummary(row, model)}.${modelName}${stateNote} Open the Provider Usage pane for every reported window. Updated ${updated}.`
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
  const parts = [resetAt ? formatReset(resetAt) : null, detail].filter(Boolean)
  return parts.length > 0 ? parts.join(' • ') : 'Reset time unavailable'
}

function progressWidth(window) {
  const remaining = Number(window?.remaining_percent)
  if (!Number.isFinite(remaining)) return '0%'
  return `${Math.max(0, Math.min(100, remaining))}%`
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
    style: { display: 'grid', gap: compact ? 5 : 7, padding: compact ? '7px 0' : '9px 0' },
    children: [
      jsxs('div', {
        style: { display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 },
        children: [
          jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 500 }, children: cleanWindowLabel(window) }),
          jsx('strong', {
            style: { ...textPrimary, color: exhausted || low ? meterTone : textPrimary.color, fontSize: compact ? 11 : 12, fontVariantNumeric: 'tabular-nums' },
            children: remaining == null ? 'Unavailable' : `${remaining}% left`
          })
        ]
      }),
      jsx('div', {
        role: 'progressbar',
        'aria-label': `${cleanWindowLabel(window)} remaining`,
        'aria-valuemin': 0,
        'aria-valuemax': 100,
        'aria-valuenow': remaining == null ? undefined : remaining,
        style: { height: 4, borderRadius: 2, overflow: 'hidden', background: 'var(--ui-bg-quaternary)' },
        children: jsx('div', {
          style: {
            width: progressWidth(window),
            height: '100%',
            borderRadius: 2,
            background: meterTone,
            transition: 'width 180ms ease-out'
          }
        })
      }),
      jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.4 }, children: windowMeta(window) })
    ]
  })
}

function BalanceMetric({ balance, prominent = false, subdued = false }) {
  const total = Number(balance?.total)
  const used = Number(balance?.used)
  const granted = Number(balance?.granted)
  const toppedUp = Number(balance?.topped_up)
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
    style: { display: 'grid', gap: 2, padding: prominent ? '3px 0' : '7px 0' },
    children: [
      jsx('span', { style: { ...(subdued ? textQuaternary : textTertiary), fontSize: 10, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: balance?.label || 'Balance' }),
      jsx('strong', {
        style: { ...(subdued ? textTertiary : textPrimary), fontSize: prominent ? 26 : subdued ? 11 : 14, fontWeight: subdued ? 500 : 650, lineHeight: 1.25, fontVariantNumeric: 'tabular-nums' },
        children: money(balance)
      }),
      details.length > 0
        ? jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: details.join(' • ') })
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
    if (hasBalances && /^(?:[A-Z]{3} )?balance:|^credits (?:remaining|balance):/i.test(text)) return false
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
        style: { display: 'grid', gridTemplateColumns: windows.length > 1 ? 'repeat(auto-fit, minmax(145px, 1fr))' : '1fr', columnGap: 18, rowGap: 1 },
        children: windows.map(window => jsx(UsageMeter, { window, compact: true }, `${rowId}-${limit?.id}-${window?.label}`))
      })
    ]
  })
}

function PricingAndDemand({ row, always = false }) {
  const pricing = Array.isArray(row?.pricing) ? row.pricing : []
  const demand = Array.isArray(row?.demand) ? row.demand : []
  const entries = [...pricing, ...demand]
  if (!always && entries.length === 0) return null
  return jsxs('div', {
    style: { display: 'grid', gap: 5, paddingTop: 10, borderTop: HAIRLINE },
    children: [
      jsx(SectionLabel, { children: 'Pricing & demand' }),
      entries.length > 0
        ? entries.map((entry, index) =>
            jsxs('div', {
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, ...textQuaternary, fontSize: 10, lineHeight: 1.45 },
              children: [
                jsx('span', { children: entry?.label || 'Rate' }),
                jsx('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, children: entry?.value || entry?.detail || 'Unavailable' })
              ]
            }, `pricing-${index}`)
          )
        : jsx('span', {
            style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 },
            children: 'This provider does not expose token pricing, dynamic rates, or peak-demand data through its account endpoint.'
          })
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
  const resetCredits = row?.reset_credits
  const creditStatus = row?.credit_status
  const spendControl = row?.spend_control
  const localMessages = messageRange(creditStatus?.approx_local_messages)
  const cloudMessages = messageRange(creditStatus?.approx_cloud_messages)
  const facts = [
    renewalAt
      ? `Subscription renews ${new Date(renewalAt).toLocaleString()}`
      : complete && row?.plan ? 'Subscription renewal date is not exposed by this provider.' : null,
    resetCredits
      ? `Banked resets: ${resetCredits.available ?? 0} total (${resetCredits.applicable ?? 0} applicable now)`
      : null,
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
        jsx(PricingAndDemand, { row, always: complete })
      ]
    })
  }
  return jsxs('div', {
    style: { display: 'grid', gap: 10 },
    children: [
      limits.length > 0 ? jsx(SectionLabel, { aside: `${limits.length} ${limits.length === 1 ? 'limit group' : 'limit groups'}`, children: 'Limits' }) : null,
      limits.map((limit, index) => jsx(LimitGroup, { rowId: row.id, limit, grouped: index > 0 }, `${row.id}-${limit.id}`)),
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
      jsx(PricingAndDemand, { row, always: complete })
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
                  })
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
          jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: fundingDetail })
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
    style: { borderBottom: HAIRLINE },
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
          padding: '11px 0',
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
                    jsx('span', { style: { ...textPrimary, fontSize: 12, fontWeight: 550, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: row.label })
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
        ? jsx('div', { style: { padding: '0 24px 13px 13px' }, children: jsx(AllProviderMetrics, { row }) })
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

function openOverview(ctx, fetchProfile, initialProvider, sourceId) {
  // Scope the open-time provider hint to the source the pane will actually
  // query (the active account), so it never leaks across a switch.
  const memoKey = sourceId || profileScope(fetchProfile)
  if (initialProvider) rememberProvider(memoKey, initialProvider)
  if (typeof host.openWorkspace === 'function') {
    host.openWorkspace('provider-usage-overview', {
      title: 'Provider usage',
      minWidth: 400,
      render: () => jsx(ProviderUsagePane, { ctx })
    })
    return
  }
  host.notify({ kind: 'info', message: 'Provider usage is available in the Provider Usage pane.' })
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

  // Divergence fails closed: never fetch or probe for a foreign account.
  if (scope.diverged) {
    return jsx(GatedUsageChip, { focusProfile: scope.focusProfile })
  }
  return jsx(ActiveUsageChipBody, { ctx, model, sessionId, gateway, scope })
}

function GatedUsageChip({ focusProfile }) {
  const description = `The focused chat is in ${focusProfile}. Switch the active profile to ${focusProfile} to view its provider usage.`
  return jsx(Tip, {
    label: description,
    children: jsx(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'micro',
      'aria-label': description,
      onClick: () => {
        haptic('tap')
        host.notify({ kind: 'info', message: `Provider usage follows the active profile. Switch to ${focusProfile} to see its usage.` })
      },
      style: { maxWidth: 230 },
      children: [jsx(icons.Activity, { 'aria-hidden': true }, 'icon'), jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `Usage on ${focusProfile}` }, 'label')]
    })
  })
}

function ActiveUsageChipBody({ ctx, model, sessionId, gateway, scope }) {
  const ready = gatewayReady(gateway)
  const provider = useActiveProvider(sessionId, '', scope.fetchProfile, scope.ownerConnection, scope.sourceId)
  const query = useOverview(ctx, provider, model, scope.fetchProfile, gateway, scope.sourceId)
  const row = activeRow(query.data, provider)
  const state = fundingState(row, model)
  const switching = useSwitchingOverride(scope.fetchProfile, ready)
  // The active profile's socket 404s /overview AND we have no rows: the backend
  // isn't enabled/installed for this profile. Make that explicit on the toolbar
  // too (not just the pane) — the iconography stays a warning, never a guess.
  const backendGone = ready && Boolean(query.isError) && !row && isBackendNotEnabled(query.error)
  const refetchError = Boolean(query.isError) && Boolean(row)
  const label = row ? compactProviderLabel(row) : 'Usage'

  let summary = 'unavailable'
  if (switching) summary = 'switching'
  else if (backendGone) summary = `not enabled in ${scope.fetchProfile}`
  else if (row) summary = statusFundingSummary(row, model)
  else if (ready) summary = query.isLoading ? 'checking' : 'unavailable'
  if (refetchError) summary = `${summary} · not refreshed`

  const description = chipDescription(row, model, query.data, switching, ready, refetchError, scope, backendGone)
  const Icon = state.kind === 'balance' ? icons.CreditCard : icons.Activity

  return jsx(Tip, {
    label: description,
    children: jsxs(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'micro',
      'aria-label': description,
      onClick: () => {
        haptic('tap')
        openOverview(ctx, scope.fetchProfile, provider || row?.id, scope.sourceId)
      },
      style: { maxWidth: 230, fontVariantNumeric: 'tabular-nums' },
      children: [
        jsx(Icon, { 'aria-hidden': true }, 'icon'),
        jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `${label} · ${summary}` }, 'label')
      ]
    })
  })
}

function ProviderUsagePane({ ctx, initialProvider = '' }) {
  const model = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const activeProfile = useValue(host.state.profile)
  const activeConnectionId = host.state.connectionId !== undefined ? useValue(host.state.connectionId) : ''
  const hasFocusedOwner = host.state.focusedSessionOwner !== undefined
  const focusedOwner = hasFocusedOwner ? useValue(host.state.focusedSessionOwner) : null
  const focusedProfile = host.state.focusedSessionProfile !== undefined ? useValue(host.state.focusedSessionProfile) : ''
  const gateway = useValue(host.state.gateway)
  const scope = resolveUsageScope({ focusedOwner, hasFocusedOwner, focusedProfile, activeConnectionId, activeProfile })

  // Divergence fails closed: the focused chat is owned by another source than
  // the active socket ctx.rest can reach, so we neither fetch nor probe — we
  // gate and tell the user to switch.
  if (scope.diverged) {
    return jsx(GatedUsagePane, { scope })
  }
  return jsx(ProviderUsagePaneBody, { ctx, initialProvider, model, sessionId, gateway, scope })
}

function GatedUsagePane({ scope }) {
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
      jsx('strong', { style: { ...textSecondary, fontSize: 13, fontWeight: 600 }, children: `The focused chat is in ${scope.focusProfile}` }),
      jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5, maxWidth: 340 }, children: `Provider usage follows the active profile's socket. Switch to ${scope.focusProfile} to view its provider usage here.` })
    ]
  })
  return jsxs('div', { style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 }, children: [header, body] })
}

function ProviderUsagePaneBody({ ctx, initialProvider, model, sessionId, gateway, scope }) {
  const ready = gatewayReady(gateway)
  const switching = useSwitchingOverride(scope.fetchProfile, ready)
  const provider = useActiveProvider(sessionId, initialProvider, scope.fetchProfile, scope.ownerConnection, scope.sourceId)
  const query = useOverview(ctx, provider, model, scope.fetchProfile, gateway, scope.sourceId)
  const rawRows = Array.isArray(query.data?.providers) ? query.data.providers : []
  const rows = mergeOpenCodeRows(rawRows, provider)
  const selected = activeRow({ ...query.data, providers: rows }, provider)
  const activeId = selected?.id || normaliseProvider(query.data?.active?.provider)
  const available = rows.filter(row => row.available && row.id !== activeId)
  const limited = rows.filter(row => !row.available && row.id !== activeId)
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
              ? available.map(row => jsx(ProviderDisclosure, { row }, row.id))
              : jsx('div', { style: { ...textTertiary, fontSize: 11, padding: '10px 0' }, children: 'No other providers are reporting usage.' }, 'empty-accounts'),
            jsx(LimitedProviders, { rows: limited }, 'limited'),
            jsx('footer', {
              style: { ...textQuaternary, fontSize: 9, lineHeight: 1.45, paddingTop: 14 },
              children: `Credentials stay in Hermes. This pane receives balances, percentages, plan names, and reset times only.`
            }, 'footer')
          ]
        }, 'accounts')
      ]
    })
  }

  return jsxs('div', {
    style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 },
    children: [header, body]
  })
}

export { activeSourceId, compactFundingSummary, eventOwns, fundingState, governingWindows, isBackendNotEnabled, mergeOpenCodeRows, profileScope, providerFromPayload, providerScopeKey, providerUsageQueryKey, rememberProvider, rememberedProvider, resolveUsageScope, shouldEnterProfileSwitch, shouldSettleProfileSwitch, statusFundingSummary }

export default {
  id: 'provider-usage',
  name: 'Provider Usage',
  defaultEnabled: true,
  register(ctx) {
    ctx.register({
      id: 'overview-pane',
      area: 'panes',
      title: 'Provider usage',
      order: 120,
      data: { placement: 'right', width: '420px' },
      render: () => jsx(ProviderUsagePane, { ctx })
    })
    ctx.register({
      id: 'active-chip',
      area: 'statusBar.right',
      order: 125,
      render: () => jsx(ActiveUsageChip, { ctx })
    })
  }
}
