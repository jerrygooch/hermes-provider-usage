# Hackathon readiness — declarative Provider Usage

Local branch: `provider-extensibility` in
`C:/Users/jerry/projects/hermes-provider-usage-ext`.
Nothing has been published, pushed, installed into the daily Hermes home, or
restarted. The source repository's `main` worktree and the foreign `-harden` /
`-harness` worktrees were left untouched.

## What is working

- Declarative, versioned JSON definitions (`hermes.provider-usage.definition/1`)
  for fixed read-only HTTPS usage/balance endpoints.
- Safe boundary: credential **references** only, HTTPS GET, default port,
  exact host allow-list, one bounded DNS resolution with a pinned public peer,
  no redirects, no proxy/netrc, 512 KiB / 10 s per-read / 20 s wall-clock
  budget checked across DNS and streaming, strict unknown-key rejection,
  30–86,400 s cache.
- **Explicit local trust gate:** bundled definitions are code-owned; every
  profile-local file is denied until `scripts/approve_definition.py` records its
  exact content digest, endpoint, and structured credential references in
  `$HERMES_HOME/provider-usage/approvals.json` (outside the definitions
  directory). Editing the file revokes approval (`blocked`). Approval reads no
  secret and cannot be triggered by a definition or the packager.
- Multiple windows (5-hour, daily, weekly, monthly, rolling, custom), units
  (percent, requests, tokens, characters, USD, credits, custom), currency,
  resets, rolling semantics only for rolling windows, and explicit unknown
  values (never fabricated 0). Omitted mapping rows carry warnings; unresolved
  currency is `UNKNOWN`, not USD.
- Bundled catalog: GitHub rate limits (credential-free), Moonshot/Kimi balance,
  ElevenLabs subscription. Profile-local definitions under
  `$HERMES_HOME/provider-usage/providers/`, explicit override for bundled ids,
  reserved built-in ids refused, duplicate profile ids reported.
- UI: active card keeps multiple meters; definition badge and provenance panel;
  catalog section with **Connected**, **Available to connect** (names the
  missing environment variable), **Ready to read**, **Requires approval**,
  **Blocked**, and **Invalid definition** (exact schema errors); copy-setup
  action; no credential values cross REST.
- Agent/person workflow: `dashboard/definitions/TEMPLATE.json`,
  `dashboard/definitions/README.md`, `scripts/validate_definition.py`,
  `scripts/approve_definition.py`,
  `POST /api/plugins/provider-usage/definitions/validate`, and a local
  sanitizing packager (`scripts/package-definition.py`) with no GitHub call and
  no approval artifact.

## Evidence tiers

### Tier 1 — unit / SSR / logic (real code, deterministic)

Command:

```bash
cd C:/Users/jerry/projects/hermes-provider-usage-ext
npm run check
```

Result (last run before the final documentation commit):

- `profile_scoped_toolbar_query_suite=PASS`
- `resolver_fixture_suite=PASS`
- `provider_scope_behavior_suite=PASS`
- `provider_real_render_smoke=PASS`
- `plugin_lifecycle_suite=PASS`
- `Ran 79 tests ... OK` (Python schema, approval gate, exfiltration,
  fingerprint revocation, profile/home isolation, malformed port/deep JSON,
  SSRF pinning, NAT64/reserved, DNS bound, total deadline, cache, mapping,
  packaging, catalog, and secret-leak checks)
- all three bundled definitions `VALID`
- `python -m py_compile dashboard/plugin_api.py` clean

### Tier 2 — real browser render (real Edge headless + real SDK components)

Command:

```bash
node harness/build.mjs
node harness/capture.mjs
node harness/verify.mjs
node harness/popover-verify.mjs
```

Result: 10 captures × PASS, lifecycle PASS, and the popover assertion PASS. The
captures use the actual plugin bundle, real SDK `Tip`/`Popover`/`Button`/theme,
and assert capped toolbar width, contrast tokens, no overflow, the
profile round-trip, and the explicit backend-not-enabled state.

Captures:

