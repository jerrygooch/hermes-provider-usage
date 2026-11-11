/**
 * Running-agents footer suite (pure logic + SSR + mounted component harness).
 *
 * What this proves — and what it does NOT:
 *  1. Pure: the identity/grouping/usage rules fed by the gateway's
 *     `subagent.list` payload. A provider is only what the row publishes; a
 *     model slug never proves a provider, and a cached pool figure is attached
 *     only when the row's stable account id matches this profile's inventory
 *     account exactly.
 *  2. SSR: the shipped `RunningAgentsSection` renders real markup for the
 *     grouped rows (the real React server renderer from this repo).
 *  3. Mounted (jsdom + react-dom): the shipped `RunningAgentsFooter` issues ONE
 *     `subagent.list` read for the whole footer on the focused session, clears
 *     on a session switch, drops a late reply for the previous session, hides
 *     on error/inactive/non-ready sockets, and reflects a completion on the
 *     next snapshot.
 *
 * It is a COMPONENT harness with a controlled SDK double: not a live desktop,
 * and not proof that the installed backend publishes account identity (the
 * core seam exists, but the plugin backend must still put accounts on its
 * cached rows; see docs/running-agents-footer.md).
 */
import fs from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { fileURLToPath } from 'node:url'

const pluginPath = fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const source = fs.readFileSync(pluginPath, 'utf8')

let failures = 0
const check = (name, condition, detail = '') => {
  if (condition) console.log(`AGENTS PASS ${name}`)
  else { failures += 1; console.error(`AGENTS FAIL ${name}${detail ? `: ${detail}` : ''}`) }
}

// ── 1. Pure module (no DOM): load with a minimal controllable SDK ────────────
const context = vm.createContext({ console })
const reactShim = await import('react')
const ReactServer = reactShim.default
const { renderToStaticMarkup } = await import('react-dom/server')
const jsxRuntime = (await import('react/jsx-runtime')).default ?? (await import('react/jsx-runtime'))
const Base = ({ children, ...rest }) => ReactServer.createElement('span', rest, children)
const pureSdk = {
  Badge: Base, Button: Base, Loader: Base, RowButton: Base, StatusDot: Base, Tip: Base,
  Popover: Base, PopoverContent: Base, PopoverTrigger: Base,
  host: { state: {}, request: async () => ({}), onEvent: () => () => {}, notify: () => {} },
  haptic: () => {},
  icons: new Proxy({}, { get: () => Base }),
  useQuery: () => ({ data: null, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }),
  useValue: atom => (atom && typeof atom.get === 'function' ? atom.get() : atom ?? null),
  ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar-nav', PALETTE_AREA: 'palette'
}
function synthetic(identifier, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context, identifier })
}
const pureDeps = new Map([
  ['@hermes/plugin-sdk', synthetic('@hermes/plugin-sdk', pureSdk)],
  ['react', synthetic('react', { useEffect: reactShim.useEffect, useState: reactShim.useState, useRef: reactShim.useRef })],
  ['react/jsx-runtime', synthetic('react/jsx-runtime', { jsx: jsxRuntime.jsx, jsxs: jsxRuntime.jsxs })]
])
const pureMod = new vm.SourceTextModule(source, { context, identifier: pluginPath })
await pureMod.link(spec => {
  const dep = pureDeps.get(spec)
  if (!dep) throw new Error(`Unexpected import: ${spec}`)
  return dep
})
await pureMod.evaluate()
const ns = pureMod.namespace

