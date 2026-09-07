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

- Native Chrome (`C:/Program Files/Google/Chrome/Application/chrome.exe`).
- Node ≥ 20. **No `npm install`** — `react`, `react-dom`, `esbuild`, and the SDK
  source are resolved from the Hermes agent installation
  (`$HERMES_AGENT_ROOT`, default `C:/Users/jerry/AppData/Local/hermes/hermes-agent`).
- The plugin file being consumed: `desktop/plugin.js` (repo or worktree), or any
  other path passed via `--plugin`.

Nothing is published or installed; nothing in a real profile is touched; the
fixture payloads contain only synthetic sample values.

## Usage

```bash
# 1. Bundle the REAL plugin + REAL SDK primitives + REAL React (default: ../desktop/plugin.js)
node harness/build.mjs
# point at a different (e.g. the ongoing-implementation) plugin:
node harness/build.mjs --plugin C:/Users/jerry/projects/hermes-provider-usage-harden/desktop/plugin.js

# 2. Capture all fixtures × widths (420 and 760) → PNG + geometry evidence
node harness/capture.mjs
# one width or one fixture:
node harness/capture.mjs --width 420
node harness/capture.mjs --fixture credit-balance
```

Outputs land in `harness/dist/` and `harness/dist/shots/`:
`<fixture>_w<width>.png`, `geometry.json` (pane/chip bounding rects, key node
geometry, theme vars actually resolved, rendered text).

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
node harness/build.mjs && node harness/capture.mjs
```

`harness/dist/app.js` and `harness/dist/shots/*.png` are git-ignored build/capture
outputs — regenerate, don't commit them.

## Limitations / honesty

- This is a **component harness**, not a screenshot of the running desktop app.
  The pane is mounted full-bleed on the editor surface; the packaged app adds pane
  chrome and a status-bar placement for the chip.
- Default SDK theme (light). It reflects the SDK's shipped default accent/palette,
  **not** whichever skin the user's live app is currently using.
- `Tip` tooltips are stubbed (resting-state invisible); hover-popovers are not
  captured.
- The fixture data is synthetic sample data, clearly labeled on each page.