/**
 * Browser mount for the Provider Usage component harness.
 *
 * Loads the REAL plugin (desktop/plugin.js), calls its register(ctx) with a
 * fixture ctx, captures the registered contributions (statusBar.right chip +
 * panes pane), and mounts them with real React DOM into DOM containers. Data
 * comes from window.__FIXTURE__.overview served to ctx.rest('/overview').
 */
import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { jsx } from 'react/jsx-runtime'

function currentFixture() {
  return window.__FIXTURE__ || { overview: null, host: {} }
}
function bodyText() {
  return window.__CAPTURE__.body
}

// The pane + chip are registered against a fixture ctx. We capture them through
// ctx.register, then render their `render()` functions, exactly as the app's
// pane shell would.
export function mountPlugin(pluginModule) {
  const contributions = []
  const restCalls = []
  // Scriptable rest door for lifecycle scenarios: 'ok' resolves the fixture
  // overview; '404' = plugin backend namespace absent in the ACTIVE profile (no
  // auto-install, mirroring the real ctx.rest 404); 'error' = generic API
  // failure. Driven from the page script or over CDP via window.__HARNESS__.
  const restState = { mode: 'ok', overview: currentFixture().overview, status: { status: 404, message: 'plugin namespace not enabled' } }
  window.__HARNESS__ = window.__HARNESS__ || {}
  window.__HARNESS__.setRest = mode => { restState.mode = mode }
  window.__HARNESS__.setOverview = data => { restState.overview = data }
  const ctx = {
    rest: (path, opts) => {
      restCalls.push({ path, opts })
      if (restState.mode === '404') return Promise.reject(restState.status)
      if (restState.mode === 'error') return Promise.reject(new Error('overview call failed'))
      return Promise.resolve(restState.overview)
    },
    socket: () => () => {},
    storage: { get: () => undefined, set: () => {}, remove: () => {} },
    i18n: { register: () => {}, t: k => k },
    register: entry => contributions.push(entry)
  }

  const plugin = pluginModule.default || pluginModule
  const meta = { id: plugin.id, name: plugin.name, defaultEnabled: plugin.defaultEnabled }
  plugin.register(ctx)

  const page = contributions.find(c => c.area === 'routes')
  const chip = contributions.find(c => c.area === 'statusBar.right')
  if (!page || !chip) {
    throw new Error(`Expected page (routes) and chip (statusBar.right) contributions; got ${contributions.map(c => c.area).join(',')}`)
  }

  window.__CAPTURE__ = Object.assign(window.__CAPTURE__ || {}, { registered: { id: meta.id, name: meta.name }, restCalls })
  mountContribution('chip-root', chip.render, { width: window.__CAPTURE__.chipWidth || 320 })
  // The full page renders in the workspace (Settings-style); give it page
  // bounds. Container id stays 'pane-root' for the existing capture scripts.
  mountContribution('pane-root', page.render, { width: window.__CAPTURE__.paneWidth || 760, height: window.__CAPTURE__.paneHeight || 1100 })

  // Static-markup DOM snapshot (geometry + text) for the capture script. Poll
  // until React has actually committed the plugin's content, then measure.
  window.__HARNESS_READY__ = true
  pollUntilCommitted(() => computeAllGeometry())
}

function mountContribution(containerId, renderFn, { width, height }) {
  const hostEl = document.getElementById(containerId)
  if (!hostEl) return
  // The pane draws its own full-bleed surface; give it the requested bounds.
  hostEl.style.width = `${width}px`
  if (height) hostEl.style.height = `${height}px`

  // Root wrapper carries the app's native surface background/text vars so the
  // plugin's theme-var styles resolve exactly as in the desktop.
  const surface = document.createElement('div')
  surface.setAttribute('data-harness-surface', '1')
  surface.style.height = '100%'
  surface.style.width = '100%'
  surface.style.background = 'var(--ui-bg-editor)'
  surface.style.color = 'var(--ui-text-primary)'
  surface.style.fontFamily = 'var(--default-font-family, system-ui, sans-serif)'
  surface.style.fontSize = '13px'
  hostEl.appendChild(surface)

  const root = createRoot(surface)
  root.render(renderFn())

  // Expose geometry as evidence once mounted.
  const rect = surface.getBoundingClientRect()
  window.__CAPTURE__ = Object.assign(window.__CAPTURE__ || {}, {
    [`${containerId}-rect`]: { width: rect.width, height: rect.height, top: rect.top, left: rect.left }
  })
}