const ACCOUNT_XAI = 'fp:1111111111111111'
const ACCOUNT_DS = 'fp:2222222222222222'
const ACCOUNT_OR = 'fp:3333333333333333'
const providers = [
  { id: 'xai-oauth', label: 'SuperGrok / xAI OAuth', available: true, capability: 'usage', accounts: [{ id: ACCOUNT_XAI, label: 'Work Grok' }], limits: [{ id: 'default', label: 'SuperGrok', windows: [{ label: 'Subscription window', kind: 'subscription', remaining_percent: 62 }] }], balances: [] },
  { id: 'deepseek', label: 'DeepSeek', available: true, capability: 'balance', accounts: [{ identity_id: ACCOUNT_DS, label: 'DeepSeek main' }], limits: [], balances: [{ amount: 5.31, unit: 'currency', currency: 'USD' }] },
  { id: 'openrouter', label: 'OpenRouter', available: true, capability: 'balance', accounts: [{ identity_id: ACCOUNT_OR, label: 'OpenRouter key' }], limits: [], balances: [{ amount: 12.5, unit: 'currency', currency: 'USD' }] }
]
const providersWithoutAccounts = providers.map(({ accounts, ...row }) => row)

const agent = (over = {}) => ({
  subagent_id: over.subagent_id || `sa-${Math.random().toString(36).slice(2, 8)}`,
  goal: over.goal ?? 'do the thing',
  model: over.model ?? 'grok-4',
  status: over.status ?? 'running',
  depth: over.depth ?? 1,
  started_at: over.started_at ?? 1,
  ...over
})

// ── 1a. normaliseRunningAgents ──────────────────────────────────────────────
{
  const payload = { subagents: [
    agent({ subagent_id: 'a', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI }),
    agent({ subagent_id: 'b' })
  ] }
  const rows = ns.normaliseRunningAgents(payload, 'sess-A')
  check('normalise: keeps live rows', rows.length === 2 && rows[0].id === 'a', JSON.stringify(rows))
  check('normalise: carries the published account identity', rows[0].providerAccountId === ACCOUNT_XAI, JSON.stringify(rows[0]))

  const terminal = ns.normaliseRunningAgents({ subagents: [
    agent({ subagent_id: 'done', status: 'completed' }),
    agent({ subagent_id: 'bad', status: 'failed' }),
    agent({ subagent_id: 'stop', status: 'interrupted' }),
    agent({ subagent_id: 'live', status: 'running' })
  ] }, 'sess-A')
  check('normalise: terminal children are not running agents', terminal.length === 1 && terminal[0].id === 'live', JSON.stringify(terminal))

  check('normalise: a payload bound to another session is rejected', ns.normaliseRunningAgents({ session_id: 'sess-B', subagents: [agent()] }, 'sess-A').length === 0)
  check('normalise: an unbound payload is accepted for the requested session', ns.normaliseRunningAgents({ subagents: [agent()] }, 'sess-A').length === 1)
  check('normalise: junk payloads degrade to no rows', ns.normaliseRunningAgents(null, 'sess-A').length === 0 && ns.normaliseRunningAgents({ subagents: 'x' }, 'sess-A').length === 0)
  check('normalise: a row without an id is dropped', ns.normaliseRunningAgents({ subagents: [{ model: 'x' }] }, 'sess-A').length === 0)
  check('normalise: a duplicated child id is counted once', ns.normaliseRunningAgents({ subagents: [
    agent({ subagent_id: 'dup' }), agent({ subagent_id: 'dup' })
  ] }, 'sess-A').length === 1)
}

{
  const base = ns.runningAgentsQueryKey('local::default', 'sess-A')
  check('key: the same session on another profile is another cache', JSON.stringify(base) !== JSON.stringify(ns.runningAgentsQueryKey('local::Alice', 'sess-A')), JSON.stringify(base))
  check('key: the same profile on another connection is another cache', JSON.stringify(base) !== JSON.stringify(ns.runningAgentsQueryKey('remote-x::default', 'sess-A')), JSON.stringify(base))
  check('key: the same source on another session is another cache', JSON.stringify(base) !== JSON.stringify(ns.runningAgentsQueryKey('local::default', 'sess-B')), JSON.stringify(base))
}

