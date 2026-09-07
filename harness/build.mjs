#!/usr/bin/env node
/**
 * Build the Provider Usage component harness bundle.
 *
 * Bundles the REAL plugin (desktop/plugin.js — configurable via --plugin) with
 * the REAL Hermes desktop SDK UI primitives (Button, Badge, Loader, RowButton,
 * StatusDot, icons) and real React, all from hermes-agent's source + node_modules.
 * The plugin→app bridge in `@hermes/plugin-sdk` is aliased to harness/src/sdk-stub.js.
 *
 * Usage:
 *   node harness/build.mjs [--plugin <abs-path-to-plugin.js>] [--outdir <dir>]
 *   Defaults: plugin = <repo>/desktop/plugin.js, outdir = harness/dist
 *
 * Reads hermes-agent root from HERMES_AGENT_ROOT (default: the AppData install).
 */
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(__dirname, '..')

const HERMES_AGENT_ROOT = process.env.HERMES_AGENT_ROOT || 'C:/Users/jerry/AppData/Local/hermes/hermes-agent'
// esbuild ships inside hermes-agent's node_modules; import it by absolute path
// because the harness worktree has no node_modules of its own.
const esbuildUrl = pathToFileURL(path.join(HERMES_AGENT_ROOT, 'node_modules', 'esbuild', 'lib', 'main.js')).href
const { build } = await import(esbuildUrl)

function arg(name, fallback) {
  const i = process.argv.indexOf(name)
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback
}

const pluginPath = arg('--plugin', path.join(repoRoot, 'desktop', 'plugin.js'))
const outdir = arg('--outdir', path.join(repoRoot, 'harness', 'dist'))
const entry = path.join(__dirname, 'src', 'entry.js')

if (!fs.existsSync(pluginPath)) throw new Error(`--plugin file not found: ${pluginPath}`)
if (!fs.existsSync(path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'src'))) {
  throw new Error(`hermes-agent src not found under ${HERMES_AGENT_ROOT}. Set HERMES_AGENT_ROOT`)
}

// Generated entry imports the real plugin and mounts it. Regenerated so the
// plugin path is baked in at build time.
const entrySrc = `import { mountPlugin } from './app-mount.js'\nimport plugin from ${JSON.stringify(pluginPath)}\nwindow.__CAPTURE__ = window.__CAPTURE__ || {}\nwindow.__CAPTURE__.plugin = ${JSON.stringify(pluginPath)}\nmountPlugin(plugin)\n`
fs.writeFileSync(entry, entrySrc, 'utf8')

const desktopSrc = path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'src')
const reactDir = path.join(HERMES_AGENT_ROOT, 'node_modules', 'react')
const reactDomDir = path.join(HERMES_AGENT_ROOT, 'node_modules', 'react-dom')

const result = await build({
  entryPoints: [entry],
  bundle: true,
  format: 'esm',
  platform: 'browser',
  target: ['es2020'],
  outfile: path.join(outdir, 'app.js'),
  write: true,
  sourcemap: false,
  logLevel: 'info',
  alias: {
    '@hermes/plugin-sdk': path.join(__dirname, 'src', 'sdk-stub.js'),
    '@': desktopSrc,
    react: reactDir,
    'react-dom': reactDomDir,
    'react/jsx-runtime': path.join(reactDir, 'jsx-runtime.js'),
    'react-dom/client': path.join(reactDomDir, 'client.js'),
    'react/jsx-dev-runtime': path.join(reactDir, 'jsx-dev-runtime.js')
  },
  nodePaths: [
    path.join(HERMES_AGENT_ROOT, 'node_modules'),
    path.join(HERMES_AGENT_ROOT, 'apps', 'desktop', 'node_modules')
  ],
  loader: { '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.mjs': 'js' },
  define: { 'process.env.NODE_ENV': '"production"' }
})

console.log(`Built ${path.join(outdir, 'app.js')} from plugin ${pluginPath} (${result.warnings?.length ?? 0} warnings)`)
if (result.warnings?.length) {
  for (const w of result.warnings) console.warn('  warn:', w.text)
  if (result.warnings.some(w => w.text.includes('Could not resolve') || w.text.toLowerCase().includes('error'))) {
    console.error('BUILD FAILED: unresolved imports (see above). This usually means the SDK alias paths drifted.')
    process.exit(1)
  }
}