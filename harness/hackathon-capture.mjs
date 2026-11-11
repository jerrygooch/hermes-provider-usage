#!/usr/bin/env node
/**
 * Hackathon asset capture — Provider Usage component harness.
 *
 * Renders the REAL shipped plugin (desktop/plugin.js) with the real Hermes SDK
 * UI primitives and the built-in `nous` dark theme, then captures clean,
 * element-scoped PNGs for the public hackathon package. Every payload here is
 * synthetic SAMPLE data. This is a browser component harness, not a recording
 * of the packaged desktop app.
 *
 * Prerequisites:
 *   node harness/build.mjs
 *   native Chrome (HARNESS_CHROME) + a Hermes agent checkout (HERMES_AGENT_ROOT)
 *
 * Outputs:
 *   harness/dist/hackathon/raw/*.png       lossless working crops
 *   harness/dist/hackathon/records.json    text + geometry + state evidence
 *
 * The optional MP4 is recorded separately by
 * harness/hackathon-video-playwright.mjs (Playwright video + ffmpeg).
 *
 * The finalize step (harness/hackathon-finalize.py) optimizes/copies images,
 * strips metadata, validates the assets, and writes the public manifest.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const dist = path.join(__dirname, 'dist')
const out = path.join(dist, 'hackathon')
const rawDir = path.join(out, 'raw')
fs.mkdirSync(rawDir, { recursive: true })

const CHROME_CANDIDATES = [
  process.env.HARNESS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || CHROME_CANDIDATES[0]
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')
if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`)
if (!fs.existsSync(path.join(dist, 'app.js'))) throw new Error('Run node harness/build.mjs first')

const { CDP } = await import(
  pathToFileURL(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'scripts', 'perf', 'lib', 'cdp.mjs')).href
)

const PORT = 8951
const CDP_PORT = 8952
const THEME = { name: 'nous', mode: 'dark' }
const PAGE_H = 2400
const FULL_W = 760
const NARROW_W = 420
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const clone = value => JSON.parse(JSON.stringify(value))
const preview = readJson(path.join(__dirname, 'fixtures', 'preview-showcase.json'))
const catalogFixture = readJson(path.join(__dirname, 'fixtures', 'declarative-catalog.json'))
const honestyFixture = readJson(path.join(__dirname, 'fixtures', 'declarative-honesty.json'))
const popularFixture = readJson(path.join(__dirname, 'fixtures', 'popular-connections.json'))

function hostFor(overview, overrides = {}) {
  const model = overview?.active?.model || 'sample-model'
  return {
    model,
    sessionId: 'sess-hackathon-sample',
    profile: 'default',
    connectionId: 'local',
    gateway: 'open',
    focusedSessionProfile: 'default',
    focusedSessionOwner: { connectionId: 'local', profile: 'default' },
    ...overrides
  }
}

function fixtureOf(overview, extra = {}) {
  return { overview, host: hostFor(overview), ...extra }
}

function resetFixtureOf(overview) {
  const sample = clone(overview)
  const account = sample.providers.find(row => row.id === 'openai-codex')
  for (const group of account?.limits || []) {
    for (const window of group.windows || []) {
      window.remaining_percent = 0
      window.used_percent = 100
    }
  }
  // Preview is eligible only for exhausted allowances: don't stage an
  // enabled confirmation next to healthy meters the real guard would refuse.
  return fixtureOf(sample)
}

// ---------------------------------------------------------------------------
// Sample states
// ---------------------------------------------------------------------------

// 1–3, 4, 9: the public sample overview. No real account values.
const multiProvider = clone(preview)
multiProvider.fetched_at = '2026-11-11T16:20:00Z'
multiProvider.account_profile = 'default'
multiProvider.host = hostFor(multiProvider)

// 5: active-provider metrics. The fields are real renderer inputs; not every
// provider returns all of them. The caption says so.
const expanded = clone(preview)
expanded.fetched_at = '2026-11-11T16:20:00Z'
expanded.account_profile = 'default'
expanded.active = { provider: 'openai-codex', model: 'gpt-5.6-codex' }
expanded.default_provider = 'openai-codex'
expanded.host = hostFor(expanded)
const codex = expanded.providers.find(row => row.id === 'openai-codex')
codex.plan = 'Pro'
codex.limits = [
  {
    id: 'default',
    label: 'Codex',
    windows: [
      { label: '5-hour window', remaining_percent: 62, reset_at: '2026-11-11T20:30:00Z' },
      { label: '7-day window', remaining_percent: 84, reset_at: '2026-11-14T17:00:00Z' }
    ]
  },
  {
    id: 'spark',
    label: 'Spark',
    windows: [
      { label: '5-hour window', remaining_percent: 36, reset_at: '2026-11-11T21:00:00Z' },
      { label: '7-day window', remaining_percent: 71, reset_at: '2026-11-14T17:00:00Z' }
    ]
  }
]
codex.breakdown = [
  { id: 'codex', label: 'Codex models', used_percent: 78 },
  { id: 'spark', label: 'Spark models', used_percent: 22 }
]
codex.breakdown_note = 'Share of sample requests in this account’s shared pool.'
codex.activity = {
  range: '7d',
  requests: 2840,
  usd: 18.42,
  input_tokens: 12_400_000,
  output_tokens: 2_100_000,
  cached_tokens: 8_600_000,
  hit_rate: 0.69,
  buckets: [
    { from: '2026-11-05T00:00:00Z', usd: 1.1, requests: 190 },
    { from: '2026-11-06T00:00:00Z', usd: 2.4, requests: 360 },
    { from: '2026-11-07T00:00:00Z', usd: 1.8, requests: 300 },
    { from: '2026-11-08T00:00:00Z', usd: 3.2, requests: 480 },
    { from: '2026-11-09T00:00:00Z', usd: 2.7, requests: 420 },
    { from: '2026-11-10T00:00:00Z', usd: 4.0, requests: 610 },
    { from: '2026-11-11T00:00:00Z', usd: 3.2, requests: 480 }
  ]
}
codex.cache = {
  hit_rate: 0.71,
  cache_read_tokens: 8_600_000,
  prompt_tokens: 12_400_000,
  cache_write_tokens: 900_000,
  saved_usd: 4.2,
  days: 7
}
codex.pricing = [
  {
    model: 'gpt-5.6-codex',
    input: 1.25,
    output: 10,
    cache_read: 0.125,
    cache_write: 1.25,
    active: true,
    pricing_version: 'sample-2026-11',
    source_url: 'https://example.com/rate-card',
    checked_at: '2026-11-11T15:00:00Z'
  },
  {
    model: 'gpt-5.6-codex-spark',
    input: 0.5,
    output: 4,
    cache_read: 0.05,
    cache_write: 0.5,
    pricing_version: 'sample-2026-11',
    source_url: 'https://example.com/rate-card',
    checked_at: '2026-11-11T15:00:00Z'
  }
]
codex.details = ['Sample extra-usage line for the expanded metrics preview.']
codex.balances = [
  { label: 'Extra usage balance', amount: 12.34, currency: 'USD' }
]

// 11–12: stock-native Codex reset panel. The rest door is scripted to return
// this read-only summary / preview, then to stop. The confirm route is never
// called, so no reset is redeemed.
const resetSummarySample = {
  ...expanded,
  state: 'ready',
  account_label: 'Codex Pro · sample',
  identity_id: 'codex:sample-account',
  message: '2 banked resets are available for this account. The server selects one only after an explicit confirmation.',
  reset_executable: true,
  available_count: 2,
  applicable_count: 1,
  inventory_detail: 'Provider-reported reset inventory. No expiry is inferred when the provider does not report one.',
  entries: [
    {
      id: 'credit-sample-1',
      reset_type: 'codex_rate_limits',
      status: 'available',
      granted_at: '2026-11-01T12:00:00Z',
      expires_at: '2026-11-20T12:00:00Z',
      title: 'Full reset',
      description: 'Sample banked reset credit.'
    },
    {
      id: 'credit-sample-2',
      reset_type: 'codex_rate_limits',
      status: 'available',
      granted_at: '2026-11-04T12:00:00Z',
      expires_at: null,
      title: 'Full reset',
      description: 'Sample banked reset credit with no reported expiry.'
    }
  ]
}
const resetPreviewSample = {
  ...resetSummarySample,
  summary: resetSummarySample,
  confirmation: {
    identity_id: 'codex:sample-account',
    account_label: 'Codex Pro · sample',
    available_count: 2,
    applicable_count: 1,
    token: 'sample-confirmation-token-not-submitted'
  }
}

// 3: compact active provider with a verified account identity and a deliberately
// mismatched child identity, so both the known-pool and unknown-pool footer
// states render in one frame.
const running = clone(preview)
running.fetched_at = '2026-11-11T16:20:00Z'
running.account_profile = 'default'
running.active = { provider: 'openai-codex', model: 'gpt-5.6-codex' }
running.default_provider = 'openai-codex'
running.host = hostFor(running)
const runningCodex = running.providers.find(row => row.id === 'openai-codex')
runningCodex.plan = 'Plus'
runningCodex.limits = [
  {
    id: 'default',
    label: 'Codex',
    windows: [{ label: '5-hour window', remaining_percent: 62, reset_at: '2026-11-11T20:30:00Z' }]
  }
]
runningCodex.balances = []
runningCodex.accounts = [{ identity_id: 'codex:sample-account', label: 'Codex Pro · sample' }]
const runningDeepSeek = running.providers.find(row => row.id === 'deepseek')
if (runningDeepSeek) {
  runningDeepSeek.accounts = [{ identity_id: 'fp:sample-deepseek', label: 'DeepSeek API · sample' }]
}
const runningFixture = fixtureOf(running, {
  subagents: {
    'sess-hackathon-sample': {
      subagents: [
        {
          subagent_id: 'sa-sample-1',
          parent_id: null,
          depth: 1,
          goal: 'Audit the popover layout at 420px',
          model: 'gpt-5.6-codex',
          provider: 'openai-codex',
          provider_account_id: 'codex:sample-account',
          status: 'running',
          started_at: 1762790400,
          tool_count: 4,
          last_tool: 'read_file'
        },
        {
          subagent_id: 'sa-sample-2',
          parent_id: null,
          depth: 1,
          goal: 'Collect the provider payloads',
          model: 'gpt-5.6-codex',
          provider: 'openai-codex',
          provider_account_id: 'codex:unmatched-account',
          status: 'running',
          started_at: 1762790405,
          tool_count: 2,
          last_tool: 'web_extract'
        },
        {
          subagent_id: 'sa-sample-3',
          parent_id: null,
          depth: 1,
          goal: 'Summarize the provider docs',
          model: 'qwen3-coder:480b',
          status: 'running',
          started_at: 1762790410,
          tool_count: 1,
          last_tool: 'read_file'
        }
      ],
      delegations: []
    }
  }
})

// 6: catalog cards are derived from the repository's real bundled definitions,
// so a definition added concurrently appears automatically. States are sample.
function bundledCatalogEntries() {
  const catalogDir = path.join(repoRoot, 'dashboard', 'definitions', 'catalog')
  const connected = new Set(['github-rate-limit'])
  if (!fs.existsSync(catalogDir)) return []
  return fs.readdirSync(catalogDir)
    .filter(file => file.endsWith('.json'))
    .sort()
    .map(file => {
      const def = readJson(path.join(catalogDir, file))
      let host = ''
      try { host = new URL(def.request?.url).hostname } catch { host = '' }
      const missing = []
      for (const header of Array.isArray(def.request?.headers) ? def.request.headers : []) {
        if (header?.credential?.source === 'env' && header.credential.name) missing.push(header.credential.name)
      }
      const isConnected = connected.has(def.id)
      return {
        id: def.id,
        name: def.name || def.id,
        description: def.description || '',
        state: isConnected ? 'connected' : 'available',
        source: 'bundled',
        stability: def.stability || 'stable',
        version: def.version || 1,
        host,
        docs_url: def.docs_url || '',
        ...(missing.length ? { missing_credentials: missing } : {}),
        setup: {
          directory: '$HERMES_HOME/provider-usage/providers',
          file: `${def.id}.json`
        }
      }
    })
}
const catalogEntries = bundledCatalogEntries()
const available = clone(catalogFixture)
available.fetched_at = '2026-11-11T16:20:00Z'
available.account_profile = 'default'
available.host = hostFor(available)
available.catalog = {
  version: 1,
  profile: 'default',
  directory: '$HERMES_HOME/provider-usage/providers',
  bundled_count: catalogEntries.length,
  profile_count: 0,
  counts: {
    connected: catalogEntries.filter(entry => entry.state === 'connected').length,
    available: catalogEntries.filter(entry => entry.state === 'available').length
  },
  definitions: catalogEntries
}

// 7–8: trust states. The honesty fixture already covers approval, blocked,
// unknown and unverified; add one invalid profile definition for the exact
// schema-error state.
const trust = clone(honestyFixture)
trust.fetched_at = '2026-11-11T16:20:00Z'
trust.account_profile = 'default'
trust.host = hostFor(trust)
trust.catalog.definitions.push({
  id: 'team-usage-invalid',
  name: 'Team usage (invalid)',
  description: 'A profile definition that failed schema validation.',
  state: 'invalid',
  source: 'profile',
  version: 1,
  file: 'team-usage.json',
  errors: [
    'mapping.windows[0].label: must not be empty',
    "request.hosts: must include the request host 'api.example.com'"
  ],
  warnings: []
})
trust.catalog.counts.invalid = 1

const EXPECTED_ADDED_CARDS = [
  { label: 'Claude / Anthropic', re: /anthropic|claude/i },
  { label: 'Google Gemini API', re: /google|gemini/i },
  { label: 'Z.ai / GLM', re: /z\.?ai|zhipu|glm/i }
]
const addedCardStatus = EXPECTED_ADDED_CARDS.map(expected => {
  const match = (Array.isArray(popularFixture.connections) ? popularFixture.connections : [])
    .find(entry => expected.re.test(`${entry.id} ${entry.name} ${entry.provider}`)) ||
    catalogEntries.find(entry => expected.re.test(`${entry.id} ${entry.name}`))
  return { label: expected.label, present: Boolean(match), id: match?.id || null }
})

// ---------------------------------------------------------------------------
// Page + browser
// ---------------------------------------------------------------------------

function htmlPage({ title, fixture, viewportW, viewportH, pane = null, chip = null, overlay = null }) {
  const paneCss = pane
    ? `#pane-root { display:block; position:absolute; left:0; top:0; width:${pane.width}px; height:${pane.height}px; }`
    : '#pane-root { display:none; }'
  const chipCss = chip
    ? `#chip-root { display:block; position:absolute; left:${chip.left}px; top:${chip.top}px; width:320px; z-index:5; }`
    : '#chip-root { display:none; }'
  return `<!doctype html>
<html lang="en" data-harness="1">
  <head>
    <meta charset="utf-8" />
    <title>${title}</title>
    <link rel="stylesheet" href="/static/hermes-sdk.css" />
    <style>
      html, body { margin:0; padding:0; background: var(--ui-bg-editor, #0d1117); }
      * { box-sizing:border-box; scrollbar-width:none; }
      *::-webkit-scrollbar { display:none; width:0; height:0; }
      #panel { position:relative; width:${viewportW}px; height:${viewportH}px; overflow:hidden; background:var(--ui-bg-editor, #0d1117); }
      ${paneCss}
      ${chipCss}
      ${overlay ? `
      #demo-overlay { position:absolute; left:30px; top:26px; z-index:20; display:grid; gap:6px; pointer-events:none; max-width:720px; }
      #demo-title { font:600 13px/1.2 var(--default-font-family, "Segoe UI", system-ui, sans-serif); letter-spacing:.13em; text-transform:uppercase; color:var(--ui-text-secondary, #7d8590); }
      #demo-sub { font:500 14px/1.35 var(--default-font-family, "Segoe UI", system-ui, sans-serif); color:var(--ui-text-primary, #e6edf3); }
      #demo-phase { position:absolute; left:30px; bottom:26px; z-index:20; font:500 13px/1.35 var(--default-font-family, "Segoe UI", system-ui, sans-serif); color:var(--ui-text-secondary, #7d8590); pointer-events:none; }
      #demo-legal { position:absolute; right:30px; bottom:26px; z-index:20; font:500 10px/1.4 var(--default-font-family, "Segoe UI", system-ui, sans-serif); color:var(--ui-text-quaternary, #6e7681); text-align:right; pointer-events:none; max-width:420px; }
      ` : ''}
    </style>
    <script>
      window.__FIXTURE__ = ${JSON.stringify(fixture)};
      window.__HARNESS_THEME__ = ${JSON.stringify(THEME)};
      window.__CAPTURE__ = { fixture:${JSON.stringify(title)}, paneWidth:${pane?.width || FULL_W}, paneHeight:${pane?.height || PAGE_H}, chipWidth:320, body:true };
      ${overlay ? `window.__DEMO_PHASE__ = function (text) { const el = document.getElementById('demo-phase'); if (el) el.textContent = text; };` : ''}
    </script>
  </head>
  <body>
    ${overlay ? `<div id="demo-overlay"><div id="demo-title">Provider Usage · Hermes Desktop</div><div id="demo-sub">${overlay.subtitle}</div></div><div id="demo-phase">${overlay.phase}</div><div id="demo-legal">Component harness · sample data · not the packaged desktop</div>` : ''}
    <div id="panel">
      <div id="chip-root"></div>
      <div id="pane-root"></div>
    </div>
    <script type="module" src="/app.js"></script>
  </body>
</html>`
}

// ---- static server ----
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const sdkCss = path.join(__dirname, 'static', 'hermes-sdk.css')
if (!fs.existsSync(sdkCss)) throw new Error('Real SDK CSS missing at harness/static/hermes-sdk.css')
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const base = urlPath.startsWith('/static/') ? path.join(__dirname, 'static') : dist
  const rel = urlPath.replace(/^\/static\//, '').replace(/^\/+/, '')
  const file = path.join(base, rel)
  if (!file.startsWith(base) && !(base === dist && file.startsWith(dist))) {
    res.writeHead(403); res.end('forbidden'); return
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
    res.writeHead(404); res.end('not found'); return
  }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
console.log(`Serving hackathon harness on http://127.0.0.1:${PORT}`)

const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpu-hackathon-'))
const chromeProc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  'about:blank'
], { stdio: 'ignore' })

async function waitUntil(cdp, expr, timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await cdp.eval(expr).catch(() => false)
    if (ok) return
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${expr}`)
    await sleep(120)
  }
}

async function loadPage(cdp, page, viewportW, viewportH) {
  fs.writeFileSync(path.join(dist, 'hackathon.html'), htmlPage(page))
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: viewportW,
    height: viewportH,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/hackathon.html?v=${Date.now()}` })
  await waitUntil(cdp, 'window.__HARNESS_READY__ === true')
  await waitUntil(cdp, `!!document.querySelector('#pane-root [data-harness-surface]') || !!document.querySelector('#chip-root button')`)
  await sleep(450)
}

async function measure(cdp, target, padding = 0) {
  return cdp.eval(`(() => {
    const target = ${JSON.stringify(target)};
    const pad = ${JSON.stringify(padding)};
    let el = null;
    let rect = null;
    let text = '';
    let detail = {};
    if (target === 'chip-button') {
      el = document.querySelector('#chip-root button');
      if (!el) return { error: 'chip button missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
      detail = { ariaHasPopup: el.getAttribute('aria-haspopup'), ariaExpanded: el.getAttribute('aria-expanded') };
    } else if (target === 'popover') {
      el = document.querySelector('[data-slot="popover-content"]');
      if (!el) return { error: 'popover missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
      detail = { scrollHeight: el.scrollHeight, clientHeight: el.clientHeight, scrollTop: el.scrollTop };
      const footer = el.querySelector('[data-running-agents]');
      if (footer) detail.runningAgents = footer.innerText.slice(0, 800);
    } else if (target === 'pane-full') {
      const root = document.getElementById('pane-root');
      if (!root) return { error: 'pane missing' };
      const rootRect = root.getBoundingClientRect();
      // The pane shell and its scroll body are full-height containers; using
      // them would add hundreds of empty pixels. Measure the deepest leaf and
      // add the last section's 18px bottom padding.
      let bottom = rootRect.top;
      for (const node of root.querySelectorAll('*')) {
        if (node.childElementCount > 0) continue;
        const r = node.getBoundingClientRect();
        if (r.width > 0 && r.height > 0) bottom = Math.max(bottom, r.bottom);
      }
      bottom = Math.min(rootRect.bottom, bottom + 18);
      rect = { x:rootRect.x, y:rootRect.y, width:rootRect.width, height:Math.max(1, bottom - rootRect.top) };
      el = root;
    } else if (target === 'popular-section') {
      el = document.querySelector('section[aria-label="Popular provider connections"]');
      if (!el) return { error: 'popular connections section missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
      const labels = ['Claude / Anthropic', 'Google Gemini API', 'Z.ai / GLM'];
      const cards = labels.map(label => {
        const leaf = Array.from(el.querySelectorAll('*')).find(node =>
          node.children.length === 0 && node.textContent.trim() === label
        );
        let card = leaf;
        while (card && card !== el) {
          const cs = getComputedStyle(card);
          const cr = card.getBoundingClientRect();
          if (cr.width > 200 && cr.height > 100 && (parseFloat(cs.borderTopWidth) > 0 || cs.boxShadow !== 'none')) break;
          card = card.parentElement;
        }
        if (!card || card === el) return { label, found: false };
        const cr = card.getBoundingClientRect();
        return {
          label,
          found: true,
          x: Math.round(cr.x * 100) / 100,
          y: Math.round(cr.y * 100) / 100,
          width: Math.round(cr.width * 100) / 100,
          height: Math.round(cr.height * 100) / 100,
          insideSection: cr.top >= r.top - 1 && cr.bottom <= r.bottom + 1
        };
      });
      const found = cards.filter(card => card.found);
      const distinct = found.length === labels.length && found.every((a, i) =>
        found.slice(i + 1).every(b =>
          a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y
        )
      );
      detail = { cardCount: el.querySelectorAll('button').length, cards, cardsDistinct: distinct };
    } else if (target === 'catalog-section') {
      el = document.querySelector('section[aria-label="Provider definitions"]');
      if (!el) return { error: 'catalog section missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
      detail = { cardCount: el.querySelectorAll('button').length };
    } else if (target === 'active-section') {
      const heading = document.getElementById('provider-usage-active-heading');
      el = heading && heading.closest('section');
      if (!el) return { error: 'active section missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
    } else if (target === 'invalid-card') {
      const section = document.querySelector('section[aria-label="Provider definitions"]');
      if (!section) return { error: 'catalog section missing' };
      const leaf = Array.from(section.querySelectorAll('*')).find(node =>
        node.children.length === 0 && node.textContent.trim() === 'Invalid definition'
      );
      let node = leaf;
      while (node && node !== section) {
        const cs = getComputedStyle(node);
        const r = node.getBoundingClientRect();
        if (cs.borderTopWidth === '1px' && parseFloat(cs.borderTopLeftRadius) >= 7 && r.height > 80) {
          el = node;
          break;
        }
        node = node.parentElement;
      }
      if (!el) return { error: 'invalid card missing' };
      const r = el.getBoundingClientRect();
      rect = { x:r.x, y:r.y, width:r.width, height:r.height };
    }
    if (!el || !rect) return { error: 'target not measured' };
    text = (el.innerText || '').slice(0, 6000);
    const pane = document.getElementById('pane-root');
    const scrollIssues = [];
    if (pane) {
      for (const node of pane.querySelectorAll('*')) {
        const cs = getComputedStyle(node);
        if ((cs.overflowY === 'auto' || cs.overflowY === 'scroll') && node.scrollHeight > node.clientHeight + 2) {
          scrollIssues.push({ tag:node.tagName, scrollHeight:node.scrollHeight, clientHeight:node.clientHeight });
        }
      }
    }
    const clip = {
      x: Math.max(0, rect.x - pad),
      y: Math.max(0, rect.y - pad),
      width: Math.max(1, rect.width + pad * 2),
      height: Math.max(1, rect.height + pad * 2)
    };
    return { rect, clip, text, detail, scrollIssues };
  })()`)
}

const records = []
async function captureState(cdp, state, viewportW, viewportH) {
  await loadPage(cdp, state.page, viewportW, viewportH)
  if (state.action === 'open-popover') {
    await cdp.eval(`(() => { const b = document.querySelector('#chip-root button'); if (!b) return false; b.click(); return true; })()`)
    await waitUntil(cdp, `!!document.querySelector('[data-slot="popover-content"]')`)
    await sleep(300)
    // The chip and popover are separate surfaces in the app. Hide the trigger
    // after it has opened so the crop is the popover + its shadow, not a
    // half-clipped chip at the top edge.
    await cdp.eval(`(() => { const c = document.getElementById('chip-root'); if (c) c.style.visibility = 'hidden'; return true; })()`)
    await sleep(120)
  }
  if (state.action === 'scroll-popover-bottom') {
    await cdp.eval(`(() => { const el = document.querySelector('[data-slot="popover-content"]'); if (!el) return false; el.scrollTop = el.scrollHeight; return true; })()`)
    await sleep(250)
  }
  if (state.action === 'reset-summary' || state.action === 'reset-confirm') {
    // Set the rest door to the read-only summary before the panel asks for it.
    await cdp.eval(`window.__HARNESS__.setOverview(${JSON.stringify(resetSummarySample)})`)
    const clickedCheck = await cdp.eval(`(() => {
      const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Check reset credits');
      if (!button) return false;
      button.click();
      return true;
    })()`)
    if (!clickedCheck) throw new Error(`${state.id}: Check reset credits button missing`)
    await waitUntil(cdp, `document.body.innerText.includes('Resets available')`)
    await sleep(300)
    if (state.action === 'reset-confirm') {
      await cdp.eval(`window.__HARNESS__.setOverview(${JSON.stringify(resetPreviewSample)})`)
      const clickedPreview = await cdp.eval(`(() => {
        const button = Array.from(document.querySelectorAll('button')).find(el => el.textContent.trim() === 'Preview reset');
        if (!button) return false;
        button.click();
        return true;
      })()`)
      if (!clickedPreview) throw new Error(`${state.id}: Preview reset button missing`)
      await waitUntil(cdp, `document.body.innerText.includes('Confirm Codex Pro · sample')`)
      await sleep(300)
    }
  }
  if (state.assertText?.length) {
    const body = await cdp.eval(`((document.querySelector(${JSON.stringify(state.textTarget || '#panel')}) || document.body).innerText || '')`)
    for (const needle of state.assertText) {
      if (!body.includes(needle)) {
        throw new Error(`${state.id}: expected text not found: ${JSON.stringify(needle)}\n---\n${body.slice(0, 2500)}`)
      }
    }
  } else {
    await sleep(120)
  }
  const measured = await measure(cdp, state.target, state.padding || 0)
  if (measured.error) throw new Error(`${state.id}: ${measured.error}`)
  if (state.target === 'chip-button') {
    if (!(measured.rect.width > 0 && measured.rect.height > 0)) throw new Error(`${state.id}: chip has zero size`)
    if (measured.rect.width > 230.5) throw new Error(`${state.id}: chip exceeds the 230px production cap (${measured.rect.width})`)
  }
  if (state.target === 'popover' && measured.rect.width > 356.5) {
    throw new Error(`${state.id}: popover exceeds 356px (${measured.rect.width})`)
  }
  if (state.target === 'popular-section') {
    const cards = measured.detail?.cards || []
    if (cards.length !== 3) throw new Error(`${state.id}: expected 3 popular cards, saw ${cards.length}`)
    for (const card of cards) {
      if (!card.found) throw new Error(`${state.id}: popular card not found: ${card.label}`)
      if (!card.insideSection) throw new Error(`${state.id}: popular card outside section: ${card.label}`)
      if (card.width < 200 || card.height < 100) throw new Error(`${state.id}: popular card has no real geometry: ${card.label}`)
    }
    if (!measured.detail?.cardsDistinct) throw new Error(`${state.id}: popular cards overlap`)
  }
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { ...measured.clip, scale: 2 }
  })
  const rawPath = path.join(rawDir, `${state.id}.png`)
  fs.writeFileSync(rawPath, Buffer.from(shot.data, 'base64'))
  records.push({
    id: state.id,
    file: `${state.id}.png`,
    title: state.title,
    caption: state.caption,
    state: state.stateLabel,
    theme: THEME,
    target: state.target,
    widthCss: Math.round(measured.clip.width * 100) / 100,
    heightCss: Math.round(measured.clip.height * 100) / 100,
    rect: measured.rect,
    detail: measured.detail,
    scrollIssues: measured.scrollIssues,
    text: measured.text,
    assertText: state.assertText || [],
    sampleData: true
  })
  console.log(`Captured ${state.id}  ${Math.round(measured.clip.width)}x${Math.round(measured.clip.height)} CSS px`)
}

let cdp
try {
  try {
    cdp = await CDP.connect({ port: CDP_PORT, match: 'about:blank', timeoutMs: 15000 })
  } catch {
    cdp = await CDP.connect({ port: CDP_PORT, timeoutMs: 15000 })
  }
  await cdp.send('Page.enable')

  const states = [
    {
      id: '01-status-chip',
      title: 'Provider Usage — status-bar chip (sample data)',
      stateLabel: 'Toolbar chip trigger · subscription provider',
      target: 'chip-button',
      padding: 18,
      page: {
        title: 'chip',
        fixture: fixtureOf(multiProvider),
        viewportW: 520,
        viewportH: 220,
        pane: null,
        chip: { left: 40, top: 40 }
      },
      viewportW: 520,
      viewportH: 220,
      assertText: ['Codex', 'wk 84%'],
      textTarget: '#chip-root',
      caption: 'The status-bar chip is the always-on entry point. It shows the active provider and the governing subscription windows, not a private chat quota.'
    },
    {
      id: '02-popover-current',
      title: 'Provider Usage — current provider popover (sample data)',
      stateLabel: 'Popover · current provider detail',
      target: 'popover',
      padding: 24,
      action: 'open-popover',
      page: {
        title: 'popover-current',
        fixture: fixtureOf(multiProvider),
        viewportW: 560,
        viewportH: 920,
        pane: null,
        chip: { left: 30, top: 40 }
      },
      viewportW: 560,
      viewportH: 920,
      assertText: ['View all providers', '5-hour', 'Weekly', '62% left'],
      textTarget: '[data-slot="popover-content"]',
      caption: 'Clicking the chip opens the current provider’s detail popover: every governing window, reset time, and any paid fallback balance.'
    },
    {
      id: '03-popover-running-agents',
      title: 'Provider Usage — running agents footer (sample data)',
      stateLabel: 'Popover footer · verified pool and unknown account',
      target: 'popover',
      padding: 24,
      action: 'open-popover',
      page: {
        title: 'popover-running-agents',
        fixture: runningFixture,
        viewportW: 560,
        viewportH: 920,
        pane: null,
        chip: { left: 30, top: 40 }
      },
      viewportW: 560,
      viewportH: 920,
      assertText: ['Running agents', '5h 62%', '—', 'provider not reported'],
      textTarget: '[data-slot="popover-content"]',
      caption: 'The footer attributes only what the gateway can prove. A child with a matching account shows the shared pool (5h 62%); a mismatched or missing account shows an em dash instead of borrowing another account’s balance.'
    },
    {
      id: '04-overview-multi-provider',
      title: 'Provider Usage — full page, multiple providers (sample data)',
      stateLabel: 'Full page · subscription and credit providers',
      target: 'pane-full',
      padding: 0,
      page: {
        title: 'overview-multi-provider',
        fixture: fixtureOf(multiProvider),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Provider usage', 'OTHER PROVIDERS', 'DeepSeek', 'OpenCode', '$8.72'],
      textTarget: '#pane-root',
      caption: 'The full page keeps subscription windows and credit balances together: the active Codex allowance, DeepSeek API credit, OpenCode Go, Ollama Cloud, and an xAI sample row. On stock 0.23.1 the xAI row shows an official account link instead of credits.'
    },
    {
      id: '05-overview-expanded-metrics',
      title: 'Provider Usage — expanded active-provider metrics (sample data)',
      stateLabel: 'Expanded metrics · activity, cache, rates, pool breakdown',
      target: 'active-section',
      padding: 0,
      page: {
        title: 'overview-expanded-metrics',
        fixture: fixtureOf(expanded),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Activity', 'Prompt cache', 'Rates', 'Usage breakdown', '2,840 requests'],
      textTarget: '#pane-root',
      caption: 'When an adapter supplies them, the active card extends to activity, prompt-cache efficiency, published token rates, and the shared-pool breakdown. Not every provider returns every field.'
    },
    {
      id: '06-popular-connections',
      title: 'Provider Usage — popular provider connection cards (sample data)',
      stateLabel: 'Popular provider cards · Claude, Gemini, Z.ai',
      target: 'popular-section',
      padding: 0,
      page: {
        title: 'popular-connections',
        fixture: fixtureOf(popularFixture),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Popular providers', 'Claude / Anthropic', 'Google Gemini API', 'Z.ai / GLM', 'No balance or quota is inferred.'],
      textTarget: '#pane-root',
      caption: 'Three always-listed connection cards separate subscription quota from API billing. They report credential presence and supported read paths only; an unconnected card says so instead of showing an invented zero.'
    },
    {
      id: '07-catalog-available',
      title: 'Provider Usage — available to connect cards (sample data)',
      stateLabel: 'Catalog · available to connect',
      target: 'catalog-section',
      padding: 0,
      page: {
        title: 'catalog-available',
        fixture: fixtureOf(available),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Provider definitions', 'Available to connect', 'MOONSHOT_API_KEY', 'ELEVENLABS_API_KEY'],
      textTarget: '#pane-root',
      caption: 'Read-only JSON definitions that ship in the catalog appear as Available to connect and name the exact missing environment variable. A card is setup guidance, not a live account test.'
    },
    {
      id: '08-catalog-trust',
      title: 'Provider Usage — approval, blocked, unknown states (sample data)',
      stateLabel: 'Catalog · approval and blocked states',
      target: 'catalog-section',
      padding: 0,
      page: {
        title: 'catalog-trust',
        fixture: fixtureOf(trust),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Approval required', 'Blocked', 'Unknown state', 'Unverified mapping'],
      textTarget: '#pane-root',
      caption: 'Profile-local definitions stay untrusted until a human approves that exact content. Editing the file, a mismatched approval record, or an unrecognized backend state is shown explicitly; nothing is fetched or invented.'
    },
    {
      id: '09-catalog-invalid',
      title: 'Provider Usage — invalid definition errors (sample data)',
      stateLabel: 'Catalog · invalid definition',
      target: 'invalid-card',
      padding: 6,
      page: {
        title: 'catalog-invalid',
        fixture: fixtureOf(trust),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Invalid definition', 'mapping.windows[0].label', "must include the request host"],
      textTarget: '#pane-root',
      caption: 'An invalid profile definition keeps its exact schema errors visible, so the fix is actionable instead of a silent empty card.'
    },
    {
      id: '10-narrow-420',
      title: 'Provider Usage — narrow responsive pane (sample data)',
      stateLabel: 'Narrow layout · 420px pane',
      target: 'pane-full',
      padding: 0,
      page: {
        title: 'narrow-420',
        fixture: fixtureOf(multiProvider),
        viewportW: NARROW_W,
        viewportH: PAGE_H,
        pane: { width: NARROW_W, height: PAGE_H },
        chip: null
      },
      viewportW: NARROW_W,
      viewportH: PAGE_H,
      assertText: ['Provider usage', '5-hour', 'OTHER PROVIDERS'],
      textTarget: '#pane-root',
      caption: 'At a 420px pane width the plugin’s own layout stacks meters and provider cards without changing the data or hiding a reset.'
    },
    {
      id: '11-reset-summary',
      title: 'Provider Usage — banked reset summary (sample data)',
      stateLabel: 'Codex reset · read-only summary',
      target: 'active-section',
      padding: 0,
      action: 'reset-summary',
      page: {
        title: 'reset-summary',
        fixture: resetFixtureOf(expanded),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Banked reset credits', 'Resets available', 'Active account: Codex Pro · sample', '2 banked resets are available', 'Preview reset'],
      textTarget: '#pane-root',
      caption: 'The stock-native reset panel reads the active Codex account only. This is a fixture summary: 2 banked resets, 1 usable now, with provider-reported inventory. No reset was redeemed.'
    },
    {
      id: '12-reset-confirm',
      title: 'Provider Usage — reset confirmation preview (sample data)',
      stateLabel: 'Codex reset · confirmation preview, not executed',
      target: 'active-section',
      padding: 0,
      action: 'reset-confirm',
      page: {
        title: 'reset-confirm',
        fixture: resetFixtureOf(expanded),
        viewportW: FULL_W,
        viewportH: PAGE_H,
        pane: { width: FULL_W, height: PAGE_H },
        chip: null
      },
      viewportW: FULL_W,
      viewportH: PAGE_H,
      assertText: ['Confirm Codex Pro · sample', '2 banked; 1 usable now', 'Confirm reset on Codex Pro · sample', 'This spends one banked reset'],
      textTarget: '#pane-root',
      caption: 'Preview/confirm is separately gated. This fixture stops at the confirmation preview; the confirm button is visible but was never clicked, and no reset was redeemed.'
    }
  ]

  for (const state of states) {
    await captureState(cdp, state, state.viewportW, state.viewportH)
  }

  // The stills stay deterministic. The optional clip is recorded separately by
  // harness/hackathon-video-playwright.mjs; never block the capture matrix on a
  // repeated Page.captureScreenshot loop.
  const videoInfo = { recorded: false, frames: 0, reason: 'recorded separately by harness/hackathon-video-playwright.mjs' }

  fs.writeFileSync(path.join(out, 'records.json'), JSON.stringify({
    schema: 'provider-usage.hackathon-capture/1',
    generated_at: new Date().toISOString(),
    plugin_version: readJson(path.join(repoRoot, 'package.json')).version,
    source_commit: (await import('node:child_process')).execFileSync('git', ['-C', repoRoot, 'rev-parse', '--short', 'HEAD'], { encoding: 'utf8' }).trim(),
    theme: THEME,
    capture_kind: 'browser component harness (real desktop/plugin.js + real SDK primitives + real built-in theme); not the packaged desktop app',
    sample_data: true,
    viewport: { full: FULL_W, narrow: NARROW_W, pageHeight: PAGE_H },
    added_cards: addedCardStatus,
    catalog_ids: catalogEntries.map(entry => entry.id),
    connection_ids: (Array.isArray(popularFixture.connections) ? popularFixture.connections : []).map(entry => entry.id),
    records,
    video: videoInfo
  }, null, 2))
  console.log(`\nRecords → ${path.join(out, 'records.json')}`)
  cdp.close()
} finally {
  server.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  chromeProc.kill()
}