// ── 1b. Provider / account verification + grouping ─────────────────────────
{
  const rows = [
    { id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI, goal: 'one' },
    { id: 'b', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI, goal: 'two' },
    { id: 'c', model: 'deepseek-chat', provider: 'deepseek', providerAccountId: ACCOUNT_DS, goal: 'three' }
  ]
  const groups = ns.runningAgentGroups(rows, { providerRows: providers })
  check('group: same provider+model+account collapses into one group', groups.length === 2, JSON.stringify(groups.map(g => g.key)))
  const xai = groups.find(g => g.provider === 'xai-oauth')
  check('group: shared pool count is the agent count', xai.count === 2, JSON.stringify(xai))
  check('group: account identity is verified against the inventory row', xai.accountVerified === true, JSON.stringify(xai))
  check('group: usage is the cached shared pool for that account', xai.usage === '62% left', String(xai.usage))
  check('group: provider label comes from the account inventory', xai.providerLabel === 'SuperGrok / xAI OAuth', xai.providerLabel)
  check('group: account label is retained for the row', xai.accountLabel === 'Work Grok', xai.accountLabel)
  const ds = groups.find(g => g.provider === 'deepseek')
  check('group: a balance pool renders the credit balance', ds.usage === '$5.31', String(ds.usage))
  check('group: goals are retained for the row tooltip', xai.goals.length === 2, JSON.stringify(xai.goals))
  check('account: exact match returns the inventory account', ns.runningAgentAccount({ providerAccountId: ACCOUNT_XAI }, providers[0])?.id === ACCOUNT_XAI)
  check('account: no published id returns null', ns.runningAgentAccount({}, providers[0]) === null)
  check('account: another credential never matches', ns.runningAgentAccount({ providerAccountId: ACCOUNT_DS }, providers[0]) === null)
}

{
  // A provider-qualified model slug is a model namespace, not a route.
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'openrouter/anthropic/claude-sonnet-4' }],
    { providerRows: providers }
  )
  check('slug: a provider-qualified model does not verify a provider', groups[0].provider === '', JSON.stringify(groups[0]))
  check('slug: no shared pool is borrowed from the slug prefix', groups[0].usage === null, JSON.stringify(groups[0]))
}

{
  // The real installed backend publishes a provider but no account identity yet.
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth' }],
    { providerRows: providers }
  )
  check('account: a published provider without account identity is shown', groups[0].provider === 'xai-oauth', JSON.stringify(groups[0]))
  check('account: no account identity means usage unavailable', groups[0].usage === null && groups[0].accountVerified === false, JSON.stringify(groups[0]))
}

{
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_DS }],
    { providerRows: providers }
  )
  check('account: a mismatched credential never borrows the row figure', groups[0].usage === null, JSON.stringify(groups[0]))
  check('account: mismatch is not marked verified', groups[0].accountVerified === false, JSON.stringify(groups[0]))
}

{
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI }],
    { providerRows: providersWithoutAccounts }
  )
  check('account: an inventory row without identities cannot prove the pool', groups[0].usage === null, JSON.stringify(groups[0]))
  check('account: provider is still shown when inventory has no identity', groups[0].provider === 'xai-oauth', JSON.stringify(groups[0]))
}

{
  const ambiguous = [{ id: 'xai-oauth', label: 'Two accounts', available: true, capability: 'usage', accounts: [{ id: ACCOUNT_XAI }, { id: ACCOUNT_DS }], limits: [{ id: 'default', label: 'Pool', windows: [{ label: 'Window', remaining_percent: 62 }] }], balances: [] }]
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI }],
    { providerRows: ambiguous }
  )
  check('account: a multi-account row is ambiguous and attaches no figure', groups[0].usage === null, JSON.stringify(groups[0]))
}

{
  // A published provider that is not in this profile's inventory is still the
  // child's real provider; it just cannot name a pool on this profile.
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'mystery-1', provider: 'not-a-provider', providerAccountId: 'fp:unknown' }],
    { providerRows: providers }
  )
  check('unknown: a real published provider is not discarded', groups[0].provider === 'not-a-provider', JSON.stringify(groups[0]))
  check('unknown: an unknown provider attaches no pool', groups[0].usage === null, JSON.stringify(groups[0]))
}

