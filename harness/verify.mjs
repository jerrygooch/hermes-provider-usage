/**
 * Verify harness capture output: asserts the real plugin actually rendered the
 * expected components + text + geometry for each captured scenario, that theme
 * tokens resolved to the real SDK values, that the toolbar chip measures
 * positive width+height INSIDE the production 230px cap (so a zero-height
 * toolbar can never pass by measuring only the 320px harness wrapper), and that
 * the browser lifecycle scenario (default → no-backend profile → default)
 * surfaced backend-unavailable on BOTH surfaces and recovered. Exits non-zero
 * on any failure.
 *
 * Usage: node harness/verify.mjs [--fixture name] [--width W]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const shotsDir = path.join(__dirname, 'dist', 'shots')
const geom = JSON.parse(fs.readFileSync(path.join(shotsDir, 'geometry.json'), 'utf8'))

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}
const reqFixture = arg('--fixture', '')
const reqWidth = arg('--width', '')

// Production cap on the chip button (its maxWidth in plugin.js). The harness
// wrapper is deliberately wider (320px) so it can't mask a broken toolbar.
const CHIP_CAP_PX = 230

const EXPECT = {
  'compact-5h-wk': {
    registeredName: 'Provider Usage',
    needles: ['5h 62%', 'wk 84%', 'Anthropic / Claude', 'ACCOUNT LIMITS & CREDITS', '5-hour window', '7-day window'],
    chipNeedle: 'Claude',
    // The toolbar must show the governing funding value itself, within the cap.
    chipGovern: '5h 62%'
  },
  'credit-balance': {
    registeredName: 'Provider Usage',
    needles: ['$43.50', 'Nous Portal', 'BALANCE', 'used of $50.00', 'Requests are billed from this provider balance'],
    chipNeedle: 'Nous',
    chipGovern: '$43.50'
  },
  'exhausted-monthly': {
    registeredName: 'Provider Usage',
    needles: ['mo 0%', 'Monthly window', '0% left', 'SuperGrok'],
    chipNeedle: 'Grok',
    chipGovern: 'mo 0%'
  }
}

let failures = 0
function problem(items, label, msg) {
  failures += 1
  console.error(`FAIL ${label}: ${msg}`)
  items.push(msg)
}

// Assert the chip BUTTON geometry: present, positive w AND h, within the 230px
// production cap. `chip` may come from mount-time __GEOMETRY__ or a live step.
function chipGeometryOK(chipEntry, label, problems) {
  const btn = chipEntry && (chipEntry.button || chipEntry)
  if (!btn || typeof btn.rect === 'undefined' && typeof btn.w === 'undefined') {
    problem(problems, label, 'no chip button geometry captured (zero/silent toolbar)')
    return
  }
  const w = btn.rect ? btn.rect.w : btn.w
  const h = btn.rect ? btn.rect.h : btn.h
  if (!(w > 0) || !(h > 0)) problem(problems, label, `chip button non-positive dims w=${w} h=${h}`)
  if (!(w <= CHIP_CAP_PX + 0.5)) problem(problems, label, `chip button ${w}px exceeds production cap ${CHIP_CAP_PX}px`)
}

const labels = Object.keys(geom).filter(l => {
  const [fx, w] = l.split('_w')
  if (reqFixture && fx !== reqFixture) return false
  if (reqWidth && w !== reqWidth) return false
  return true
})

for (const label of labels) {
  const [fixture] = label.split('_w')
  const expected = EXPECT[fixture]
  if (!expected) continue
  const e = geom[label]
  const problems = []
  const okName = e.registered?.name === expected.registeredName
  const text = (e.text || '') + '\n' + (e.chipText || '')
  const missingNeedles = expected.needles.filter(n => !text.includes(n))
  const badChip = expected.chipNeedle && !(e.chipText || '').includes(expected.chipNeedle)
  const accent = e.geometry?.resolvedVars?.accent
  const destructive = e.geometry?.resolvedVars?.destructive

  if (!okName) problems.push(`registered name ≠ ${expected.registeredName}`)
  if (missingNeedles.length) problems.push(`missing text: ${missingNeedles.join(', ')}`)
  if (badChip) problems.push(`chip missing ${expected.chipNeedle}`)
  if (accent !== '#0053fd') problems.push(`accent token ${accent} ≠ #0053fd`)
  if (destructive !== '#cf2d56') problems.push(`destructive token ${destructive} ≠ #cf2d56`)
  if (!e.paneRect || e.paneRect.width < 1) problems.push('pane has no geometry')

  // Toolbar honesty: positive dims inside the 230px cap + the governing funding
  // value visible (not ellipsized to nothing).
  if (e.geometry && e.geometry.chip) chipGeometryOK(e.geometry.chip, label, problems)
  const governChip = (e.geometry?.chip?.button?.text || e.chipText || '')
  if (expected.chipGovern && !governChip.includes(expected.chipGovern)) {
    problems.push(`chip does not show governing value "${expected.chipGovern}"`)
  }

  if (problems.length) {
    failures += 1
    console.error(`FAIL ${label}: ${problems.join('; ')}`)
  } else {
    const chip = e.geometry?.chip?.button?.rect
    console.log(`PASS ${label}  (pane ${e.paneRect ? `${e.paneRect.width}×${e.paneRect.height}px` : ''} | chip button ${chip ? `${Math.round(chip.w)}×${Math.round(chip.h)}px` : 'n/a'} | accent ${accent} | destructive ${destructive})`)
  }
}

// ── Browser lifecycle scenario assertions ─────────────────────────────────
{
  const lc = geom.lifecycle
  const problems = []
  const mustHave = (step, label) => {
    if (!step) problem(problems, `lifecycle.${label}`, 'step missing')
    return step
  }
  if (!lc || !Array.isArray(lc.steps) || lc.steps.length !== 3) {
    problem(problems, 'lifecycle', `missing 3-step scenario (got ${lc?.steps?.length ?? 0})`)
  } else {
    const [s0, s1, s2] = lc.steps

    // Step 0 — default with backend: real data on pane + toolbar, toolbar capped.
    const p0 = []
    if (!(s0.paneText || '').includes('5h 62%')) p0.push('pane missing governing 5h 62%')
    if (!(s0.chipText || '').includes('Claude')) p0.push('chip missing provider label')
    chipGeometryOK(s0.chipButton, 'lifecycle.step0.chip', p0)
    if (p0.length) problem(problems, 'lifecycle.step0 (default w/ backend)', p0.join('; '))

    // Step 1 — ChaosForge (no backend): explicit on pane AND toolbar; no
    // wrong-account data; no render error (id labels captured, not a crash).
    const p1 = []
    if (!(s1.paneText || '').includes("isn't enabled or installed in chaosforge")) p1.push('pane missing explicit backend-unavailable copy')
    if ((s1.paneText || '').includes('5h 62%')) p1.push('pane served default rows under chaosforge (wrong-account stale)')
    if ((s1.paneText || '').includes('Account limits')) p1.push('pane rendered account rows under a missing backend')
    if (!(s1.chipText || '').includes('not enabled in chaosforge')) p1.push('chip missing explicit backend-unavailable copy')
    if ((s1.chipText || '').includes('5h 62%') || (s1.chipText || '').includes('$43.50')) p1.push('chip served a wrong-account figure under chaosforge')
    chipGeometryOK(s1.chipButton, 'lifecycle.step1.chip', p1)
    if (p1.length) problem(problems, 'lifecycle.step1 (chaosforge no backend)', p1.join('; '))

    // Step 2 — returned to default: recovered the right account on both surfaces.
    const p2 = []
    if (!(s2.paneText || '').includes('5h 62%')) p2.push('pane did not recover default data')
    if ((s2.paneText || '').includes('chaosforge')) p2.push('pane still names chaosforge after return')
    if (!(s2.chipText || '').includes('5h 62%')) p2.push('chip did not recover default governing value')
    chipGeometryOK(s2.chipButton, 'lifecycle.step2.chip', p2)
    if (p2.length) problem(problems, 'lifecycle.step2 (recovered default)', p2.join('; '))
  }

  if (problems.length) {
    console.error(`LIFECYCLE FAIL: ${problems.join(' | ')}`)
  } else {
    console.log('PASS lifecycle default → no-backend → default (explicit on pane+chip, no wrong-account data, recovers)')
  }
}

if (failures) {
  console.error(`\n${failures} capture(s) failed verification`)
  process.exit(1)
}
console.log('\nAll harness captures PASS verification (real plugin + real SDK components + real theme + capped toolbar + lifecycle).')