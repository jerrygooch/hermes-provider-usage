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
import { useEffect, useState } from 'react'

const REFRESH_MS = 60_000
const HAIRLINE = '1px solid var(--ui-stroke-tertiary)'
const textPrimary = { color: 'var(--ui-text-primary)' }
const textSecondary = { color: 'var(--ui-text-secondary)' }
const textTertiary = { color: 'var(--ui-text-tertiary)' }
const textQuaternary = { color: 'var(--ui-text-quaternary)' }
let lastFocusedProvider = ''

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

function payloadFromResponse(response) {
  return response?.payload || response?.result?.payload || response?.result || response?.data || response || {}
}

function useActiveProvider(sessionId, initialProvider = '') {
  const [provider, setProvider] = useState(() => lastFocusedProvider || normaliseProvider(initialProvider))

  useEffect(() => {
    let alive = true
    const accept = payload => {
      const statusMatch = typeof payload?.output === 'string'
        ? payload.output.match(/^Model:\s+.*\(([^()]*)\)\s*$/m)
        : null
      const value = payload?.provider || payload?.info?.provider || statusMatch?.[1]
      if (typeof value === 'string' && value.trim() && alive) {
        lastFocusedProvider = normaliseProvider(value)
        setProvider(lastFocusedProvider)
      }
    }

    const dispose = host.onEvent('session.info', event => {
      const payload = event?.payload || {}
      const eventSession = event?.session_id || payload?.session_id
      if (sessionId && eventSession && eventSession !== sessionId) return
      accept(payload)
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
  }, [sessionId])

  return provider
}

function useOverview(ctx, provider, model) {
  return useQuery({
    queryKey: ['provider-usage', 'overview', provider || '', model || ''],
    queryFn: () =>
      ctx.rest('/overview', {
        method: 'POST',
        body: { active_provider: provider || null, active_model: model || null },
        timeoutMs: 25_000
      }),
    staleTime: 15_000,
    refetchInterval: REFRESH_MS,
    retry: 1
  })
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
    const primaryWindows = state.windows.filter(window => {
      const label = shortWindowLabel(window)
      return label === '5h' || label === 'wk'
    })
    if (primaryWindows.length > 0) {
      return primaryWindows
        .map(window => `${shortWindowLabel(window)} ${round(window.remaining_percent)}%`)
        .join(' · ')
    }
  }
  return compactFundingSummary(row, model)
}

function chipDescription(row, model, data) {
  const updated = data?.fetched_at ? new Date(data.fetched_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }) : 'not yet'
  if (!row) return `Provider usage. Last updated ${updated}.`
  const modelName = model ? ` Active model ${model}.` : ''
  return `${row.label}: ${statusFundingSummary(row, model)}.${modelName} Open the Provider Usage pane for every reported window. Updated ${updated}.`
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
        children: windows.map(window => jsx(UsageMeter, { key: `${rowId}-${limit?.id}-${window?.label}`, window, compact: true }))
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
              key: `pricing-${index}`,
              style: { display: 'flex', justifyContent: 'space-between', gap: 12, ...textQuaternary, fontSize: 10, lineHeight: 1.45 },
              children: [
                jsx('span', { children: entry?.label || 'Rate' }),
                jsx('span', { style: { textAlign: 'right', fontVariantNumeric: 'tabular-nums' }, children: entry?.value || entry?.detail || 'Unavailable' })
              ]
            })
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
          key: `${entry?.model}-${index}`,
          style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12, fontSize: 10, lineHeight: 1.45 },
          children: [
            jsx('span', { style: { ...textSecondary, fontWeight: 500 }, children: entry?.model || 'Model' }),
            jsx('span', { style: { ...textQuaternary, textAlign: 'right' }, children: status })
          ]
        })
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
            key: `${row.id}-${product.id}`,
            style: { display: 'grid', gap: 8, paddingTop: index > 0 ? 11 : 0, borderTop: index > 0 ? HAIRLINE : 'none' },
            children: [
              jsx(SectionLabel, { aside: product.kind === 'subscription' ? 'Subscription' : 'API credits', children: product.label }),
              product.available
                ? jsx(AllProviderMetrics, { row: { ...product, id: `${row.id}-${product.id}`, products: [] } })
                : jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.45 }, children: product.unavailable_reason || 'This product does not expose usage data.' })
            ]
          })
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
      limits.map((limit, index) => jsx(LimitGroup, { key: `${row.id}-${limit.id}`, rowId: row.id, limit, grouped: index > 0 })),
      balances.length > 0
        ? jsxs('div', {
            style: { display: 'grid', gap: 4, paddingTop: limits.length > 0 ? 10 : 0, borderTop: limits.length > 0 ? HAIRLINE : 'none' },
            children: [
              jsx(SectionLabel, { children: row?.id === 'openai-codex' ? 'Paid fallback' : 'Balance' }),
              jsx('div', {
                style: { display: 'grid', gridTemplateColumns: balances.length > 1 ? 'repeat(auto-fit, minmax(130px, 1fr))' : '1fr', gap: 12 },
                children: balances.map(balance => jsx(BalanceMetric, { key: `${balance.label}-${balance.currency}`, balance, subdued: row?.id === 'openai-codex' }))
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
          children: [jsx(open ? icons.ChevronDown : icons.ChevronRight, { 'aria-hidden': true, style: { width: 13, height: 13 } }), `Limited data (${rows.length})`]
        })
      }),
      open
        ? jsx('div', {
            style: { display: 'grid', gap: 10, padding: '5px 0 12px 20px' },
            children: rows.map(row =>
              jsxs('div', {
                key: row.id,
                style: { display: 'grid', gap: 2 },
                children: [
                  jsx('span', { style: { ...textSecondary, fontSize: 11, fontWeight: 500 }, children: row.label }),
                  jsx('span', { style: { ...textQuaternary, fontSize: 10, lineHeight: 1.4 }, children: row.unavailable_reason || 'This provider does not expose usage or balance data.' })
                ]
              })
            )
          })
        : null
    ]
  })
}