{
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI }],
    { providerRows: [{ id: 'xai-oauth', label: 'SuperGrok', available: true, capability: 'usage', accounts: [{ id: ACCOUNT_XAI }], limits: [], balances: [], details: ['No windows published.'] }] }
  )
  check('unknown: a provider row with no figures stays unknown', groups[0].usage === null, JSON.stringify(groups[0]))
}

{
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'm', provider: 'deepseek', providerAccountId: ACCOUNT_DS }],
    { providerRows: [{ id: 'deepseek', label: 'DeepSeek', available: true, capability: 'balance', accounts: [{ identity_id: ACCOUNT_DS }], limits: [], balances: [{ amount: 5.31 }] }] }
  )
  check('unknown: a currency-less balance is never printed as dollars', groups[0].usage === '5.31 (currency not reported)', String(groups[0].usage))
}

{
  const groups = ns.runningAgentGroups([
    { id: 'a', model: '', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI },
    { id: 'b', model: '', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI }
  ], { providerRows: providers })
  check('unknown: a missing model still groups and is never invented', groups.length === 1 && groups[0].model === '' && groups[0].count === 2, JSON.stringify(groups))
  check('unknown: a verified account pool can still be shown without a model', groups[0].usage === '62% left', String(groups[0].usage))
}

{
  const groups = ns.runningAgentGroups([
    { id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI },
    { id: 'b', model: 'grok-4', provider: 'deepseek', providerAccountId: ACCOUNT_DS }
  ], { providerRows: providers })
  check('group: different providers never merge', groups.length === 2 && groups.every(g => g.count === 1), JSON.stringify(groups))
}

{
  const groups = ns.runningAgentGroups([
    { id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI },
    { id: 'b', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_DS }
  ], { providerRows: [{ id: 'xai-oauth', label: 'SuperGrok', available: true, accounts: [{ id: ACCOUNT_XAI }, { id: ACCOUNT_DS }], limits: [{ id: 'default', label: 'Pool', windows: [{ label: 'Window', remaining_percent: 62 }] }], balances: [] }] })
  check('group: different credentials on one provider stay separate', groups.length === 2 && groups.every(g => g.count === 1), JSON.stringify(groups))
  check('group: neither ambiguous credential borrows a pool figure', groups.every(g => g.usage === null), JSON.stringify(groups))
}

// ── 1c. SSR of the shipped section ──────────────────────────────────────────
const renderSection = groups => renderToStaticMarkup(
  jsxRuntime.jsx('div', { children: jsxRuntime.jsx(ns.RunningAgentsSection, { groups }) })
)
{
  const groups = ns.runningAgentGroups([
    { id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI },
    { id: 'b', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI },
    { id: 'c', model: 'mystery-1' }
  ], { providerRows: providers })
  const html = renderSection(groups)
  check('ssr: header names the agent total', html.includes('Running agents') && html.includes('3 agents'), html.slice(0, 400))
  check('ssr: grouped row shows the count and shared pool', html.includes('2×') && html.includes('62% left'), html.slice(0, 600))
  check('ssr: verified account label is shown on the row', html.includes('Work Grok'), html.slice(0, 700))
  check('ssr: unverified child is labelled, not guessed', html.includes('provider not reported') && html.includes('mystery-1'), html.slice(0, 800))
  check('ssr: unknown usage renders a dash, never 0%', html.includes('—') && !html.includes('0%'), html.slice(0, 900))
  check('ssr: the section is labelled for assistive tech', html.includes('aria-label="Running agents: 3"'), html.slice(0, 200))
  check('ssr: no per-agent cost is invented', !/cost|spend|usd per agent/i.test(html), html.slice(0, 900))
}
{
  const html = renderSection([])
  check('ssr: no running agents renders nothing', html === '<div></div>', html)
  const htmlNull = renderSection(null)
  check('ssr: a null group list renders nothing', htmlNull === '<div></div>', htmlNull)
}
{
  const rows = [{ id: 'a', model: 'grok-4', provider: 'xai-oauth', providerAccountId: ACCOUNT_XAI, goal: 'only one' }]
  const html = renderSection(ns.runningAgentGroups(rows, { providerRows: providers }))
  check('ssr: singular count is grammatical', html.includes('1 agent') && !html.includes('1 agents'), html.slice(0, 300))
}
{
  const groups = ns.runningAgentGroups(
    [{ id: 'a', model: 'grok-4', provider: 'xai-oauth' }],
    { providerRows: providers }
  )
  const html = renderSection(groups)
  check('ssr: reported provider without an account shows usage unavailable', html.includes('xai-oauth') && html.includes('—'), html.slice(0, 600))
  check('ssr: unverified account never shows a percentage', !html.includes('62%'), html.slice(0, 600))
}

