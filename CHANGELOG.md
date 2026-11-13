# Changelog

## 0.10.6 — the provider list stops hiding signed-in accounts; card text stops being cut

Two defects made the chip look broken next to a working backend.

A provider you sign into through Hermes has no environment key and is usually absent
from `config.yaml` once you switch models, so `xai-oauth` fell out of the provider
inventory entirely: Grok disappeared from the page and the compatibility switch had no
row to fill. And the popover clipped its own text — a rate line, the published peak
schedule and the rate source were wider than the 356px card and were cut by its
overflow guard.

### Changed

- **A signed-in account counts as configured.** Presence for OAuth-only providers comes
  from core's `get_xai_oauth_auth_status`, reduced to a boolean in one statement; the
  snapshot's token field never leaves the probe. Signed out reports as
  known-and-not-configured instead of vanishing.
- **Popover text wraps instead of clipping.** Rate figures wrap under the model name and
  right-align; the peak schedule and the rate source break inside the card.
- **The footer control is centred structurally**, in a flex row in every popover state,
  instead of relying on a button honouring `width: 100%`.
- **Saving a setting refetches usage** rather than leaving stale numbers on screen.

## 0.10.5 — deeper provider coverage

Arcee, Fireworks and DeepInfra readers, each limited to what the vendor documents:
Arcee's token and request totals stay details (never a fake balance); Fireworks spend
uses the `currencyCode` in its own response; DeepInfra's negative Stripe balance reads
as credit on hand, with scoped credits converted from cents. StepFun and Hugging Face
remain unshipped on purpose — StepFun's docs disagree on its host, and Hugging Face needs
an organisation name the key does not carry.

## 0.10.4 — one window vocabulary, and a Novita balance

Every usage window now carries a `kind` (`five_hour`, `daily`, `weekly`, `monthly`,
`rolling`, `custom`) inferred from the provider's own label, so the renderer labels the
same timeframe the same way everywhere. Window order is deliberately untouched: sorting
by kind broke Claude's model-scoped sequence. Adds the Novita balance reader, which
converts the integer 1/10 000 units the API returns into dollars.

## 0.10.3 — a settings surface, and a secure compatibility mode

`GET`/`PUT /settings` over one allowlisted JSON file per profile, with a collapsible
Settings section rendered from that spec. Adds opt-in compatibility mode
(`compat_oauth_reads`) for builds with no xAI broker: it resolves through core's locked
OAuth resolver, never a token file, so a refresh cannot race or revoke the rotation
chain. Includes a live proof against stock 0.23.1 (HTTP 200, real billing payload, no
token in the response or its repr).

## 0.10.2 — provider reports, and a broker capability probe

A `provider-data` issue template, a `report_url` on `/diagnostics`, and a `core_broker`
block that says whether this build can broker a provider at all — so a limited Grok card
is provably an upgrade state rather than a bug. Adds `docs/provider-account-endpoints.md`
(27 providers checked against vendor documentation) and
`docs/fallback-without-core-broker.md`.

## 0.10.1 — refresh observability and an honest chip

Fixes the failure mode where the status-bar chip reads **Usage unavailable** with no
explanation, and makes the next occurrence diagnosable instead of silent.

### Why

The desktop aborts a plugin request at 25s. When an overview refresh failed or ran
long, the chip had no row to render and said "Usage unavailable", while the page kept
showing cached rows behind a "Could not refresh" banner. The two surfaces disagreed
and neither named a cause: provider read failures were logged at `debug`, which the
host does not write, so a real outage looked identical to a slow one.

### Changed

- **Per-provider WARNING logs.** A failed read now logs the provider, elapsed
  milliseconds and a redacted reason (`RuntimeError: …`, `TimeoutError: …`) instead of
  a `debug` line nobody sees.
- **One INFO line per refresh** — profile, row count, unavailable count, duration and
  the failure list — so "nobody asked" is distinguishable from "every read failed".
- **`GET /diagnostics`** (read-only, credential-free) returns the plugin version, the
  refresh budget, the last refresh's row ids, per-provider timings, failures and
  active provider, plus whether this profile's keys resolve through the host's secret
  scope (`present` / `missing` / `raised`). Values are never returned.
- **18s refresh budget.** The backend now answers inside the desktop's 25s cap even
  when a provider hangs: anything unfinished at the deadline becomes an explicit
  `did not answer within 18s` row, and the request returns normally. Previously the
  whole response was lost to the client-side timeout.
- **The chip names the mismatch.** When a response arrives without a row for the
  chat's provider, the chip reads `<Provider> · no data` and its tooltip lists the row
  ids the backend actually reported — instead of an anonymous "Usage unavailable".

### Unchanged

Read-only for usage. No credential leaves the backend, the renderer still receives
only percentages and balances, and the only mutation (the separately gated Codex
banked-reset action) is untouched.

## 0.10.0

Namespaced as `jg-provider-usage`; declarative read-only provider definitions; Claude,
Gemini and Z.ai connection cards; banked-reset preview/confirm; running-agents footer.
