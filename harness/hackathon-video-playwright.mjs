#!/usr/bin/env node
/**
 * Record the Provider Usage chip -> popover interaction with Playwright video.
 *
 * This is the smooth-video path. It drives the shipped plugin in the same
 * browser component harness as the stills, with synthetic sample data and a
 * permanent "Component harness · sample data · not the packaged desktop"
 * overlay.
 *
 * Setup (optional, not a plugin runtime dependency):
 *   npm install --prefix "$TMPDIR/hpu-pw" playwright-core@1.65.0
 *   PLAYWRIGHT_CORE="$TMPDIR/hpu-pw/node_modules/playwright-core" \
 *     node harness/hackathon-video-playwright.mjs
 *
 * Output:
 *   assets/hackathon/demo.mp4
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import http from 'node:http'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const dist = path.join(__dirname, 'dist')
const out = path.join(dist, 'hackathon')
const rawVideoDir = path.join(out, 'video-playwright')
const finalMp4 = path.join(repoRoot, 'assets', 'hackathon', 'demo.mp4')
const PORT = 8955
const W = 1280
const H = 720
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const CHROME_CANDIDATES = [
  process.env.HARNESS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || CHROME_CANDIDATES[0]
const FFMPEG = process.env.FFMPEG || 'ffmpeg'
const PW = process.env.PLAYWRIGHT_CORE || 'playwright-core'
if (!CHROME || !fs.existsSync(CHROME)) throw new Error('Chrome/Edge not found; set HARNESS_CHROME')
if (!fs.existsSync(path.join(dist, 'app.js'))) throw new Error('Run node harness/build.mjs first')

let chromium
try {
  const module = await import(PW.startsWith('/') || /^[A-Za-z]:/.test(PW) ? pathToFileURL(path.join(PW, 'index.mjs')).href : PW)
  chromium = module.chromium
} catch (error) {
  throw new Error(`Playwright core not available (${error.message}). Set PLAYWRIGHT_CORE to its install directory.`)
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'))
const overview = readJson(path.join(__dirname, 'fixtures', 'preview-showcase.json'))
overview.fetched_at = '2026-11-11T16:20:00Z'
overview.account_profile = 'default'
const host = {
  model: overview?.active?.model || 'sample-model',
  sessionId: 'sess-hackathon-sample',
  profile: 'default',
  connectionId: 'local',
  gateway: 'open',
  focusedSessionProfile: 'default',
  focusedSessionOwner: { connectionId: 'local', profile: 'default' }
}
overview.host = host
const fixture = { overview, host }
const THEME = { name: 'nous', mode: 'dark' }

fs.rmSync(rawVideoDir, { recursive: true, force: true })
fs.mkdirSync(rawVideoDir, { recursive: true })

const html = `<!doctype html>
<html lang="en" data-harness="1">
<head>
<meta charset="utf-8" />
<title>Provider Usage — component harness demo</title>
<link rel="stylesheet" href="/static/hermes-sdk.css" />
<style>
  html, body { margin:0; padding:0; background:var(--ui-bg-editor,#0d1117); }
  * { box-sizing:border-box; scrollbar-width:none; }
  *::-webkit-scrollbar { display:none; width:0; height:0; }
  #panel { position:relative; width:${W}px; height:${H}px; overflow:hidden; background:var(--ui-bg-editor,#0d1117); }
  #pane-root { display:none; }
  #chip-root { display:block; position:absolute; left:560px; top:640px; width:320px; z-index:5; }
  #demo-overlay { position:absolute; left:34px; top:30px; z-index:20; display:grid; gap:7px; pointer-events:none; max-width:860px; }
  #demo-title { font:600 13px/1.2 var(--default-font-family,"Segoe UI",system-ui,sans-serif); letter-spacing:.13em; text-transform:uppercase; color:var(--ui-text-secondary,#7d8590); }
  #demo-sub { font:500 15px/1.35 var(--default-font-family,"Segoe UI",system-ui,sans-serif); color:var(--ui-text-primary,#e6edf3); }
  #demo-phase { position:absolute; left:34px; bottom:30px; z-index:20; font:500 14px/1.35 var(--default-font-family,"Segoe UI",system-ui,sans-serif); color:var(--ui-text-secondary,#7d8590); pointer-events:none; }
  #demo-legal { position:absolute; right:34px; bottom:30px; z-index:20; font:500 10px/1.4 var(--default-font-family,"Segoe UI",system-ui,sans-serif); color:var(--ui-text-quaternary,#6e7681); text-align:right; pointer-events:none; max-width:430px; }
</style>
<script>
  window.__FIXTURE__ = ${JSON.stringify(fixture)};
  window.__HARNESS_THEME__ = ${JSON.stringify(THEME)};
  window.__CAPTURE__ = { fixture:'demo', paneWidth:${W}, paneHeight:${H}, chipWidth:320, body:true };
  window.__DEMO_PHASE__ = function (text) { const el = document.getElementById('demo-phase'); if (el) el.textContent = text; };
</script>
</head>
<body>
<div id="panel">
  <div id="demo-overlay"><div id="demo-title">Provider Usage · Hermes Desktop</div><div id="demo-sub">A status-bar readout for the provider that funds the next request.</div></div>
  <div id="demo-phase">Status-bar chip · sample data</div>
  <div id="demo-legal">Component harness · sample data · not the packaged desktop</div>
  <div id="chip-root"></div>
  <div id="pane-root"></div>
</div>
<script type="module" src="/app.js"></script>
</body>
</html>`

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' }
const sdkCss = path.join(__dirname, 'static', 'hermes-sdk.css')
if (!fs.existsSync(sdkCss)) throw new Error('Real SDK CSS missing')
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
fs.writeFileSync(path.join(dist, 'hackathon-video.html'), html)

let browser
try {
  browser = await chromium.launch({ executablePath: CHROME, headless: true, args: ['--hide-scrollbars'] })
  const context = await browser.newContext({
    viewport: { width: W, height: H },
    deviceScaleFactor: 1,
    recordVideo: { dir: rawVideoDir, size: { width: W, height: H } }
  })
  const page = await context.newPage()
  await page.goto(`http://127.0.0.1:${PORT}/hackathon-video.html?v=${Date.now()}`, { waitUntil: 'load' })
  await page.waitForFunction('window.__HARNESS_READY__ === true')
  await page.locator('#chip-root button').waitFor({ state: 'visible' })
  await page.waitForTimeout(900)

  await page.locator('#chip-root button').hover()
  await page.waitForTimeout(500)
  await page.locator('#chip-root button').click()
  await page.locator('[data-slot="popover-content"]').waitFor({ state: 'visible' })
  await page.evaluate(`window.__DEMO_PHASE__('Current provider · sample data')`)
  await page.waitForTimeout(3000)
  await page.mouse.move(20, 20)
  await page.waitForTimeout(700)

  await context.close()
  await browser.close()
  browser = null

  const video = fs.readdirSync(rawVideoDir).filter(name => name.endsWith('.webm')).sort().map(name => path.join(rawVideoDir, name)).pop()
  if (!video) throw new Error('Playwright did not write a WebM video')
  const probe = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size', '-of', 'json', video], { encoding: 'utf8' })
  const meta = probe.status === 0 ? JSON.parse(probe.stdout).format : {}
  const ff = spawnSync(FFMPEG, [
    '-y', '-hide_banner', '-loglevel', 'error',
    '-i', video,
    '-vf', `scale=${W}:${H}:flags=lanczos,format=yuv420p`,
    '-c:v', 'libx264', '-preset', 'medium', '-crf', '20',
    '-movflags', '+faststart', '-map_metadata', '-1', '-an', finalMp4
  ], { encoding: 'utf8' })
  if (ff.status !== 0) throw new Error(`ffmpeg failed: ${ff.stderr || ff.stdout}`)
  fs.writeFileSync(path.join(out, 'video-playwright.json'), JSON.stringify({
    recorded_at: new Date().toISOString(),
    source: 'Playwright recordVideo',
    source_webm: path.basename(video),
    webm_duration_seconds: meta.duration ? Number(meta.duration) : null,
    width: W,
    height: H,
    sample_data: true,
    capture_kind: 'browser component harness interaction (real plugin, synthetic sample data); not the packaged desktop app'
  }, null, 2) + '\n')
  console.log(`Video → ${finalMp4}`)
  console.log(`Duration ${meta.duration || '?'}s, ${fs.statSync(finalMp4).size.toLocaleString()} bytes`)
} finally {
  try { await browser?.close() } catch {}
  server.close()
}
