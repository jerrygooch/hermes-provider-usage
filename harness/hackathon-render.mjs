#!/usr/bin/env node
/**
 * Render the diagram-only hackathon infographic and the 830px screenshot
 * gallery from the captured evidence. No application pixels are generated:
 * the gallery embeds the real harness PNGs; the infographic is drawn shapes
 * and text only.
 *
 * Usage:
 *   node harness/hackathon-render.mjs
 *
 * Requires: harness/hackathon-capture.mjs + harness/hackathon-finalize.py have
 * run, native Chrome, and the Hermes agent checkout for its CDP client.
 */
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { execFileSync, spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')
const out = path.join(repoRoot, 'assets', 'hackathon')
const dist = path.join(__dirname, 'dist', 'hackathon')
fs.mkdirSync(out, { recursive: true })
fs.mkdirSync(dist, { recursive: true })

const CHROME_CANDIDATES = [
  process.env.HARNESS_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe'
].filter(Boolean)
const CHROME = CHROME_CANDIDATES.find(candidate => fs.existsSync(candidate)) || CHROME_CANDIDATES[0]
const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || path.join(os.homedir(), 'AppData', 'Local', 'hermes', 'hermes-agent')
const { CDP } = await import(
  pathToFileURL(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'scripts', 'perf', 'lib', 'cdp.mjs')).href
)
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'))
const shots = manifest.screenshots
const byId = new Map(shots.map(shot => [shot.id, shot]))