- `harness/dist/shots/declarative-catalog_w420.png`
- `harness/dist/shots/declarative-catalog_w760.png`
- `harness/dist/shots/compact-5h-wk_w420.png` / `_w760.png`
- `harness/dist/shots/credit-balance_w420.png` / `_w760.png`
- `harness/dist/shots/exhausted-monthly_w420.png` / `_w760.png`
- `harness/dist/shots/preview-showcase_w420.png` / `_w760.png`
- `harness/dist/shots/popover-open_w760.png`
- `harness/dist/shots/geometry.json` (text + rect + color evidence)

The declarative capture asserts the active GitHub card (3 windows),
**No allowance** for GraphQL 0/0 (not “0%”), the available-to-connect Moonshot
and ElevenLabs entries with their env names, and an invalid definition with
actionable errors.

### Tier 3 — live provider read (no credential)

Command:

```bash
python scripts/live-check-github.py
```

Observed: `state=ok`, `available=True`, `windows=3`,
`host=api.github.com`, Core/Search/GraphQL normalized, GraphQL
`remaining_percent=None` with `limit=0` (unknown/no allowance, not zero).
No response body, headers, or credentials are printed.

### Not verified live

- Moonshot and ElevenLabs account responses: definitions are schema-valid and
  follow their published docs, but no private account was called. They remain
  **Available to connect** until the user supplies the env var.
- The actual Electron Desktop app hosting the updated plugin: this worktree was
  not installed into the daily Hermes home or restarted. The browser harness
  uses real SDK components but is not Electron itself.
- A real gateway HTTP round-trip to `/overview`: backend units and direct route
  functions are tested; no live gateway profile was modified.
- DNS rebinding between the preflight DNS check and httpx's own resolution
  remains a documented residual risk; proxy/netrc are disabled to keep the
  checked peer predictable.

## Under-90-second demo outline

| Time | Beat |
| --- | --- |
| 0–10 s | Status-bar chip shows `GitHub API rate limit · Core 92% · Search 90%`; click it. |
| 10–25 s | Page opens on the active GitHub card: Core, Search, and GraphQL. Point out GraphQL says **No allowance**, not 0%, because GitHub reports limit 0. |
| 25–40 s | Scroll to **Data source**: bundled definition, endpoint host, fetched/checked/cache/scope provenance. |
| 40–65 s | **Available to connect** shows Moonshot and ElevenLabs with the exact missing env vars, plus an invalid profile definition with its schema error. Click **Copy setup**. |
| 65–80 s | Show `TEMPLATE.json` + `python scripts/validate_definition.py ...`; explain no scripts, no secret values, HTTPS/pinned-public-peer/no-redirect boundary, and the local approval CLI. |
| 80–90 s | Close: definitions are portable data; package with `scripts/package-definition.py`; no automatic publication. |

## Submission checklist

Per the user-provided announcement (not independently re-verified here):

- [ ] Open the catalog PR (not authorized / not done).
- [ ] Post the X demo tagging `@NousResearch` (not authorized / not done).
- [ ] Submit the required form (not authorized / not done).
- [ ] Deadline noted by the user: **Nov 11, 5:00 PM EST**.

Local preparation is complete; publication needs explicit approval.

## Known limitations / next work

- Add live tests for Moonshot and ElevenLabs only with user-supplied sandbox
  credentials; do not print or persist account bodies.
- DNS rebinding hardening would require connecting to the vetted IP with SNI /
  certificate validation pinned to the host; current mitigation is the
  preflight public-address check plus no proxy/environment trust.
- No OAuth refresh, multi-step requests, writes, gRPC, or HTML scraping in
  definitions by design; those remain Python adapters.
- Cache is in-process and disappears on gateway restart; a future version could
  persist sanitized normalized rows, never raw responses.
- The standalone `/definitions/catalog` endpoint marks ready-but-unfetched
  public definitions as **Ready to read**; the page's overview normally has a
  row for each connected definition.
- Definition cards currently use the generic provider icon; per-definition
  icons would be a small cosmetic addition.
- No automatic directory watcher: adding a file requires the next overview
  refresh (manual refresh or 60 s poll).