{
  // Fixture contract: the browser harness fixture publishes the same
  // provider/account shape the backend sends, and demonstrates one verified
  // balance plus one unknown account (no borrowed figure).
  const fixture = JSON.parse(fs.readFileSync(new URL('../harness/fixtures/running-agents.json', import.meta.url), 'utf8'))
  const rows = ns.normaliseRunningAgents(fixture.subagents['sess-harness-1'], 'sess-harness-1')
  const groups = ns.runningAgentGroups(rows, { providerRows: fixture.providers })
  const verifiedBalance = groups.find(group => group.provider === 'deepseek')
  const unknown = groups.find(group => group.provider === 'openai-codex' && !group.accountVerified)
  check('fixture: publishes a verified balance account',
        Boolean(verifiedBalance?.accountVerified) && verifiedBalance?.usage === '$8.72',
        JSON.stringify(groups))
  check('fixture: publishes an unknown account without borrowing a figure',
        Boolean(unknown) && unknown.usage === null && unknown.accountVerified === false,
        JSON.stringify(groups))
}

// ── 2. Mounted component harness (jsdom) ────────────────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const win = dom.window
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'VisualViewport', 'DOMParser', 'Image', 'Option', 'CSS', 'CSSStyleDeclaration']) {
  try { if (win[key] !== undefined) globalThis[key] = win[key] } catch { /* read-only globals */ }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const ReactAct = typeof React.act === 'function' ? React.act : (await import('react-dom/test-utils')).act

async function mountedHarness() {
  const cache = new Map()
  const subscribers = new Map()
  const requests = []
  const queryConfigs = []
  const sdkComponent = ({ children, ...rest }) => React.createElement('span', rest, children)

  function keyOf(key) { return JSON.stringify(key) }
  function notify(key) { for (const fn of [...(subscribers.get(key) || [])]) fn() }

  function useQuery(config) {
    const cacheKey = keyOf(config.queryKey)
    const [, force] = React.useReducer(value => value + 1, 0)
    queryConfigs.push({ key: config.queryKey, enabled: config.enabled, refetchInterval: config.refetchInterval, staleTime: config.staleTime })
    React.useEffect(() => {
      let set = subscribers.get(cacheKey)
      if (!set) { set = new Set(); subscribers.set(cacheKey, set) }
      set.add(force)
      return () => set.delete(force)
    }, [cacheKey])
    React.useEffect(() => {
      if (config.enabled !== true) return undefined
      let alive = true
      const pending = config.queryFn()
      Promise.resolve(pending).then(
        data => { if (alive) { cache.set(cacheKey, { data, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }); notify(cacheKey) } },
        error => { if (alive) { cache.set(cacheKey, { data: cache.get(cacheKey)?.data, isLoading: false, isError: true, isFetching: false, error, refetch: () => {} }); notify(cacheKey) } }
      )
      return () => { alive = false }
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [cacheKey, config.enabled])
    return cache.get(cacheKey) || { data: undefined, isLoading: config.enabled === true, isError: false, isFetching: false, error: null, refetch: () => {} }
  }

  function useValue(atomLike) {
    if (atomLike === undefined || atomLike === null) return null
    if (typeof atomLike.get !== 'function') return atomLike
    return React.useSyncExternalStore(handle => atomLike.subscribe(handle), () => atomLike.get())
  }

  const sdkValues = {
    Badge: sdkComponent, Button: sdkComponent, Loader: sdkComponent, RowButton: sdkComponent,
    StatusDot: sdkComponent, Tip: sdkComponent, Popover: sdkComponent, PopoverContent: sdkComponent, PopoverTrigger: sdkComponent,
    host: {
      state: {
        model: { get: () => 'grok-4' },
        focusedSessionId: { get: () => null },
        profile: { get: () => 'default' },
        connectionId: { get: () => 'local' },
        gateway: { get: () => 'open' }
      },
      // The footer's queryFn goes through host.request; hand back a deferred the
      // test resolves, exactly like the gateway's JSON-RPC reply.
      request: (method, params) => {
        const req = { method, params, resolve: null, reject: null }
        req.promise = new Promise((resolve, reject) => { req.resolve = resolve; req.reject = reject })
        requests.push(req)
        return req.promise
      },
      onEvent: () => () => {},
      notify: () => {}
    },
    haptic: () => {},
    icons: new Proxy({}, { get: () => sdkComponent }),
    useQuery, useValue,
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar-nav', PALETTE_AREA: 'palette'
  }
  const localContext = vm.createContext({ console })
  const localDeps = new Map([
    ['@hermes/plugin-sdk', synthetic2(localContext, '@hermes/plugin-sdk', sdkValues)],
    ['react', synthetic2(localContext, 'react', { useEffect: React.useEffect, useState: React.useState, useRef: React.useRef, useReducer: React.useReducer, useSyncExternalStore: React.useSyncExternalStore })],
    ['react/jsx-runtime', synthetic2(localContext, 'react/jsx-runtime', { jsx: jsxRuntime.jsx, jsxs: jsxRuntime.jsxs })]
  ])
  const mod = new vm.SourceTextModule(source, { context: localContext, identifier: pluginPath })
  await mod.link(spec => {
    const dep = localDeps.get(spec)
    if (!dep) throw new Error(`Unexpected import: ${spec}`)
    return dep
  })
  await mod.evaluate()

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  const inAct = fn => ReactAct(async () => { await fn() })
  const flush = async () => { await inAct(async () => {}); await inAct(async () => {}) }
  const render = async props => { await inAct(async () => { root.render(React.createElement(mod.namespace.RunningAgentsFooter, props)) }); await flush() }
  const text = () => container.textContent
  const unmount = () => { ReactAct(() => { root.unmount() }); document.body.removeChild(container) }
  return {
    mod, requests, queryConfigs, render, text, inAct, flush, unmount,
    setData(key, data) {
      cache.set(keyOf(key), { data, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} })
      ReactAct(() => notify(keyOf(key)))
    }
  }
}

function synthetic2(ctx, identifier, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context: ctx, identifier })
}

