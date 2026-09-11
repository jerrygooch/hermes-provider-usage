/**
 * @hermes/plugin-sdk facade for the browser capture harness.
 *
 * Re-exports the REAL Hermes desktop SDK UI primitives (Button, Badge, Loader,
 * RowButton, StatusDot, icons) straight from hermes-agent's source, so the
 * provider-usage plugin gets faithful native widgets — including the real
 * Tooltip (`Tip`). Do not substitute Tip: a prop-forwarding double once masked a
 * broken PopoverTrigger→Tip→Button nesting (the chip popover never opened in the
 * real app). The parts that talk to a live app (host atoms/request/events,
 * useQuery data fetching, haptics) stay deterministic fixture doubles. The
 * plugin→app bridge is a COMPONENT HARNESS, not the running desktop.
 *
 * Fault model (faithful to the plugin's assumptions):
 *  - host.state.* atoms are READONLY to the plugin but we keep them observable
 *    and settable through `window.__HARNESS__.set` so scripted lifecycle
 *    scenarios (reconnect, diverging focus, A-B-A session swaps) can drive the
 *    real plugin through real re-renders.
 *  - useQuery keeps its last resolved data while `enabled:false` (exactly what
 *    React Query does), so a gateway reconnect keeps the cached rows STALE
 *    instead of wiping them.
 *  - ctx.rest is scriptable per fixture: resolve the overview, or reject with a
 *    404 (backend namespace missing) or a generic error (API failure).
 */
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader } from '@/components/ui/loader'
import { RowButton } from '@/components/ui/row-button'
import { StatusDot } from '@/components/status-dot'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tip } from '@/components/ui/tooltip'
import * as icons from '@/lib/icons'
import { useEffect, useState, useSyncExternalStore } from 'react'
import { jsx } from 'react/jsx-runtime'

// Real SDK UI primitives, re-exported so the plugin imports them faithfully.
export { Button, Badge, Loader, RowButton, StatusDot, icons, Popover, PopoverContent, PopoverTrigger, Tip }
export const ROUTES_AREA = 'routes'
export const SIDEBAR_NAV_AREA = 'sidebar-nav'
export const PALETTE_AREA = 'palette'

// ---- Fixture loader: injects the active scenario before the app boots ----
// window.__FIXTURE__ = { overview, host: {...}, rest: 'ok'|'404'|'error',
//                        events: [...], sessionStatus: [...] }
function fixture() {
  return window.__FIXTURE__ || { overview: null, host: {} }
}
function overview() {
  return fixture().overview
}
function activeProvider() {
  return overview()?.active?.provider || ''
}

// ---- Reactive atoms (readonly to the plugin; settable via the controller) ----
function makeAtom(initial) {
  let value = initial
  const subs = new Set()
  return {
    get: () => value,
    // public SDK atoms are readonly to consume via useValue; the harness
    // controller is the only writer and exposes a derived `_set`.
    _set(next) { if (value !== next) { value = next; for (const fn of subs) fn() } },
    subscribe(fn) { subs.add(fn); return () => subs.delete(fn) }
  }
}

const stateDim = {
  model: '',
  focusedSessionId: null,
  focusedStoredSessionId: null,
  focusedSessionProfile: '',
  focusedSessionOwner: null,
  focusOwnerPresent: false,
  profile: '',
  connectionId: '',
  gateway: 'open'
}
function hostState() {
  const h = fixture().host || {}
  const ownerPresent = Object.prototype.hasOwnProperty.call(h, 'focusedSessionOwner')
  return {
    model: h.model ?? '',
    focusedSessionId: h.sessionId ?? null,
    focusedStoredSessionId: h.storedSessionId ?? h.sessionId ?? null,
    focusedSessionProfile: h.focusedSessionProfile ?? h.profile ?? '',
    focusedSessionOwner: h.focusedSessionOwner ?? null,
    focusOwnerPresent: ownerPresent,
    profile: h.profile ?? 'default',
    connectionId: h.connectionId ?? 'local',
    gateway: h.gateway ?? 'open'
  }
}

function buildHostState() {
  const s = hostState()
  const atoms = {
    model: makeAtom(s.model),
    focusedSessionId: makeAtom(s.focusedSessionId),
    focusedStoredSessionId: makeAtom(s.focusedStoredSessionId),
    focusedSessionProfile: makeAtom(s.focusedSessionProfile),
    profile: makeAtom(s.profile),
    connectionId: makeAtom(s.connectionId),
    gateway: makeAtom(s.gateway)
  }
  // The SDK publishes the owner atom always in current builds; when the fixture
  // does not pass it we still expose the atom so the plugin's "absent vs null"
  // detection is exercised faithfully: undefined atom → absent (legacy).
  let ownerAtom
  if (s.focusOwnerPresent) {
    ownerAtom = makeAtom(s.focusedSessionOwner)
    atoms.__focusedSessionOwner = ownerAtom
  } else {
    ownerAtom = undefined
  }
  return { atoms, ownerAtom }
}

let hostStateCtx = buildHostState()

// Controller the capture script (or a scenario page) drives over CDP.
window.__HARNESS__ = {
  set(partial) {
    for (const [key, value] of Object.entries(partial)) {
      if (key === 'focusedSessionOwner') {
        if (hostStateCtx.ownerAtom) hostStateCtx.ownerAtom._set(value)
        else if (value !== undefined) { hostStateCtx.ownerAtom = makeAtom(value); hostStateCtx.atoms.__focusedSessionOwner = hostStateCtx.ownerAtom }
      } else if (hostStateCtx.atoms[key]) {
        hostStateCtx.atoms[key]._set(value)
      }
    }
  },
  emit(type, event) {
    if (type === 'session.info') for (const fn of [...(eventHandlers.sessionInfo || [])]) fn(event)
  }
}

