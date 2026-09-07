/**
 * @hermes/plugin-sdk facade for the browser capture harness.
 *
 * Re-exports the REAL Hermes desktop SDK UI primitives (Button, Badge, Loader,
 * RowButton, StatusDot, icons) straight from hermes-agent's source, so the
 * provider-usage plugin gets faithful native widgets. Only the parts of the SDK
 * that talk to a live app (host atoms/request/events, useQuery data fetching,
 * haptics) and the Tooltip (`Tip`) are replaced by a deterministic fixture test
 * double. This is a COMPONENT HARNESS, not a screenshot of the running desktop.
 */
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Loader } from '@/components/ui/loader'
import { RowButton } from '@/components/ui/row-button'
import { StatusDot } from '@/components/status-dot'
import * as icons from '@/lib/icons'
import { useEffect, useState } from 'react'
import { jsx } from 'react/jsx-runtime'

// Real SDK UI primitives, re-exported so the plugin imports them faithfully.
export { Button, Badge, Loader, RowButton, StatusDot, icons }

// ---- Fixture loader: injects the active scenario before the app boots ----
// window.__FIXTURE__ = { overview: {...}, host: { model, sessionId, profile, gateway } }

function fixture() {
  return window.__FIXTURE__ || { overview: null, host: {} }
}
function overview() {
  return fixture().overview
}
function activeProvider() {
  return overview()?.active?.provider || ''
}
function activeModel() {
  return overview()?.active?.model || fixture().host.model || ''
}

// ---- Atoms: tiny readonly atoms the plugin reads via useValue ----
const atom = value => ({
  get: () => value,
  set: () => {},
  subscribe: () => () => {}
})

function hostAtom(key) {
  return atom(getHostValue(key))
}
function getHostValue(key) {
  const h = fixture().host || {}
  return h[key] ?? ''
}

export const host = {
  state: {
    model: hostAtom('model'),
    activeSessionId: hostAtom('sessionId'),
    focusedSessionId: hostAtom('sessionId'),
    focusedStoredSessionId: hostAtom('sessionId'),
    focusedSessionProfile: hostAtom('profile'),
    profile: hostAtom('profile'),
    gateway: hostAtom('gateway')
  },
  // Called by useActiveProvider: resolve the active provider from the fixture.
  async request(method) {
    if (method === 'session.status') {
      return { info: { provider: activeProvider() }, provider: activeProvider() }
    }
    return {}
  },
  onEvent(type, handler) {
    if (type === 'session.info') {
      // Deliver the fixture's active provider once on subscribe so the pane
      // resolves to the intended provider deterministically.
      setTimeout(() => {
        handler({ payload: { provider: activeProvider() } })
      }, 0)
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

// ---- useValue: reads an atom (as the real SDK does via @nanostores/react) ----
export function useValue(atomLike) {
  if (atomLike && typeof atomLike.get === 'function') return atomLike.get()
  return atomLike ?? null
}

// ---- useQuery: deterministic fixture double. Real SDK returns a React Query
// result; we return a resolved result shaped the same (data/isLoading/isError/
// isFetching/refetch) so ALL downstream render logic runs for real. ----
export function useQuery(config) {
  const noop = () => {}
  if (typeof config.queryFn !== 'function') {
    return { data: overview(), isLoading: false, isError: false, isFetching: false, refetch: noop }
  }
  let result
  try {
    result = config.queryFn()
  } catch {
    result = undefined
  }
  if (result && typeof result.then === 'function') {
    // Async path: the plugin's ctx.rest may return a promise in real usage;
    // resolve it and re-render (data becomes available a microtask later).
    const [state, setState] = useState({ data: undefined, isLoading: true })
    useEffect(() => {
      let alive = true
      Promise.resolve(result).then(
        data => alive && setState({ data, isLoading: false }),
        () => alive && setState({ data: undefined, isLoading: false })
      )
      return () => {
        alive = false
      }
    }, [])
    return { ...state, isError: false, isFetching: false, refetch: noop }
  }
  return { data: result, isLoading: false, isError: false, isFetching: false, refetch: noop }
}
export const useMutation = () => [{}, {}]
export const useQueryClient = () => ({})

// ---- Tip: faithful tooltip scaffold (title + wrapper). The real Tip is a
// Radix tooltip wired to keybind/i18n stores; we render the trigger with the
// label as the accessible title so screenshots show the same trigger. ----
export function Tip({ label, children, ...rest }) {
  return jsx(
    'span',
    {
      title: label,
      'aria-label': label,
      'data-fake-tip': 'stubbed-tooltip',
      style: { display: 'inline-flex' },
      ...rest,
      children
    }
  )
}

// Test-only export to confirm the harness wired the REAL components, not stubs.
export const __HARNESS_SDK__ = {
  componentsAreReal: ![Button, Badge, Loader, RowButton, StatusDot].includes(undefined) && typeof icons.RefreshCw === 'function',
  primitives: { button: Boolean(Button), badge: Boolean(Badge), loader: Boolean(Loader), rowButton: Boolean(RowButton), statusDot: Boolean(StatusDot), icons: Object.keys(icons).length }
}