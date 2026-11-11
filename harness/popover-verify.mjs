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
import { spawn, execFileSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const dist = path.join(__dirname, 'dist')
const shots = path.join(dist, 'shots')
fs.mkdirSync(shots, { recursive: true })

const CHROME_CANDIDATES = [
  process.env.HARNESS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || CHROME_CANDIDATES[0]
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')
const PORT = 8932
const CDP_PORT = 9341 // unrelated tools commonly hold 9333 — pick a rarely-used port
const PANE_HEIGHT = 1500
function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const sleep = ms => new Promise(r => setTimeout(r, ms))

const { CDP, discoverTarget } = await import(
  pathToFileURL(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'scripts', 'perf', 'lib', 'cdp.mjs')).href
)

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png' }
const sdkCss = path.join(__dirname, 'static', 'hermes-sdk.css')
if (!fs.existsSync(sdkCss)) throw new Error('Real SDK CSS missing at harness/static/hermes-sdk.css')
const server = http.createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0])
  // Serve static/ (the real SDK stylesheet) and dist/ (bundle + generated
  // pages). The popover page MUST get the real stylesheet — without it every
  // var()-based token falls back and the capture renders unstyled.
  const base = urlPath.startsWith('/static/') ? path.join(__dirname, 'static') : dist
  const rel = urlPath.replace(/^\/static\//, '').replace(/^\/+/, '')
  const file = path.join(base, rel)
  if (!file.startsWith(base) && !(base === dist && file.startsWith(dist))) {
    res.writeHead(403); res.end('forbidden'); return
  }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); res.end('not found'); return }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' })
  fs.createReadStream(file).pipe(res)
})
await new Promise(r => server.listen(PORT, '127.0.0.1', r))

function htmlPage({ fixture, width, fixtureData, hostCfg, themeSpec = null }) {
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
      window.__FIXTURE__ = {
        overview: ${JSON.stringify(fixtureData)},
        subagents: ${JSON.stringify(fixtureData.subagents || {})},
        host: ${JSON.stringify(hostCfg)}
      };
      window.__HARNESS_THEME__ = ${JSON.stringify(themeSpec)};
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

const fixture = arg('--fixture', 'compact-5h-wk')
const width = Number(arg('--width', '760'))
const themeName = arg('--theme', '')
const themeMode = arg('--mode', 'dark') === 'light' ? 'light' : 'dark'
const themeSpec = themeName ? { name: themeName, mode: themeMode } : null
const fixtureData = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', `${fixture}.json`), 'utf8'))
const hostCfg = { model: fixtureData.active.model, sessionId: 'sess-harness-1', profile: 'default', gateway: 'open' }

let cdp
try { cdp = await CDP.connect({ port: CDP_PORT, match: 'about:blank', timeoutMs: 15000 }) }
catch { cdp = await CDP.connect({ port: CDP_PORT, timeoutMs: 15000 }) }
await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1400, height: 1600, deviceScaleFactor: 1, mobile: false })
await cdp.send('Page.enable')