const eventHandlers = { sessionInfo: new Set() }

function sessionStatusPlan(sessionId) {
  const plan = fixture().sessionStatus
  const entry = Array.isArray(plan) ? plan.find(p => p.session_id === sessionId) : null
  return entry
}

// ---- host bridge ----
export const host = {
  state: {
    get model() { return hostStateCtx.atoms.model },
    get focusedSessionId() { return hostStateCtx.atoms.focusedSessionId },
    get focusedStoredSessionId() { return hostStateCtx.atoms.focusedStoredSessionId },
    get focusedSessionProfile() { return hostStateCtx.atoms.focusedSessionProfile },
    get connectionId() { return hostStateCtx.atoms.connectionId },
    get profile() { return hostStateCtx.atoms.profile },
    get gateway() { return hostStateCtx.atoms.gateway },
    get focusedSessionOwner() { return hostStateCtx.ownerAtom }
  },
  async request(method, params) {
    if (method === 'session.status') {
      const id = params?.session_id
      const plan = sessionStatusPlan(id)
      const provider = plan?.provider ?? activeProvider()
      const delayMs = plan?.delayMs ?? 0
      return new Promise(resolve => {
        setTimeout(() => resolve({ info: { provider }, provider }), delayMs)
      })
    }
    return {}
  },
  onEvent(type, handler) {
    if (type === 'session.info') {
      eventHandlers.sessionInfo.add(handler)
      // Deterministic initial delivery of the fixture's active provider.
      setTimeout(() => handler({ payload: { provider: activeProvider() } }), 0)
      // Scheduled late/foreign events (A-B-A, source-attributed, anonymous).
      const scheduled = Array.isArray(fixture().events) ? fixture().events : []
      for (const ev of scheduled) {
        setTimeout(() => {
          if (eventHandlers.sessionInfo.has(handler)) handler(ev)
        }, ev.afterMs ?? 0)
      }
      return () => eventHandlers.sessionInfo.delete(handler)
    }
    return () => {}
  },
  openWorkspace() {},
  navigate() {},
  notify() {},
  status() {},
  logs() {},
  warmProfile() {}
}

export const haptic = () => {}

// ---- useValue: subscribes to an atom exactly like @nanostores/react ----
export function useValue(atomLike) {
  if (atomLike === undefined || atomLike === null) return null
  if (typeof atomLike.get !== 'function') return atomLike
  return useSyncExternalStore(
    subscribe => {
      const un = atomLike.subscribe(subscribe)
      return un
    },
    () => atomLike.get()
  )
}

// ---- useQuery: deterministic double that faithfully models React Query ----
// It caches the last resolved data per key and KEEPS it while `enabled:false`
// (reconnect) instead of clearing — this is the mechanism the plugin relies on
// for "reconnecting keeps the last rows stale".
// The key is serialized (React Query structurally hashes its key), NOT used by
// array reference identity — the plugin builds a fresh array each render, so a
// reference-keyed Map never hits and the cache would be dead on arrival (no
// in-browser reconnect retention, no demonstrable cross-account isolation).
const queryCache = new Map()
function queryKeyOf(key) {
  try { return JSON.stringify(key) } catch { return String(key) }
}
export function useQuery(config) {
  const noop = () => {}
  if (typeof config.queryFn !== 'function') {
    return { data: overview(), isLoading: false, isError: false, isFetching: false, refetch: noop }
  }
  const cacheKey = queryKeyOf(config.queryKey)
  const [state, setState] = useState(() => {
    const cached = queryCache.get(cacheKey)
    if (!config.enabled) {
      return { data: cached ?? undefined, isLoading: false, isError: false, isFetching: false }
    }
    return { data: cached ?? undefined, isLoading: !cached, isError: false, isFetching: !cached }
  })
  useEffect(() => {
    if (config.enabled !== true) return
    let alive = true
    let result
    try { result = config.queryFn() } catch (e) { result = Promise.reject(e) }
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).then(
        data => { if (alive) { queryCache.set(cacheKey, data); setState({ data, isLoading: false, isError: false, isFetching: false }) } },
        err => { if (alive) setState({ data: queryCache.get(cacheKey), isLoading: false, isError: true, isFetching: false, error: err }) }
      )
    } else {
      queryCache.set(cacheKey, result)
      setState({ data: result, isLoading: false, isError: false, isFetching: false })
    }
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config.enabled, cacheKey])
  // When the gateway disconnects (enabled:false) we return the cached data so
  // the plugin renders it STALE (same as React Query's keepPreviousData).
  const cached = queryCache.get(cacheKey)
  const effective = config.enabled === false && cached !== undefined
    ? { data: cached, isLoading: false, isError: false, isFetching: false }
    : state
  return { ...effective, refetch: noop, isFetching: false }
}
export const useMutation = () => [{}, {}]
export const useQueryClient = () => ({})
export const __QUERY_CACHE_RESET__ = () => queryCache.clear()

// ---- Tip: the REAL component (imported above), deliberately not stubbed. ----
// The old prop-forwarding double sent trigger props to a DOM node, which hid a
// real-app regression where Tip swallowed PopoverTrigger's wiring.

// Test-only export to confirm the harness wired the REAL components, not stubs.
export const __HARNESS_SDK__ = {
  componentsAreReal: ![Button, Badge, Loader, RowButton, StatusDot].includes(undefined) && typeof Tip === 'function' && typeof icons.RefreshCw === 'function',
  primitives: { button: Boolean(Button), badge: Boolean(Badge), loader: Boolean(Loader), rowButton: Boolean(RowButton), statusDot: Boolean(StatusDot), icons: Object.keys(icons).length }
}