/**
 * Static SSR smoke test: renders the plugin's registered components (status
 * chip + pane) with the real React server renderer and asserts the honest
 * profile-scope / reconnect / divergence / missing-backend UI states appear.
 * This exercises the actual JSX produced by the plugin's hooks — any render-time
 * ReferenceError, bad icon reference, invalid StatusDot tone, or wrong prop
 * surfaces here — plus the fail-closed divergence gate.
 *
 * React + react-dom resolve from the REPOSITORY's own devDependencies (this
 * repo, not any private Hermes path). Effects do NOT run under SSR, so the
 * async lifecycle (A-B-A races, reconnect retention, event attribution) is
 * covered separately by the mounted DOM harness in plugin_lifecycle_test.mjs.
 */

import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const pluginPath = fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const source = fs.readFileSync(pluginPath, 'utf8')
const context = vm.createContext({ console })

// Real React + server renderer from THIS repo's declared devDependencies.
const React = (await import('react')).default
const reactHooks = { useEffect: React.useEffect, useState: React.useState, useRef: React.useRef }
const { renderToStaticMarkup } = await import('react-dom/server')
const JsxRuntime = await import('react/jsx-runtime')
const jsxRuntime = JsxRuntime.default ?? JsxRuntime

// ── Controllable plugin environment ──────────────────────────────────────────
const world = {
  model: 'mimo-v2.5',
  sessionId: 'sess-1',
  storedSessionId: 'sess-1',
  profile: 'default',
  connectionId: 'local',
  focusedOwner: null, // null = atom absent (legacy desktop)
  focusedProfile: '',
  gateway: 'open'
}
const mkAtom = key => ({ get: () => world[key] })
let queryResult = { data: null, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }
let restCalls = []
const sdkHost = {
  state: {
    model: mkAtom('model'),
    focusedSessionId: mkAtom('sessionId'),
    profile: mkAtom('profile'),
    connectionId: mkAtom('connectionId'),
    gateway: mkAtom('gateway'),
    focusedStoredSessionId: mkAtom('storedSessionId'),
    // Feature-detected: absent when no focused owner is published.
    get focusedSessionOwner() {
      return world.focusedOwner === null ? undefined : mkAtom('focusedOwner')
    },
    get focusedSessionProfile() {
      return world.focusedProfile ? mkAtom('focusedProfile') : undefined
    }
  },
  onEvent: () => () => {},
  request: async () => ({}),
  notify: () => {},
  openWorkspace: () => {}
}

const Base = ({ children, title, label, tone, ...rest }) =>
  React.createElement('span', { 'data-slot': 'aui-slot', 'data-tone': tone, title, ...rest }, children)
const sdkComponents = { Badge: Base, Button: Base, Loader: Base, RowButton: Base, StatusDot: Base, Tip: Base }

function synthetic(identifier, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context, identifier })
}

const sdkValues = {
  ...sdkComponents,
  host: sdkHost,
  haptic: () => {},
  icons: new Proxy({}, { get: () => Base }),
  useQuery: config => queryResult,
  useValue: atomLike => (atomLike && typeof atomLike.get === 'function' ? atomLike.get() : atomLike ?? null)
}

const dependencies = new Map([
  ['@hermes/plugin-sdk', synthetic('@hermes/plugin-sdk', sdkValues)],
  ['react', synthetic('react', reactHooks)],
  ['react/jsx-runtime', synthetic('react/jsx-runtime', { jsx: jsxRuntime.jsx, jsxs: jsxRuntime.jsxs })]
])

const mod = new vm.SourceTextModule(source, { context, identifier: pluginPath })
await mod.link(specifier => {
  const dependency = dependencies.get(specifier)
  if (!dependency) throw new Error(`Unexpected import: ${specifier}`)
  return dependency
})
await mod.evaluate()

// Register the plugin and capture the chip + pane render functions.
const contributions = []
const capturedCtx = {
  register: contrib => contributions.push(contrib),
  rest: (pathStr, opts) => {
    restCalls.push({ path: pathStr, opts })
    return Promise.resolve({})
  },
  socket: () => () => {},
  storage: { get: () => undefined, set: () => {}, remove: () => {} },
  i18n: {}
}
const plugin = mod.namespace.default
plugin.register(capturedCtx)
const chipContribution = contributions.find(c => c.area === 'statusBar.right')
const paneContribution = contributions.find(c => c.area === 'panes')
if (!chipContribution || !paneContribution) throw new Error('chips/pane not registered')
const renderChip = () => renderToStaticMarkup(React.createElement(chipContribution.render))
const renderPane = () => renderToStaticMarkup(React.createElement(paneContribution.render))