const footerProps = (over = {}) => ({
  sessionId: 'sess-A',
  active: true,
  gateway: 'open',
  sourceId: 'local::default',
  providerRows: providers,
  ...over
})

// R1 — one read for the whole footer, on the focused session.
{
  const h = await mountedHarness()
  await h.render(footerProps())
  const list = h.requests.filter(r => r.method === 'subagent.list')
  check('mounted: exactly one subagent.list read for the footer', list.length === 1, JSON.stringify(h.requests.map(r => r.method)))
  check('mounted: the read is scoped to the focused session', list[0].params.session_id === 'sess-A', JSON.stringify(list[0].params))
  const cfg = h.queryConfigs.find(c => Array.isArray(c.key) && c.key[1] === 'running-agents')
  check('mounted: polling is 5s, not per agent', cfg && cfg.refetchInterval === 5000, JSON.stringify(cfg))
  check('mounted: the query key is session + source qualified', JSON.stringify(cfg.key) === JSON.stringify(['provider-usage', 'running-agents', 'local::default', 'sess-A']), JSON.stringify(cfg.key))

  await h.inAct(async () => {
    h.requests.find(r => r.method === 'subagent.list').resolve({ subagents: [
      agent({ subagent_id: 'a', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI, goal: 'fix tests' }),
      agent({ subagent_id: 'b', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI, goal: 'write docs' }),
      agent({ subagent_id: 'c', model: 'mystery-1' })
    ] })
  })
  await h.flush()
  check('mounted: renders the running total', h.text().includes('Running agents') && h.text().includes('3 agents'), h.text())
  check('mounted: groups verified workers on the shared pool', h.text().includes('2×') && h.text().includes('62% left'), h.text())
  check('mounted: verified account label is visible', h.text().includes('Work Grok'), h.text())
  check('mounted: unverified worker stays explicitly unknown', h.text().includes('provider not reported'), h.text())
  check('mounted: no zeroed percentage is fabricated', !h.text().includes('0%'), h.text())

  // Completion: the next snapshot from the same read no longer has 'a'.
  h.setData(['provider-usage', 'running-agents', 'local::default', 'sess-A'], ns.normaliseRunningAgents({ subagents: [
    agent({ subagent_id: 'b', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI, goal: 'write docs' }),
    agent({ subagent_id: 'c', model: 'mystery-1' })
  ] }, 'sess-A'))
  await h.flush()
  check('mounted: a finished worker leaves on the next snapshot', h.text().includes('2 agents') && !h.text().includes('2×'), h.text())
  h.unmount()
}