function openOverview(ctx, initialProvider) {
  if (typeof host.openWorkspace === 'function') {
    host.openWorkspace('provider-usage-overview', {
      title: 'Provider usage',
      minWidth: 400,
      render: () => jsx(ProviderUsagePane, { ctx, initialProvider })
    })
    return
  }
  host.notify({ kind: 'info', message: 'Provider usage is available in the Provider Usage pane.' })
}

function ActiveUsageChip({ ctx }) {
  const model = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const provider = useActiveProvider(sessionId)
  const query = useOverview(ctx, provider, model)
  const row = activeRow(query.data, provider)
  const state = fundingState(row, model)
  const label = row ? compactProviderLabel(row) : 'Usage'
  const summary = query.isLoading && !row ? 'checking' : row ? statusFundingSummary(row, model) : 'unavailable'
  const Icon = state.kind === 'balance' ? icons.CreditCard : icons.Activity

  return jsx(Tip, {
    label: chipDescription(row, model, query.data),
    children: jsxs(Button, {
      type: 'button',
      variant: 'ghost',
      size: 'micro',
      'aria-label': chipDescription(row, model, query.data),
      onClick: () => {
        haptic('tap')
        openOverview(ctx, provider || row?.id)
      },
      style: { maxWidth: 230, fontVariantNumeric: 'tabular-nums' },
      children: [
        jsx(Icon, { 'aria-hidden': true }),
        jsx('span', { style: { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }, children: `${label} · ${summary}` })
      ]
    })
  })
}

