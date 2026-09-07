/**
 * Capture script for the Provider Usage component harness.
 *
 * Serves the harness over a local HTTP server, launches native headless Chrome
 * with a remote-debugging port, navigates each fixture×width page, WAITS for the
 * plugin to actually mount (window.__HARNESS_READY__), captures a screenshot,
 * and dumps DOM geometry + rendered text as evidence.
 *
 * Usage:
 *   node harness/capture.mjs                    # all fixtures × widths [420, 760]
 *   node harness/capture.mjs --width 420        # only one width
 *   node harness/capture.mjs --fixture credit-balance
 *
 * Requires: harness bundle (harness/build.mjs) + native Chrome + hermes-agent
 * (for the CDP client). Defaults as above.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const dist = path.join(__dirname, 'dist')
const shots = path.join(dist, 'shots')
fs.mkdirSync(shots, { recursive: true })

// Portable defaults: never hardcode a personal user path. HERMES_AGENT_ROOT may
// point at any checkout; CHROME may point at any Chrome binary. Both resolve to
// the standard-machine path when the env var is unset.
const CHROME = process.env.HARNESS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')

// Import the hermes-agent CDP client by absolute path.
const { CDP, discoverTarget } = await import(
  pathToFileURL(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'scripts', 'perf', 'lib', 'cdp.mjs')).href
)

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const fixturesDir = path.join(__dirname, 'fixtures')
const fixtures = fs
  .readdirSync(fixturesDir)
  .filter(f => f.endsWith('.json'))
  .map(f => f.replace(/\.json$/, ''))

const requestedFixture = arg('--fixture', '')
const requestedWidth = arg('--width', '')
const WIDTHS = requestedWidth ? [Number(requestedWidth)] : [420, 760]
const PANE_HEIGHT = 1500

if (!fs.existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}`)
if (!fs.existsSync(path.join(dist, 'app.js'))) throw new Error('Run harness/build.mjs first')
const sdkCss = path.join(__dirname, 'static', 'hermes-sdk.css')
if (!fs.existsSync(sdkCss)) throw new Error('Real SDK CSS missing at harness/static/hermes-sdk.css')

// ---- 1. static server ----
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  // Serve static/ (real SDK css) and dist/ (bundle + generated html).
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
const PORT = 8931
await new Promise(resolve => server.listen(PORT, '127.0.0.1', resolve))
console.log(`Serving harness on http://127.0.0.1:${PORT} (worktree root ${repoRoot})`)

// ---- 2. headless chrome on isolated CDP port ----
const CDP_PORT = 8932
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpu-harness-'))
const cdpArgs = [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  '--force-device-scale-factor=1',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  'about:blank'
]
const chromeProc = spawn(CHROME, cdpArgs, { stdio: 'ignore' })

const sleep = ms => new Promise(r => setTimeout(r, ms))
async function waitForRender(cdp, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ready = await cdp.eval('window.__HARNESS_READY__ === true').catch(() => false)
    if (ready) return true
    if (Date.now() >= deadline) throw new Error('Timed out waiting for window.__HARNESS_READY__')
    await sleep(150)
  }
}

// Poll a page expression until it returns a truthy value (or timeout). Used by
// the lifecycle scenario to synchronise on the plugin actually committing each
// step's DOM before capturing evidence.
async function waitUntil(cdp, expr, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await cdp.eval(expr).catch(() => false)
    if (ok) return
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for: ${expr}`)
    await sleep(120)
  }
}

const geometry = {}
try {
  let cdp = null
  try {
    cdp = await CDP.connect({ port: CDP_PORT, match: 'about:blank', timeoutMs: 15000 })
  } catch {
    cdp = await CDP.connect({ port: CDP_PORT, timeoutMs: 15000 })
  }
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1400,
    height: PANE_HEIGHT + 80,
    deviceScaleFactor: 1,
    mobile: false
  })
  await cdp.send('Page.enable')

  const selected = fixtures.filter(f => !requestedFixture || f === requestedFixture)
  for (const fixture of selected) {
    const fixtureData = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${fixture}.json`), 'utf8'))
    const hostCfg = { model: fixtureData.active.model, sessionId: 'sess-harness-1', profile: 'default', gateway: 'open' }

    for (const width of WIDTHS) {
      const label = `${fixture}_w${width}`
      // Rebuild the HTML each time with this width so the pane container reflects width.
      const html = htmlPage({ fixture, width, fixtureData, hostCfg })
      fs.writeFileSync(path.join(dist, 'index.html'), html)
      const url = `http://127.0.0.1:${PORT}/index.html`

      await cdp.send('Page.navigate', { url })
      await waitForRender(cdp)
      await sleep(400) // let React commit + layout settle

      const meta = {
        registered: await cdp.eval('window.__CAPTURE__.registered'),
        paneRect: await cdp.eval('window.__CAPTURE__["pane-root-rect"]'),
        chipRect: await cdp.eval('window.__CAPTURE__["chip-root-rect"]'),
        geometry: await cdp.eval('window.__GEOMETRY__'),
        text: await cdp.eval('(document.getElementById("pane-root")||document.body).innerText.slice(0, 2000)')
      }
      // Screenshot at device metrics (pane occupies left width, tall).
      try {
        const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
        fs.writeFileSync(path.join(shots, `${label}.png`), Buffer.from(shot.data, 'base64'))
      } catch (e) {
        console.warn(`  screenshot failed for ${label}: ${e.message}`)
      }
      const geometrySnap = await cdp
        .eval('window.__GEOMETRY__ ? JSON.stringify(window.__GEOMETRY__) : null')
        .catch(() => null)
      const final = { registered: meta.registered, paneRect: meta.paneRect, chipRect: meta.chipRect }
      final.geometry = geometrySnap ? JSON.parse(geometrySnap) : null
      final.text = meta.text
      final.chipText = await cdp
        .eval('(document.getElementById("chip-root")||document.body).innerText.slice(0, 300)')
        .catch(() => '')
      final.chipHtml = await cdp
        .eval('document.getElementById("chip-root") ? document.getElementById("chip-root").innerHTML.slice(0, 300) : ""')
        .catch(() => '')
      geometry[label] = final
      console.log(`Captured ${label}  pane=${JSON.stringify(meta.paneRect)}  chip=${JSON.stringify(meta.chipRect)}`)
    }
  }
  // Real-browser lifecycle verification of the priority regression: a default
  // profile WITH backend → a profile WITHOUT the plugin backend (ChaosForge) →
  // back to default. Asserts pane AND toolbar at every step.
  geometry.lifecycle = await runLifecycle(cdp, { dist, PORT, htmlPage })
  cdp.close()
} finally {
  server.close()
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  chromeProc.kill()
}

fs.writeFileSync(path.join(shots, 'geometry.json'), JSON.stringify(geometry, null, 2))
console.log(`\nGeometry evidence → ${path.join(shots, 'geometry.json')}`)

function htmlPage({ fixture, width, fixtureData, hostCfg }) {
  return `<!doctype html>
<html lang="en" data-harness="1">
  <head>
    <meta charset="utf-8" />
    <title>Provider Usage harness — ${fixture} (width ${width})</title>
    <link rel="stylesheet" href="./static/hermes-sdk.css" />
    <style>
      html, body { margin: 0; padding: 0; background: var(--ui-bg-editor, #f8faff); }
      * { box-sizing: border-box; }
      #panel { position: relative; background: var(--ui-bg-editor, #f8faff); }
      #chip-root { position: absolute; top: 10px; left: ${width + 20}px; width: 320px; z-index: 5; border: 1px dashed rgba(128,128,128,.4); padding: 4px; }
      #pane-root { width: ${width}px; height: ${PANE_HEIGHT}px; }
      .harness-note { position: absolute; top: 10px; left: 10px; font: 11px/1.4 system-ui; color: #888; z-index: 9; }
    </style>
    <script>
      window.__FIXTURE__ = { overview: ${JSON.stringify(fixtureData)}, host: ${JSON.stringify(hostCfg)} };
      window.__CAPTURE__ = { fixture: ${JSON.stringify(fixture)}, paneWidth: ${width}, paneHeight: ${PANE_HEIGHT}, chipWidth: 320, body: true };
    </script>
  </head>
  <body>
    <div class="harness-note">Provider Usage harness · fixture ${fixture} · pane ${width}px · component render (real plugin.js + real SDK primitives)</div>
    <div id="panel">
      <div id="chip-root"></div>
      <div id="pane-root"></div>
    </div>
    <script type="module" src="./app.js"></script>
  </body>
</html>`
}

/**
 * Real-browser lifecycle verification of the priority regression:
 *   default (with backend) → ChaosForge-like profile (NO backend, `/overview`
 *   404s) → back to default.
 * Every step drives the REAL plugin through real re-renders (SDK atoms + the
 * stubbed-but-keyed useQuery/ctx.rest) and asserts pane AND toolbar state.
 * Returns per-step evidence recorded into geometry.json for verify.mjs.
 */
