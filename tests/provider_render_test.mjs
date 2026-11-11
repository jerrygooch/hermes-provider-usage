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
const sdkComponents = { Badge: Base, Button: Base, Loader: Base, RowButton: Base, StatusDot: Base, Tip: Base, Popover: Base, PopoverContent: Base, PopoverTrigger: Base }

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
  useValue: atomLike => (atomLike && typeof atomLike.get === 'function' ? atomLike.get() : atomLike ?? null),
  ROUTES_AREA: 'routes',
  SIDEBAR_NAV_AREA: 'sidebar-nav',
  PALETTE_AREA: 'palette'
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

// Register the plugin and capture the chip + page render functions.
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
const pageContribution = contributions.find(c => c.area === 'routes')
if (!chipContribution || !pageContribution) throw new Error('chip/page not registered')
const renderChip = () => renderToStaticMarkup(React.createElement(chipContribution.render))
const renderPage = () => renderToStaticMarkup(React.createElement(pageContribution.render))

// The provider is resolved asynchronously from the focused session. Under SSR
// effects do not run, so seed the account memory the hook starts from (a real
// mounted lifecycle is covered by plugin_lifecycle_test.mjs).
const { activeSourceId, rememberProvider, DefinitionPanel, DefinitionBadge, CatalogSection, catalogSetupText, ConnectionCardsSection, connectionSetupText } = mod.namespace
function seedProvider(profile = 'default', provider = 'xai-oauth') {
  world.sessionId = ''
  rememberProvider(activeSourceId(world.connectionId, profile), provider)
}