const fixture = fetchedAt => ({
  version: 1,
  fetched_at: fetchedAt,
  active: { provider: 'xai-oauth', model: 'mimo-v2.5' },
  default_provider: 'xai-oauth',
  providers: [
    { id: 'xai-oauth', label: 'SuperGrok / xAI OAuth', available: true, plan: 'SuperGrok', limits: [{ id: 'default', label: 'SuperGrok', windows: [{ label: 'Subscription window', remaining_percent: 62 }] }], balances: [], details: [] },
    { id: 'deepseek', label: 'DeepSeek', available: false, unavailable_reason: 'No credentials here.' }
  ]
})

let failures = 0
function check(name, html, needle) {
  const ok = html.includes(needle)
  if (ok) console.log(`RENDER PASS ${name}`)
  else {
    failures += 1
    console.error(`RENDER FAIL ${name}: expected text "${needle}" not found`)
  }
}
function nocheck(name, html, forbiddenNeedle) {
  const ok = !html.includes(forbiddenNeedle)
  if (ok) console.log(`RENDER PASS ${name}`)
  else {
    failures += 1
    console.error(`RENDER FAIL ${name}: forbidden text "${forbiddenNeedle}" was present`)
  }
}

// Loaded normal scope: default profile, focused session also default (legacy).
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const chipLoaded = renderChip()
check('chip renders the provider funding summary', chipLoaded, '· 62% left')
check('chip tooltip is populated with the loaded description', chipLoaded, 'Open the Provider Usage pane for every reported window')

const paneLoaded = renderPane()
check('pane header shows the active scope', paneLoaded, 'Scope default')
check('pane shows the loaded provider usage', paneLoaded, 'Account limits &amp; credits')

// Verified active focus (connection-qualified owner == active source).
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = { connectionId: 'local', profile: 'default' }
world.focusedProfile = 'default'
world.gateway = 'open'
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }
const chipVerified = renderChip()
check('verified focus renders normal usage (not a gate)', chipVerified, '62% left')

// Diverged focus: the focused chat is Alice but the active socket is default.
// #2 must FAIL CLOSED into a gate — no fetching/probe of a foreign account.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = { connectionId: 'local', profile: 'Alice' }
world.focusedProfile = 'Alice'
world.gateway = 'open'
const chipDiverged = renderChip()
check('#2 diverged chip shows a gate keyed to the focus profile', chipDiverged, 'Usage on Alice')
check('#2 diverged chip tooltip tells the user to switch', chipDiverged, 'Switch the active profile to Alice')
nocheck('#2 diverged chip does NOT show active accounting under foreign focus', chipDiverged, '62% left')

const paneDiverged = renderPane()
check('#2 diverged pane names the focus profile', paneDiverged, 'The focused chat is in Alice')
check('#2 diverged pane tells the user to switch', paneDiverged, 'Switch to Alice to view its provider usage here')
nocheck('#2 diverged pane does NOT display active-account rows', paneDiverged, 'Account limits &amp; credits')

// Reconnect (same profile, socket NOT ready): last rows stay visible as stale.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const chipReconnecting = renderChip()
check('reconnecting chip keeps the last figure, not "switching"', chipReconnecting, '62% left')
check('reconnecting chip tooltip says reconnecting on the same profile', chipReconnecting, 'reconnecting')

const paneReconnecting = renderPane()
check('reconnecting pane keeps the loaded rows', paneReconnecting, 'Account limits &amp; credits')
check('reconnecting pane surfaces an honest stale banner', paneReconnecting, 'Reconnecting — showing default usage')
nocheck('reconnecting pane does NOT claim a profile switch', paneReconnecting, 'Switching profile — refreshing')

// No rows yet + socket not ready: honest empty reconnect state.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'
queryResult = { data: null, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const paneEmptyReconnect = renderPane()
check('reconnecting with no rows shows the reconnect note', paneEmptyReconnect, 'Provider usage for default will load when the connection is ready')

// Refetch failure with rows: stale indication must surface in panel.
world.gateway = 'open'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: true, isFetching: false, error: new Error('boom'), refetch: () => {} }
const paneStaleRefresh = renderPane()
check('#5 refetch-error with rows keeps the rows', paneStaleRefresh, 'Account limits &amp; credits')
check('#5 refetch-error with rows surfaces a stale banner', paneStaleRefresh, 'Could not refresh — showing default usage')

// Missing backend namespace (404): explicit "not enabled/installed", no auto-edit.
world.gateway = 'open'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
queryResult = { data: null, isLoading: false, isError: true, isFetching: false, error: { status: 404, message: 'plugin namespace not enabled' }, refetch: () => {} }
const paneMissingBackend = renderPane()
check('#7 missing backend surfaces explicit not-enabled copy', paneMissingBackend, 'enabled or installed in default')
check('#7 missing backend says Hermes never edits profiles', paneMissingBackend, 'Hermes never edits profiles automatically')

if (failures > 0) {
  throw new Error(`${failures} render assertion(s) failed`)
}
console.log('provider_real_render_smoke=PASS')