// ---------------------------------------------------------------------------
// Infographic — source-derived Hermes dark identity:
// nous dark: bg #0d1117, surface #161b22, border #30363d, text #e6edf3,
// muted #7d8590, accent #4a84fe. Type stack mirrors DEFAULT_TYPOGRAPHY.
// ---------------------------------------------------------------------------
const infographic = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Provider Usage — hackathon infographic</title>
<style>
  :root {
    --bg: #0d1117;
    --surface: #161b22;
    --surface-2: #010409;
    --border: #30363d;
    --border-soft: #21262d;
    --text: #e6edf3;
    --muted: #7d8590;
    --faint: #6e7681;
    --accent: #4a84fe;
    --accent-soft: #17243a;
    --warn: #d29922;
    --green: #3fb950;
    --sans: "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    --mono: "Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font-family: var(--sans); -webkit-font-smoothing: antialiased; }
  #canvas { width: 1660px; padding: 58px 64px 46px; background: var(--bg); position: relative; overflow: hidden; }
  #canvas::before {
    content: ""; position: absolute; inset: 0; pointer-events: none;
    background:
      linear-gradient(90deg, rgba(48,54,61,.22) 1px, transparent 1px) 0 0 / 83px 100%,
      linear-gradient(0deg, rgba(48,54,61,.16) 1px, transparent 1px) 0 0 / 100% 83px;
    mask-image: linear-gradient(180deg, rgba(0,0,0,.85), transparent 62%);
  }
  header, section, footer { position: relative; z-index: 1; }
  .eyebrow { font: 650 15px/1.2 var(--sans); letter-spacing: .16em; text-transform: uppercase; color: var(--accent); }
  .headrow { display: flex; align-items: flex-start; justify-content: space-between; gap: 36px; margin-top: 20px; }
  h1 { margin: 0; max-width: 1130px; font: 650 74px/1.02 var(--sans); letter-spacing: -.035em; }
  h1 .soft { color: var(--muted); }
  .candidate {
    flex: 0 0 auto; margin-top: 7px; padding: 13px 16px; border: 1px solid #4a3a11; border-radius: 8px;
    background: #1d1708; color: #e3b341; font: 650 12px/1.45 var(--sans); letter-spacing: .10em; text-transform: uppercase;
  }
  .candidate span { display: block; color: var(--muted); font-size: 10.5px; letter-spacing: .08em; margin-top: 3px; }
  .lede { margin: 24px 0 0; max-width: 1090px; color: #b9c1ca; font: 400 26px/1.45 var(--sans); }
  .lede strong { color: var(--text); font-weight: 600; }
  .rule { height: 1px; background: var(--border); margin: 38px 0 0; }
  .flow { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0; margin-top: 30px; border-top: 1px solid var(--border); border-bottom: 1px solid var(--border); }
  .step { position: relative; padding: 20px 26px 22px 0; min-height: 136px; }
  .step + .step { border-left: 1px solid var(--border); padding-left: 26px; }
  .step .num { display: block; color: var(--accent); font: 650 12px/1 var(--mono); letter-spacing: .08em; }
  .step .stitle { margin-top: 12px; font: 650 21px/1.2 var(--sans); letter-spacing: -.01em; }
  .step .sbody { margin-top: 8px; color: #9fa9b4; font: 400 18.5px/1.45 var(--sans); max-width: 315px; }
  .step::after { content: "→"; position: absolute; right: 14px; top: 21px; color: var(--faint); font: 400 17px/1 var(--sans); }
  .step:last-child::after { display: none; }
  .main { display: grid; grid-template-columns: 1.16fr .84fr; gap: 70px; margin-top: 44px; }
  .kicker { color: var(--accent); font: 650 12.5px/1.2 var(--sans); letter-spacing: .14em; text-transform: uppercase; }
  h2 { margin: 12px 0 0; font: 650 33px/1.15 var(--sans); letter-spacing: -.02em; }
  .main p { margin: 14px 0 0; color: #9fa9b4; font: 400 19.5px/1.5 var(--sans); }
  .rowdiagram { margin-top: 24px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); overflow: hidden; }
  .rowhead { display: flex; align-items: baseline; justify-content: space-between; gap: 20px; padding: 13px 18px; border-bottom: 1px solid var(--border); background: var(--surface-2); }
  .rowhead b { font: 650 15px/1.2 var(--mono); color: var(--text); }
  .rowhead span { font: 500 12px/1.2 var(--mono); color: var(--faint); }
  .rowgrid { display: grid; grid-template-columns: repeat(3, 1fr); }
  .cell { padding: 16px 18px 17px; min-height: 106px; border-right: 1px solid var(--border-soft); }
  .cell:last-child { border-right: 0; }
  .cell label { display: block; color: var(--faint); font: 600 11px/1.2 var(--sans); letter-spacing: .12em; text-transform: uppercase; }
  .cell strong { display: block; margin-top: 10px; font: 650 22px/1.15 var(--mono); font-variant-numeric: tabular-nums; }
  .cell span { display: block; margin-top: 5px; color: #9fa9b4; font: 400 13.5px/1.4 var(--sans); }
  .rowfoot { padding: 11px 18px; border-top: 1px solid var(--border); color: #9fa9b4; font: 500 13.5px/1.45 var(--mono); }
  .rules { display: grid; grid-template-columns: repeat(3, 1fr); gap: 0; margin-top: 24px; border-top: 1px solid var(--border); }
  .ruleitem { padding: 16px 18px 0 0; }
  .ruleitem + .ruleitem { border-left: 1px solid var(--border); padding-left: 18px; }
  .ruleitem b { display: block; font: 650 16.5px/1.3 var(--sans); }
  .ruleitem span { display: block; margin-top: 6px; color: #9fa9b4; font: 400 15.5px/1.45 var(--sans); }
  .stack { margin-top: 22px; display: grid; gap: 0; }
  .box { border: 1px solid var(--border); background: var(--surface); padding: 16px 17px; }
  .box:first-child { border-radius: 9px 9px 0 0; }
  .box:last-of-type { border-radius: 0 0 9px 9px; }
  .box b { display: block; font: 650 18px/1.25 var(--sans); }
  .box span { display: block; margin-top: 4px; color: #9fa9b4; font: 400 14.5px/1.4 var(--sans); }
  .box.renderer { border-left: 3px solid var(--accent); }
  .box.gateway { border-left: 3px solid var(--green); }
  .box.api { border-left: 3px solid var(--faint); }
  .linkline { display: grid; grid-template-columns: 1fr auto 1fr; align-items: center; gap: 10px; color: var(--faint); font: 500 11.5px/1 var(--mono); padding: 8px 0; }
  .linkline::before, .linkline::after { content: ""; height: 1px; background: var(--border); }
  .gatebox { margin-top: 18px; border: 1px solid #4a3a11; background: #1d1708; border-radius: 8px; padding: 13px 15px; color: #e3b341; font: 650 14.5px/1.45 var(--sans); }
  .gatebox span { display: block; margin-top: 3px; color: #c2ad74; font: 500 13px/1.4 var(--sans); }
  .features { display: grid; grid-template-columns: repeat(3, 1fr); gap: 12px; margin-top: 42px; }
  .feature { border: 1px solid var(--border); background: var(--surface); border-radius: 8px; padding: 16px 17px 17px; min-height: 150px; }
  .feature b { display: block; font: 650 19px/1.3 var(--sans); }
  .feature span { display: block; margin-top: 7px; color: #9fa9b4; font: 400 16px/1.5 var(--sans); }
  .feature .tag { display: inline-block; margin-bottom: 11px; color: var(--accent); font: 650 11.5px/1 var(--mono); letter-spacing: .10em; text-transform: uppercase; }
  footer { display: flex; align-items: flex-end; justify-content: space-between; gap: 40px; margin-top: 38px; padding-top: 17px; border-top: 1px solid var(--border); }
  footer .left { color: #8f98a3; font: 500 13px/1.55 var(--mono); max-width: 980px; }
  footer .left strong { color: var(--text); font-weight: 600; }
  footer .right { text-align: right; color: var(--faint); font: 500 12.5px/1.55 var(--mono); }
</style>
</head>
<body>
<div id="canvas">
  <header>
    <div class="eyebrow">Hermes Desktop · Provider Usage 0.10</div>
    <div class="headrow">
      <h1>Know the limit<br><span class="soft">before the next request.</span></h1>
      <div class="candidate">Hackathon candidate<span>Stock Hermes Desktop</span></div>
    </div>
    <p class="lede">A status-bar readout, a focused popover, and a full provider page — built around <strong>profile-scoped usage and explicit account controls.</strong></p>
  </header>

  <section class="flow" aria-label="Workflow">
    <div class="step">
      <span class="num">01</span>
      <div class="stitle">Focused session</div>
      <div class="sbody">Provider, model, and connection-qualified account scope.</div>
    </div>
    <div class="step">
      <span class="num">02</span>
      <div class="stitle">Status-bar chip</div>
      <div class="sbody">The governing window stays visible beside the model you are using.</div>
    </div>
    <div class="step">
      <span class="num">03</span>
      <div class="stitle">Detail popover</div>
      <div class="sbody">Every window, reset, fallback balance, and running-agent footer.</div>
    </div>
    <div class="step">
      <span class="num">04</span>
      <div class="stitle">Provider page</div>
      <div class="sbody">All providers, metrics, catalog cards, and local trust states.</div>
    </div>
  </section>

  <section class="main">
    <div class="truth">
      <div class="kicker">The data model</div>
      <h2>One row, every reported fact.</h2>
      <p>The renderer receives normalized limits, balances, states, and provenance — never a credential value, raw provider body, or a guessed zero.</p>
      <div class="rowdiagram" aria-label="Provider row data diagram">
        <div class="rowhead"><b>provider row</b><span>id · label · plan · state</span></div>
        <div class="rowgrid">
          <div class="cell"><label>limits[]</label><strong>5h 62%</strong><span>wk 84% · resets shown</span></div>
          <div class="cell"><label>balances[]</label><strong>$8.72</strong><span>provider currency</span></div>
          <div class="cell"><label>provenance</label><strong>api.github.com</strong><span>cached · scoped · checked</span></div>
        </div>
        <div class="rowfoot">unknown stays unknown &nbsp;·&nbsp; shared pool, never per-chat</div>
      </div>
      <div class="rules">
        <div class="ruleitem"><b>Subscription + credit</b><span>Windows first; paid fallback or API balance stays secondary.</span></div>
        <div class="ruleitem"><b>Profile-scoped</b><span>A divergent focus fails closed instead of borrowing another account.</span></div>
        <div class="ruleitem"><b>Account-attributed</b><span>A child’s pool is shown only when its account id matches exactly.</span></div>
      </div>
    </div>

    <div class="trust">
      <div class="kicker">The boundary</div>
      <h2>Secrets stay behind the gateway.</h2>
      <div class="stack">
        <div class="box renderer"><b>Desktop renderer</b><span>limits · balances · states · provenance</span></div>
        <div class="linkline">local IPC</div>
        <div class="box gateway"><b>Hermes gateway</b><span>scoped credential access · usage cache</span></div>
        <div class="linkline">HTTPS GET</div>
        <div class="box api"><b>Provider API</b><span>exact host allow-list · bounded response</span></div>
      </div>
      <div class="gatebox">A profile-local definition is not trusted until a human approves it.<span>The approval record fingerprints the exact content, destination, and credential references.</span></div>
    </div>
  </section>

  <section class="features" aria-label="Capabilities">
    <div class="feature"><span class="tag">Account controls</span><b>Resets and dashboard links</b><span>Check Codex reset credits, review before confirming, or open the provider’s account dashboard.</span></div>
    <div class="feature"><span class="tag">Providers</span><b>Claude, Gemini, Z.ai</b><span>Always-listed cards separate subscription quota from API billing; no invented balance.</span></div>
    <div class="feature"><span class="tag">Catalog</span><b>Read-only definitions</b><span>JSON data, no scripts or literal keys. Available, approval, blocked, and invalid states stay explicit.</span></div>
    <div class="feature"><span class="tag">Delegation</span><b>Running agents</b><span>Verified account → shared pool. Mismatched or missing → an em dash, never a borrowed figure.</span></div>
    <div class="feature"><span class="tag">Trust</span><b>Local consent gate</b><span>Editing a profile definition revokes approval until the new content is reviewed.</span></div>
    <div class="feature"><span class="tag">Network</span><b>Bounded custom reads</b><span>Definitions use HTTPS GET, approved hosts, no redirects, and bounded response size and time.</span></div>
  </section>

  <footer>
    <div class="left"><strong>Evidence:</strong> screenshots in assets/hackathon/screenshots render the shipped plugin with sample data in a browser component harness — not the packaged desktop app. Optional provider metadata is capability-detected; unavailable data links to the provider dashboard.</div>
    <div class="right">Provider Usage · 0.10<br>Hermes Desktop plugin</div>
  </footer>
</div>
</body>
</html>`

fs.writeFileSync(path.join(dist, 'infographic.html'), infographic, 'utf8')

// ---------------------------------------------------------------------------
// Screenshot gallery at the 830px PR/body width
// ---------------------------------------------------------------------------
const sections = [
  { title: 'The three surfaces', ids: ['01-status-chip', '02-popover-current', '03-popover-running-agents'] },
  { title: 'The provider page', ids: ['04-overview-multi-provider', '05-overview-expanded-metrics'] },
  { title: 'Banked reset credits', ids: ['11-reset-summary', '12-reset-confirm'] },
  { title: 'Popular provider cards', ids: ['06-popular-connections'] },
  { title: 'Definitions and trust states', ids: ['07-catalog-available', '08-catalog-trust', '09-catalog-invalid'] },
  { title: 'Responsive layout', ids: ['10-narrow-420'] }
]

const esc = value => String(value)
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')

const figure = shot => `
  <figure id="${esc(shot.id)}">
    <div class="frame${shot.width < 420 ? ' frame-small' : ''}">
      <img src="${esc(shot.file)}" alt="${esc(shot.title)}" width="${shot.width}" height="${shot.height}" loading="eager" />
    </div>
    <figcaption>
      <div class="cap-head"><span class="cap-num">${esc(shot.id.slice(0, 2))}</span><strong>${esc(shot.title.replace(/^Provider Usage — /, '').replace(/ \(sample data\)$/, ''))}</strong></div>
      <p>${esc(shot.caption)}</p>
      <div class="cap-meta"><span>SAMPLE DATA</span><span>${shot.width}×${shot.height}</span><span>component harness</span></div>
    </figcaption>
  </figure>`

const hasVideo = fs.existsSync(path.join(out, 'demo.mp4'))

const gallery = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Provider Usage — screenshot gallery (sample data)</title>
<style>
  :root {
    --bg: #0d1117; --surface: #161b22; --border: #30363d; --text: #e6edf3;
    --muted: #7d8590; --faint: #6e7681; --accent: #4a84fe; --warn: #d29922;
    --sans: "Segoe UI", -apple-system, BlinkMacSystemFont, "SF Pro Text", system-ui, sans-serif;
    --mono: "Cascadia Code", "JetBrains Mono", "SF Mono", Consolas, monospace;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; background: var(--bg); color: var(--text); }
  body { font-family: var(--sans); }
  main { width: 830px; max-width: 100%; margin: 0 auto; padding: 38px 24px 54px; }
  .eyebrow { color: var(--accent); font: 650 11px/1.2 var(--sans); letter-spacing: .15em; text-transform: uppercase; }
  h1 { margin: 12px 0 0; font: 650 34px/1.12 var(--sans); letter-spacing: -.025em; }
  .lede { margin: 12px 0 0; color: #b9c1ca; font: 400 15px/1.55 var(--sans); }
  .banner { display: flex; align-items: flex-start; gap: 10px; margin-top: 20px; padding: 12px 14px; border: 1px solid #4a3a11; border-radius: 8px; background: #1d1708; color: #e3b341; font: 600 12px/1.5 var(--sans); }
  .banner b { color: #f0c75e; }
  .toc { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 18px; }
  .toc a { color: var(--muted); text-decoration: none; border: 1px solid var(--border); border-radius: 999px; padding: 5px 9px; font: 500 10.5px/1 var(--mono); }
  .toc a:hover { color: var(--text); border-color: #4a84fe; }
  h2 { margin: 38px 0 14px; padding-top: 16px; border-top: 1px solid var(--border); font: 650 14px/1.3 var(--sans); letter-spacing: .10em; text-transform: uppercase; color: var(--muted); }
  figure { margin: 0 0 34px; }
  .frame { border: 1px solid var(--border); border-radius: 10px; background: #010409; overflow: hidden; }
  .frame img { display: block; width: 100%; height: auto; }
  .frame-small { width: 360px; max-width: 100%; margin: 0 auto; padding: 18px; }
  .frame-small img { width: 274px; }
  .video-frame { border: 1px solid var(--border); border-radius: 10px; background: #010409; overflow: hidden; }
  .video-frame a { display: block; position: relative; }
  .video-frame img { display: block; width: 100%; height: auto; }
  .play { position: absolute; left: 50%; top: 50%; transform: translate(-50%, -50%); width: 56px; height: 56px; border-radius: 50%; display: grid; place-items: center; padding-left: 3px; color: var(--text); background: rgba(13,17,23,.82); border: 1px solid var(--accent); font: 600 18px/1 var(--sans); }
  .video-meta { margin-top: 7px; color: var(--faint); font: 500 10px/1.5 var(--mono); }
  .video-meta a { color: var(--muted); }
  figcaption { padding-top: 10px; }
  .cap-head { display: flex; align-items: baseline; gap: 9px; }
  .cap-num { color: var(--accent); font: 650 11px/1 var(--mono); }
  .cap-head strong { font: 650 15px/1.35 var(--sans); }
  figcaption p { margin: 5px 0 0; color: var(--muted); font: 400 12.5px/1.55 var(--sans); }
  .cap-meta { display: flex; flex-wrap: wrap; gap: 7px; margin-top: 7px; color: var(--faint); font: 500 9.5px/1 var(--mono); letter-spacing: .05em; text-transform: uppercase; }
  .cap-meta span + span::before { content: "·"; margin-right: 7px; color: var(--border); }
  .notes { margin-top: 36px; border: 1px solid var(--border); border-radius: 10px; background: var(--surface); padding: 16px 18px; }
  .notes h3 { margin: 0 0 8px; font: 650 13px/1.3 var(--sans); }
  .notes p, .notes li { color: var(--muted); font: 400 12.5px/1.55 var(--sans); }
  .notes ul { margin: 0; padding-left: 17px; }
  .notes li + li { margin-top: 5px; }
  footer { margin-top: 26px; color: var(--faint); font: 500 10px/1.55 var(--mono); }
  code { font-family: var(--mono); color: #b9c1ca; }
</style>
</head>
<body>
<main>
  <div class="eyebrow">Hermes Desktop · Provider Usage 0.10</div>
  <h1>Provider Usage — screenshot gallery</h1>
  <p class="lede">Real plugin components, real SDK primitives, real <code>nous</code> dark theme. Every value below is synthetic sample data. These are component-harness captures, not screenshots of the packaged Electron desktop app.</p>
  <div class="banner"><span><b>Read this first:</b> the screenshots are evidence of renderer behavior and the chip → popover interaction. They do not prove a live provider call or a packaged-app install. The plugin targets stock Hermes Desktop; optional provider capabilities are detected at runtime and shown as unavailable with dashboard links when absent. These are pre-freeze captures; final release captures wait on the frozen stock build.</span></div>
  <nav class="toc" aria-label="Sections">
    ${hasVideo ? '<a href="#demo">demo.mp4</a>' : ''}
    ${sections.map(section => `<a href="#${section.ids[0]}">${esc(section.title)}</a>`).join('')}
    <a href="manifest.json">manifest.json</a>
  </nav>

  ${hasVideo ? `
  <h2>Demo clip</h2>
  <figure id="demo">
    <div class="video-frame">
      <a href="demo.mp4" aria-label="Open the 5.9 second sample-data interaction clip">
        <img src="demo-poster.png" alt="Provider Usage popover in the component harness, sample data" width="1280" height="720" loading="eager" />
        <span class="play" aria-hidden="true">▶</span>
      </a>
    </div>
    <div class="video-meta"><a href="demo.mp4">Open demo.mp4</a> · 5.9 s · 1280×720 · silent</div>
    <figcaption>
      <div class="cap-head"><span class="cap-num">▶</span><strong>Real chip click, popover open</strong></div>
      <p>A short screen recording of the component harness: the pointer moves to the chip, clicks, and the popover opens. Every value is sample data; the on-screen label says so. No live account or packaged desktop is shown.</p>
      <div class="cap-meta"><span>SAMPLE DATA</span><span>1280×720</span><span>component harness</span></div>
    </figcaption>
  </figure>` : ''}

  ${sections.map(section => `
  <h2>${esc(section.title)}</h2>
  ${section.ids.map(id => byId.has(id) ? figure(byId.get(id)) : '').join('')}
  `).join('')}

  <div class="notes">
    <h3>What this package establishes — and what it does not</h3>
    <ul>
      <li>The real <code>desktop/plugin.js</code> components render with the real SDK Button, Badge, Popover, StatusDot and theme tokens.</li>
      <li>The chip is wired as the popover trigger; the open state, meters, provider rows, catalog cards, and running-agent footer are asserted by the capture script.</li>
      <li>It does <strong>not</strong> establish the packaged Electron shell, a real gateway socket, or live provider responses. It uses synthetic sample data; final release captures wait on the frozen stock build.</li>
      <li>The definition trust states and provider-card copy are fixture-tested. No real account was read for these images.</li>
    </ul>
  </div>
  <footer>Generated by <code>harness/hackathon-capture.mjs</code> + <code>harness/hackathon-render.mjs</code> + <code>harness/hackathon-video-playwright.mjs</code>. Screenshot crops are 2× CSS pixels; image metadata stripped. Video re-muxed with metadata cleared. See <a href="manifest.json" style="color:var(--muted)">manifest.json</a> for hashes and exact dimensions.</footer>
</main>
</body>
</html>`

fs.writeFileSync(path.join(out, 'gallery.html'), gallery, 'utf8')

// ---------------------------------------------------------------------------
// Chromium: capture infographic at 2x, then verify gallery at 830
// ---------------------------------------------------------------------------
const CDP_PORT = 8962
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'hpu-hackathon-render-'))
const chromeProc = spawn(CHROME, [
  '--headless=new',
  '--disable-gpu',
  '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${userData}`,
  '--allow-file-access-from-files',
  'about:blank'
], { stdio: 'ignore' })

const waitUntil = async (cdp, expr, timeoutMs = 20000) => {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const ok = await cdp.eval(expr).catch(() => false)
    if (ok) return
    if (Date.now() >= deadline) throw new Error(`timeout: ${expr}`)
    await sleep(120)
  }
}

let cdp
try {
  try { cdp = await CDP.connect({ port: CDP_PORT, match: 'about:blank', timeoutMs: 15000 }) }
  catch { cdp = await CDP.connect({ port: CDP_PORT, timeoutMs: 15000 }) }
  await cdp.send('Page.enable')

  // Infographic: 1660 CSS px wide, 2x output.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 1660, height: 1500, deviceScaleFactor: 2, mobile: false
  })
  await cdp.send('Page.navigate', { url: pathToFileURL(path.join(dist, 'infographic.html')).href })
  await waitUntil(cdp, `document.fonts && document.fonts.status === 'loaded'`)
  await sleep(350)
  const info = await cdp.eval(`(() => {
    const canvas = document.getElementById('canvas');
    const r = canvas.getBoundingClientRect();
    return {
      width: r.width,
      height: r.height,
      scrollWidth: document.documentElement.scrollWidth,
      images: Array.from(document.images).map(i => ({ complete: i.complete, naturalWidth: i.naturalWidth }))
    };
  })()`)
  if (Math.abs(info.width - 1660) > 1) throw new Error(`infographic canvas is ${info.width}px wide`)
  if (info.scrollWidth > 1661) throw new Error(`infographic overflows horizontally: ${info.scrollWidth}`)
  const height = Math.ceil(info.height)
  const shot = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 1660, height, scale: 2 }
  })
  const rawInfo = path.join(dist, 'infographic-2x.png')
  fs.writeFileSync(rawInfo, Buffer.from(shot.data, 'base64'))
  console.log(`Infographic raw: 1660x${height} CSS -> ${rawInfo}`)

  // Downsample to 1660 with Pillow, strip metadata.
  const py = [
    'from PIL import Image',
    'import sys',
    'src, dst = sys.argv[1], sys.argv[2]',
    'im = Image.open(src).convert("RGB")',
    'im = im.resize((1660, round(im.height * 1660 / im.width)), Image.Resampling.LANCZOS)',
    'im.save(dst, format="PNG", optimize=True, compress_level=9)',
    'print(im.size)'
  ].join('\n')
  const finalPng = path.join(out, 'infographic.png')
  const size = execFileSync('python', ['-c', py, rawInfo, finalPng], { encoding: 'utf8' }).trim()
  console.log(`Infographic final: ${size} -> ${finalPng}`)

  // Gallery: verify at the 830px body width, every image loaded, no horizontal
  // overflow and no element beyond the right edge.
  await cdp.send('Emulation.setDeviceMetricsOverride', {
    width: 830, height: 1200, deviceScaleFactor: 1, mobile: false
  })
  await cdp.send('Page.navigate', { url: pathToFileURL(path.join(out, 'gallery.html')).href })
  await waitUntil(cdp, `Array.from(document.images).every(i => i.complete)`)
  await sleep(350)
  const g = await cdp.eval(`(() => {
    const images = Array.from(document.images).map(i => ({ src: i.getAttribute('src'), complete: i.complete, naturalWidth: i.naturalWidth, naturalHeight: i.naturalHeight, w: i.getBoundingClientRect().width }));
    const overflow = Array.from(document.querySelectorAll('*')).filter(el => {
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > 831;
    }).map(el => ({ tag: el.tagName, cls: el.className || '', right: el.getBoundingClientRect().right })).slice(0, 8);
    return {
      scrollWidth: document.documentElement.scrollWidth,
      bodyWidth: document.body.getBoundingClientRect().width,
      images,
      overflow,
      height: document.documentElement.scrollHeight
    };
  })()`)
  if (g.scrollWidth > 831) throw new Error(`gallery overflows at 830px: ${g.scrollWidth}`)
  if (g.overflow.length) throw new Error(`gallery elements exceed 830px: ${JSON.stringify(g.overflow)}`)
  const bad = g.images.filter(i => !i.complete || i.naturalWidth <= 0)
  if (bad.length) throw new Error(`gallery images failed to load: ${JSON.stringify(bad)}`)
  if (g.images.length !== shots.length + (hasVideo ? 1 : 0)) throw new Error(`gallery has ${g.images.length} images, expected ${shots.length + (hasVideo ? 1 : 0)}`)
  const qa = await cdp.send('Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: true,
    clip: { x: 0, y: 0, width: 830, height: g.height, scale: 1 }
  })
  fs.writeFileSync(path.join(dist, 'gallery-830.png'), Buffer.from(qa.data, 'base64'))
  console.log(`Gallery verified at 830px: ${g.images.length} images, height ${g.height}px`)
  console.log(`Gallery QA: ${path.join(dist, 'gallery-830.png')}`)
  cdp.close()
} finally {
  try { fs.rmSync(userData, { recursive: true, force: true }) } catch {}
  chromeProc.kill()
}