fs.writeFileSync(path.join(dist, 'index.html'), htmlPage({ fixture, width, fixtureData, hostCfg, themeSpec }))
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
  return { text: btn.textContent.trim(), w: r.width, h: r.height, ariaHasPopup: btn.getAttribute('aria-haspopup'), ariaExpanded: btn.getAttribute('aria-expanded'), uiBgEditor: getComputedStyle(document.documentElement).getPropertyValue('--ui-bg-editor').trim() }
})()`)
console.log('CHIP BUTTON:', JSON.stringify(chipInfo))
if (!chipInfo || chipInfo.ariaHasPopup !== 'dialog' || chipInfo.ariaExpanded !== 'false') {
  console.error('FAIL: chip button is not wired as the popover trigger (aria-haspopup/aria-expanded missing) — trigger props are being swallowed between PopoverTrigger and the button.')
  process.exitCode = 1
}
// The page must load the REAL compiled SDK stylesheet: without it every
// var()-based token falls back and the capture renders unstyled (this is not
// hypothetical — a server without /static/ handling produced token-less
// popover captures).
if (chipInfo && !chipInfo.uiBgEditor) {
  console.error('FAIL: the SDK stylesheet did not load (--ui-bg-editor unresolved) — the harness server must serve /static/hermes-sdk.css.')
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

// The running-agents footer: present only when the fixture reports live
// children, subordinate in weight (smaller type than the 13px provider title),
// and inside the popover's width. If the popover scrolls, bring the footer into
// view so the capture shows it instead of the clipped top.
const expectsAgents = Boolean(fixtureData.subagents && Object.keys(fixtureData.subagents).length)
const footerGeo = await cdp.eval(`(() => {
  const pop = document.querySelector('[data-slot="popover-content"]')
  const section = pop && pop.querySelector('[data-running-agents]')
  if (!section) return { present: false }
  const rows = Array.from(section.querySelectorAll('[data-running-agent]'))
  const r = section.getBoundingClientRect()
  const popRect = pop.getBoundingClientRect()
  const rowStyle = rows[0] ? getComputedStyle(rows[0]) : null
  return {
    present: true,
    count: section.getAttribute('data-running-agents'),
    text: section.innerText.slice(0, 500),
    w: r.width,
    h: r.height,
    popW: popRect.width,
    popH: popRect.height,
    scrollHeight: pop.scrollHeight,
    clientHeight: pop.clientHeight,
    rowFontSize: rowStyle ? rowStyle.fontSize : null,
    rows: rows.map(row => ({ text: row.innerText, fontSize: getComputedStyle(row).fontSize, w: row.getBoundingClientRect().width })).slice(0, 6)
  }
})()`)
console.log('FOOTER GEO:', JSON.stringify(footerGeo))

let footerOk = true
if (expectsAgents) {
  footerOk = Boolean(footerGeo && footerGeo.present && footerGeo.count && footerGeo.rows.length > 0 &&
    footerGeo.w <= footerGeo.popW && footerGeo.rowFontSize && parseFloat(footerGeo.rowFontSize) < 12 &&
    /Running agents/.test(footerGeo.text))
  if (!footerOk) console.error('FAIL: running-agents footer missing, overflowing, or not subordinate in weight.', JSON.stringify(footerGeo))
} else if (footerGeo && footerGeo.present) {
  footerOk = false
  console.error('FAIL: running-agents footer rendered with no live children.')
}

const pass = Boolean(popoverText && popGeo && popGeo.visible && popGeo.viewAll) && footerOk
console.log(pass
  ? 'POPOVER VERIFY: PASS — chip click opens the popover with "View all providers" and the running-agents footer.'
  : 'POPOVER VERIFY: FAIL — the chip click did not open a usable popover (or its footer is wrong).')
if (!pass) process.exitCode = 1

// Hide the page behind the popover so the capture shows the popover alone
await cdp.eval(`(() => {
  const p = document.getElementById('pane-root'); if (p) p.style.visibility = 'hidden'
  const section = document.querySelector('[data-running-agents]')
  if (section) section.scrollIntoView({ block: 'nearest' })
  return true
})()`)
await sleep(300)
try {
  const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  // Keep the long-standing `popover-open_w<width>.png` name (export-previews.py
  // maps it into README assets) and add a fixture-qualified copy.
  fs.writeFileSync(path.join(shots, `popover-open_w${width}.png`), Buffer.from(shot.data, 'base64'))
  fs.writeFileSync(path.join(shots, `popover-${fixture}_w${width}.png`), Buffer.from(shot.data, 'base64'))
  console.log('SCREENSHOT:', path.join(shots, `popover-${fixture}_w${width}.png`))
} catch (e) { console.error('screenshot failed', e.message) }

cdp.close()
server.close()
try {
  if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(chrome.pid), '/T', '/F'], { stdio: 'ignore' })
  else process.kill(-chrome.pid)
} catch { /* best-effort cleanup */ }
try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
console.log('DONE')
// Exit non-zero when anything failed above (the wiring check or the popover check).
process.exit(pass && process.exitCode !== 1 ? 0 : 1)