// After render, walk the plugin's meaningful DOM and record geometry for the
// capture script as evidence of the REAL component (not a hand-made mock).
function pollUntilCommitted(fn) {
  let tries = 0
  const attempt = () => {
    const el = document.getElementById('pane-root')
    const probe = el && (el.querySelector('h1, #provider-usage-active-heading, [role="progressbar"]'))
    if (probe || tries > 40) {
      window.__GEOMETRY__ = fn()
      return
    }
    tries++
    setTimeout(attempt, 120)
  }
  attempt()
}

// Pane geometry (as before) PLUS the chip's OWN button geometry. The harness
// wrapper (#chip-root) is 320px wide; the plugin's real chip button is capped at
// 230px (production cap) and must measure positive width AND height, so a
// zero-height toolbar regression could never pass by measuring only the wrapper.
function computeAllGeometry() {
  const records = computeGeometry('pane-root')
  const chipRoot = document.getElementById('chip-root')
  const chipButton = chipRoot && chipRoot.querySelector('button')
  records.chip = {
    rootRect: chipRoot ? chipRoot.getBoundingClientRect().toJSON() : null,
    button: chipButton ? box(chipButton) : null
  }
  return records
}

function computeGeometry(containerId) {
  const target = document.getElementById(containerId)
  if (!target) return null
  const records = {}
  const pick = selector => target.querySelector(selector)
  // Section headings / meters / balances / progressbars the plugin emits.
  const probeSelectors = {
    activeProviderHeading: '#provider-usage-active-heading',
    accountsHeading: '#provider-usage-accounts-heading',
    progressbars: '[role="progressbar"]',
    sectionLabels: 'h3',
    statusDots: '[data-tone]',
    badges: '[data-slot="badge"]',
    rowButtons: '[data-slot="row-button"]',
    panes: '[data-slot="pane-root"], [data-harness-surface]'
  }
  for (const [key, sel] of Object.entries(probeSelectors)) {
    if (sel.includes('progressbars') || sel.includes('sectionLabels') || sel.includes('statusDots') || sel.includes('badges') || sel.includes('rowButtons')) {
      const all = target.querySelectorAll(sel)
      records[key] = Array.from(all).map(el => box(el)).slice(0, 20)
    } else {
      const el = pick(sel)
      if (el) records[key] = box(el)
    }
  }
  // Theme vars actually in effect on the surface (proves real theme, and that
  // the accent/destructive tones resolved to the SDK's values).
  const cs = getComputedStyle(surfaceOf(target))
  records.resolvedVars = {
    accent: cs.getPropertyValue('--ui-accent').trim() || null,
    destructive: cs.getPropertyValue('--dt-destructive').trim() || null,
    textPrimary: cs.getPropertyValue('--ui-text-primary').trim() || null,
    surfaceBg: cs.getPropertyValue('--ui-bg-editor').trim() || null
  }
  records.paneBoundingRect = target.getBoundingClientRect().toJSON()
  return records
}

function surfaceOf(target) {
  return target.querySelector('[data-harness-surface]') || document.documentElement
}
function box(el) {
  const r = el.getBoundingClientRect()
  const cs = getComputedStyle(el)
  return {
    tag: el.tagName.toLowerCase(),
    text: (el.textContent || '').trim().slice(0, 60),
    rect: { x: r.x, y: r.y, w: r.width, h: r.height },
    color: cs.color,
    bg: cs.backgroundColor,
    fontSize: cs.fontSize
  }
}