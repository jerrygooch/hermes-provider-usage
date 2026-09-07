import fs from 'node:fs'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

const pluginPath = fileURLToPath(new URL('../desktop/plugin.js', import.meta.url))
const source = fs.readFileSync(pluginPath, 'utf8')
const context = vm.createContext({ console })

const component = () => null
const sdkValues = {
  Badge: component,
  Button: component,
  Loader: component,
  RowButton: component,
  StatusDot: component,
  Tip: component,
  host: { state: { model: {}, focusedSessionId: {} }, onEvent: () => () => {}, request: async () => ({}), notify: () => {} },
  haptic: () => {},
  icons: new Proxy({}, { get: () => component }),
  useQuery: () => ({}),
  useValue: () => null
}
const reactValues = { useEffect: () => {}, useState: value => [value, () => {}], useRef: () => ({}) }
const jsxValues = { jsx: component, jsxs: component }

function synthetic(identifier, values) {
  return new vm.SyntheticModule(Object.keys(values), function () {
    for (const [key, value] of Object.entries(values)) this.setExport(key, value)
  }, { context, identifier })
}

const dependencies = new Map([
  ['@hermes/plugin-sdk', synthetic('@hermes/plugin-sdk', sdkValues)],
  ['react', synthetic('react', reactValues)],
  ['react/jsx-runtime', synthetic('react/jsx-runtime', jsxValues)]
])

const mod = new vm.SourceTextModule(source, { context, identifier: pluginPath })
await mod.link(specifier => {
  const dependency = dependencies.get(specifier)
  if (!dependency) throw new Error(`Unexpected import: ${specifier}`)
  return dependency
})
await mod.evaluate()

const { compactFundingSummary, fundingState, governingWindows, mergeOpenCodeRows, providerScopeKey, providerUsageQueryKey, statusFundingSummary } = mod.namespace
const window = (label, remaining) => ({ label, remaining_percent: remaining, used_percent: 100 - remaining })
const codex = {
  id: 'openai-codex',
  label: 'OpenAI Codex',
  available: true,
  plan: 'Prolite',
  limits: [
    { id: 'default', label: 'Codex', windows: [window('Weekly', 98)] },
    { id: 'gpt-5-3-codex-spark', label: 'GPT-5.3-Codex-Spark', windows: [window('GPT-5.3-Codex-Spark · 5-hour', 60), window('GPT-5.3-Codex-Spark · Weekly', 80)] }
  ],
  balances: [{ label: 'Extra usage balance', amount: 12.34, currency: 'USD' }],
  details: []
}
const plus = {
  ...codex,
  plan: 'Plus',
  limits: [{ id: 'default', label: 'Codex', windows: [window('5-hour', 75), window('Weekly', 50)] }]
}
const deepseek = {
  id: 'deepseek',
  label: 'DeepSeek',
  available: true,
  limits: [],
  balances: [{ label: 'Total balance', amount: 36.29, currency: 'USD' }],
  details: []
}

const xai = {
  id: 'xai-oauth',
  label: 'SuperGrok / xAI OAuth',
  plan: 'SuperGrok',
  available: true,
  limits: [{ id: 'default', label: 'SuperGrok', windows: [{ label: 'Subscription window', remaining_percent: 62 }] }],
  balances: [],
  details: []
}

const opencodeGo = {
  id: 'opencode-go',
  label: 'OpenCode',
  plan: 'Go subscription',
  available: true,
  limits: [{ id: 'go', label: 'Go subscription', windows: [window('5-hour', 100), window('Weekly', 100), window('Monthly', 85)] }],
  balances: [],
  products: [{ id: 'go', label: 'Go subscription', kind: 'subscription', available: true }],
  details: []
}
const opencodeZen = {
  id: 'opencode-zen',
  label: 'OpenCode',
  plan: 'Zen API credits',
  available: true,
  limits: [],
  balances: [],
  products: [{ id: 'zen', label: 'Zen API credits', kind: 'balance', available: true, details: ['API access authenticated; balance unavailable'] }],
  details: ['API access authenticated; balance unavailable']
}

