# Provider Usage component harness (browser capture + testing)

Renders the **actual** Provider Usage plugin components — `ProviderUsagePane` and
`ActiveUsageChip`, straight from `desktop/plugin.js` — and screenshots them in a
real Chromium with **native Hermes SDK styling**. This is **not** a hand-made HTML
mock and **not** a screenshot of the running desktop app; it is a faithful
**component harness** that imports the shipped plugin and real SDK primitives.

## What actually renders

- The real `desktop/plugin.js` module (`ProviderUsagePane`, `ActiveUsageChip`,
  and every nested `UsageMeter` / `BalanceMetric` / `ProviderDisclosure` /
  `AllProviderMetrics` / `SectionLabel` / `LimitGroup` …) is bundled unchanged.
- The real SDK UI primitives **Button, Badge, Loader, RowButton, StatusDot and
  the `icons.*` set are imported from the Hermes desktop SDK source**
  (`@/components/…`, `@/lib/icons`) and re-exported through a thin facade — so the
  native widgets render with their real classes, variants and theme tokens.
- Real React + `react-dom/client` render the components into the DOM.
- Real **(compiled) Hermes SDK stylesheet** (`hermes-agent/…/dist/assets/*.css`,
  copied to `harness/static/hermes-sdk.css`) supplies the Tailwind utilities and
  the real `--ui-*` / `--dt-*` theme variable definitions (default accent
  `#0053fd`, destructive `#cf2d56`, etc.). The pane's theme-var inline styles
  therefore resolve exactly as in the desktop.
- **Fixture provider data** (realistic `/overview` payloads) is served to the
  plugin through `ctx.rest('/overview', …)`.

## What is stubbed (and why)

Only the plugin→app *bridge* — the parts of the SDK that talk to a live gateway —
is replaced by a deterministic fixture double in `harness/src/sdk-stub.js`:

| SDK surface | Harness behavior |
|---|---|
| `host.state.*` atoms | tiny readonly atoms fed from `window.__FIXTURE__.host` |
| `host.request('session.status')` | resolves the active provider from the fixture |
| `host.onEvent('session.info')` | delivers the fixture's active provider on subscribe |
| `useQuery` | deterministic resolved React-Query-shaped result wrapping the fixture |
| `Tip` | tooltip scaffold (label as accessible `title`); **stubbed** — real Tip pulls keybind/i18n stores |
| `haptic`, `host.openWorkspace`, `notify`, `navigate` | no-ops |

Everything that affects what you SEE (the plugin's own renderers, the SDK widgets,
the theme) is the real thing. The only visually material substitution is `Tip`,
which in the resting (non-hover) state contributes no pixels beyond its trigger, so
screenshots are unaffected.

> **Fidelity label:** screenshots are of a *component harness*, not the packaged
> desktop window. The pane is rendered full-bleed on the editor surface; the real
> app adds pane chrome (title bar, ordering). Highlighted as such on the page.

## Prerequisites

- Native Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`, override with `$HARNESS_CHROME`).
- Node ≥ 20 and the repo's dev toolchain: `npm ci` (the `jsdom`/`react`/`react-dom`
  devDependencies — used by the jsdom suites and for the harness docs).
- A Hermes agent checkout whose **React + desktop SDK source** the bundle re-exports.
  Set `$HERMES_AGENT_ROOT` (default: `AppData/Local/hermes/hermes-agent` under this
  machine's home), and point `$HARNESS_CHROME` at any Chrome binary for the capture
  step. No paths are baked into the repo; env vars make it portable.
- The plugin file being consumed: `desktop/plugin.js` (repo or worktree default), or any
  other path passed via `--plugin`.

Nothing is published or installed; nothing in a real profile is touched; the
fixture payloads contain only synthetic sample values.

## Usage

```bash
# 1. Bundle the REAL plugin + REAL SDK primitives + REAL React (default: ../desktop/plugin.js)
node harness/build.mjs
# point at a different (e.g. the ongoing-implementation) plugin:
node harness/build.mjs --plugin ./desktop/plugin.js

