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
  activeSourceId,
  providerScopeKey,
  providerUsageQueryKey,
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

// ── Scope resolution: ctx.rest physically targets the ACTIVE socket source ──
// The account ctx.rest queries is identified by connection+profile, not profile
// alone. A focused session is interpretable ONLY when its connection-qualified
// owner matches that active source; anything else fails closed (diverged) and
// the pane/chip gate instead of fetching or probing a foreign account.

// Normal single-socket genuine profile-switch case: focus owner == active source.
const plain = resolveUsageScope({
  focusedOwner: { connectionId: 'local', profile: 'Alice' },
  hasFocusedOwner: true,
  focusedProfile: 'Alice',
  activeConnectionId: 'local',
  activeProfile: 'Alice'
})
check('focus==active: fetch profile is the active profile', plain.fetchProfile === 'Alice')
check('focus==active: not diverged', plain.diverged === false)
check('focus==active: focusProfile preserved', plain.focusProfile === 'Alice')
check('focus==active: source is active', plain.source === 'active')
check('focus==active: sourceId is connection-qualified', activeSourceId('local', 'Alice') === plain.sourceId)

// Legacy desktop: only the profile atom present (NO focus-owner atom), == active,
// single-connection.
const legacy = resolveUsageScope({ focusedOwner: null, hasFocusedOwner: false, focusedProfile: 'default', activeConnectionId: 'local', activeProfile: 'default' })
check('legacy focus==active: fetch active, not diverged', legacy.fetchProfile === 'default' && legacy.diverged === false)

// Divergence: focused bot tile on Alice, socket homed on default.
const diverged = resolveUsageScope({
  focusedOwner: { connectionId: 'local', profile: 'Alice' },
  hasFocusedOwner: true,
  focusedProfile: 'Alice',
  activeConnectionId: 'local',
  activeProfile: 'default'
})
check('focus!=active: fetched/keyed scope stays the ACTIVE socket source', diverged.fetchProfile === 'default')
check('focus!=active: divergence is surfaced (fail closed)', diverged.diverged === true)
check('focus!=active: focus identity preserved for the gate', diverged.focusProfile === 'Alice')

// #1 SAME-PROFILE REMOTE COLLISION: names both "Alice" but different
// connections — the focused remote chat must NOT be treated as the active
// Alice account. Connection qualification must catch it.
const sameProfileRemote = resolveUsageScope({
  focusedOwner: { connectionId: 'remote-focus', profile: 'Alice' },
  hasFocusedOwner: true,
  focusedProfile: 'Alice',
  activeConnectionId: 'remote-main',
  activeProfile: 'Alice'
})
check('#1 same-profile remote: names match but connections differ -> DIVERGED', sameProfileRemote.diverged === true)
check('#1 same-profile remote: never guesses same account', sameProfileRemote.source === 'foreign')

// #1 FAIL-CLOSED: active source identity unavailable -> cannot verify focus.
const unverifiable = resolveUsageScope({
  focusedOwner: { connectionId: 'local', profile: 'Alice' },
  hasFocusedOwner: true,
  focusedProfile: 'Alice',
  activeConnectionId: '',
  activeProfile: 'Alice'
})
check('#1 unverifiable active source: fail closed -> DIVERGED', unverifiable.diverged === true)
check('#1 unverifiable: never serves data under an unverified account', unverifiable.source === 'foreign')

// Authoritative ambiguity: the SDK publishes the owner atom but its value is
// null (unresolved/ambiguous focused id) — the profile-only fallback must NOT
// be allowed to guess, even when focusedSessionProfile names a profile.
const ambiguous = resolveUsageScope({
  focusedOwner: null,
  hasFocusedOwner: true,
  focusedProfile: 'Alice',
  activeConnectionId: 'local',
  activeProfile: 'default'
})
check('#10 present-but-null focus owner fails closed (never profile-only bypass)', ambiguous.diverged === true && ambiguous.source === 'ambiguous')

// Absent legacy half-shape: focusedProfile missing entirely -> active wins.
const absent = resolveUsageScope({ focusedOwner: null, hasFocusedOwner: false, focusedProfile: '', activeConnectionId: 'worker', activeProfile: 'worker' })
check('no focus atoms: fall back to active profile, not diverged', absent.fetchProfile === 'worker' && absent.focusProfile === 'worker' && absent.diverged === false)