// R2 — a session switch clears the previous chat's children.
{
  const h = await mountedHarness()
  await h.render(footerProps())
  const first = h.requests.find(r => r.method === 'subagent.list')
  await h.inAct(async () => { first.resolve({ subagents: [agent({ subagent_id: 'a', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI })] }) })
  await h.flush()
  check('switch: session A renders its worker', h.text().includes('1 agent'), h.text())

  // Switch to B; B answers slowly, A answers late.
  await h.render(footerProps({ sessionId: 'sess-B' }))
  const listRequests = h.requests.filter(r => r.method === 'subagent.list')
  check('switch: B issues its own read', listRequests.length === 2 && listRequests[1].params.session_id === 'sess-B', JSON.stringify(listRequests.map(r => r.params)))
  check('switch: A’s worker is cleared while B loads', !h.text().includes('Running agents'), h.text())

  await h.inAct(async () => { first.resolve({ subagents: [agent({ subagent_id: 'z', model: 'late-model', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI })] }) })
  await h.flush()
  check('switch: a late A reply cannot reappear under B', !h.text().includes('late-model') && !h.text().includes('Running agents'), h.text())

  await h.inAct(async () => { listRequests[1].resolve({ subagents: [agent({ subagent_id: 'b1', model: 'deepseek-chat', provider: 'deepseek', provider_account_id: ACCOUNT_DS })] }) })
  await h.flush()
  check('switch: B renders only B’s worker', h.text().includes('1 agent') && h.text().includes('deepseek-chat') && !h.text().includes('grok-4'), h.text())
  h.unmount()
}

// R2b — the same session id on another source (profile/connection) is another
//       roster: the key is source-qualified, so no cross-account leak.
{
  const h = await mountedHarness()
  await h.render(footerProps())
  const first = h.requests.find(r => r.method === 'subagent.list')
  await h.inAct(async () => { first.resolve({ subagents: [agent({ subagent_id: 'a', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI })] }) })
  await h.flush()
  check('source: the first source shows its worker', h.text().includes('1 agent'), h.text())

  await h.render(footerProps({ sourceId: 'remote-x::default' }))
  const listRequests = h.requests.filter(r => r.method === 'subagent.list')
  check('source: another connection issues its own read', listRequests.length === 2 && listRequests[1].params.session_id === 'sess-A', JSON.stringify(listRequests.map(r => r.params)))
  check('source: the previous source’s roster is cleared', !h.text().includes('Running agents'), h.text())
  await h.inAct(async () => { listRequests[1].resolve({ subagents: [agent({ subagent_id: 'b', model: 'remote-model' })] }) })
  await h.flush()
  check('source: only the new source’s worker is shown', h.text().includes('remote-model') && !h.text().includes('grok-4'), h.text())
  h.unmount()
}