function ProviderUsagePane({ ctx, initialProvider = '' }) {
  const model = useValue(host.state.model)
  const sessionId = useValue(host.state.focusedSessionId)
  const provider = useActiveProvider(sessionId, initialProvider)
  const query = useOverview(ctx, provider, model)
  const rawRows = Array.isArray(query.data?.providers) ? query.data.providers : []
  const rows = mergeOpenCodeRows(rawRows, provider)
  const selected = activeRow({ ...query.data, providers: rows }, provider)
  const activeId = selected?.id || normaliseProvider(query.data?.active?.provider)
  const available = rows.filter(row => row.available && row.id !== activeId)
  const limited = rows.filter(row => !row.available && row.id !== activeId)

  return jsxs('div', {
    style: { height: '100%', minWidth: 0, overflow: 'hidden', color: 'var(--ui-text-primary)', fontSize: 12 },
    children: [
      jsxs('header', {
        style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '13px 18px', borderBottom: HAIRLINE },
        children: [
          jsxs('div', {
            style: { minWidth: 0, display: 'grid', gap: 2 },
            children: [
              jsx('h1', { style: { ...textPrimary, margin: 0, fontSize: 13, lineHeight: 1.35, fontWeight: 650 }, children: 'Provider usage' }),
              jsx('span', { style: { ...textQuaternary, fontSize: 10 }, children: formatUpdated(query.data?.fetched_at) })
            ]
          }),
          jsx(Tip, {
            label: query.isFetching ? 'Refreshing provider usage' : 'Refresh provider usage',
            children: jsx(Button, {
              type: 'button',
              variant: 'ghost',
              size: 'icon-xs',
              disabled: query.isFetching,
              'aria-label': 'Refresh provider usage',
              onClick: () => {
                haptic('tap')
                void query.refetch()
              },
              children: jsx(icons.RefreshCw, { 'aria-hidden': true })
            })
          })
        ]
      }),
      query.isLoading && rows.length === 0
        ? jsx('div', { style: { height: 'calc(100% - 58px)', display: 'grid', placeItems: 'center' }, children: jsx(Loader, { type: 'lemniscate-bloom', label: 'Checking provider accounts', style: { width: 58 } }) })
        : query.isError && rows.length === 0
          ? jsxs('div', {
              style: { padding: 24, display: 'grid', placeItems: 'center', textAlign: 'center', gap: 12 },
              children: [
                jsx(icons.AlertCircle, { 'aria-hidden': true, style: { width: 22, height: 22, color: 'var(--ui-text-tertiary)' } }),
                jsx('strong', { children: 'Provider data could not be loaded' }),
                jsx('span', { style: { ...textTertiary, fontSize: 11, lineHeight: 1.5 }, children: 'The Hermes backend may need to reload this plugin.' }),
                jsx(Button, { type: 'button', variant: 'secondary', size: 'xs', onClick: () => void query.refetch(), children: 'Try again' })
              ]
            })
          : jsxs('div', {
              style: { height: 'calc(100% - 58px)', overflowY: 'auto', overflowX: 'hidden' },
              children: [
                selected ? jsx(ActiveProvider, { row: selected, model }) : null,
                jsxs('section', {
                  'aria-labelledby': 'provider-usage-accounts-heading',
                  style: { padding: '15px 18px 18px' },
                  children: [
                    jsxs('div', {
                      style: { display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 10, paddingBottom: 6 },
                      children: [
                        jsx('h2', { id: 'provider-usage-accounts-heading', style: { ...textPrimary, margin: 0, fontSize: 11, lineHeight: 1.4, fontWeight: 650, textTransform: 'uppercase', letterSpacing: '0.06em' }, children: 'Other providers' }),
                        jsx('span', { style: { ...textQuaternary, fontSize: 10 }, children: `${available.length} reporting` })
                      ]
                    }),
                    available.length > 0
                      ? available.map(row => jsx(ProviderDisclosure, { key: row.id, row }))
                      : jsx('div', { style: { ...textTertiary, fontSize: 11, padding: '10px 0' }, children: 'No other providers are reporting usage.' }),
                    jsx(LimitedProviders, { rows: limited }),
                    jsx('footer', {
                      style: { ...textQuaternary, fontSize: 9, lineHeight: 1.45, paddingTop: 14 },
                      children: 'Credentials stay in Hermes. This pane receives balances, percentages, plan names, and reset times only.'
                    })
                  ]
                })
              ]
            })
    ]
  })
}

export { compactFundingSummary, fundingState, governingWindows, mergeOpenCodeRows, statusFundingSummary }

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
