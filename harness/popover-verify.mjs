/**
 * One-off popover verification: serves the harness, navigates to a fixture,
 * clicks the toolbar chip button, and captures the open popover (current
 * provider detail + "View all providers") as a screenshot + DOM text + geometry.
 *
 * This proves the NEW chip→popover interaction works in a real browser with the
 * real SDK components, not just that the chip button renders.
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
const shots = path.join(dist, 'shots')
fs.mkdirSync(shots, { recursive: true })

const CHROME = process.env.HARNESS_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')
const PORT = 8932
const CDP_PORT = 9341 // unrelated tools commonly hold 9333 — pick a rarely-used port
const PANE_HEIGHT = 1500
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { CDP, discoverTarget } = await import(
  pathToFileURL(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'scripts', 'perf', 'lib', 'cdp.mjs')).href
)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
const server = http.createServer((req, res) => {
  const urlPath = (req.url || '/').split('?')[0]
  const file = urlPath === '/' ? path.join(dist, 'index.html') : path.join(dist, urlPath.replace(/^\//, ''))
  if (!fs.existsSync(file)) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  res.end(fs.readFileSync(file))
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

function htmlPage({ fixture, width, fixtureData, hostCfg }) {
  return `<!doctype html>
<html lang="en" data-harness="1">
  <head>
    <meta charset="utf-8" />
    <title>Provider Usage popover — ${fixture}</title>
    <link rel="stylesheet" href="./static/hermes-sdk.css" />
    <style>
      html, body { margin: 0; padding: 0; background: var(--ui-bg-editor, #f8faff); }
      * { box-sizing: border-box; }
      #chip-root { position: absolute; top: 10px; left: 20px; width: 320px; z-index: 5; }
      #pane-root { width: ${width}px; height: ${PANE_HEIGHT}px; }
    </style>
    <script>
      window.__FIXTURE__ = { overview: ${JSON.stringify(fixtureData)}, host: ${JSON.stringify(hostCfg)} };
      window.__CAPTURE__ = { fixture: ${JSON.stringify(fixture)}, paneWidth: ${width}, paneHeight: ${PANE_HEIGHT}, chipWidth: 320, body: true };
    </script>
  </head>
  <body>
    <div id="chip-root"></div>
    <div id="pane-root"></div>
    <script type="module" src="./app.js"></script>
  </body>
</html>`
}

// launch headless chrome with a debug port
const userData = path.join(os.tmpdir(), `pu-popover-${Date.now()}`)
const chrome = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  '--window-size=1400,1600', 'about:blank'
], { stdio: 'ignore', detached: true })
chrome.unref()

async function waitForRender(cdp) {
  const deadline = Date.now() + 15000
  for (;;) {
    const ok = await cdp.eval('!!window.__HARNESS_READY__').catch(() => false)
    if (ok) return
    if (Date.now() >= deadline) throw new Error('harness not ready')
    await sleep(120)
  }
}
const waitUntil = async (cdp, expr, timeoutMs = 15000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await cdp.eval(expr).catch(() => false)
    if (ok) return
    if (Date.now() >= deadline) throw new Error(`timeout: ${expr}`)
    await sleep(120)
  }
}

const fixture = 'compact-5h-wk'
const fixtureData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${fixture}.json`), 'utf8'))
const hostCfg = { model: fixtureData.active.model, sessionId: 'sess-harness-1', profile: 'default', gateway: 'open' }

let cdp
try { cdp = await CDP.connect({ port: CDP_PORT, match: 'about:blank', timeoutMs: 15000 }) }
catch { cdp = await CDP.connect({ port: CDP_PORT, timeoutMs: 15000 }) }
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1600, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.enable')

fs.writeFileSync(path.join(dist, 'index.html'), htmlPage({ fixture, width: 760, fixtureData, hostCfg }))
await cdp.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` })
await waitForRender(cdp)
await sleep(500)

// Prove the chip button is wired as the Popover trigger. Radix puts
// aria-haspopup="dialog" + aria-expanded on the trigger ELEMENT — if a scaffold
// (e.g. a tooltip wrapper) sits between PopoverTrigger and the button, those
// props are swallowed and the click opens nothing. That is the v0.4.1 regression.
const chipInfo = await cdp.eval(`(() => {
  const btn = document.querySelector('#chip-root button')
  if (!btn) return null
  const r = btn.getBoundingClientRect()
  return { text: btn.textContent.trim(), w: r.width, h: r.height, ariaHasPopup: btn.getAttribute('aria-haspopup'), ariaExpanded: btn.getAttribute('aria-expanded') }
})()`)
console.log('CHIP BUTTON:', JSON.stringify(chipInfo))
if (!chipInfo || chipInfo.ariaHasPopup !== 'dialog' || chipInfo.ariaExpanded !== 'false') {
  console.error('FAIL: chip button is not wired as the popover trigger (aria-haspopup/aria-expanded missing) — trigger props are being swallowed between PopoverTrigger and the button.')
  process.exitCode = 1
}

// Click the chip button to open the popover.
await cdp.eval(`(() => {
  const btn = document.querySelector('#chip-root button')
  if (!btn) return false
  btn.click()
  return true
})()`)
await sleep(700)

// Capture the open popover content (current provider detail + view all).
const popoverText = await cdp.eval(`(() => {
  const pop = document.querySelector('[data-slot="popover-content"]')
  return pop ? pop.innerText.slice(0, 1200) : null
})()`)
console.log('POPOVER TEXT:', JSON.stringify(popoverText))

const popGeo = await cdp.eval(`(() => {
  const pop = document.querySelector('[data-slot="popover-content"]')
  if (!pop) return null
  const r = pop.getBoundingClientRect()
  const cs = getComputedStyle(pop)
  const btns = Array.from(pop.querySelectorAll('button'))
  const viewAllBtn = btns.find(b => /view all/i.test(b.textContent))
  return { w: r.width, h: r.height, visible: r.width > 0 && r.height > 0, bg: cs.backgroundColor, buttonCount: btns.length, buttonTexts: btns.map(b => b.textContent.trim()).slice(0,10), viewAll: !!viewAllBtn, viewAllRect: viewAllBtn ? (() => { const rr = viewAllBtn.getBoundingClientRect(); return { w: rr.width, h: rr.height } })() : null }
})()`)
console.log('POPOVER GEO:', JSON.stringify(popGeo))

const pass = Boolean(popoverText && popGeo && popGeo.visible && popGeo.viewAll)
console.log(pass
  ? 'POPOVER VERIFY: PASS — chip click opens the popover with "View all providers".'
  : 'POPOVER VERIFY: FAIL — the chip click did not open a usable popover.')
if (!pass) process.exitCode = 1

// Hide the page behind the popover so the capture shows the popover alone
await cdp.eval(`(() => { const p = document.getElementById('pane-root'); if (p) p.style.visibility = 'hidden'; return true })()`)
await sleep(300)
try {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  fs.writeFileSync(path.join(shots, 'popover-open_w760.png'), Buffer.from(shot.data, 'base64'))
  console.log('SCREENSHOT:', path.join(shots, 'popover-open_w760.png'))
} catch (e) { console.error('screenshot failed', e.message) }

cdp.close()
server.close()
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
console.log('DONE')
// Exit non-zero when anything failed above (the wiring check or the popover check).
process.exit(pass && process.exitCode !== 1 ? 0 : 1)
