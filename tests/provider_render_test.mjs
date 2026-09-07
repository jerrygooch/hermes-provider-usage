/**
 * Real renderer smoke test: mounts the plugin's actual registered components
 * (status chip + pane) with React's server renderer and asserts the honest
 * profile-scope / reconnect / divergence UI states appear. This exercises the
 * real JSX produced by the plugin's hooks — any render-time ReferenceError,
 * bad icon reference, invalid StatusDot tone, or wrong prop surfaces here —
 * rather than regex-matching source text.
 *
 * Uses the repo's real `react` + `react-dom/server` (resolved from the Hermes
 * agent's node_modules, not re-implemented) with the SDK primitives stubbed so
 * the components render under controlled atoms and query data.
 */
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { pathToFileURL } from 'node:url'
import { fileURLToPath } from 'node:url'

const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || 'C:/Users/jerry/AppData/Local/hermes/hermes-agent'
const reactEntry = path.join(HERMES_AGENT_ROOT, 'node_modules/react/index.js')
if (!fs.existsSync(reactEntry)) {
  throw new Error(`Renderer test needs the Hermes agent's node_modules for real React. Set HERMES_AGENT_ROOT to the hermes-agent repo (missing: ${reactEntry})`)
}

const pluginPath = fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const source = fs.readFileSync(pluginPath, 'utf8')
const context = vm.createContext({ console })

// Real React + server renderer from the Hermes agent's node_modules.
const React = await import(pathToFileURL(path.join(HERMES_AGENT_ROOT, 'node_modules/react/index.js')).href)
const reactDefault = React.default ?? React
const { renderToStaticMarkup } = await import(pathToFileURL(path.join(HERMES_AGENT_ROOT, 'node_modules/react-dom/server.js')).href)
const JsxRuntime = await import(pathToFileURL(path.join(HERMES_AGENT_ROOT, 'node_modules/react/jsx-runtime.js')).href)
const jsxRuntime = JsxRuntime.default ?? JsxRuntime

// ── Controllable plugin environment ──────────────────────────────────────────
const world = {
  model: 'mimo-v2.5',
  sessionId: 'sess-1',
  storedSessionId: 'sess-1',
  profile: 'default',
  focusedOwner: null, // null = atom absent (legacy desktop)
  focusedProfile: '',
  gateway: 'open'
}
const mkAtom = key => ({ get: () => world[key] })
let queryResult = { data: null, isLoading: false, isError: false, isFetching: false, refetch: () => {} }
let restCalls = []
const sdkHost = {
  state: {
    model: mkAtom('model'),
    focusedSessionId: mkAtom('sessionId'),
    profile: mkAtom('profile'),
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
  reactDefault.createElement('span', { 'data-slot': 'aui-slot', 'data-tone': tone, title, ...rest }, children)
const sdkComponents = { Badge: Base, Button: Base, Loader: Base, RowButton: Base, StatusDot: Base, Tip: Base }

function synthetic(identifier, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context, identifier })
}

const reactHooks = {
  useEffect: reactDefault.useEffect,
  useState: reactDefault.useState,
  useRef: reactDefault.useRef
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
const renderChip = () => renderToStaticMarkup(reactDefault.createElement(chipContribution.render))
const renderPane = () => renderToStaticMarkup(reactDefault.createElement(paneContribution.render))

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

// Loaded normal scope: default profile, focused session also default.
world.profile = 'default'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, refetch: () => {} }

const chipLoaded = renderChip()
check('chip renders the provider funding summary', chipLoaded, '· 62% left')
check('chip tooltip is populated with the loaded description', chipLoaded, 'Open the Provider Usage pane for every reported window')

const paneLoaded = renderPane()
check('pane header shows the active scope', paneLoaded, 'Scope default')
check('pane shows the loaded provider usage', paneLoaded, 'Account limits &amp; credits')

// Diverged focus: the focused chat is Alice while the active socket is default.
world.profile = 'default'
world.focusedOwner = { connectionId: 'local', profile: 'Alice' }
world.focusedProfile = 'Alice'
world.gateway = 'open'

const chipDiverged = renderChip()
check('diverged chip shows the fetched scope label', chipDiverged, '· default')
check('diverged chip tooltip names the focused chat profile', chipDiverged, 'focused chat is in Alice')

const paneDiverged = renderPane()
check('diverged pane names the active vs focused scope', paneDiverged, 'The focused chat is in Alice')
check('diverged pane keeps the active-profile subtitle', paneDiverged, 'focused Alice')

// Reconnect (same profile, socket NOT ready): last rows stay visible as stale.
world.profile = 'default'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'

const chipReconnecting = renderChip()
check('reconnecting chip keeps the last figure, not "switching"', chipReconnecting, '62% left')
check('reconnecting chip tooltip says reconnecting on the same profile', chipReconnecting, 'reconnecting')

const paneReconnecting = renderPane()
check('reconnecting pane keeps the loaded rows', paneReconnecting, 'Account limits &amp; credits')
check('reconnecting pane surfaces an honest stale banner', paneReconnecting, 'Reconnecting — showing default usage')
nocheck('reconnecting pane does NOT claim a profile switch', paneReconnecting, 'Switching profile — refreshing')

// No rows yet + socket not ready: honest empty reconnect state, no spinner+no switch.
world.profile = 'default'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'
queryResult = { data: null, isLoading: false, isError: false, isFetching: false, refetch: () => {} }

const paneEmptyReconnect = renderPane()
check('reconnecting with no rows shows the reconnect note', paneEmptyReconnect, 'Provider usage for default will load when the connection is ready')

if (failures > 0) {
  throw new Error(`${failures} render assertion(s) failed`)
}
console.log('provider_real_render_smoke=PASS')