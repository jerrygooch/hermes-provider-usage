# Brokered credential migration — Grok (xai-oauth)

Status: **Grok is brokered; the rest of the built-in adapters are now migrated
to public read-only core snapshots (see the update at the bottom).** The broker
remains a bounded, per-provider route — it is not a universal proxy.

- Candidate: `C:/Users/jerry/projects/hermes-provider-usage-ext`
  (branch `provider-extensibility`, existing dirty tree preserved).
- Required core commit until a release contains it:
  `dbe0bcec0d6c3e84acd99c6cb0072561c84fa623`
  (`plugin requests: brokered xAI Grok sign-in, bytes bodies, URL hardening`).
- Additive core seams (separate worktree, not the installed core):
  `C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams`,
  current HEAD `a4c484eb5d` (includes `dbe0bcec0d`, `622eb3219f`, and the
  cherry-picked delegation metadata `13152f4603`).
- No prerelease version was invented. `plugin.yaml` stays `0.10.0` and now has
  **no `requires_hermes` floor**; the exact core commit is the dependency until
  a Hermes release carries both the broker and the public usage seams. See the
  manifest comment rather than a false `>=0.21.6`.

## What changed in the plugin

`dashboard/plugin_api.py`:

- `_fetch_xai()` no longer calls `_runtime("xai-oauth")` and never handles a
  token. `_fetch_xai_proxy()` and the gRPC fallback both call
  `_credentialed_xai_request()`, which imports
  `hermes_cli.plugin_provider_requests.credentialed_provider_request` and calls
  it as `("xai-oauth", method, url, headers=…, content=…, timeout=…)`.
- Both Grok hosts remain: `cli-chat-proxy.grok.com` for the JSON credits proxy
  and `/v1/settings`, `grok.com` for the gRPC-web `GetGrokCreditsConfig`
  fallback. The fallback still runs for non-auth proxy failures.
- Auth, permission and broker-policy failures on the billing/gRPC requests do
  **not** fall back: `ProviderNotSignedIn`/`PermissionError`/HTTP 401/403
  produce an unavailable row with the safe reason instead of trying the other
  route. `/v1/settings` plan metadata stays optional, exactly as before.
- On a core without the `xai-oauth` broker route (including the currently
  installed `0.23.1`, whose helper only declares `openai-codex`), the adapter
  returns a clear upgrade-required row. It does **not** read a raw runtime token
  and has no legacy fallback.
- `_serialize_snapshot` now reads the additive core `snapshot.raw` shape
  `{"credits": …, "key": …}` for OpenRouter, through the shared
  `_openrouter_row()` normalizer. No current adapter calls it yet; this is the
  plugin half of the core seam below.
- A small `_openrouter_row()` refactor keeps `_fetch_openrouter()` and the new
  raw-snapshot path on one normalizer.

`plugin.yaml`:

- Added `requires_auth: [openai-codex, xai-oauth]`. `openai-codex` is still read
  through the sanctioned `fetch_account_usage(..., read_only=True)` snapshot;
  `xai-oauth` is the new brokered route.

Preserved Grok data fields (covered by the new tests):

- `plan` from `/v1/settings` (still optional/failure-tolerant);
- `limits[0].label` and the weekly/monthly/other window label;
- `used_percent`, `remaining_percent`, `reset_at`;
- reconciled product `breakdown` + `breakdown_note` (unreconciled split dropped);
- prepaid balance in cents → USD;
- saved-payment-method and unified-pool detail lines;
- gRPC fallback window, pay-as-you-go `total`/`used`/`amount`, fallback detail,
  `source=grok_billing_grpc`;
- the raw bytes body `b"\x00\x00\x00\x00\x00"` and the caller headers
  (`Content-Type`, `Accept`, `X-Grpc-Web`, `Origin`, `Referer`, `User-Agent`);
- no `Authorization` header is passed by plugin code at all.

## Tests

New: `tests/test_brokered_provider_usage.py` — 10 tests.

```bash
cd C:/Users/jerry/projects/hermes-provider-usage-ext
python -m unittest tests.test_brokered_provider_usage -v
# Ran 10 tests ... OK
```

Coverage:

- full proxy field parity through a fake public broker;
- full gRPC fallback parity and exact bytes/header preservation;
- 401/403 and `PermissionError` do not fall back;
- missing broker module and a pre-`xai-oauth` broker report upgrade-required,
  including the installed helper's older signature without `content=`;
- the real helper imported from the isolated core checkout
  `worktrees/xai-plugin-provider-requests` (or `HERMES_PU_CORE_CHECKOUT`),
  invoked from an installed-plugin fixture under a throwaway `HERMES_HOME`,
  with a synthetic in-process bearer and `httpx.MockTransport`:
  proxy GET, settings GET and gRPC POST all return status/body without a token
  in the result or an `auth.json` on disk.

Existing parity baseline (mocks for the xAI cases updated to the public broker;
all data assertions unchanged):

```bash
python -m unittest discover -s tests -p "test_*.py" -q
# Ran 146 tests ... OK (skipped=7; the migration acceptance classes are opt-in)
```