// R3 — inactive popover / non-ready socket: no read at all.
{
  const h = await mountedHarness()
  await h.render(footerProps({ active: false }))
  check('inactive: closed popover issues no subagent.list', h.requests.length === 0, JSON.stringify(h.requests))
  check('inactive: closed popover renders nothing', !h.text().includes('Running agents'), h.text())
  h.unmount()
}
{
  const h = await mountedHarness()
  await h.render(footerProps({ gateway: 'closed' }))
  check('inactive: reconnecting socket issues no subagent.list', h.requests.length === 0, JSON.stringify(h.requests))
  h.unmount()
}
{
  const h = await mountedHarness()
  await h.render(footerProps({ sessionId: '' }))
  check('inactive: no focused session issues no read', h.requests.length === 0, JSON.stringify(h.requests))
  h.unmount()
}

// R4 — error / empty / malformed responses hide the footer (never a zero row).
{
  const h = await mountedHarness()
  await h.render(footerProps())
  await h.inAct(async () => { h.requests.find(r => r.method === 'subagent.list').reject(new Error('4001 session not owned')) })
  await h.flush()
  check('error: a refused read hides the footer', !h.text().includes('Running agents'), h.text())
  h.unmount()
}
{
  const h = await mountedHarness()
  await h.render(footerProps())
  await h.inAct(async () => { h.requests.find(r => r.method === 'subagent.list').resolve({ subagents: [] }) })
  await h.flush()
  check('empty: no children hides the footer', !h.text().includes('Running agents'), h.text())
  h.unmount()
}
{
  const h = await mountedHarness()
  await h.render(footerProps())
  await h.inAct(async () => { h.requests.find(r => r.method === 'subagent.list').resolve({ session_id: 'sess-OTHER', subagents: [agent({ subagent_id: 'foreign', model: 'grok-4' })] }) })
  await h.flush()
  check('stale: a payload bound to another session is discarded', !h.text().includes('Running agents'), h.text())
  h.unmount()
}

// R5 — no account inventory: provider is real, usage is unavailable, never the
//       active account's figure.
{
  const h = await mountedHarness()
  await h.render(footerProps({ providerRows: null }))
  await h.inAct(async () => { h.requests.find(r => r.method === 'subagent.list').resolve({ subagents: [agent({ subagent_id: 'a', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_XAI })] }) })
  await h.flush()
  check('missing inventory: the published provider is shown, not guessed', h.text().includes('xai-oauth'), h.text())
  check('missing inventory: no percentage is borrowed', !h.text().includes('62%'), h.text())
  h.unmount()
}

// R6 — an account id that does not match the cached row never shows its pool.
{
  const h = await mountedHarness()
  await h.render(footerProps())
  await h.inAct(async () => { h.requests.find(r => r.method === 'subagent.list').resolve({ subagents: [agent({ subagent_id: 'a', model: 'grok-4', provider: 'xai-oauth', provider_account_id: ACCOUNT_DS })] }) })
  await h.flush()
  check('mismatch: the provider is still shown', h.text().includes('SuperGrok / xAI OAuth'), h.text())
  check('mismatch: the other credential’s pool is never attached', !h.text().includes('62%'), h.text())
  h.unmount()
}

console.log(failures === 0 ? 'running_agents_footer_suite=PASS' : `running_agents_footer_suite=FAIL (${failures})`)
process.exit(failures === 0 ? 0 : 1)