# 2. Capture all fixtures × widths (420 and 760) → PNG + geometry evidence,
#    then a real-browser LIFECYCLE scenario (default → no-backend → default)
node harness/capture.mjs
# one width or one fixture:
node harness/capture.mjs --width 420
node harness/capture.mjs --fixture credit-balance

# 3. Verify: theme tokens, required text, chip geometry inside the 230px cap,
#    governing chip values, and the lifecycle assertions
node harness/verify.mjs
```

Outputs land in `harness/dist/` and `harness/dist/shots/`:
`<fixture>_w<width>.png`, `geometry.json` (pane/chip bounding rects, the real
**chip button** rect, theme vars actually resolved, rendered text, and the
lifecycle steps). Build/capture/verify outputs are git-ignored — regenerate them.

### Toolbar honesty (and the false-positive it kills)

The old harness measured the 320px wrapper div, whose height can read `0` — a
zero-height toolbar could "pass" while rendering nothing. `verify.mjs` now
measures the plugin's **real chip `<button>`** and requires it to have positive
width **and** height and stay inside the plugin's **230px production cap**
(`maxWidth: 230`), and that the governing funding value (e.g. `5h 62%`, `$43.50`,
`mo 0%`) is actually visible in that button's text — not ellipsized away.

### Lifecycle scenario (priority regression)

`harness/capture.mjs` additionally drives the REAL plugin through a full
profile round-trip in real Chromium by rewriting the live SDK atoms and rest
door over CDP:

1. **default (with backend)** → genuine benefits on pane + toolbar;
2. **a ChaosForge-like profile without the plugin backend** (`/overview` 404s) →
   the pane says "isn't enabled or installed in chaosforge" AND the toolbar chip
   says "not enabled in chaosforge", with **no** wrong-account figures and no
   render error;
3. **return to default** → the default account's rows come back (recovered).

`verify.mjs` asserts all three steps on both surfaces.

## Fixtures

| fixture | state exercised |
|---|---|
| `compact-5h-wk` | subscription with **5-hour + 7-day** windows → compact funding `5h 62% · wk 84%`, two meter bars |
| `credit-balance` | **credit-balance** provider → prominent `$43.50`, `used/granted` break-down, `CreditCard` chip icon |
| `exhausted-monthly` | subscription with a **0% monthly window** → red destructive `mo 0%`, alongside a live 5-hour window |

Wide (760) renders the multi-window meters in the plugin's `minmax(145px,1fr)`
grid; narrow (420) stacks them — the layout is the plugin's own.

## Reproducing from a clean checkout

```bash
npm ci
node harness/build.mjs && node harness/capture.mjs && node harness/verify.mjs
```

`harness/dist/app.js`, `harness/dist/*.html`, and `harness/dist/shots/*` are
git-ignored build/capture outputs — regenerate, don't commit them.

## What the stub models about the SDK

The `host.state.*` atoms are reactive doubles (driven by `window.__FIXTURE__.host`
at boot and by `window.__HARNESS__.set(...)` over CDP for lifecycle scripts), so
the plugin's `useValue` subscriptions re-render for real. The focused-owner atom
is exposed **always**, exactly like the current SDK; a present-but-null value
means the SDK judged the focus ambiguous/unresolved, and the stub (and therefore
the plugin) treats that as authoritative — never a profile-only fallback. The
`useQuery` double caches rows per **serialized** query key — the same structural
identity React Query uses — so cross-account isolation and
"reconnecting keeps the last rows stale" are real in-browser behaviors, not
reference-identity accidents.

## Limitations / honesty

- This is a **component harness**, not a screenshot of the running desktop app.
  The pane is mounted full-bleed on the editor surface; the packaged app adds pane
  chrome and a status-bar placement for the chip. Nothing here proves the full
  packaged-app integration (Electron shell, real gateway socket, real
  per-profile backend routing) — that remains a live-app acceptance step.
- Default SDK theme (light). It reflects the SDK's shipped default accent/palette,
  **not** whichever skin the user's live app is currently using.
- `Tip` tooltips are stubbed (resting-state invisible); hover-popovers are not
  captured.
- The fixture data is synthetic sample data, clearly labeled on each page.