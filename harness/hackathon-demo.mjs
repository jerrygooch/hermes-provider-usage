#!/usr/bin/env node
/**
 * Hackathon demo — FINISHED 60–85 s MP4 from REAL plugin-component interaction.
 *
 * This drives the shipped `desktop/plugin.js` in the same browser component
 * harness as the stills, with the real Hermes SDK primitives + real `nous`
 * dark theme. A synthetic fixture supplies every value. Each beat is a real
 * DOM click / wheel / scroll followed by a state assertion; captions describe
 * only what the assertion proved is on screen.
 *
 * Honesty rails:
 *  - Synthetic sample data. The visible badge says "Real plugin components •
 *    sample data"; the end card repeats it. No live account, credential,
 *    password, email, or local path appears.
 *  - Running-agents fixture removes every account identity, matching a stock
 *    host: every row shows an em dash, never a borrowed balance.
 *  - The reset beat clicks Check reset credits → Preview reset and STOPS. The
 *    harness `ctx.rest` is counted; a `/reset/confirm` call fails the run.
 *  - Manage-account links are only hovered / outlined, never clicked. External
 *    requests are blocked and counted; no login page is opened.
 *
 * Outputs:
 *   assets/hackathon/demo-full.mp4
 *   assets/hackathon/demo-full-poster.png
 *   harness/dist/hackathon/demo-full.record.json   (hashes + probe + assertions)
 *   harness/dist/hackathon/demo-full-frames/*.png  (review stills)
 *
 * Usage:
 *   node harness/build.mjs
 *   node harness/hackathon-demo.mjs
 *   node harness/hackathon-demo.mjs --check   # fail if plugin/bundle changed
 *
 * Env: HARNESS_CHROME, PLAYWRIGHT_CORE, FFMPEG/ffprobe on PATH.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import crypto from 'node:crypto'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const dist = path.join(__dirname, 'dist')
const outDir = path.join(dist, 'hackathon')
const assetDir = path.join(repoRoot, 'assets', 'hackathon')
const framesDir = path.join(outDir, 'demo-full-frames')
const finalMp4 = path.join(assetDir, 'demo-full.mp4')
const poster = path.join(assetDir, 'demo-full-poster.png')
const recordFile = path.join(outDir, 'demo-full.record.json')
const pluginPath = path.join(repoRoot, 'desktop', 'plugin.js')
const bundlePath = path.join(dist, 'app.js')
const W = 1280
const H = 720
const OUT_W = 1920
const OUT_H = 1080
const PORT = 8961
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const clone = value => JSON.parse(JSON.stringify(value))

if (!fs.existsSync(bundlePath)) throw new Error('Run node harness/build.mjs first')
if (!fs.existsSync(pluginPath)) throw new Error(`Missing plugin ${pluginPath}`)

// ---- --check: the video is stale if the shipped plugin or its bundle moved ----
if (process.argv.includes('--check')) {
  if (!fs.existsSync(recordFile)) throw new Error('No demo-full.record.json; render the demo first')
  const record = readJson(recordFile)
  const now = { plugin_sha256: sha256(pluginPath), bundle_sha256: sha256(bundlePath) }
  const stale = Object.entries(now).filter(([key, value]) => record.source?.[key] !== value)
  console.log(JSON.stringify({ video: path.relative(repoRoot, finalMp4), recorded: record.source, now, stale: stale.map(([key]) => key) }, null, 2))
  if (stale.length) {
    console.error('STALE: plugin or harness bundle changed since the last render. Re-run node harness/hackathon-demo.mjs')
    process.exit(1)
  }
  console.log('OK: demo-full.mp4 matches the current plugin + bundle hashes')
  process.exit(0)
}

const CHROME_CANDIDATES = [
  process.env.HARNESS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate))
if (!CHROME) throw new Error('Chrome/Edge not found; set HARNESS_CHROME')
const PW = process.env.PLAYWRIGHT_CORE ||
  path.join(os.homedir(), 'AppData', 'Local', 'Temp', 'hpu-pw', 'node_modules', 'playwright-core')
const { chromium } = await import(pathToFileURL(path.join(PW, 'index.mjs')).href)
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const FFPROBE = process.env.FFPROBE || 'ffprobe'

// ---------------------------------------------------------------------------
// Synthetic fixture (sample values only; no identity inventory = stock truth)
// ---------------------------------------------------------------------------
const preview = readJson(path.join(__dirname, 'fixtures', 'preview-showcase.json'))
const popular = readJson(path.join(__dirname, 'fixtures', 'popular-connections.json'))
const honesty = readJson(path.join(__dirname, 'fixtures', 'declarative-honesty.json'))

const host = {
  model: 'gpt-5.6-codex',
  sessionId: 'sess-hackathon-sample',
  profile: 'default',
  connectionId: 'local',
  gateway: 'open',
  focusedSessionProfile: 'default',
  focusedSessionOwner: { connectionId: 'local', profile: 'default' }
}

const overview = clone(preview)
overview.version = 1
overview.fetched_at = '2026-11-11T16:20:00Z'
overview.account_profile = 'default'
overview.active = { provider: 'openai-codex', model: 'gpt-5.6-codex' }
overview.default_provider = 'openai-codex'
overview.host = host

// Active Codex card: real renderer inputs, richer sample metrics.
const codex = overview.providers.find(row => row.id === 'openai-codex')
codex.plan = 'Pro'
codex.limits = [
  {
    id: 'default',
    label: 'Codex',
    windows: [
      { label: '5-hour', remaining_percent: 62, reset_at: '2026-11-11T20:30:00Z' },
      { label: 'Weekly', remaining_percent: 84, reset_at: '2026-11-14T17:00:00Z' }
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

// A Manage-account link that must only be highlighted, never opened.
codex.manage_links = [
  { label: 'OpenAI usage dashboard', url: 'https://chatgpt.com/codex/settings/usage' }
]
const deepseek = overview.providers.find(row => row.id === 'deepseek')
if (deepseek) {
  deepseek.manage_links = [
    { label: 'DeepSeek billing', url: 'https://platform.deepseek.com/usage' }
  ]
}

// xAI on stock: no broker, so no invented subscription credit — official link.
const xai = overview.providers.find(row => row.id === 'xai-oauth')
if (xai) {
  xai.available = false
  xai.capability = 'usage'
  xai.plan = null
  xai.limits = []
  xai.balances = []
  xai.unavailable_reason = 'This stock host does not broker xAI subscription usage.'
  xai.manage_links = [{ label: 'Open xAI dashboard', url: 'https://grok.com/dashboard' }]
}

// Three always-listed connection cards + trust-state catalog.
overview.connections = clone(popular.connections).slice(0, 3)
overview.catalog = clone(honesty.catalog)
overview.catalog.profile = 'default'
overview.catalog.directory = '$HERMES_HOME/provider-usage/providers'

// Reset flow: read-only summary then confirmation preview. Never confirm.
const resetSummary = {
  ...clone(overview),
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
// A banked reset is only coherent when the allowance is exhausted. The real
// guard refuses a preview beside healthy meters, so the reset fixture mirrors
// the parent capture fix: every Codex window is 0% left / 100% used.
const resetCodex = resetSummary.providers.find(row => row.id === 'openai-codex')
for (const group of resetCodex?.limits || []) {
  for (const window of group.windows || []) {
    window.remaining_percent = 0
    window.used_percent = 100
  }
}
const resetPreview = {
  ...clone(resetSummary),
  summary: resetSummary,
  confirmation: {
    identity_id: 'codex:sample-account',
    account_label: 'Codex Pro · sample',
    available_count: 2,
    applicable_count: 1,
    token: 'sample-confirmation-token-not-submitted'
  }
}

// Running agents: three children, NO provider_account_id and NO accounts[].
// Stock has no identity inventory, so every row must render an em dash.
const subagents = {
  'sess-hackathon-sample': {
    subagents: [
      { subagent_id: 'sa-sample-1', goal: 'Audit the popover layout at 420px', model: 'gpt-5.6-codex', provider: 'openai-codex', status: 'running', started_at: 1762790400 },
      { subagent_id: 'sa-sample-2', goal: 'Collect the provider payloads', model: 'gpt-5.6-codex', provider: 'openai-codex', status: 'running', started_at: 1762790405 },
      { subagent_id: 'sa-sample-3', goal: 'Summarize provider docs', model: 'qwen3-coder:480b', status: 'running', started_at: 1762790410 }
    ],
    delegations: []
  }
}

const fixture = {
  overview,
  host,
  subagents,
  resetSummary,
  resetPreview
}
const THEME = { name: 'nous', mode: 'dark' }

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------
fs.mkdirSync(outDir, { recursive: true })
fs.mkdirSync(assetDir, { recursive: true })
fs.rmSync(framesDir, { recursive: true, force: true })
fs.mkdirSync(framesDir, { recursive: true })

const htmlPage = (fixtureData, resetMode = false) => `<!doctype html>
<html lang="en" data-harness="1">
<head>
<meta charset="utf-8" />
<title>Provider Usage — real components, sample data</title>
<link rel="stylesheet" href="/static/hermes-sdk.css" />
<style>
  html, body { margin:0; padding:0; background:#0b0f14; }
  * { box-sizing:border-box; scrollbar-width:none; }
  *::-webkit-scrollbar { display:none; width:0; height:0; }
  #panel {
    position:relative; width:1280px; height:720px; overflow:hidden; color:var(--ui-text-primary,#e6edf3);
    background:
      radial-gradient(900px 420px at 78% 18%, rgba(74,132,254,.10), transparent 62%),
      radial-gradient(700px 380px at 22% 92%, rgba(63,185,80,.055), transparent 68%),
      #0b0f14;
    font-family:var(--default-font-family,"Segoe UI",system-ui,sans-serif);
  }
  #panel::before {
    content:""; position:absolute; inset:0; pointer-events:none; opacity:.5;
    background:
      linear-gradient(90deg, rgba(48,54,61,.20) 1px, transparent 1px) 0 0 / 64px 100%,
      linear-gradient(0deg, rgba(48,54,61,.16) 1px, transparent 1px) 0 0 / 100% 64px;
    mask-image:linear-gradient(120deg, rgba(0,0,0,.5), transparent 58%);
  }
  #topbar { position:absolute; left:40px; right:40px; top:28px; display:flex; justify-content:space-between; align-items:flex-start; z-index:30; }
  #brand { display:grid; gap:4px; }
  #brand .name { font-size:13px; font-weight:650; letter-spacing:.02em; color:var(--ui-text-primary,#e6edf3); }
  #brand .sub { font-size:10.5px; letter-spacing:.14em; text-transform:uppercase; color:var(--ui-text-tertiary,#8b949e); }
  #fixture { display:flex; align-items:center; gap:8px; padding:7px 10px; border:1px solid rgba(210,153,34,.42); border-radius:7px; background:rgba(210,153,34,.08); font-size:10px; font-weight:650; letter-spacing:.10em; text-transform:uppercase; color:#e3b341; }
  #fixture i { width:6px; height:6px; border-radius:50%; background:#e3b341; display:block; }
  #rail { position:absolute; left:40px; top:118px; width:308px; z-index:25; }
  #step { font-size:10.5px; font-weight:650; letter-spacing:.16em; text-transform:uppercase; color:var(--ui-accent,#4a84fe); }
  #demo-title { margin:13px 0 0; font-size:25px; line-height:1.12; font-weight:650; letter-spacing:-.02em; color:var(--ui-text-primary,#e6edf3); min-height:56px; }
  #demo-body { margin:13px 0 0; font-size:14px; line-height:1.55; color:#9fa9b4; min-height:110px; }
  #demo-body b { color:#d7dee7; font-weight:600; }
  #rail-rule { width:44px; height:2px; background:var(--ui-accent,#4a84fe); margin:20px 0 14px; opacity:.85; }
  #legal { position:absolute; left:40px; bottom:26px; width:330px; font-size:9.5px; line-height:1.55; color:#6e7681; z-index:25; }
  #stage { position:absolute; left:390px; top:92px; width:850px; height:596px; z-index:5; }
  #stage-frame { position:absolute; inset:0; border:1px solid var(--ui-stroke-secondary,#30363d); border-radius:11px; background:rgba(13,17,23,.55); box-shadow:0 24px 70px rgba(0,0,0,.45); overflow:hidden; }
  #stage-frame::after { content:"status bar · right slot"; position:absolute; right:14px; bottom:9px; font-size:9px; letter-spacing:.12em; text-transform:uppercase; color:#5b636d; }
  #pane-root { display:none; position:absolute; left:390px; top:92px; width:850px; height:596px; z-index:10; border:1px solid var(--ui-stroke-secondary,#30363d); border-radius:11px; overflow:hidden; box-shadow:0 24px 70px rgba(0,0,0,.45); background:var(--ui-bg-editor,#0d1117); }
  #pane-root.is-visible { display:block; animation:paneIn .32s cubic-bezier(.2,.7,.2,1) both; }
  .demo-reset #pane-root { display:block; }
  .demo-reset #chip-root { display:none; }
  .demo-reset #stage-frame { opacity:0; }
  @keyframes paneIn { from { opacity:0; transform:translateY(7px) scale(.995); } to { opacity:1; transform:none; } }
  #chip-root { display:block; position:absolute; left:960px; top:648px; width:290px; z-index:20; }
  #chip-root.is-hidden { display:none; }
  #demo-ring { position:fixed; z-index:60; pointer-events:none; border-radius:7px; box-shadow:0 0 0 2px rgba(74,132,254,.95), 0 0 0 7px rgba(74,132,254,.16), 0 10px 34px rgba(0,0,0,.35); transition:all .28s cubic-bezier(.2,.7,.2,1); }
  #demo-hint { position:fixed; left:50%; top:64px; transform:translateX(-50%); z-index:61; pointer-events:none; padding:4px 8px; border-radius:5px; background:#17325f; border:1px solid rgba(74,132,254,.55); color:#dce9ff; font-size:9px; font-weight:650; letter-spacing:.09em; text-transform:uppercase; white-space:nowrap; }
  #endcard { display:none; position:absolute; inset:0; z-index:80; background:radial-gradient(760px 420px at 50% 38%, rgba(74,132,254,.16), transparent 66%), #0b0f14; padding:96px 90px; }
  #endcard.is-visible { display:block; animation:fadeIn .4s ease both; }
  @keyframes fadeIn { from { opacity:0; } to { opacity:1; } }
  #endcard .eyebrow { font-size:11px; font-weight:650; letter-spacing:.18em; text-transform:uppercase; color:var(--ui-accent,#4a84fe); }
  #endcard h1 { margin:20px 0 0; font-size:58px; line-height:1.02; letter-spacing:-.035em; font-weight:650; }
  #endcard .tag { margin:20px 0 0; font-size:21px; line-height:1.45; color:#b9c1ca; max-width:850px; }
  #endcard .facts { margin-top:34px; display:grid; grid-template-columns:repeat(3,1fr); gap:12px; max-width:1080px; }
  #endcard .fact { border:1px solid #30363d; border-radius:9px; padding:14px 16px; background:rgba(22,27,34,.66); }
  #endcard .fact strong { display:block; font-size:13px; font-weight:650; color:#e6edf3; }
  #endcard .fact span { display:block; margin-top:5px; font-size:11px; line-height:1.5; color:#8b949e; }
  #endcard .legal { position:absolute; left:90px; bottom:52px; right:90px; font-size:10.5px; line-height:1.6; color:#6e7681; }
</style>
<script>
  window.__FIXTURE__ = ${JSON.stringify(fixtureData)};
  window.__HARNESS_THEME__ = ${JSON.stringify(THEME)};
  window.__CAPTURE__ = { fixture:'demo-full', paneWidth:850, paneHeight:596, chipWidth:290, body:true };
  window.__DEMO_STATE__ = { step: '', clicks: 0 };
  if (${resetMode ? 'true' : 'false'}) document.documentElement.classList.add('demo-reset');
  window.__DEMO_MARK__ = function (name) { window.__DEMO_STATE__[name] = new Date().toISOString(); };
  window.__DEMO_CAPTION__ = function (step, title, body) {
    document.getElementById('step').textContent = step;
    document.getElementById('demo-title').textContent = title;
    document.getElementById('demo-body').innerHTML = body;
    window.__DEMO_MARK__(step);
  };
  window.__DEMO_SHOW_OVERVIEW__ = function () {
    document.getElementById('chip-root').classList.add('is-hidden');
    var pane = document.getElementById('pane-root');
    pane.classList.add('is-visible');
    document.getElementById('stage-frame').style.opacity = '0';
    window.__DEMO_STATE__.overview_opened = true;
  };
  window.__DEMO_RING__ = function (r, label) {
    if (!r) return null;
    var ring = document.getElementById('demo-ring');
    var hint = document.getElementById('demo-hint');
    if (!ring) { ring = document.createElement('div'); ring.id = 'demo-ring'; document.body.appendChild(ring); }
    if (!hint) { hint = document.createElement('div'); hint.id = 'demo-hint'; document.body.appendChild(hint); }
    ring.style.left = (r.left - 3) + 'px'; ring.style.top = (r.top - 3) + 'px';
    ring.style.width = (r.width + 6) + 'px'; ring.style.height = (r.height + 6) + 'px';
    hint.textContent = label || '';
    hint.style.display = label ? 'block' : 'none';
    return { x:r.x, y:r.y, width:r.width, height:r.height };
  };
  window.__DEMO_UNRING__ = function () {
    var ring = document.getElementById('demo-ring'); if (ring) ring.remove();
    var hint = document.getElementById('demo-hint'); if (hint) hint.remove();
  };
  window.__DEMO_END__ = function () {
    document.getElementById('endcard').classList.add('is-visible');
    window.__DEMO_STATE__.end = true;
  };
  // The real plugin calls host.navigate() for "View all providers". The harness
  // host is a no-op, so emulate the host's page switch at the capture layer.
  document.addEventListener('click', function (event) {
    var button = event.target && event.target.closest && event.target.closest('[aria-label="View all providers"]');
    if (!button) return;
    window.__DEMO_STATE__.view_all_clicks = (window.__DEMO_STATE__.view_all_clicks || 0) + 1;
    setTimeout(window.__DEMO_SHOW_OVERVIEW__, 320);
  }, true);
</script>
</head>
<body>
<div id="panel">
  <div id="topbar">
    <div id="brand"><span class="name">Provider Usage</span><span class="sub">Hermes Desktop · component harness</span></div>
    <div id="fixture"><i></i>Real plugin components · sample data</div>
  </div>
  <div id="rail">
    <div id="step">${resetMode ? '09 / BANKED RESET' : '01 / STATUS BAR'}</div>
    <h1 id="demo-title">${resetMode ? 'The allowance is spent. Check the reset.' : 'The account limit, beside the work.'}</h1>
    <p id="demo-body">${resetMode ? 'Codex is at <b>0% left</b>. Click <b>Check reset credits</b> for a read-only, account-scoped summary. Checking itself spends nothing.' : 'A status-bar readout for the provider funding the next request. <b>Synthetic fixture</b> — no live account is connected.'}</p>
    <div id="rail-rule"></div>
  </div>
  <div id="legal">Component harness, not the packaged desktop app. Every value is synthetic sample data. No account, credential, email, or local path is shown.</div>
  <div id="stage"><div id="stage-frame"></div></div>
  <div id="chip-root"></div>
  <div id="pane-root"></div>
  <div id="endcard">
    <div class="eyebrow">Provider Usage · Hermes Desktop plugin</div>
    <h1>The account limit,<br/>without the guesswork.</h1>
    <p class="tag">Windows, resets, and paid fallbacks for the provider that actually funds the request — with an em dash wherever the host cannot prove a value.</p>
    <div class="facts">
      <div class="fact"><strong>Real plugin components</strong><span>Shipped desktop/plugin.js + real Hermes SDK primitives.</span></div>
      <div class="fact"><strong>Sample data only</strong><span>Synthetic fixture. No live accounts, credentials, or balances.</span></div>
      <div class="fact"><strong>Nothing spent</strong><span>Reset flow stopped at the preview. No reset, credit, or purchase was made.</span></div>
    </div>
    <div class="legal">Component harness with the real plugin and real SDK components, driven by a synthetic fixture · not the packaged desktop app · no live provider read · no account or local path shown.</div>
  </div>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>`

const html = htmlPage(fixture, false)
const resetHtml = htmlPage({ ...fixture, overview: resetSummary }, true)
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  const base = urlPath.startsWith('/static/') ? path.join(__dirname, 'static') : dist
  const rel = urlPath.replace(/^\/static\//, '').replace(/^\/+/, '')
  const file = path.join(base, rel)
  if (!file.startsWith(base) && !(base === dist && file.startsWith(dist))) { res.writeHead(403); res.end('forbidden'); return }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'content-type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
fs.writeFileSync(path.join(dist, 'hackathon-demo.html'), html)
fs.writeFileSync(path.join(dist, 'hackathon-demo-reset.html'), resetHtml)

// ---------------------------------------------------------------------------
// Assertion helpers
// ---------------------------------------------------------------------------
const checks = []
function ok(name, detail = '') {
  checks.push({ name, detail, at: new Date().toISOString() })
  console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`)
}
async function must(condition, name, detail = '') {
  if (!condition) throw new Error(`ASSERTION FAILED: ${name}${detail ? ` — ${detail}` : ''}`)
  ok(name, detail)
}
async function textOf(page, selector) {
  return (await page.locator(selector).innerText().catch(() => '')) || ''
}
async function hasText(page, selector, needle) {
  const text = await textOf(page, selector)
  return text.replace(/\s+/g, ' ').toLowerCase().includes(needle.replace(/\s+/g, ' ').toLowerCase())
}
async function caption(page, step, title, body) {
  await page.evaluate(([step, title, body]) => window.__DEMO_CAPTION__(step, title, body), [step, title, body])
}
async function ring(page, target, label) {
  const locator = typeof target === 'string' ? page.locator(target).first() : target
  const box = await locator.boundingBox()
  if (!box) throw new Error(`ring target has no box: ${label}`)
  return page.evaluate(([rect, text]) => window.__DEMO_RING__(rect, text), [{ left: box.x, top: box.y, width: box.width, height: box.height }, label])
}
async function cardRect(page, label) {
  return page.getByText(label, { exact: true }).first().evaluate(node => {
    let el = node
    while (el && el.parentElement) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 300 && rect.height >= 30 && rect.height <= 120) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      el = el.parentElement
    }
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}
async function headerRect(page, label) {
  return page.getByText(label, { exact: true }).first().evaluate(node => {
    let el = node
    while (el && el.parentElement) {
      const rect = el.getBoundingClientRect()
      if (rect.width > 300 && rect.height >= 16 && rect.height <= 90) return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
      el = el.parentElement
    }
    const rect = node.getBoundingClientRect()
    return { left: rect.left, top: rect.top, width: rect.width, height: rect.height }
  })
}
async function shot(page, name) {
  await page.screenshot({ path: path.join(framesDir, `${name}.png`) })
}

// ---------------------------------------------------------------------------
// Record
// ---------------------------------------------------------------------------
const rawDir = path.join(outDir, 'demo-full-video')
fs.rmSync(rawDir, { recursive: true, force: true })
fs.mkdirSync(rawDir, { recursive: true })
const externalRequests = []
let browser
const startedAt = Date.now()

try {
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--hide-scrollbars', '--disable-extensions', '--no-first-run', '--disable-background-networking']
  })
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawDir, size: { width: W, height: H } }
  })
  await context.route('**/*', route => {
    const url = route.request().url()
    if (url === 'about:blank' || url.startsWith(`http://127.0.0.1:${PORT}`)) return route.continue()
    externalRequests.push(url)
    return route.abort()
  })
  const page = await context.newPage()
  let popups = 0
  const navigations = []
  page.on('popup', () => { popups += 1 })
  page.on('framenavigated', frame => { if (frame === page.mainFrame()) navigations.push(frame.url()) })
  page.on('pageerror', error => console.error('PAGE ERROR:', error.message))

  await page.goto(`http://127.0.0.1:${PORT}/hackathon-demo.html?v=${Date.now()}`, { waitUntil: 'load' })
  await page.waitForFunction('window.__HARNESS_READY__ === true', null, { timeout: 30000 })
  await page.locator('#chip-root button').waitFor({ state: 'visible', timeout: 20000 })
  await sleep(900)
  const harnessUrl = page.url()

  // 01 — resting chip
  await caption(page, '01 / STATUS BAR', 'The account limit, beside the work.',
    'A status-bar readout for the provider funding the next request. <b>Synthetic fixture</b> — no live account is connected.')
  await sleep(3000)
  await page.locator('#chip-root button').hover()
  await sleep(800)
  await shot(page, '01-chip-hover')
  const chipText = (await page.locator('#chip-root button').innerText()).replace(/\s+/g, ' ')
  await must(chipText.includes('Codex') && /wk\s*84%/.test(chipText), 'chip shows active provider + governing weekly window', chipText)

  // 02 — click → popover
  await page.locator('#chip-root button').click()
  await page.locator('[data-slot="popover-content"]').waitFor({ state: 'visible', timeout: 5000 })
  await sleep(450)
  await must(await hasText(page, '[data-slot="popover-content"]', '5-hour'), 'popover shows 5-hour window')
  await must(await hasText(page, '[data-slot="popover-content"]', 'Weekly'), 'popover shows weekly window')
  await must(await hasText(page, '[data-slot="popover-content"]', '62% left'), 'popover shows 62% left')
  await must(await hasText(page, '[data-slot="popover-content"]', 'View all providers'), 'popover exposes View all providers')
  await caption(page, '02 / USAGE & RESETS', 'Every governing window, in one place.',
    'Codex <b>5-hour 62% left</b> · <b>Weekly 84% left</b>, each with its reset time. The paid fallback appears only on its own labelled row.')
  await sleep(6500)
  await shot(page, '02-popover-top')

  // 03 — wheel-scroll the popover to the running-agents footer
  const popRect = await page.locator('[data-slot="popover-content"]').boundingBox()
  await page.mouse.move(popRect.x + popRect.width / 2, popRect.y + popRect.height / 2)
  await page.mouse.wheel(0, 460)
  await sleep(900)
  const scrollState = await page.evaluate(() => {
    const el = document.querySelector('[data-slot="popover-content"]')
    return { scrollTop: el.scrollTop, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight }
  })
  await must(scrollState.scrollTop > 20, 'popover actually scrolled with the wheel', JSON.stringify(scrollState))
  const footerText = await page.locator('[data-running-agents]').innerText().catch(() => '')
  const footerFlat = footerText.replace(/\s+/g, ' ')
  await must(footerFlat.includes('Running agents'), 'running-agents footer is present', footerFlat.slice(0, 120))
  await must(footerFlat.includes('3 agents'), 'footer counts three running agents', footerFlat.slice(0, 120))
  await must(footerFlat.includes('provider not reported'), 'footer shows provider-not-reported for an anonymous child')
  await must((footerFlat.match(/—/g) || []).length >= 2, 'footer uses em dashes for unverified pools', `${(footerFlat.match(/—/g) || []).length} em dashes`)
  await caption(page, '03 / RUNNING AGENTS', 'Prove the account, or say nothing.',
    'Three children are running. With no stock identity match, usage is an <b>em dash</b> — never another account’s balance. The anonymous child says <b>provider not reported</b>.')
  await sleep(7000)
  await shot(page, '03-footer-unknown')

  // 04 — View all → full page
  await caption(page, '03 / VIEW ALL', 'Open the full provider page.',
    'Click <b>View all providers</b>: the popover dismisses and the full page opens with every provider.')
  await sleep(1400)
  await page.locator('[aria-label="View all providers"]').click()
  await page.waitForFunction('window.__DEMO_STATE__.overview_opened === true', null, { timeout: 4000 })
  await page.locator('#pane-root').waitFor({ state: 'visible' })
  await sleep(650)
  await must(await page.locator('#chip-root').isHidden(), 'popover/chip dismissed when the page opens')
  await must(await hasText(page, '#pane-root', 'Provider usage'), 'full page rendered')
  await must(await hasText(page, '#pane-root', 'Other providers'), 'full page lists other providers')
  await page.evaluate(() => {
    const scroll = document.querySelector('#pane-root div[style*="overflow-y"]')
    if (scroll) scroll.scrollTop = 0
  })
  await sleep(500)
  await must(await hasText(page, '#pane-root', 'Current request funding'), 'active Codex card is at the top of the page')
  const activeBox = await page.locator('#provider-usage-active-heading').boundingBox()
  await must(Boolean(activeBox && activeBox.y >= 100 && activeBox.y < 230), 'active provider heading is in the visible pane viewport', JSON.stringify(activeBox))
  await caption(page, '04 / FULL PAGE', 'Every provider, each in its own units.',
    'The active Codex card keeps its windows and reset times. DeepSeek shows <b>API credit</b> in USD — every provider in its own units, never a copied balance.')
  await sleep(7500)
  await shot(page, '04-full-page')

  // 05 — provider detail expansion (real click on a disclosure row)
  const deepseekRow = page.locator('[aria-label="Expand DeepSeek"]')
  await deepseekRow.scrollIntoViewIfNeeded()
  await sleep(500)
  await deepseekRow.click()
  await page.waitForFunction(() => {
    const el = document.querySelector('[aria-label="Collapse DeepSeek"]')
    return Boolean(el && el.getAttribute('aria-expanded') === 'true')
  }, null, { timeout: 4000 })
  await sleep(500)
  await must(await hasText(page, '#pane-root', 'Balance'), 'expanded row reveals balance detail')
  await must(await hasText(page, '#pane-root', 'Total balance'), 'expanded row names the balance')
  await caption(page, '05 / PROVIDER DETAIL', 'Expand a provider for its own detail.',
    'A real click expands DeepSeek: balance components and reset metadata, read from that provider’s row — not copied from the active account.')
  await sleep(6000)
  await shot(page, '05-expanded-detail')

  // 06 — Manage account links highlighted, never opened
  const manageHref = await page.locator('a[aria-label="DeepSeek billing"]').getAttribute('href')
  await must(Boolean(manageHref && manageHref.startsWith('https://platform.deepseek.com/')), 'manage link is a real official URL', manageHref)
  await ring(page, 'a[aria-label="DeepSeek billing"]', 'Manage account · highlight only')
  await page.locator('a[aria-label="DeepSeek billing"]').hover()
  await sleep(600)
  await must(page.url() === harnessUrl, 'hovering Manage account did not navigate')
  await must(popups === 0, 'Manage account did not open a login window')
  await caption(page, '06 / ACCOUNT LINKS', 'A link out — never a login in disguise.',
    'Manage-account links are highlighted, not opened. No real sign-in page, credential, or password is touched anywhere in this demo.')
  await sleep(4500)
  await shot(page, '06-manage-link')
  await page.evaluate(() => window.__DEMO_UNRING__())

  // 07 — three popular connection cards
  const popularHeading = page.getByText('Popular providers', { exact: true }).first()
  await popularHeading.scrollIntoViewIfNeeded()
  await sleep(750)
  const popularSection = page.locator('section[aria-label="Popular provider connections"]')
  await must(await popularSection.locator('text=Claude / Anthropic').count() > 0, 'Claude / Anthropic card present')
  await must(await popularSection.locator('text=Google Gemini API').count() > 0, 'Google Gemini API card present')
  await must(await popularSection.locator('text=Z.ai / GLM').count() > 0, 'Z.ai / GLM card present')
  await must(await hasText(page, 'section[aria-label="Popular provider connections"]', 'No balance or quota is inferred.'), 'cards state no balance is inferred')
  await caption(page, '07 / POPULAR PROVIDERS', 'Three cards. Zero invented quotas.',
    'Claude / Anthropic, Google Gemini API, and Z.ai / GLM stay always-listed. They report credential presence and supported read paths — <b>never a balance or quota</b>.')
  const labels = ['Claude / Anthropic', 'Google Gemini API', 'Z.ai / GLM']
  for (let index = 0; index < labels.length; index += 1) {
    await page.getByText(labels[index], { exact: true }).first().scrollIntoViewIfNeeded()
    await sleep(520)
    await page.evaluate(([rect, text]) => window.__DEMO_RING__(rect, text), [await cardRect(page, labels[index]), `Card ${index + 1} / 3`])
    await sleep(2200)
  }
  await sleep(1500)
  await shot(page, '07-popular-cards')
  await page.evaluate(() => window.__DEMO_UNRING__())

  // 08 — trust states in Provider definitions
  await page.getByText('Provider definitions', { exact: true }).first().scrollIntoViewIfNeeded()
  await sleep(800)
  await must(await hasText(page, '#pane-root', 'Approval required'), 'catalog shows Approval required')
  await must(await hasText(page, '#pane-root', 'Blocked'), 'catalog shows Blocked')
  await must(await hasText(page, '#pane-root', 'Unverified mapping'), 'catalog shows Unverified mapping')
  await page.evaluate(([rect, text]) => window.__DEMO_RING__(rect, text), [await headerRect(page, 'Provider definitions'), 'Definitions · trust states'])
  await caption(page, '08 / DEFINITIONS & TRUST', 'Trust is a state, not a vibe.',
    'Read-only JSON names the exact missing credential. A profile-local file shows <b>Approval required</b>; a blocked or unverified mapping stays visible. Nothing is fetched or auto-approved.')
  await sleep(6000)
  await shot(page, '08-trust-definitions')
  await page.evaluate(() => window.__DEMO_UNRING__())

  // 09 — banked reset: exhausted-allowance scene, read-only summary
  const callsBeforeReset = await page.evaluate(() => (window.__CAPTURE__.restCalls || []).map(call => ({ path: call.path, method: call.opts?.method || 'GET', body: call.opts?.body || null })))
  const stateBeforeReset = await page.evaluate(() => ({ ...window.__DEMO_STATE__ }))
  await page.goto(`http://127.0.0.1:${PORT}/hackathon-demo-reset.html?v=${Date.now()}`, { waitUntil: 'load' })
  await page.waitForFunction('window.__HARNESS_READY__ === true', null, { timeout: 30000 })
  await page.locator('#pane-root').waitFor({ state: 'visible' })
  await sleep(800)
  await must(await hasText(page, '#pane-root', '0% left'), 'reset scenario opens with exhausted Codex windows (0% left)')
  await must(!(await hasText(page, '#pane-root', '62% left')), 'no healthy 62% meter beside the reset flow')
  await caption(page, '09 / BANKED RESET', 'The allowance is spent. Check the reset.',
    'Codex is at <b>0% left</b>. Click <b>Check reset credits</b> for a read-only, account-scoped summary. Checking itself spends nothing.')
  await sleep(1400)
  const checkButton = page.getByRole('button', { name: 'Check reset credits' })
  await checkButton.scrollIntoViewIfNeeded()
  await sleep(600)
  await checkButton.click()
  await page.waitForFunction(() => document.body.innerText.includes('Resets available'), null, { timeout: 5000 })
  await must(await hasText(page, '#pane-root', '2 banked resets are available'), 'read-only reset summary rendered')
  await must(await hasText(page, '#pane-root', 'Active account: Codex Pro · sample'), 'summary names the synthetic account')
  await caption(page, '09 / BANKED RESET', 'A read-only summary, scoped to one account.',
    'Two banked resets are visible for the sample Codex account. This panel only <b>reads</b> provider-reported inventory; nothing is redeemed by checking.')
  await sleep(4500)
  await shot(page, '09-reset-summary')

  // The preview is a second POST read; script the preview payload before the
  // click so the response carries the confirmation block.
  await page.evaluate((previewData) => window.__HARNESS__.setOverview(previewData), resetPreview)
  await caption(page, '10 / PREVIEW ONLY', 'Preview the reset — then stop.',
    'Click <b>Preview reset</b>. It opens a confirmation preview; the final <b>Confirm reset</b> is never pressed.')
  await sleep(1400)
  const previewButton = page.getByRole('button', { name: 'Preview reset' })
  await previewButton.click()
  await page.waitForFunction(() => document.body.innerText.includes('Confirm Codex Pro · sample'), null, { timeout: 5000 })
  await must(await hasText(page, '#pane-root', 'This spends one banked reset'), 'confirmation preview names the spend')
  const confirmButton = page.getByRole('button', { name: /Confirm reset on Codex Pro/ })
  await must(await confirmButton.count() === 1, 'explicit final confirm button exists')
  await must(await confirmButton.isVisible(), 'final confirm is visible and deliberately not clicked')
  await sleep(400)
  const calls = callsBeforeReset.concat(await page.evaluate(() => (window.__CAPTURE__.restCalls || []).map(call => ({ path: call.path, method: call.opts?.method || 'GET', body: call.opts?.body || null }))))
  const confirmCalls = calls.filter(call => String(call.path).includes('/reset/confirm'))
  await must(confirmCalls.length === 0, 'ZERO /reset/confirm calls — confirmation intercepted, nothing redeemed', `${calls.length} harness REST calls`)
  await must(calls.some(call => call.path.includes('/reset/summary')), 'summary read was a real harness REST call')
  await must(calls.some(call => call.path.includes('/reset/preview')), 'preview read was a real harness REST call')
  await caption(page, '10 / STOP BEFORE CONFIRM', 'The preview is where this demo ends.',
    'The confirmation names the account and counts <b>2 banked · 1 usable</b>. The final <b>Confirm reset</b> is visible but never clicked: no reset, credit, or purchase was made.')
  await sleep(5500)
  await shot(page, '10-confirm-preview')

  // 11 — end card
  await page.evaluate(() => window.__DEMO_END__())
  await sleep(400)
  await must(await page.locator('#endcard').isVisible(), 'end card disclosure visible')
  await must(await hasText(page, '#endcard', 'Real plugin components'), 'end card labels real components')
  await must(await hasText(page, '#endcard', 'Sample data only'), 'end card labels sample data')
  await must(await hasText(page, '#endcard', 'Nothing spent'), 'end card states nothing was spent')
  await sleep(4600)
  await shot(page, '11-endcard')
  await sleep(1200)

  const resetState = await page.evaluate(() => ({ ...window.__DEMO_STATE__ }))
  const pageState = { ...stateBeforeReset, ...resetState, restCalls: calls.length }
  await must(pageState.view_all_clicks === 1, 'View all was clicked exactly once')
  await must(externalRequests.length === 0, 'ZERO external network requests (no login/provider calls)', JSON.stringify(externalRequests))
  await must(navigations.every(url => url.startsWith(`http://127.0.0.1:${PORT}/`)), 'every navigation stayed on the local harness (no external site)', JSON.stringify(navigations))
  if (popups !== 0) throw new Error(`popup count ${popups}`)

  await context.close()
  await browser.close()
  browser = null

  // ---- encode ----
  const video = fs.readdirSync(rawDir).filter(name => name.endsWith('.webm')).map(name => path.join(rawDir, name)).sort().pop()
  if (!video) throw new Error('Playwright wrote no WebM')
  const probeRaw = spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', video], { encoding: 'utf8' })
  const rawMeta = JSON.parse(probeRaw.stdout || '{}').format || {}
  const rawDuration = Number(rawMeta.duration || 0)
  const targetDuration = 84
  const trimStart = rawDuration > targetDuration + 2 ? Math.min(rawDuration - targetDuration, 3.5) : 0
  const encodeArgs = [
    '-y', '-hide_banner', '-loglevel', 'error',
    ...(trimStart > 0 ? ['-ss', trimStart.toFixed(3)] : []),
    '-i', video,
    '-vf', `fps=30,scale=${OUT_W}:${OUT_H}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '19',
    '-profile:v', 'high', '-level', '4.2', '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart', '-map_metadata', '-1', '-an',
    '-metadata', 'title=Provider Usage — real plugin components, sample data',
    '-metadata', `comment=Synthetic fixture; plugin sha256 ${sha256(pluginPath)}; bundle sha256 ${sha256(bundlePath)}; no live accounts; reset preview only, nothing redeemed`,
    finalMp4
  ]
  const ff = spawnSync(FFMPEG, encodeArgs, { encoding: 'utf8' })
  if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr || ff.stdout}`)

  const probe = JSON.parse(spawnSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height,codec_name,pix_fmt,r_frame_rate,duration:format=duration,size,format_name:format_tags=comment,title', '-of', 'json', finalMp4], { encoding: 'utf8' }).stdout || '{}')
  const stream = probe.streams?.[0] || {}
  const format = probe.format || {}
  const duration = Number(format.duration || stream.duration || 0)
  if (!(duration > 60 && duration <= 90)) throw new Error(`Duration ${duration}s outside 60–90s`)
  if (stream.width !== OUT_W || stream.height !== OUT_H) throw new Error(`Resolution ${stream.width}x${stream.height}`)
  if (stream.codec_name !== 'h264' || stream.pix_fmt !== 'yuv420p') throw new Error(`Codec ${stream.codec_name}/${stream.pix_fmt}`)

  // poster at 8s — popover/window beat
  const posterAt = Math.min(8.0, Math.max(0, duration - 1))
  const posterFf = spawnSync(FFMPEG, ['-y', '-hide_banner', '-loglevel', 'error', '-ss', String(posterAt), '-i', finalMp4, '-frames:v', '1', '-update', '1', poster], { encoding: 'utf8' })
  if (posterFf.status !== 0) throw new Error(`poster failed: ${posterFf.stderr}`)

  const record = {
    rendered_at: new Date().toISOString(),
    elapsed_seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    video: path.relative(repoRoot, finalMp4).replace(/\\/g, '/'),
    poster: path.relative(repoRoot, poster).replace(/\\/g, '/'),
    source: { plugin: 'desktop/plugin.js', plugin_sha256: sha256(pluginPath), bundle: 'harness/dist/app.js', bundle_sha256: sha256(bundlePath) },
    fixture: { file: 'harness/hackathon-demo.mjs', synthetic: true, live_accounts: false, reset_fixture: 'read-only summary + confirmation preview, never confirmed' },
    raw_webm: { file: path.basename(video), duration: rawDuration, trim_start: trimStart },
    output: {
      duration_seconds: Math.round(duration * 1000) / 1000,
      width: stream.width,
      height: stream.height,
      codec: stream.codec_name,
      pix_fmt: stream.pix_fmt,
      fps: stream.r_frame_rate,
      bytes: fs.statSync(finalMp4).size,
      audio: 'none (silent, burned-in captions)',
      metadata_comment: format.tags?.comment || ''
    },
    assertions: checks,
    interaction: { view_all_clicks: pageState.view_all_clicks, harness_rest_calls: calls.length, reset_confirm_calls: confirmCalls.length, external_requests: externalRequests.length, popups, navigations }
  }
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n')

  console.log(`\nMP4     ${finalMp4}`)
  console.log(`Poster  ${poster}`)
  console.log(`Duration ${duration.toFixed(2)}s · ${stream.width}x${stream.height} · ${stream.codec_name}/${stream.pix_fmt} · ${(fs.statSync(finalMp4).size / 1024 / 1024).toFixed(2)} MB`)
  console.log(`Plugin  sha256 ${record.source.plugin_sha256}`)
  console.log(`Bundle  sha256 ${record.source.bundle_sha256}`)
  console.log(`Checks  ${checks.length} passed · reset-confirm calls ${confirmCalls.length} · external requests ${externalRequests.length}`)
  console.log(`Record  ${recordFile}`)
} finally {
  try { await browser?.close() } catch {}
  server.close()
}
