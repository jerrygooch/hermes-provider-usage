# Changelog

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