const fixture = (fetchedAt, account = 'default') => ({
  version: 1,
  fetched_at: fetchedAt,
  account_profile: account,
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
seedProvider('default')
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const chipLoaded = renderChip()
check('chip renders the provider funding summary', chipLoaded, '· 62% left')
check('chip tooltip is populated with the loaded description', chipLoaded, 'Open the Provider Usage pane for every reported window')

const pageLoaded = renderPage()
check('page header shows the active scope', pageLoaded, 'Scope default')
check('page shows the loaded provider usage', pageLoaded, 'Account limits &amp; credits')

// Verified active focus (connection-qualified owner == active source).
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = { connectionId: 'local', profile: 'default' }
world.focusedProfile = 'default'
world.gateway = 'open'
seedProvider('default')
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }
const chipVerified = renderChip()
check('verified focus renders normal usage (not a gate)', chipVerified, '62% left')

// Local bot profile: the focused chat is Alice, the active socket is default,
// both on this machine. v0.9+ fetches Alice with profile scope instead of
// forcing a profile switch.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = { connectionId: 'local', profile: 'Alice' }
world.focusedProfile = 'Alice'
world.gateway = 'open'
seedProvider('Alice')
queryResult = { data: fixture('2026-09-07T12:00:00Z', 'Alice'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }
const chipLocalBot = renderChip()
check('local bot chip renders the focused profile usage', chipLocalBot, '62% left')
nocheck('local bot chip is not gated', chipLocalBot, 'Other connection')

const pageLocalBot = renderPage()
check('local bot page names the scope profile', pageLocalBot, 'Scope Alice')
check('local bot page keeps the account rows', pageLocalBot, 'Account limits &amp; credits')

// Other connection: same profile name on another socket is unreachable. Gate;
// never fetch or display this machine's same-named account.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = { connectionId: 'remote-focus', profile: 'Alice' }
world.focusedProfile = 'Alice'
world.gateway = 'open'
const chipRemote = renderChip()
check('#2 remote chip shows a gate', chipRemote, 'Other connection')
nocheck('#2 remote chip does NOT show local accounting', chipRemote, '62% left')

const pageRemote = renderPage()
check('#2 remote page names the focused profile', pageRemote, 'Alice is on another connection')
check('#2 remote page explains the connection boundary', pageRemote, 'cannot read that connection')
nocheck('#2 remote page does NOT display local-account rows', pageRemote, 'Account limits &amp; credits')

// Reconnect (same profile, socket NOT ready): last rows stay visible as stale.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'
seedProvider('default')
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const chipReconnecting = renderChip()
check('reconnecting chip keeps the last figure, not "switching"', chipReconnecting, '62% left')
check('reconnecting chip tooltip says reconnecting on the same profile', chipReconnecting, 'reconnecting')

const pageReconnecting = renderPage()
check('reconnecting page keeps the loaded rows', pageReconnecting, 'Account limits &amp; credits')
check('reconnecting page surfaces an honest stale banner', pageReconnecting, 'Reconnecting — showing default usage')
nocheck('reconnecting page does NOT claim a profile switch', pageReconnecting, 'Switching profile — refreshing')

// No rows yet + socket not ready: honest empty reconnect state.
world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'closed'
queryResult = { data: null, isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {} }

const pageEmptyReconnect = renderPage()
check('reconnecting with no rows shows the reconnect note', pageEmptyReconnect, 'Provider usage for default will load when the connection is ready')

// Refetch failure with rows: stale indication must surface in panel.
world.gateway = 'open'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
seedProvider('default')
queryResult = { data: fixture('2026-09-07T12:00:00Z'), isLoading: false, isError: true, isFetching: false, error: new Error('boom'), refetch: () => {} }
const pageStaleRefresh = renderPage()
check('#5 refetch-error with rows keeps the rows', pageStaleRefresh, 'Account limits &amp; credits')
check('#5 refetch-error with rows surfaces a stale banner', pageStaleRefresh, 'Could not refresh — showing default usage')

// Missing backend namespace (404): explicit "not enabled/installed", no auto-edit.
world.gateway = 'open'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
queryResult = { data: null, isLoading: false, isError: true, isFetching: false, error: { status: 404, message: 'plugin namespace not enabled' }, refetch: () => {} }
const pageMissingBackend = renderPage()
check('#7 missing backend surfaces explicit not-enabled copy', pageMissingBackend, 'enabled or installed in default')
check('#7 missing backend says Hermes never edits profiles', pageMissingBackend, 'Hermes never edits profiles automatically')

// Declarative definition row + available-to-connect catalog.
const definitionRow = {
  id: 'github-rate-limit',
  label: 'GitHub API rate limit',
  definition: true,
  definition_id: 'github-rate-limit',
  definition_version: 1,
  definition_source: 'bundled',
  state: 'ok',
  available: true,
  capability: 'usage',
  label: 'GitHub API rate limit',
  plan: 'Rate limit',
  limits: [{ id: 'default', label: 'GitHub REST API', windows: [
    { label: 'Core', kind: 'rolling', rolling: true, unit: 'requests', used: 5, limit: 60, remaining: 55, used_percent: 8.33, remaining_percent: 91.67, reset_at: '2026-11-11T03:03:07Z', detail: '5 of 60 requests' }
  ] }],
  balances: [],
  details: ['GitHub REST API request windows for this machine.'],
  provenance: {
    kind: 'declarative',
    definition_id: 'github-rate-limit',
    definition_version: 1,
    definition_source: 'bundled',
    definition_file: 'github-rate-limit.json',
    docs_url: 'https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api',
    endpoint_host: 'api.github.com',
    fetched_at: '2026-11-11T02:03:07Z',
    checked_at: '2026-11-11T02:03:08Z',
    cache: 'hit',
    ttl_seconds: 60,
    scope: 'default',
    overrides: null
  },
  freshness: { fetched_at: '2026-11-11T02:03:07Z', age_seconds: 42, stale: false, ttl_seconds: 60 }
}

const definitionCatalog = {
  version: 1,
  profile: 'default',
  directory: '$HERMES_HOME/provider-usage/providers',
  counts: { connected: 1, available: 1, invalid: 1 },
  definitions: [
    { id: 'github-rate-limit', name: 'GitHub API rate limit', state: 'connected', source: 'bundled', version: 1, host: 'api.github.com', setup: { directory: '$HERMES_HOME/provider-usage/providers', file: 'github-rate-limit.json' } },
    { id: 'moonshot-balance', name: 'Moonshot / Kimi balance', description: 'Prepaid API balance reported by the Moonshot Open Platform.', state: 'available', source: 'bundled', stability: 'stable', version: 1, host: 'api.moonshot.ai', missing_credentials: ['MOONSHOT_API_KEY'], setup: { directory: '$HERMES_HOME/provider-usage/providers', file: 'moonshot-balance.json' }, docs_url: 'https://platform.kimi.ai/docs/api/balance' },
    { id: 'broken-def', name: 'Broken definition', state: 'invalid', source: 'profile', errors: ['mapping.windows[0].label: must not be empty'], warnings: [] }
  ]
}

world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
// Seed the definition itself as the focused provider so the ACTIVE card is the
// declarative provider — the browser harness gets the same state from the
// fixture's session.info event, but SSR effects never run.
seedProvider('default', 'github-rate-limit')
queryResult = {
  data: { ...fixture('2026-11-11T02:03:07Z'), providers: [definitionRow, ...fixture('2026-11-11T02:03:07Z').providers], catalog: definitionCatalog },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: () => {}
}
const pageDefinitions = renderPage()
check('catalog section is titled provider definitions', pageDefinitions, 'Provider definitions')
check('catalog section renders available-to-connect entries', pageDefinitions, 'Available to connect')
check('catalog names the missing credential', pageDefinitions, 'Needs MOONSHOT_API_KEY')
check('legacy catalog fallback admits it cannot type the credential', pageDefinitions, 'credential type not reported by this backend')
check('catalog keeps invalid definitions visible with an error', pageDefinitions, 'mapping.windows[0].label: must not be empty')
check('catalog explains the safe data-only model', pageDefinitions, 'No scripts, no eval')
check('definition row shows its state badge', pageDefinitions, 'Connected')
check('definition row keeps its windows', pageDefinitions, 'Core')
check('definition card names the read-only boundary', pageDefinitions, 'Rate limit · read-only definition')
nocheck('definition card does not claim a subscription allowance', pageDefinitions, 'Rate limit subscription allowance')
nocheck('rate-limit definition does not claim a subscription renewal', pageDefinitions, 'Subscription renewal date is not exposed')

const panelHtml = renderToStaticMarkup(React.createElement(DefinitionPanel, { row: definitionRow }))
check('definition panel names the bundled source', panelHtml, 'Bundled definition github-rate-limit v1')
check('definition panel shows cache and scope provenance', panelHtml, 'cached response')
check('definition panel shows the endpoint host', panelHtml, 'api.github.com')
check('definition panel shows the docs URL', panelHtml, 'docs.github.com')

// ── Declarative honesty: state badges, credential types, warnings ───────────
const renderCatalog = definitions => renderToStaticMarkup(React.createElement(CatalogSection, {
  catalog: { version: 1, profile: 'default', directory: '$HERMES_HOME/provider-usage/providers', definitions }
}))
const renderBadge = row => renderToStaticMarkup(React.createElement(DefinitionBadge, { row }))

check('ok definition badge is explicitly connected', renderBadge({ definition: true, state: 'ok' }), 'Connected')
check('untrusted definition badge asks for approval', renderBadge({ definition: true, state: 'untrusted' }), 'Approval required')
check('requires_approval row state asks for approval', renderBadge({ definition: true, state: 'requires_approval' }), 'Approval required')
check('blocked definition badge says blocked', renderBadge({ definition: true, state: 'blocked' }), 'Blocked')
const unknownBadge = renderBadge({ definition: true, state: 'waiting_for_review' })
check('unknown definition state is neutral', unknownBadge, 'Unknown state')
nocheck('unknown definition state never claims connected', unknownBadge, 'Connected')

const untrustedEntry = {
  id: 'needs-approval',
  name: 'Needs approval',
  state: 'requires_approval',
  source: 'profile',
  version: 1,
  host: 'api.example.com',
  credential_refs: [{ source: 'hermes_provider', provider: 'moonshot', field: 'api_key' }],
  missing_credentials: ['moonshot.api_key'],
  setup: {
    directory: '$HERMES_HOME/provider-usage/providers',
    file: 'needs-approval.json',
    approve: 'python scripts/approve_definition.py <definition.json>'
  },
  warnings: []
}
const untrustedHtml = renderCatalog([untrustedEntry])
check('untrusted catalog state asks for approval', untrustedHtml, 'Approval required')
check('untrusted card names the Hermes credential type', untrustedHtml, 'Hermes credential moonshot.api_key')
check('untrusted card names the destination host', untrustedHtml, 'Destination: api.example.com')
check('untrusted card points at the CLI approval command', untrustedHtml, 'scripts/approve_definition.py')
check('untrusted card makes approval a human CLI step', untrustedHtml, 'Approval is a human CLI step')
nocheck('untrusted card never claims connected', untrustedHtml, 'Connected')
const aliasHtml = renderCatalog([{ ...untrustedEntry, id: 'needs-approval-alias', state: 'untrusted' }])
check('untrusted catalog alias also asks for approval', aliasHtml, 'Approval required')

const blockedHtml = renderCatalog([{
  id: 'blocked-provider', name: 'Blocked provider', state: 'blocked', source: 'profile', version: 1,
  host: 'api.blocked.example', credential_refs: [{ source: 'env', name: 'BLOCKED_KEY' }],
  missing_credentials: ['BLOCKED_KEY'], setup: { file: 'blocked-provider.json' }
}])
check('blocked catalog state says blocked', blockedHtml, 'Blocked')
check('blocked card explains no fetch happened', blockedHtml, 'Nothing is fetched or displayed from it.')
nocheck('blocked card never claims connected', blockedHtml, 'Connected')

const unknownHtml = renderCatalog([{
  id: 'future-provider', name: 'Future provider', state: 'waiting_for_review', source: 'profile', version: 1,
  host: 'api.future.example', setup: { file: 'future-provider.json' }
}])
check('unknown catalog state is neutral', unknownHtml, 'Unknown state')
nocheck('unknown catalog state never claims connected', unknownHtml, 'Connected')

const mixedCatalogHtml = renderCatalog([
  { id: 'connected-one', name: 'Connected one', state: 'connected', source: 'bundled', version: 1 },
  { id: 'unknown-one', name: 'Unknown one', state: 'waiting', source: 'profile', version: 1 }
])
check('catalog counts only explicit connected states', mixedCatalogHtml, '1 connected')
nocheck('catalog does not count unknown states as connected', mixedCatalogHtml, '2 connected')

const legacyEntry = {
  id: 'legacy-provider', name: 'Legacy provider', state: 'available', source: 'profile', version: 1,
  host: 'api.legacy.example', missing_credentials: ['LEGACY_API_KEY'], setup: { file: 'legacy-provider.json' }
}
const legacyHtml = renderCatalog([legacyEntry])
check('legacy missing credential is still named', legacyHtml, 'Needs LEGACY_API_KEY')
check('legacy fallback says the type is not reported', legacyHtml, 'credential type not reported by this backend')
nocheck('legacy fallback does not invent an environment type', legacyHtml, 'environment variable')
const envFallbackHtml = renderCatalog([{
  ...legacyEntry,
  id: 'env-fallback-provider',
  missing_credentials: undefined,
  setup: { file: 'env-fallback-provider.json', env: ['ENV_FALLBACK_KEY'] }
}])
check('legacy setup.env fallback is still read', envFallbackHtml, 'ENV_FALLBACK_KEY')
const unknownSourceHtml = renderCatalog([{ ...legacyEntry, id: 'unknown-source-provider', source: undefined }])
check('catalog unknown source is labeled honestly', unknownSourceHtml, 'Source not reported')
nocheck('catalog does not invent an official source', unknownSourceHtml, 'Official')
nocheck('catalog helper text avoids the quaternary contrast token', untrustedHtml, '--ui-text-quaternary')

const warningEntry = {
  id: 'warned-provider', name: 'Warned provider', state: 'unverified', source: 'profile', version: 1,
  host: 'api.warned.example', credential_refs: [{ source: 'env', name: 'WARN_KEY' }],
  warnings: ["Mapping path 'data.windows' is not an array, so no windows were read."],
  setup: { file: 'warned-provider.json' }
}
const warningHtml = renderCatalog([warningEntry])
check('catalog surfaces mapping warnings', warningHtml, 'is not an array, so no windows were read.')
check('catalog warning copy is labeled', warningHtml, 'Warnings:')

const copyText = catalogSetupText(untrustedEntry)
check('copied setup names the destination host', copyText, 'Destination: api.example.com')
check('copied setup names the credential type', copyText, 'Hermes credential moonshot.api_key')
check('copied setup names the CLI approval command', copyText, 'python scripts/approve_definition.py')
check('copied setup requires the interactive approve word', copyText, 'type "approve"')
check('copied setup says copying is not approval', copyText, 'Copying or saving does not approve it')
check('copied setup denies UI trust and fetching', copyText, 'never grants trust or fetches data for you')
nocheck('copied setup does not report approval as done', copyText, 'Approved:')

// Balance detail must survive, and a missing currency must not become USD.
const balanceDetailRow = {
  id: 'example-balance',
  label: 'Example balance',
  definition: true,
  definition_id: 'example-balance',
  definition_version: 1,
  definition_source: 'profile',
  state: 'ok',
  available: true,
  capability: 'balance',
  plan: 'Prepaid',
  limits: [],
  balances: [{
    label: 'Prepaid balance',
    amount: 12.5,
    unit: 'currency',
    detail: 'Granted by support on Nov 1.'
  }],
  details: [],
  provenance: {
    kind: 'declarative',
    definition_id: 'example-balance',
    definition_version: 1,
    definition_source: 'profile',
    definition_file: 'example-balance.json',
    endpoint_host: 'api.example.com',
    cache: 'none',
    ttl_seconds: 300,
    scope: 'default',
    overrides: null
  },
  freshness: { fetched_at: '2026-11-11T02:03:07Z', age_seconds: 42, stale: false, ttl_seconds: 300 }
}

world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
seedProvider('default', 'example-balance')
queryResult = {
  data: { ...fixture('2026-11-11T02:03:07Z'), providers: [balanceDetailRow, ...fixture('2026-11-11T02:03:07Z').providers], catalog: { definitions: [] } },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: () => {}
}
const pageBalanceDetail = renderPage()
check('balance detail from the mapping is rendered', pageBalanceDetail, 'Granted by support on Nov 1.')
check('unknown balance currency is labeled unknown', pageBalanceDetail, 'currency not reported')
nocheck('unknown balance currency is not relabeled USD', pageBalanceDetail, '$12.50')
nocheck('definition notes do not invent a subscription renewal', pageBalanceDetail, 'Subscription renewal date is not exposed')

// Legacy built-in USD balances still use the dollar sign.
const usdBalanceRow = {
  id: 'nous', label: 'Nous Portal', available: true, capability: 'balance', plan: 'API credits',
  limits: [], balances: [{ label: 'Balance', amount: 43.5, currency: 'USD' }], details: []
}
seedProvider('default', 'nous')
queryResult = {
  data: { ...fixture('2026-11-11T02:03:07Z'), providers: [usdBalanceRow, ...fixture('2026-11-11T02:03:07Z').providers] },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: () => {}
}
const pageUsdBalance = renderPage()
check('legacy USD built-in balance keeps the dollar sign', pageUsdBalance, '$43.50')
nocheck('legacy USD built-in is not labeled currency-unknown', pageUsdBalance, 'currency not reported')

// Always-listed popular-provider cards: no account, no credential, no number.
const connectionCards = [
  {
    id: 'anthropic', name: 'Claude / Anthropic', provider: 'anthropic', state: 'not_connected',
    state_detail: 'No Claude / Anthropic credentials were found in this profile.',
    configured: false, credential_source: 'none',
    description: 'Claude subscription limits through Hermes read-only Claude Code sign-in.',
    scopes: [
      { id: 'claude-subscription', label: 'Claude subscription (Pro, Max, Ultra)', state: 'not_connected', detail: 'Claude Code reports a 5-hour session limit and a weekly limit.', docs_url: 'https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan' },
      { id: 'anthropic-api', label: 'Anthropic API usage (Admin API)', state: 'needs_permission', detail: 'Requires an Admin API key with the admin role; individual accounts cannot use the Admin API.', docs_url: 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api' }
    ],
    setup: { summary: 'Sign in with Claude Code in this profile to read subscription limits.', env: ['ANTHROPIC_API_KEY'], command: 'claude', links: [{ label: 'Admin API', url: 'https://platform.claude.com/docs/en/manage-claude/admin-api' }] },
    docs_url: 'https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan',
    links: [{ label: 'Usage and Cost API', url: 'https://platform.claude.com/docs/en/manage-claude/usage-cost-api' }],
    verification: 'No live account in this build. Card states and metadata are fixture-tested.'
  },
  {
    id: 'gemini', name: 'Google Gemini API', provider: 'gemini', state: 'not_connected',
    state_detail: 'No Google Gemini API credentials were found in this profile.',
    configured: false, credential_source: 'none',
    description: 'Gemini Developer API keys for inference. Usage is visible in Google AI Studio.',
    scopes: [
      { id: 'gemini-api-key', label: 'Gemini API key (Google AI Studio)', state: 'not_connected', detail: 'Google AI Pro/Ultra subscription benefits apply in the AI Studio web UI only; direct Gemini API use is billed separately.', docs_url: 'https://ai.google.dev/gemini-api/docs/google-ai-plans' },
      { id: 'usage-billing', label: 'Usage and prepay balance', state: 'unavailable', detail: 'No supported read-only balance/quota endpoint for an API key.', docs_url: 'https://ai.google.dev/gemini-api/docs/billing' }
    ],
    setup: { summary: 'Create a Gemini API key in Google AI Studio.', env: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'], command: '', links: [{ label: 'Usage dashboard', url: 'https://aistudio.google.com/usage' }] },
    docs_url: 'https://ai.google.dev/gemini-api/docs/api-key',
    links: [{ label: 'Billing', url: 'https://aistudio.google.com/billing' }],
    verification: 'No live account and no network adapter; rendering is fixture-tested.'
  },
  {
    id: 'zai', name: 'Z.ai / GLM', provider: 'zai', state: 'not_connected',
    state_detail: 'No Z.ai / GLM credentials were found in this profile.',
    configured: false, credential_source: 'none',
    description: 'GLM Coding Plan or standard pay-as-you-go API access.',
    scopes: [
      { id: 'coding-plan', label: 'GLM Coding Plan (subscription)', state: 'not_connected', detail: 'A 5-hour limit and a weekly limit, shared across supported tools.', docs_url: 'https://docs.z.ai/devpack/overview' },
      { id: 'standard-api', label: 'Standard API (pay-as-you-go)', state: 'not_connected', detail: 'Standard API keys bill per token from account balance.', docs_url: 'https://docs.z.ai/devpack/notice/api-key-management' },
      { id: 'endpoints', label: 'Regional endpoints', state: 'info', detail: 'Global host: api.z.ai. China host: open.bigmodel.cn.' }
    ],
    setup: { summary: 'Create a Coding Plan or Standard API key in Z.ai.', env: ['GLM_API_KEY', 'ZAI_API_KEY'], command: '', links: [{ label: 'API keys', url: 'https://z.ai/manage-apikey/apikey-list' }] },
    docs_url: 'https://docs.z.ai/devpack/overview',
    links: [{ label: 'Subscription and usage', url: 'https://z.ai/manage-apikey/subscription' }],
    verification: 'No live account and no core account-usage hook; rendering is fixture-tested.'
  }
]

world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
seedProvider('default', '')
queryResult = {
  data: { ...fixture('2026-11-11T02:03:07Z'), providers: [], connections: connectionCards, catalog: { definitions: [] } },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: () => {}
}
const pageConnections = renderPage()
check('unconnected page still lists Claude / Anthropic', pageConnections, 'Claude / Anthropic')
check('unconnected page still lists Google Gemini API', pageConnections, 'Google Gemini API')
check('unconnected page still lists Z.ai / GLM', pageConnections, 'Z.ai / GLM')
check('unconnected cards say Not connected', pageConnections, 'Not connected')
check('Anthropic card separates admin API permission', pageConnections, 'Permission needed')
check('Anthropic card names the Admin API boundary', pageConnections, 'individual accounts cannot use the Admin API')
check('Gemini usage scope is not available', pageConnections, 'Not available')
check('Gemini explains subscription vs API billing', pageConnections, 'Google AI Pro/Ultra subscription benefits apply in the AI Studio web UI only')
check('Z.ai card names both regional hosts', pageConnections, 'open.bigmodel.cn')
check('cards state that no balance is inferred', pageConnections, 'No balance or quota is inferred.')
nocheck('unconnected cards do not fabricate zero dollars', pageConnections, '$0.00')
nocheck('unconnected cards do not fabricate a zero meter', pageConnections, '0% left')
nocheck('old payloads without connections hide the section', pageLoaded, 'Popular providers')

const configuredConnections = connectionCards.map(card => {
  if (card.id === 'anthropic') {
    return {
      ...card,
      state: 'connected_no_usage',
      configured: true,
      credential_source: 'env',
      state_detail: 'An Anthropic API key is configured for inference. Claude subscription limits require a Claude Code OAuth sign-in.',
      scopes: card.scopes.map(scope => scope.id === 'claude-subscription'
        ? { ...scope, state: 'not_connected', state_detail: 'No Claude Code OAuth sign-in was found; an API key is inference-only.' }
        : scope)
    }
  }
  if (card.id === 'gemini') {
    return {
      ...card,
      state: 'connected_no_usage',
      configured: true,
      credential_source: 'config',
      state_detail: 'A Gemini API key is configured for inference. Usage and prepay balance are shown in Google AI Studio.',
      scopes: card.scopes.map(scope => scope.id === 'gemini-api-key' ? { ...scope, state: 'connected' } : scope)
    }
  }
  return {
    ...card,
    state: 'connected_no_usage',
    configured: true,
    credential_source: 'env',
    state_detail: 'A Z.AI credential is configured for inference. The key type is not verified.',
    scopes: card.scopes.map(scope => scope.id === 'endpoints' ? scope : {
      ...scope,
      state: 'unverified',
      state_detail: "The configured key's product type (Coding Plan vs Standard API) is not reported."
    })
  }
})
queryResult = {
  data: { ...fixture('2026-11-11T02:03:07Z'), providers: [], connections: configuredConnections, catalog: { definitions: [] } },
  isLoading: false,
  isError: false,
  isFetching: false,
  error: null,
  refetch: () => {}
}
const pageConfiguredConnections = renderPage()
check('configured inference cards say usage unavailable', pageConfiguredConnections, 'Connected · usage unavailable')
check('Anthropic API key is not called a subscription', pageConfiguredConnections, 'API key is inference-only')
check('Z.ai key type is explicitly not verified', pageConfiguredConnections, 'Not verified')
check('Gemini usage remains not available after key setup', pageConfiguredConnections, 'Not available')
nocheck('configured cards still show no fabricated zero meter', pageConfiguredConnections, '0% left')

const copiedConnection = connectionSetupText(connectionCards[1])
check('copied connection setup names the environment key', copiedConnection, 'GEMINI_API_KEY')
check('copied connection setup names the official destination', copiedConnection, 'https://ai.google.dev/gemini-api/docs/api-key')
nocheck('copied connection setup contains no credential value', copiedConnection, 'sk-')

// Banked-reset counts: an absent provider count is unknown, not zero. An
// explicit numeric 0 is a real reading and must stay 0.
function codexResetFixture(reset_credits) {
  return {
    version: 1,
    fetched_at: '2026-11-11T02:03:07Z',
    account_profile: 'default',
    active: { provider: 'openai-codex', model: 'gpt-5.2-codex' },
    default_provider: 'openai-codex',
    providers: [{
      id: 'openai-codex',
      label: 'OpenAI Codex',
      available: true,
      plan: 'Pro',
      limits: [{ id: 'default', label: 'Codex', windows: [{ label: 'Weekly', remaining_percent: 40 }] }],
      balances: [],
      details: [],
      reset_credits
    }]
  }
}

world.profile = 'default'
world.connectionId = 'local'
world.focusedOwner = null
world.focusedProfile = ''
world.gateway = 'open'
seedProvider('default', 'openai-codex')

queryResult = {
  data: codexResetFixture({ available: null, applicable: null }),
  isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {}
}
const missingResetCounts = renderPage()
check('absent banked reset counts say not reported', missingResetCounts,
  'Banked resets: not reported saved, not reported usable now')
nocheck('absent banked reset counts never become zero', missingResetCounts, 'Banked resets: 0 saved')

queryResult = {
  data: codexResetFixture({ available: 0, applicable: 0 }),
  isLoading: false, isError: false, isFetching: false, error: null, refetch: () => {}
}
const zeroResetCounts = renderPage()
check('explicit zero banked reset counts stay zero', zeroResetCounts,
  'Banked resets: 0 saved, 0 usable now')
nocheck('explicit zero is not replaced by not reported', zeroResetCounts,
  'Banked resets: not reported saved')

if (failures > 0) {
  throw new Error(`${failures} render assertion(s) failed`)
}
console.log('provider_real_render_smoke=PASS')