/**
 * Verify harness capture output: asserts the real plugin actually rendered the
 * expected components + text + geometry for each captured scenario, and that the
 * theme tokens resolved to the real SDK values. Exits non-zero on any failure.
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

const EXPECT = {
  'compact-5h-wk': {
    registeredName: 'Provider Usage',
    needles: ['5h 62%', 'wk 84%', 'Anthropic / Claude', 'ACCOUNT LIMITS & CREDITS', '5-hour window', '7-day window'],
    chipNeedle: 'Claude'
  },
  'credit-balance': {
    registeredName: 'Provider Usage',
    needles: ['$43.50', 'Nous Portal', 'BALANCE', 'used of $50.00', 'Requests are billed from this provider balance'],
    chipNeedle: 'Nous'
  },
  'exhausted-monthly': {
    registeredName: 'Provider Usage',
    needles: ['mo 0%', 'Monthly window', '0% left', 'SuperGrok'],
    chipNeedle: 'Grok'
  }
}

let failures = 0
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
  const okName = e.registered?.name === expected.registeredName
  const text = (e.text || '') + '\n' + (e.chipText || '')
  const missingNeedles = expected.needles.filter(n => !text.includes(n))
  const badChip = expected.chipNeedle && !(e.chipText || '').includes(expected.chipNeedle)
  const accent = e.geometry?.resolvedVars?.accent
  const destructive = e.geometry?.resolvedVars?.destructive

  const problems = []
  if (!okName) problems.push(`registered name ≠ ${expected.registeredName}`)
  if (missingNeedles.length) problems.push(`missing text: ${missingNeedles.join(', ')}`)
  if (badChip) problems.push(`chip missing ${expected.chipNeedle}`)
  if (accent !== '#0053fd') problems.push(`accent token ${accent} ≠ #0053fd`)
  if (destructive !== '#cf2d56') problems.push(`destructive token ${destructive} ≠ #cf2d56`)
  if (!e.paneRect || e.paneRect.width < 1) problems.push('pane has no geometry')

  if (problems.length) {
    failures++
    console.error(`FAIL ${label}: ${problems.join('; ')}`)
  } else {
    console.log(`PASS ${label}  (${
      e.paneRect ? `pane ${e.paneRect.width}×${e.paneRect.height}px` : ''
    } | accent ${accent} | destructive ${destructive})`)
  }
}

if (failures) {
  console.error(`\n${failures} capture(s) failed verification`)
  process.exit(1)
}
console.log('\nAll harness captures PASS verification (real plugin + real SDK components + real theme).')