const cases = [
  ['Pro GPT-5.6 uses shared weekly meter', compactFundingSummary(codex, 'gpt-5.6-sol'), 'wk 98%'],
  ['Pro GPT-6 Astra uses shared weekly meter', compactFundingSummary(codex, 'gpt-6-astra'), 'wk 98%'],
  ['Spark uses its own 5-hour and weekly meters', compactFundingSummary(codex, 'gpt-5.3-codex-spark'), '5h 60% · wk 80%'],
  ['Plus uses the 5-hour meter', compactFundingSummary(plus, 'gpt-5.6'), '5h 75%'],
  ['DeepSeek uses its API balance', compactFundingSummary(deepseek, 'deepseek-chat'), '$36.29'],
  ['Single subscription window stays concise', compactFundingSummary(xai, 'grok-4.6'), '62% left'],
  ['OpenCode Go shows every subscription window', compactFundingSummary(opencodeGo, 'mimo-v2.5'), '5h 100% · wk 100% · mo 85%'],
  ['OpenCode Zen never invents a credit balance', compactFundingSummary(opencodeZen, 'kimi-k2.5'), 'Zen balance unavailable']
]

const exhausted = structuredClone(codex)
exhausted.limits[0].windows[0].remaining_percent = 0
cases.push(['Exhausted normal subscription falls back to extra credits', compactFundingSummary(exhausted, 'gpt-5.6-sol'), '$12.34 extra'])
const sparkExhausted = structuredClone(codex)
sparkExhausted.limits[1].windows[1].remaining_percent = 0
cases.push(['Either exhausted Spark ceiling falls back to extra credits', compactFundingSummary(sparkExhausted, 'gpt-5.3-codex-spark'), '$12.34 extra'])

for (const [name, actual, expected] of cases) {
  if (actual !== expected) throw new Error(`${name}: expected ${expected}, received ${actual}`)
  console.log(`PASS ${name}: ${actual}`)
}

const proWindows = governingWindows(codex, 'gpt-5.6-sol').windows
if (proWindows.length !== 1 || proWindows[0].label !== 'Weekly') throw new Error('Pro normal-model window selection failed')
if (fundingState(deepseek, 'deepseek-chat').kind !== 'balance') throw new Error('DeepSeek funding selection failed')
if (xai.plan !== 'SuperGrok') throw new Error('SuperGrok tier must remain conservative')
const mergedOpenCode = mergeOpenCodeRows([codex, opencodeGo, opencodeZen], 'opencode-go')
const mergedRows = mergedOpenCode.filter(row => row.id === 'opencode-go' || row.id === 'opencode-zen')
if (mergedRows.length !== 1 || mergedRows[0].products.length !== 2) throw new Error('OpenCode product grouping failed')
if (statusFundingSummary(opencodeGo, 'mimo-v2.5') !== '5h 100% · wk 100%') throw new Error('OpenCode status summary should omit the monthly window')
if (!compactFundingSummary(opencodeGo, 'mimo-v2.5').includes('mo 85%')) throw new Error('OpenCode detailed summary must retain the monthly window')
const aliceKey = providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', 'open')
const chaosForgeKey = providerUsageQueryKey('ChaosForge', 'xai-oauth', 'grok-4.6', 'open')
const secondBotKey = providerUsageQueryKey('ChaosForge', 'xai-oauth', 'grok-4.6', 'open')
if (providerScopeKey('Alice', 'alice-session') === providerScopeKey('ChaosForge', 'chaos-session')) throw new Error('Focused provider scopes must differ between Alice and ChaosForge')
if (JSON.stringify(aliceKey) === JSON.stringify(chaosForgeKey)) throw new Error('Profile-scoped usage keys must not share between Alice and ChaosForge')
// The /overview request is provider+model only, so a session id must NOT fork
// the cache — pane and chip now share ONE key for the same profile/provider.
if (JSON.stringify(chaosForgeKey) !== JSON.stringify(secondBotKey)) throw new Error('Session ids must not split the usage cache; /overview is not session-scoped')
console.log('profile_scoped_toolbar_query_suite=PASS')
console.log('resolver_fixture_suite=PASS')