async function runLifecycle(cdp, { dist, PORT, htmlPage }) {
  const fixture = 'compact-5h-wk'
  const width = 420
  const fixtureData = JSON.parse(fs.readFileSync(path.join(fixturesDir, `${fixture}.json`), 'utf8'))
  const hostCfg = {
    model: 'claude-4-9-sonnet',
    sessionId: 'sess-harness-1',
    profile: 'default',
    connectionId: 'local',
    focusedSessionOwner: { connectionId: 'local', profile: 'default' },
    focusedSessionProfile: 'default',
    gateway: 'open'
  }
  fs.writeFileSync(path.join(dist, 'index.html'), htmlPage({ fixture, width, fixtureData, hostCfg }))
  await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
  await waitForRender(cdp)

  const paneText = () => cdp.eval('(document.getElementById("pane-root")||document.body).innerText').catch(() => '')
  const chipText = () => cdp.eval('(document.getElementById("chip-root")||document.body).innerText').catch(() => '')
  // Live chip BUTTON geometry (positive w/h, ≤230px production cap) — not the
  // 320px harness wrapper. This is what catches a zero-height toolbar.
  const chipButton = () => cdp.eval(`(() => { const b = document.querySelector('#chip-root button'); if (!b) return null; const r = b.getBoundingClientRect(); return { w: r.width, h: r.height, text: (b.textContent||'').trim() }; })()`).catch(() => null)

  const snapshot = async () => ({ paneText: (await paneText()).slice(0, 1500), chipText: (await chipText()).slice(0, 300), chipButton: await chipButton() })

  // Step 0 — default with backend: genuine data on pane + toolbar.
  await waitUntil(cdp, `(document.getElementById("pane-root")||document.body).innerText.includes("5h 62%")`)
  await sleep(250)
  const s0 = { label: 'default-with-backend', profile: 'default', ...(await snapshot()) }

  // Step 1 — ChaosForge-like profile, backend NOT installed: /overview 404s.
  await cdp.eval(`window.__HARNESS__.setRest('404'); window.__HARNESS__.set({ profile:'chaosforge', connectionId:'local', sessionId:'sess-cf', focusedSessionOwner:{connectionId:'local',profile:'chaosforge'}, focusedSessionProfile:'chaosforge', gateway:'open' }); true`)
  await waitUntil(cdp, `(document.getElementById("pane-root")||document.body).innerText.includes("isn't enabled or installed in chaosforge")`)
  await sleep(250)
  const s1 = { label: 'chaosforge-no-backend', profile: 'chaosforge', restMode: '404', ...(await snapshot()) }

  // Step 2 — return to default: back to the cached default account, recovered.
  await cdp.eval(`window.__HARNESS__.setRest('ok'); window.__HARNESS__.set({ profile:'default', connectionId:'local', sessionId:'sess-harness-1', focusedSessionOwner:{connectionId:'local',profile:'default'}, focusedSessionProfile:'default', gateway:'open' }); true`)
  await waitUntil(cdp, `(document.getElementById("pane-root")||document.body).innerText.includes("5h 62%")`)
  await sleep(250)
  const s2 = { label: 'recovered-default', profile: 'default', restMode: 'ok', ...(await snapshot()) }

  console.log('Lifecycle scenario captured: default → chaosforge(no backend) → default')
  return { fixture, width, steps: [s0, s1, s2] }
}