Full candidate gate:

```bash
npm run check
# node logic/scope/render/lifecycle/running-agents suites PASS,
# Ran 146 tests ... OK (skipped=7),
# 3 bundled definitions VALID, py_compile clean; exit 0.
```

Whole-plugin acceptance is now green against the completed core checkout
(`PYTHONPATH=…/provider-usage-core-seams`):

```bash
HERMES_PU_ACCEPT_MIGRATION=1 python -m unittest discover -s tests \
    -p "test_credential_migration_parity.py" -q
# Ran 56 tests ... OK (0 skips).
```

The broker acceptance no longer requires a universal `_PROVIDERS` entry: it
asserts that every supported provider has a sanctioned public route (read-only
snapshot, fallback fetcher, or the xAI broker) and that every core built-in
fetcher has a read-only variant.

## Additive core seams implemented

Worktree `provider-usage-core-seams` (base `dbe0bcec0d`, current HEAD
`a4c484eb5d`; not installed, not the xAI worktree, not pushed):

1. **OpenRouter `raw` + read-only fetcher** in `agent/account_usage.py`.
   `_fetch_openrouter_account_usage` now returns
   `raw={"credits": <decoded /credits data>, "key": <decoded /key data>}`.
   `_fetch_openrouter_account_usage_read_only` is registered in
   `_READ_ONLY_USAGE_FETCHERS`. No headers, tokens or request objects are in
   `raw`.
2. **Public pool inventory**:
   `list_account_usage_identities(provider, *, base_url=None)` returns
   `{identity_id, label, auth_type, source, available, status, request_count,
   last_status_at, base_url}` per pool row, with no token/agent key. It uses the
   same identity function as the usage cache (`codex:` principal or `fp:` token
   fingerprint).
3. **Per-identity fetch**:
   `fetch_account_usage(provider, identity_id=…, read_only=True)` resolves the
   pool row inside core when `api_key` is omitted, sets the resolved
   `runtime_api_key`/`runtime_base_url`, and never returns a token to the
   caller. An explicit `api_key` still wins.

Core test evidence (run with the xAI worktree's dev venv because the new
worktree has no `.venv`):

```bash
cd C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams
../xai-plugin-provider-requests/.venv/Scripts/python.exe -m pytest \
  tests/agent/test_account_usage_provider_usage_seams.py -q
# 4 passed

../xai-plugin-provider-requests/.venv/Scripts/python.exe -m pytest \
  tests/agent/test_account_usage_fetch.py tests/agent/test_account_usage.py \
  tests/agent/test_account_usage_pool_fetch.py \
  tests/hermes_cli/test_plugin_provider_requests.py -q
# 48 passed  (23 of them are the real helper suite)
# Parent's integrated-tree run at HEAD a4c484eb5d (reported): 62 passed across
# snapshot + new fetcher + seams + broker tests.

../xai-plugin-provider-requests/.venv/Scripts/python.exe -m ruff check \
  agent/account_usage.py tests/agent/test_account_usage_provider_usage_seams.py
# All checks passed
```

## Closed since this document was first written

The whole-plugin migration completed against core HEAD `a4c484eb5d`; the
remaining blockers listed here previously are all closed in the plugin:

1. **Raw-runtime adapters** — OpenRouter, DeepSeek, Ollama Cloud, OpenCode Zen
   and OpenCode Go now call `fetch_account_usage(..., read_only=True)`; their
   existing parsers consume `snapshot.raw`. `_runtime()` is deleted.
2. **OpenRouter snapshot** — wired through `_openrouter_row()`; narrowing probe
   N1 now guards the rawless shape instead of measuring the old gap.
3. **Pool inventory** — `_has_local_credentials` uses
   `provider_credential_summary`; `_attach_accounts` adds deduped, bounded
   `row.accounts[]` from `list_account_usage_identities`, reusing a
   provider-wide row for a sole pool account only when its verified identity
   matches, and otherwise using a per-identity TTL-cached read where supported
   (xAI/Nous stay unknown).
4. **Anthropic** — read-only fetcher registered in core and requested by the
   plugin.
5. **Nous** — public read-only snapshot; the `hermes_cli.nous_account` import is
   gone.
6. **Broker coverage** — still deliberately 2/9 (`openai-codex`, `xai-oauth`);
   the other seven use core snapshots, which the acceptance test now checks
   route-by-route instead of pretending a universal broker exists.

## Operating limits

- No UI edit, no install, no push, no gateway restart, no paid API call and no
  real credential was used. The installed plugin is untouched.
- The currently installed Hermes (`0.23.1`) has
  `hermes_cli.plugin_provider_requests` but only `openai-codex` in
  `_PROVIDERS`, and its helper has no `content=` argument. Verified in a
  throwaway installed-plugin fixture: `_fetch_xai()` returns one unavailable
  row with the upgrade reason above, reads no runtime token and makes no
  fallback request. The Grok pane will show that row until a core build
  containing `dbe0bcec0d` (or the release that includes it) is installed.
- Every xAI test payload and bearer is synthetic. No token is written to a test
  home.