// Empty/whitespace active profile normalizes.
const emptyActive = resolveUsageScope({ focusedOwner: null, hasFocusedOwner: false, focusedProfile: '', activeConnectionId: '', activeProfile: '   ' })
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

// ── Query key: stable source, NO gateway state (reconnect must not lose rows) ──
const keyA = providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', activeSourceId('local', 'Alice'))
const keyB = providerUsageQueryKey('Bob', 'xai-oauth', 'grok-4.6', activeSourceId('local', 'Bob'))
check('keys differ across fetch sources', JSON.stringify(keyA) !== JSON.stringify(keyB))
check('key carries the FETCH source, not a focus hint', JSON.stringify(keyA) !== JSON.stringify(providerUsageQueryKey('focus-alice', 'xai-oauth', 'grok-4.6', activeSourceId('local', 'Alice'))))

// Same profile name on a DIFFERENT connection keys differently (no collision).
const keyAliceRemote = providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', activeSourceId('remote-main', 'Alice'))
check('#1 cache key is connection-qualified (no same-profile collision)', JSON.stringify(keyA) !== JSON.stringify(keyAliceRemote))

// The /overview payload is provider+model; the session does not change the
// request, so it must not fragment the cache (pane + chip share ONE key).
check('session id does not fragment the usage cache', JSON.stringify(keyA) === JSON.stringify(providerUsageQueryKey('Alice', 'xai-oauth', 'grok-4.6', activeSourceId('local', 'Alice'), 'any-session-id')))
// The key carries NO gateway slot: a reconnect with the SAME source yields the
// SAME key, so the last cached rows survive and render stale. (Live reconnect
// retention is exercised in the mounted hook harness; here we pin the shape.)
check('#4 query key carries no gateway slot (reconnect keeps rows)', !JSON.stringify(keyA).includes('"open"') && !JSON.stringify(keyA).includes('"closed"'))

// ── Provider memory is per SOURCE; initialProvider must not leak accounts ──
const aliceLocal = activeSourceId('local', 'Alice')
rememberProvider(aliceLocal, 'openai-codex')
check('provider remembered under its own connection-qualified source', rememberedProvider(aliceLocal) === 'openai-codex')
check('provider does not leak into another profile', rememberedProvider(activeSourceId('local', 'Bob')) === '')
// Same profile name, different connection -> separate memory (no remote collision).
const aliceRemote = activeSourceId('remote-main', 'Alice')
rememberProvider(aliceRemote, 'deepseek')
check('#1 provider memory is connection-qualified (remote Alice separate)', rememberedProvider(aliceRemote) === 'deepseek' && rememberedProvider(aliceLocal) === 'openai-codex')

// ── OpenCode Go: chip never hides a blocking/exhausted window, and ordering ──
// puts the BLOCKING meter FIRST so truncation can't cut it.
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
check('#6 blocking meter comes FIRST (not appended after 5h/wk)', chipBlocked.indexOf('mo 0%') < chipBlocked.indexOf('5h 44%'))

// A healthy monthly stays compressed out of the chip for readability.
const opencodeHealthy = structuredClone(opencodeBlockedMonthly)
opencodeHealthy.limits[0].windows[2].remaining_percent = 78
const chipHealthy = statusFundingSummary(opencodeHealthy, 'mimo-v2.5')
check('healthy monthly stays omitted from the compact chip', !chipHealthy.includes('mo'))

// If the whole 5h/wk+monthly surface is exhausted, nothing is hidden.
const opencodeAllGone = structuredClone(opencodeBlockedMonthly)
for (const w of opencodeAllGone.limits[0].windows) w.remaining_percent = 0
const chipAllGone = statusFundingSummary(opencodeAllGone, 'mimo-v2.5')
check('exhausted surface reports every zeroed window', chipAllGone.includes('mo 0%') && chipAllGone.includes('wk 0%') && chipAllGone.includes('5h 0%'))

if (failures > 0) {
  throw new Error(`${failures} behavioral assertion(s) failed`)
}
console.log('provider_scope_behavior_suite=PASS')