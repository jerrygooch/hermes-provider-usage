/**
 * Mounted DOM lifecycle harness (honest integration, NOT full desktop E2E).
 *
 * SSR does NOT run effects, so the async lifecycle — A-B-A races, reconnect
 * retention, cross-profile event attribution, fail-closed divergence, and
 * missing-backend handling — can only be proven with the REAL React DOM
 * renderer mounted in a browser-like DOM. This harness executes the plugin's
 * ACTUAL registered components (chip + pane) under real effects with a
 * controlled SDK test double (no credentials, no network to Hermes): it uses
 * jsdom + react-dom/createRoot + act from THIS repo's declared devDependencies.
 *
 * Each scenario builds a fresh plugin module + world so React hook state and
 * the per-source provider memory cannot leak between tests.
 */

import fs from 'node:fs'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import { fileURLToPath } from 'node:url'

const pluginPath = fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const source = fs.readFileSync(pluginPath, 'utf8')

// ── Browser-like DOM globals before importing React ─────────────────────────
const dom = new JSDOM('<!doctype html><html><body></body></html>', { pretendToBeVisual: true })
const win = dom.window
for (const key of ['window', 'document', 'navigator', 'HTMLElement', 'SVGElement', 'Element', 'Node', 'Text', 'Comment', 'DocumentFragment', 'getComputedStyle', 'requestAnimationFrame', 'cancelAnimationFrame', 'MutationObserver', 'VisualViewport', 'DOMParser', 'Image', 'Option', 'CSS', 'CSSStyleDeclaration']) {
  try {
    if (win[key] !== undefined) globalThis[key] = win[key]
  } catch {
    // Some hosts expose read-only globals (e.g. navigator); jsdom already wins
    // or the host default is sufficient for React to boot.
  }
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true

const React = (await import('react')).default
const { createRoot } = await import('react-dom/client')
const ReactAct = typeof React.act === 'function' ? React.act : (await import('react-dom/test-utils')).act
const JsxRuntime = (await import('react/jsx-runtime')).default ?? (await import('react/jsx-runtime'))
const jsxRuntime = JsxRuntime

let failures = 0
const fail = (name, detail = '') => {
  failures += 1
  console.error(`LIFECYCLE FAIL ${name}${detail ? `: ${detail}` : ''}`)
}
const check = (name, condition, detail = '') => {
  if (condition) console.log(`LIFECYCLE PASS ${name}`)
  else fail(name, detail)
}

function makeAtom(initial) {
  let value = initial
  const subs = new Set()
  return {
    get() { return value },
    set(next) { value = next; for (const fn of subs) fn() },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
  }
}

const sdkComponent = ({ children, ...rest }) => React.createElement('span', rest, children)

/**
 * Build a fully isolated plugin runtime for one scenario.
 * `initial` controls which atoms exist (feature detection) and their values.
 */
async function harness(initial = {}) {
  const atoms = {
    model: makeAtom(initial.model ?? 'mimo-v2.5'),
    sessionId: makeAtom(initial.sessionId ?? undefined),
    profile: makeAtom(initial.profile ?? 'default'),
    connectionId: makeAtom(initial.connectionId ?? 'local'),
    gateway: makeAtom(initial.gateway ?? 'open'),
    focusedStoredSessionId: makeAtom(initial.storedSessionId ?? undefined)
  }
  if (initial.focusedOwner !== undefined) atoms.focusedOwner = makeAtom(initial.focusedOwner)
  if (initial.focusedProfile !== undefined) atoms.focusedProfile = makeAtom(initial.focusedProfile)

  const state = {
    model: atoms.model,
    focusedSessionId: atoms.sessionId,
    profile: atoms.profile,
    connectionId: atoms.connectionId,
    gateway: atoms.gateway,
    focusedStoredSessionId: atoms.focusedStoredSessionId
  }
  // The plugin treats host.state.* as READONLY ATOMS (useValue(atom)); when a
  // feature is absent, the property is undefined so the plugin's guard skips it.
  if (initial.focusedOwner !== undefined) state.focusedSessionOwner = atoms.focusedOwner
  if (initial.focusedProfile !== undefined) state.focusedSessionProfile = atoms.focusedProfile

  // host.state atoms are READONLY to the plugin; expose setters via the harness.
  const setState = {
    sessionId: v => ReactAct(() => atoms.sessionId.set(v)),
    profile: v => ReactAct(() => atoms.profile.set(v)),
    connectionId: v => ReactAct(() => atoms.connectionId.set(v)),
    gateway: v => ReactAct(() => atoms.gateway.set(v)),
    focusedOwner: v => ReactAct(() => atoms.focusedOwner?.set(v)),
    focusedProfile: v => ReactAct(() => atoms.focusedProfile?.set(v))
  }

  const listeners = new Map()
  const requests = []
  const host = {
    state,
    onEvent(type, fn) {
      let set = listeners.get(type)
      if (!set) { set = new Set(); listeners.set(type, set) }
      set.add(fn)
      return () => set.delete(fn)
    },
    request(method, params) {
      const req = { method, params, resolve: null, reject: null }
      req.promise = new Promise((res, rej) => { req.resolve = res; req.reject = rej })
      requests.push(req)
      return req.promise
    },
    notify() {},
    openWorkspace() {}
  }
  // Delivering an event runs the plugin's session.info handler, which may call
  // setState — keep it inside an act scope so React doesn't warn about a root
  // update outside a test act().
  const emit = (type, event) => { ReactAct(() => { for (const fn of [...(listeners.get(type) || [])]) fn(event) }) }

  // Controlled query surface. useSyncExternalStore dedupes on getSnapshot
  // IDENTITY, so each setQuery must hand out a NEW snapshot object (not mutate
  // one) or React won't re-render — a reconnect/refetch would silently sit.
  let querySnap = { data: null, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {}, _v: 0 }
  const querySubs = new Set()
  let queryCalls = 0
  let lastQueryKey = null
  function useQuery(config) {
    queryCalls += 1
    lastQueryKey = config?.queryKey ?? lastQueryKey
    return React.useSyncExternalStore(h => { querySubs.add(h); return () => querySubs.delete(h) }, () => querySnap)
  }
  const setQuery = patch => {
    ReactAct(() => {
      querySnap = { ...querySnap, ...patch, _v: querySnap._v + 1 }
      for (const fn of querySubs) fn()
    })
  }

  function useValue(atomLike) {
    if (atomLike === undefined || atomLike === null) return null
    if (typeof atomLike.get !== 'function') return atomLike
    return React.useSyncExternalStore(h => atomLike.subscribe(h), () => atomLike.get())
  }

  const reactBoxed = { useEffect: React.useEffect, useState: React.useState, useRef: React.useRef, useCallback: undefined }
  const sdkValues = {
    Badge: sdkComponent, Button: sdkComponent, Loader: sdkComponent, RowButton: sdkComponent, StatusDot: sdkComponent, Tip: sdkComponent,
    Popover: sdkComponent, PopoverContent: sdkComponent, PopoverTrigger: sdkComponent,
    ROUTES_AREA: 'routes', SIDEBAR_NAV_AREA: 'sidebar-nav', PALETTE_AREA: 'palette',
    host, haptic: () => {}, icons: new Proxy({}, { get: () => sdkComponent }),
    useQuery, useValue
  }
  const deps = new Map()
  function makeSynthetic(identifier, values) {
    return new vm.SyntheticModule(Object.keys(values), function () {
      for (const [key, value] of Object.entries(values)) this.setExport(key, value)
    }, { context, identifier })
  }
  const context = vm.createContext({ console })
  deps.set('@hermes/plugin-sdk', makeSynthetic('@hermes/plugin-sdk', sdkValues))
  deps.set('react', makeSynthetic('react', reactBoxed))
  deps.set('react/jsx-runtime', makeSynthetic('react/jsx-runtime', { jsx: jsxRuntime.jsx, jsxs: jsxRuntime.jsxs }))

  const mod = new vm.SourceTextModule(source, { context, identifier: pluginPath })
  await mod.link(spec => {
    const dep = deps.get(spec)
    if (!dep) throw new Error(`Unexpected import: ${spec}`)
    return dep
  })
  await mod.evaluate()

  const contributions = []
  let restCalls = []
  const ctx = {
    register: c => contributions.push(c),
    rest: (pathStr, opts) => { restCalls.push({ path: pathStr, opts }); return Promise.resolve({}) },
    socket: () => () => {},
    storage: { get: () => undefined, set: () => {}, remove: () => {} },
    i18n: {}
  }
  mod.namespace.default.register(ctx)
  const chipEl = React.createElement(contributions.find(c => c.area === 'statusBar.right').render)
  const pageEl = React.createElement(contributions.find(c => c.area === 'routes').render)

  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  // `ReactAct(async () => …)` flushes effects AND pending microtasks (promise
  // resolutions in useActiveProvider's session.status handler), so late async
  // replies are attributed to an act scope instead of warning about an update
  // to Root outside act(). inAct is the exported form for scenario-driven
  // async mutations (req.resolve / req.reject).
  const inAct = fn => ReactAct(async () => { await fn() })
  const flush = async () => { await inAct(async () => {}); await inAct(async () => {}) }
  const mountChip = async () => { await inAct(async () => { root.render(chipEl) }); await flush() }
  const mountPage = async () => { await inAct(async () => { root.render(pageEl) }); await flush() }
  const text = () => container.textContent
  const unmount = () => { ReactAct(() => { root.unmount() }); document.body.removeChild(container) }

  return {
    mod, setState, emit, setQuery, queryResult: querySnap, requests, restCalls, text, inAct, mountChip, mountPage, unmount, flush,
    get queryCalls() { return queryCalls },
    get lastQueryKey() { return lastQueryKey },
    readonly: atoms,
    remembered: key => mod.namespace.rememberedProvider(key),
    scopeOf: arg => mod.namespace.resolveUsageScope(arg),
    usageKey: (fetchProfile, provider, model, source) => mod.namespace.providerUsageQueryKey(fetchProfile, provider, model, source)
  }
}

const fixture = () => ({
  version: 1,
  fetched_at: '2026-09-07T12:00:00Z',
  active: { provider: 'xai-oauth', model: 'mimo-v2.5' },
  default_provider: 'xai-oauth',
  providers: [
    { id: 'xai-oauth', label: 'SuperGrok / xAI OAuth', available: true, plan: 'SuperGrok', limits: [{ id: 'default', label: 'SuperGrok', windows: [{ label: 'Subscription window', remaining_percent: 62 }] }], balances: [], details: [] },
    { id: 'anthropic', label: 'Anthropic', available: true, plan: 'Claude', limits: [{ id: 'default', label: 'Claude', windows: [{ label: 'Subscription window', remaining_percent: 40 }] }], balances: [], details: [] },
    { id: 'deepseek', label: 'DeepSeek', available: false, unavailable_reason: 'No credentials here.' }
  ]
})

// ── S1: Verified focus mounts the normal account readout (no gate). ─────────
{
  const h = await harness({ sessionId: undefined, focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  await h.mountChip()
  check('S1 verified focus shows the active provider funding', h.text().includes('62% left'), h.text())
  check('S1 verified focus does not gate', !h.text().includes('Switch the active profile'), h.text())
  h.unmount()
}

// ── S2: Async A-B-A race — a late response for a superseded session must not
//        win over the current session's provider, nor contaminate memory. ─────
{
  const h = await harness({ sessionId: 'sess-A', focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  await h.mountChip()
  check('S2 requested session.status for A', h.requests.length === 1 && h.requests[0].params.session_id === 'sess-A', JSON.stringify(h.requests))
  const reqA = h.requests[0]

  // User refocuses onto sess-B mid-flight.
  h.setState.sessionId('sess-B')
  await h.flush()
  check('S2 requested session.status for B', h.requests.length === 2 && h.requests[1].params.session_id === 'sess-B', JSON.stringify(h.requests))
  const reqB = h.requests[1]
  const sourceKey = 'local::default'

  // B resolves first: the current session owns the provider.
  await h.inAct(async () => { reqB.resolve({ info: { provider: 'anthropic' } }) })
  check('S2 current session B (anthropic) wins', h.remembered(sourceKey) === 'anthropic', h.remembered(sourceKey))
  check('S2 chip reflects B provider', h.text().includes('40% left'), h.text())

  // A resolves LATE for the superseded session: must be dropped, not applied.
  await h.inAct(async () => { reqA.resolve({ info: { provider: 'xai-oauth' } }) })
  check('S2 late response for superseded A does NOT win', h.remembered(sourceKey) === 'anthropic', h.remembered(sourceKey))
  check('S2 chip stays on B provider after late A (no A-B reversal)', h.text().includes('40% left') && !h.text().includes('62% left'), h.text())
  h.unmount()
}

// ── S3: Cross-profile late events & anonymous events must not contaminate ───
//        per-source remembered provider (no session currently focused). ───────
{
  const h = await harness({ sessionId: undefined, focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  await h.mountChip()
  const sourceKey = 'local::default'
  check('S3 no focused session -> no session.status probe', h.requests.length === 0, JSON.stringify(h.requests))

  // Anonymous event (missing ids) must be REJECTED outright.
  h.emit('session.info', { payload: { provider: 'grok' } })
  await h.flush()
  check('S3 anonymous event (missing ids) is rejected', h.remembered(sourceKey) === '', h.remembered(sourceKey))

  // Event for a DIFFERENT source (remote connection, same profile name) → reject.
  h.emit('session.info', { session_id: 'other', connection_id: 'remote', profile: 'default', payload: { provider: 'deepseek' } })
  await h.flush()
  check('S3 foreign-source event cannot contaminate local memory', h.remembered(sourceKey) !== 'deepseek', h.remembered(sourceKey))

  // Event with ids matching our exact owner+session → accepted.
  h.emit('session.info', { session_id: 'mine', connection_id: 'local', profile: 'default', payload: { provider: 'anthropic' } })
  await h.flush()
  check('S3 matching-source event is accepted', h.remembered(sourceKey) === 'anthropic', h.remembered(sourceKey))
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  await h.flush()
  check('S3 chip reflects the accepted provider', h.text().includes('40% left'), h.text())
  h.unmount()
}

// ── S4: Reconnect retention — the query key must NOT carry gateway state, so
//        a reconnecting socket keeps the cached rows (stale) instead of losing
//        them, and the chip/pane says "reconnecting". ────────────────────────
{
  const h = await harness({ sessionId: undefined, focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  await h.mountPage()
  const keyOpen = JSON.stringify(h.lastQueryKey)
  check('S4 pane loaded from cached data', h.text().includes('62% left'), h.text())

  h.setState.gateway('closed')
  await h.flush()
  check('#4 key is stable across reconnect (no gateway slot)', JSON.stringify(h.lastQueryKey) === keyOpen, `${JSON.stringify(h.lastQueryKey)} vs ${keyOpen}`)
  check('#4 reconnect keeps the cached rows (stale, not wiped)', h.text().includes('62% left'), h.text())
  check('#4 pane banner says reconnecting on the same profile', h.text().includes('Reconnecting — showing default usage'), h.text())
  check('#4 not mislabelled as a profile switch', !h.text().includes('Switching profile — refreshing'), h.text())
  h.unmount()
}

// ── S5: Missing backend namespace (404) → explicit not-enabled/installed, ───
//        no attempt to auto-enable/install a real profile. ────────────────────
{
  const h = await harness({ sessionId: undefined, focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  h.setQuery({ data: null, isLoading: false, isError: true, isFetching: false, error: { status: 404, message: 'plugin namespace not enabled' } })
  await h.mountPage()
  check('#7 missing backend: explicit not-enabled copy in pane', h.text().includes("isn't enabled or installed"), h.text())
  check('#7 no automatic profile edits (only read-only overview call)', h.restCalls.every(c => c.path === '/overview' && c.opts.method === 'POST'), JSON.stringify(h.restCalls))
  h.unmount()
}

// ── S6: Fail-closed divergence — focused chat on Alice but active socket on
//        default: gate BOTH surfaces and issue NO fetch/probe for the foreign
//        account (no session.status request, no /overview subscription). ─────
{
  const h = await harness({ sessionId: 'sess-alice', focusedOwner: { connectionId: 'local', profile: 'Alice' }, focusedProfile: 'Alice' })
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  await h.mountPage()
  check('#2 diverged pane gates (names the focus profile)', h.text().includes('focused chat is in Alice'), h.text())
  check('#2 diverged pane tells the user to switch', h.text().includes('Switch to Alice to view its provider usage'), h.text())
  check('#2 diverged pane does NOT fetch for the foreign account', h.queryCalls === 0, `queryCalls=${h.queryCalls}`)
  check('#2 diverged pane does NOT probe the foreign session', h.requests.length === 0, JSON.stringify(h.requests))
  check('#2 diverged pane does NOT display active-account rows', !h.text().includes('Account limits'), h.text())
  h.unmount()
}

// ── S6b: Same chip fails closed on divergence (no foreign-account accounting). ─
{
  const h = await harness({ sessionId: 'sess-alice', focusedOwner: { connectionId: 'local', profile: 'Alice' }, focusedProfile: 'Alice' })
  await h.mountChip()
  check('#2 diverged chip gates', h.text().includes('Usage on Alice'), h.text())
  check('#2 diverged chip does not fetch', h.queryCalls === 0, `queryCalls=${h.queryCalls}`)
  h.unmount()
}

// ── S6c: #1 same-profile-remote collision — names match 'Alice' but the
//         focused remote chat is a different connection: still fails closed. ──
{
  const h = await harness({ sessionId: 'sess-remote', connectionId: 'remote-main', profile: 'Alice', focusedOwner: { connectionId: 'remote-focus', profile: 'Alice' }, focusedProfile: 'Alice' })
  const scope = h.scopeOf({ focusedOwner: { connectionId: 'remote-focus', profile: 'Alice' }, hasFocusedOwner: true, focusedProfile: 'Alice', activeConnectionId: 'remote-main', activeProfile: 'Alice' })
  check('#1 same-profile remote: diverged at resolve level', scope.diverged === true, JSON.stringify(scope))
  await h.mountPage()
  check('#1 same-profile remote: pane gates (no wrong-account data)', h.text().includes('focused chat is in Alice') && h.queryCalls === 0, `queryCalls=${h.queryCalls}`)
  check('#1 same-profile remote: no probe of the foreign session', h.requests.length === 0, JSON.stringify(h.requests))
  h.unmount()
}

// ── S7: No-crash under a degraded world — atoms absent/undefined must not
//        throw (the guard `host.state.X ? useValue(...) : ''` handles it). ────
{
  const h = await harness({ sessionId: undefined, connectionId: undefined, focusedOwner: undefined, focusedProfile: undefined, gateway: undefined })
  await h.mountPage({})
  check('#9 degraded world renders without a crash', h.text().length >= 0 && h.text().includes('Provider usage'), h.text())
  h.unmount()
}

// ── S8: Refetch failure with rows already on screen — pane keeps the stale
//        rows and surfaces an explicit "could not refresh" banner. ──────────
{
  const h = await harness({ sessionId: undefined, focusedOwner: { connectionId: 'local', profile: 'default' }, focusedProfile: 'default' })
  h.setQuery({ data: fixture(), isLoading: false, isError: true, isFetching: false, error: new Error('boom') })
  await h.mountPage()
  check('#5 refetch-error keeps the stale rows', h.text().includes('Account limits'), h.text())
  check('#5 refetch-error surfaces a stale banner', h.text().includes('Could not refresh'), h.text())
  h.unmount()
}

// ── S9: Authoritative ambiguity — the SDK publishes the focus-owner atom but
//        its value is null (unresolved/ambiguous focused id). Must fail closed
//        and NEVER fall back to the profile-only ladder, which could name the
//        active account and fetch its rows under the ambiguous chat's focus. ─
{
  const h = await harness({
    sessionId: 'sess-ambiguous',
    focusedOwner: null,        // atom PRESENT but null → authoritative ambiguity
    focusedProfile: 'Alice',   // profile-only fallback would guess wrong
    connectionId: 'local', profile: 'default'
  })
  h.setQuery({ data: fixture(), isLoading: false, isError: false })
  const scope = h.scopeOf({ focusedOwner: null, hasFocusedOwner: true, focusedProfile: 'Alice', activeConnectionId: 'local', activeProfile: 'default' })
  check('#10 null focus-owner resolves as diverged (never profile-only bypass)', scope.diverged === true && scope.source === 'ambiguous', JSON.stringify(scope))
  await h.mountPage()
  check('#10 ambiguous focus gates instead of fetching active rows', h.text().includes('focused chat is in Alice') && h.queryCalls === 0, `queryCalls=${h.queryCalls}`)
  check('#10 ambiguous focus does not display active-account data', !h.text().includes('Account limits'), h.text())
  h.unmount()
}

// ── S10: Same profile-name, DIFFERENT connection: eventOwns must reject a
//        session.info event that carries our focused session id but a foreign
//        source (the remote alias vs the live socket) — even a same-name
//        profile on another connection must not contaminate this account. ────
{
  const h = await harness({ sessionId: 'sess-A', connectionId: 'remote-main', profile: 'Alice', focusedOwner: { connectionId: 'remote-focus', profile: 'Alice' }, focusedProfile: 'Alice', gateway: 'open' })
  // active socket on remote-main:Alice diverges from focus remote-focus:Alice → gated.
  await h.mountChip()
  check('#11 same-profile different-connection chip gates (no foreign accounting)', h.text().includes('Usage on Alice') && h.queryCalls === 0, `queryCalls=${h.queryCalls}`)
  h.unmount()
}

// ── S11: Missing backend on the ACTIVE profile (verified scope, /overview 404,
//        no rows) must surface explicitly on the CHIP too — not a generic
//        "unavailable", and certainly not a wrong-account figure. ─────────────
{
  const h = await harness({ sessionId: 'sess-cf', focusedOwner: { connectionId: 'local', profile: 'chaosforge' }, focusedProfile: 'chaosforge', connectionId: 'local', profile: 'chaosforge', gateway: 'open' })
  h.setQuery({ data: null, isLoading: false, isError: true, isFetching: false, error: { status: 404, message: 'plugin namespace not enabled' } })
  await h.mountChip()
  check('#7 chip says backend not enabled on the active profile', h.text().includes('not enabled in chaosforge'), h.text())
  check('#7 chip does NOT fall back to a generic "unavailable"', !/Usage · unavailable/.test(h.text()), h.text())
  check('#7 chip does not show a wrong-account figure', !h.text().includes('62% left') && !h.text().includes('40% left'), h.text())
  h.unmount()
}

// ── S12: Priority round-trip — default(with backend) → chaosforge(no backend)
//        → default. The scope must STAY a genuine fetch at every step (verified,
//        never a divergence gate) so the not-enabled state is reachable, and the
//        query source must round-trip cleanly (default data is recoverable, no
//        wrong-account key collision for chaosforge). ─────────────────────────
{
  const cfOwner = { connectionId: 'local', profile: 'chaosforge' }
  const defOwner = { connectionId: 'local', profile: 'default' }
  const scopes = [
    h => h.scopeOf({ focusedOwner: defOwner, hasFocusedOwner: true, focusedProfile: 'default', activeConnectionId: 'local', activeProfile: 'default' }),
    h => h.scopeOf({ focusedOwner: cfOwner, hasFocusedOwner: true, focusedProfile: 'chaosforge', activeConnectionId: 'local', activeProfile: 'chaosforge' }),
    h => h.scopeOf({ focusedOwner: defOwner, hasFocusedOwner: true, focusedProfile: 'default', activeConnectionId: 'local', activeProfile: 'default' })
  ]
  const h = await harness({})
  const r0 = scopes[0](h)
  check('#8 default-with-backend scope is a verified fetch (not a gate)', r0.diverged === false && r0.source === 'active' && r0.fetchProfile === 'default', JSON.stringify(r0))
  const scopeCf = scopes[1](h)
  check('#8 chaosforge scope is a verified fetch (backend-not-enabled state reachable)', scopeCf.diverged === false && scopeCf.fetchProfile === 'chaosforge', JSON.stringify(scopeCf))
  const r2 = scopes[2](h)
  check('#8 return-to-default scope is verified again (recovery not gated)', r2.diverged === false && r2.fetchProfile === 'default', JSON.stringify(r2))
  // Source-qualified keys: chaosforge and default accounts never collide, and the
  // return restores the exact default source key (recover the right account).
  const kDefault = h.usageKey('default', '', '', 'local::default')
  const kChaos = h.usageKey('chaosforge', '', '', 'local::chaosforge')
  check('#8 round-trip keys are source-distinct and stable', JSON.stringify(kDefault) !== JSON.stringify(kChaos) && JSON.stringify(kDefault) === JSON.stringify(h.usageKey('default', '', '', 'local::default')), JSON.stringify(kDefault))
  h.unmount()
}

if (failures > 0) {
  throw new Error(`${failures} lifecycle assertion(s) failed`)
}
console.log('plugin_lifecycle_suite=PASS')