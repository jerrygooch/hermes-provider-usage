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
const reactValues = { useEffect: () => {}, useState: value => [value, () => {}], useRef: () => ({}), useCallback: fn => fn }
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

const {
  providerUsageQueryKey,
  providerScopeKey,
  rememberProvider,
  rememberedProvider,
  resolveUsageScope,
  shouldEnterProfileSwitch,
  shouldSettleProfileSwitch,
  statusFundingSummary
} = mod.namespace

let failures = 0
function check(name, condition) {
  if (condition) {
    console.log(`PASS ${name}`)
  } else {
    failures += 1
    console.error(`FAIL ${name}`)
  }
}

// ── Scope resolution: ctx.rest physically targets the ACTIVE socket profile ──
// A focused session can belong to a different profile than the live socket
// (bot tile / multi-profile focus without a socket swap). The plugin's REST is
// routed by the active connection, so the fetched/keyed profile must be the
// ACTIVE profile; a differing focused profile is a labeling concern, never a
// reason to key the cache under a profile ctx.rest cannot reach.

// Normal single-socket / genuine profile-switch case: focus == active.
const plain = resolveUsageScope({
  focusedOwner: { connectionId: 'local', profile: 'Alice' },
  focusedProfile: 'Alice',
  activeProfile: 'Alice'
})
check('focus==active: fetch profile is the active profile', plain.fetchProfile === 'Alice')
check('focus==active: not diverged', plain.diverged === false)
check('focus==active: focusProfile equals active', plain.focusProfile === 'Alice')

// Legacy desktop: only focusedSessionProfile (a half-shape) present, == active.
const legacy = resolveUsageScope({ focusedOwner: null, focusedProfile: 'default', activeProfile: 'default' })
check('legacy focus==active: fetch active, not diverged', legacy.fetchProfile === 'default' && legacy.diverged === false)

// Divergence: focused bot tile on Alice while the socket is homed on default.
const diverged = resolveUsageScope({
  focusedOwner: { connectionId: 'local', profile: 'Alice' },
  focusedProfile: 'Alice',
  activeProfile: 'default'
})
check('focus!=active: fetched/keyed scope stays the ACTIVE socket profile', diverged.fetchProfile === 'default')
check('focus!=active: divergence is surfaced for honest labeling', diverged.diverged === true)
check('focus!=active: focus identity preserved for the scope note', diverged.focusProfile === 'Alice')

// Absent legacy half-shape: focusedProfile missing entirely -> active wins, no crash.
const absent = resolveUsageScope({ focusedOwner: null, focusedProfile: '', activeProfile: 'worker' })
check('no focus atoms: fall back to active profile, not diverged', absent.fetchProfile === 'worker' && absent.focusProfile === 'worker' && absent.diverged === false)

// Empty/whitespace active profile normalizes.
const emptyActive = resolveUsageScope({ focusedOwner: null, focusedProfile: '', activeProfile: '   ' })
check('blank active profile normalizes to default', emptyActive.fetchProfile === 'default')

// ── Profile-switch detection: never infer a switch from socket state alone ──
check('socket hiccup is NOT a profile switch', shouldEnterProfileSwitch('Alice', 'Alice') === false)
check('profile value change IS a switch', shouldEnterProfileSwitch('Alice', 'Bob') === true)
check('blank -> named first boot is a re-home', shouldEnterProfileSwitch('', 'default') === true)

// Settle: a ready gateway ends switching immediately; a stuck socket ends it
// after the bounded settle window (never an infinite 'switching' spinner).
check('ready gateway settles the switch', shouldSettleProfileSwitch(true, true, 0, 12_000) === true)
check('stuck gateway settles only after the bounded window', shouldSettleProfileSwitch(false, true, 20_000, 12_000) === true)
check('stuck gateway does NOT settle before the window', shouldSettleProfileSwitch(false, true, 4_000, 12_000) === false)
check('no switch in flight needs no settling', shouldSettleProfileSwitch(false, false, 0, 12_000) === false)

// ── Query key: pane and chip must be ONE key, and it must equal the fetch scope ──
const keyA = providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', 'open')
const keyB = providerUsageQueryKey('Bob', 'xai-oauth', 'grok-4.6', 'open')
check('keys differ across fetch profiles', JSON.stringify(keyA) !== JSON.stringify(keyB))
check('key carries the FETCH scope, not a focus hint', JSON.stringify(keyA) !== JSON.stringify(providerUsageQueryKey('focus-alice', 'xai-oauth', 'grok-4.6', 'open')))

// The /overview payload is provider+model; the session does not change the
// request, so it must not fragment the cache (pane using stored, chip using
// runtime id was the old split). Identical inputs -> identical key.
check('session id does not fragment the usage cache', JSON.stringify(keyA) === JSON.stringify(providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', 'open', 'any-session-id')))

// ── Provider memory is per fetch scope; initialProvider must not leakprofiles ──
rememberProvider('Alice', 'openai-codex')
check('provider remembered under its own fetch scope', rememberedProvider('Alice') === 'openai-codex')
check('provider does not leak into another profile', rememberedProvider('Bob') === '')
check('remembered lookup falls back to empty, not a cross-profile token', rememberedProvider('ChaosForge') !== 'openai-codex')

// ── OpenCode Go: the chip may compress to 5h/wk, but must NOT hide a blocking ──
// exhausted monthly window.
const opencodeBlockedMonthly = {
  id: 'opencode-go',
  label: 'OpenCode',
  available: true,
  plan: 'Go subscription',
  limits: [{
    id: 'go',
    label: 'Go subscription',
    windows: [
      { label: '5-hour', remaining_percent: 44 },
      { label: 'Weekly', remaining_percent: 61 },
      { label: 'Monthly', remaining_percent: 0 }
    ]
  }],
  balances: []
}
const chipBlocked = statusFundingSummary(opencodeBlockedMonthly, 'mimo-v2.5')
check('blocking exhausted monthly is surfaced in the chip', chipBlocked.includes('mo 0%'))
check('blocking exhausted monthly keeps its siblings visible', chipBlocked.includes('5h 44%') && chipBlocked.includes('wk 61%'))

// A healthy monthly stays compressed out of the chip for readability.
const opencodeHealthy = structuredClone(opencodeBlockedMonthly)
opencodeHealthy.limits[0].windows[2].remaining_percent = 78
const chipHealthy = statusFundingSummary(opencodeHealthy, 'mimo-v2.5')
check('healthy monthly stays omitted from the compact chip', !chipHealthy.includes('mo'))

// If the whole 5h/wk+monthly surface is exhausted, nothing is hidden.
const opencodeAllGone = structuredClone(opencodeBlockedMonthly)
for (const w of opencodeAllGone.limits[0].windows) w.remaining_percent = 0
const chipAllGone = statusFundingSummary(opencodeAllGone, 'mimo-v2.5')
check('exhausted surface reports every zeroed window', chipAllGone.includes('mo 0%') && chipAllGone.includes('wk 0%'))

if (failures > 0) {
  throw new Error(`${failures} behavioral assertion(s) failed`)
}
console.log('provider_scope_behavior_suite=PASS')