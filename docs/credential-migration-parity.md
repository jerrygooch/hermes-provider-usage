# Credential migration parity contract — historical migration record

Status: **historical migration record**. The route table below describes the optional
enhanced-core target used to prove field parity; it is **not** a stock route claim. On
stock Hermes 0.23.1 the live routes are: read-only snapshots for Codex, Anthropic,
OpenRouter and the OpenCode Go provider hook; profile-scoped `get_secret` to fixed
official endpoints for DeepSeek, Ollama Cloud and OpenCode Zen; the core
`build_nous_credits_snapshot` builder for Nous; and an official-link, unavailable row for
xAI because stock has no broker. See [stock-support.md](stock-support.md) for the
current matrix. The parity work here is still the reason the plugin never reads a
runtime key, credential pool, or auth store.

Whole-plugin migration of the built-in Provider Usage adapters onto the public
Hermes credential routes, with the Desktop pane's field parity preserved.

- Candidate: this repository checkout (branch `provider-extensibility` in the original
  development tree).
- Completed against an optional isolated core checkout at
  `/path/to/optional-hermes-checkout` (`a4c484eb5d`).
- Stock `0.23.1` exposes the required read-only snapshot route, so `plugin.yaml`
  floors at `>=0.23.1`. Enhanced identity/summary/broker helpers remain optional,
  degrade one row, and are covered by `docs/stock-support.md`.
- Nothing was installed into the daily Hermes home, published, or restarted.

## Routes now used

| # | Provider | Route | What still arrives on the row |
| --- | --- | --- | --- |
| P1 | `openai-codex` | `fetch_account_usage("openai-codex", read_only=True)` + `snapshot.raw` | plan names, default/Spark/code-review groups, extra-usage balance, `credit_status`, banked resets, `model_access`, `spend_control`, reached-type detail |
| P2 | `anthropic` | `fetch_account_usage("anthropic", read_only=True)` | four windows incl. model-scoped Opus/Sonnet weeks (`scope` preserved), `extra_usage` detail, honest API-key-account reason |
| P3 | `openrouter` | `fetch_account_usage("openrouter", read_only=True)` + raw `{credits,key}` | remaining credits with `total`/`used`, API-key quota + reset detail, free-model daily quota, `key_usage` total/daily/weekly/monthly/BYOK |
| P4 | `deepseek` | Stock: `get_secret("DEEPSEEK_API_KEY")` at `https://api.deepseek.com/user/balance`; enhanced core may return raw `{balance}` | every `balance_infos` row, `granted_balance`/`topped_up_balance`, provider currency verbatim, unavailable reason |
| P5 | `xai-oauth` | `credentialed_provider_request("xai-oauth", …)` for both Grok origins when the host brokers it; **stock has no broker** | plan, weekly/monthly percent + reset, reconciled product split + note, prepaid balance, saved-payment/unified-pool details, gRPC fallback cap/used; stock shows the official link only |
| P6 | `opencode-go` | `fetch_account_usage("opencode-go", read_only=True)` (profile hook, core fallback + whole raw `{usage}`) | rolling→5-hour/weekly/monthly, `allowed/limit_reached`, Go product + allowance note, Zen product marked unavailable, detail lines |
| P7 | `opencode-zen` | Stock: `get_secret("OPENCODE_ZEN_API_KEY")` at the fixed `/zen/v1/models` access check; enhanced core may normalize the snapshot | authenticated-access detail, Zen product row, no invented wallet |
| P8 | `ollama-cloud` | Stock: `get_secret("OLLAMA_API_KEY")` at fixed `/api/usage` + `/api/balance`; enhanced core may return raw `{usage,balance}` | session/weekly/monthly percent, per-model counts, spend-in-period, `activity` totals/buckets/hit rate, monthly included allowance, purchased credits |
| P9 | `nous` | Stock: core `build_nous_credits_snapshot`; enhanced core may expose `fetch_account_usage("nous")` | gauge percent, subscription/top-up/total-usable/rollover details, renewal, plan, top-up link, depleted line; no private Nous account module import |
| P10 | unsupported/custom names | inventory only | row presence, label, `capability: "unsupported"`, alias canonicalisation |
| P11 | declarative definitions | `agent.secret_scope.get_secret` (unchanged) | mapped windows/balances/details, trust gate, setup metadata |

Inventory presence comes from `provider_credential_summary(provider)`. Pooled
account metadata comes from `list_account_usage_identities(provider)`; the
plugin never calls `load_pool`, `get_provider_auth_state`, or
`resolve_runtime_provider`.

## Rule-11 routes this map is measured against

From `plugin-catalog/README.md` rule 11 and `catalog-submission`:

- declared secrets via `agent.secret_scope.get_secret(NAME)` (profile-scoped,
  never a bare `os.environ` read);
- a subscription sign-in only through
  `credentialed_provider_request(provider, …)` with `requires_auth`;
- or an explicitly supported `fetch_account_usage(..., read_only=True)`.

Anything that resolves a runtime key through
`hermes_cli.runtime_provider.resolve_runtime_provider`, reads
`agent.credential_pool`, reads `hermes_cli.auth.get_provider_auth_state`, or
imports `hermes_cli.nous_account` is outside those routes and is now absent from
`dashboard/plugin_api.py` (enforced by AC2).

## Parity surface contract (what the row must keep)

| Surface | Row fields the pane consumes (desktop/plugin.js) | Covered by |
| --- | --- | --- |
| Limit groups / windows | `limits[].id/label/allowed/limit_reached/windows[].label/used_percent/remaining_percent/reset_at/detail` | all provider tests |
| Money | `balances[].label/amount/currency/total/used/granted/topped_up` | OpenRouter, DeepSeek, Codex, Ollama, xAI, Moonshot |
| Subscription credits | window percent + `reset_at`, `allowance_usd/spent_usd/remaining_usd` | Ollama, Codex, xAI, Nous |
| Reset credits | `reset_credits.available/applicable` | Codex |
| Model access / spend control | `model_access[].model/available/available_at/credits_would_enable`, `spend_control.reached/individual_limit` | Codex |
| Key usage | `key_usage.total/daily/weekly/monthly/byok_total` | OpenRouter |
| Product split | `breakdown[].id/label/used_percent`, `breakdown_note`, `products[]` | xAI, OpenCode |
| Details / activity | `details[]`, `activity.range/requests/usd/*_tokens/hit_rate/buckets[]` | all providers, Ollama activity |
| Rates & derived | `pricing[]`, `peak`, `cache` (computed in `_overview_scoped`, not fetched per provider) | `RatesAndDerivedParityTests` |
| Inventory / profile | one row per configured or credentialed provider, `label/configured/supported/capability` | `InventoryParityTests`, `OverviewParityTests` |
| Definitions / trust / setup | `catalog.definitions[].state/trust/approval/credential_refs/missing_credentials/setup` | `CatalogTrustParityTests` |

Every adapter test finishes with `assert_ui_contract(row)`, which requires all
27 `_base` keys, JSON serializability, no credential field name, and the
synthetic key value absent from the row.

## Per-account `accounts[]` contract

The running-agents footer attaches a shared pool only when the cached row names
exactly one account identity equal to the child's published
`provider_account_id`. `/overview` now adds:

```json
"accounts": [
  {"identity_id": "fp:… | codex:<account>:<sub> | entry:<pool id>",
   "label": "…", "account_id": null, "credential_id": "…",
   "status": "ok", "available": true,
   "limits": [], "balances": [], "details": [], "plan": null,
   "source": "credits_api", "fetched_at": "…"}
]
```

Rules enforced by tests and code:

1. Identities come only from `list_account_usage_identities(provider)`, are
   deduped by `identity_id`, and are capped (`_ACCOUNT_USAGE_MAX_ACCOUNTS`).
2. One known account: the provider-wide row is reused only when its snapshot's
   verified `identity_id`/`account_id` matches that account; an unverified
   env/singleton row is never copied. If core supports an exact identity read,
   the entry gets it; otherwise (xAI, Nous credits) the entry stays unknown. The
   flat row `identity_id`/`account_label` is never stamped with an unproven
   account.
3. Two or more accounts: per-identity usage is read with the **exact**
   `fetch_account_usage(provider, read_only=True, identity_id=…)`. The
   provider-wide value is never copied onto an entry. The flat row keeps only
   the identity its own snapshot proved, never a guessed account.
4. A missing identity returns unknown and is negatively cached; it is never
   retried as a provider-wide read.
5. Per-account reads are TTL-cached (60 s), deduped per `(provider, identity,
   home scope)` with a per-key lock, capped at 32 entries, and at most four
   accounts per provider are enriched per overview. They run inside the
   overview's existing provider worker, so there is no second fan-out or polling
   storm.
6. Nous credits are account-global: a multi-account Nous row lists identities
   but never fetches per-identity usage. xAI is brokered at provider level, so it
   lists identities without per-identity reads.
7. The existing footer consumer already reads `identity_id`/`label` from
   `row.accounts[]`; no UI change was needed.

## How to run

```bash
cd /path/to/hermes-provider-usage-ext
export PYTHONPATH=/path/to/optional-hermes-checkout

# Parity baseline (normal suite; gated classes stay skipped)
python -m unittest discover -s tests -p "test_*.py" -q

# Migration acceptance, against the completed core checkout
HERMES_PU_ACCEPT_MIGRATION=1 python -m unittest discover -s tests \
    -p "test_credential_migration_parity.py" -q
```

The gated classes are opt-in so the normal suite stays runnable on a stock core;
with `HERMES_PU_ACCEPT_MIGRATION=1` they must run with **no skips**.

## Acceptance status (executed, exact)

- Parity baseline: **Ran 146 tests … OK (skipped=7)**.
- `HERMES_PU_ACCEPT_MIGRATION=1` migration acceptance: **Ran 56 tests … OK**
  (0 skips). This includes the fixture-installed plugin route against the real
  core helper (transport mocked only).
- `npm run check`: node logic/scope/render/lifecycle/running-agents suites PASS,
  Python tests OK, 3 bundled definitions VALID, `py_compile` clean.

## What changed in the plugin backend

- `_runtime()` deleted. No adapter resolves a runtime key.
- OpenRouter, DeepSeek, Ollama Cloud, OpenCode Zen/Go, Anthropic and Nous now call
  the public read-only snapshot route; their existing parsers run over
  `snapshot.raw`.
- `_serialize_snapshot` carries `identity_id`/`account_id`/`profile_scope` and a
  model `scope` on windows instead of dropping them.
- `_has_local_credentials` uses `provider_credential_summary`.
- `_attach_accounts` adds the `accounts[]` contract above. A sole pool account
  inherits the provider-wide row only when that snapshot's verified identity
  matches; otherwise the entry gets an exact identity read where core supports
  one (xAI/Nous stay unknown) and the flat row is never stamped with an
  unproven account.
- A core build without the read-only route becomes an explicit unavailable row.
  A stock core without the optional raw bodies falls back to the provider's own
  profile env key at its fixed official origin (or to the normalized snapshot);
  it never falls back to a raw OAuth token or credential store. See
  `docs/stock-support.md`.

## Remaining gaps / non-goals

- No Hermes release contained the required core commits at migration time; stock
  `0.23.1` now provides the read-only snapshot baseline, and the optional
  enhanced helpers are documented in `docs/stock-support.md`.
- xAI per-account usage is still provider-level (the broker route is
  provider-scoped); the footer correctly shows `—` for an ambiguous multi-account
  row.
- OpenCode Go's read-only path depends on core's profile hook + fallback; the
  plugin no longer has its own raw-token fallback.
- No UI edit, no install, no publish, no gateway restart, no live provider call.
  Every payload in the tests is synthetic; credentials are mocked and asserted
  absent from rows and errors.
- Core-side test counts are owned by the parent checkout; this document records
  only the plugin commands above.

## Test index

All in `tests/test_credential_migration_parity.py` unless noted.

| ID | Test |
| --- | --- |
| T1 | `CodexParityTests::test_raw_payload_keeps_every_codex_group` |
| T2 | `CodexParityTests::test_snapshot_without_raw_still_reports_windows_and_details` |
| T3 | `CodexParityTests::test_snapshot_only_build_keeps_normalized_windows` |
| T3b | `CodexParityTests::test_old_core_is_an_upgrade_row_not_a_typeerror` |
| T4 | `AnthropicParityTests::test_snapshot_keeps_model_scoped_windows_and_extra_usage` |
| T5 | `AnthropicParityTests::test_unavailable_snapshot_reason_is_preserved` |
| T6 | `OpenRouterParityTests::test_credits_key_quota_free_quota_and_key_usage` |
| T7 | `OpenRouterParityTests::test_credits_only_response_still_reports_a_balance` |
| T7b | `OpenRouterParityTests::test_core_snapshot_without_raw_keeps_normalized_snapshot` |
| T7c | `OpenRouterParityTests::test_old_core_without_the_seam_reports_upgrade_not_a_raw_fallback` |
| T8 | `DeepSeekParityTests::test_multi_currency_balances_keep_components_and_currency` |
| T9 | `DeepSeekParityTests::test_unavailable_account_keeps_the_reason` |
| T10 | `XaiParityTests::test_proxy_keeps_plan_period_prepaid_and_product_split` |
| T11 | `XaiParityTests::test_unreconciled_product_split_is_dropped_not_shown` |
| T12 | `XaiParityTests::test_grpc_fallback_keeps_window_and_pay_as_you_go_balance` |
| T13 | `OpenCodeGoParityTests::test_snapshot_windows_and_both_products` |
| T14 | `OpenCodeGoParityTests::test_raw_usage_body_keeps_rolling_label` |
| T15 | `OpenCodeZenParityTests::test_authenticated_models_route_reports_access_without_a_wallet` |
| T16 | `OllamaCloudParityTests::test_usage_windows_models_activity_and_totals` |
| T17 | `OllamaCloudParityTests::test_balance_adds_monthly_allowance_and_purchased_credits_first` |
| T18 | `NousParityTests::test_gauge_account_keeps_percent_details_plan_and_topup_link` |
| T19 | `NousParityTests::test_depleted_account_keeps_the_depleted_line` |
| T20 | `InventoryParityTests::test_config_and_env_only_providers_appear_with_labels_and_capability` |
| T21 | `InventoryParityTests::test_alias_and_unknown_providers_are_canonicalized` |
| T22 | `CatalogTrustParityTests::test_bundled_catalog_states_and_setup_metadata` |
| T23 | `CatalogTrustParityTests::test_profile_definition_needs_approval_and_reads_no_secret` |
| T24 | `CatalogTrustParityTests::test_definition_mapping_keeps_typed_window_balances_and_details` |
| T25 | `OverviewParityTests::test_overview_keeps_rows_errors_unsupported_and_catalog` |
| T26 | `CredentialHygieneTests::test_error_copy_never_echoes_urls_tokens_or_headers` |
| T27 | `CredentialHygieneTests::test_adapter_rows_never_include_the_runtime_key` |
| T28 | `RatesAndDerivedParityTests::test_peak_schedule_is_derived_from_published_spec_without_a_request` |
| T29 | `RatesAndDerivedParityTests::test_cache_stats_are_absent_without_a_ledger` |
| A1 | `AccountAttributionParityTests::test_single_account_reuses_the_provider_row_without_an_extra_read` |
| A2 | `AccountAttributionParityTests::test_multi_account_entries_get_only_their_own_usage` |
| A3 | `AccountAttributionParityTests::test_nous_is_never_fetched_per_identity` |
| A4 | `AccountAttributionParityTests::test_exact_identity_missing_never_falls_back_to_provider_usage` |
| A5 | `AccountAttributionParityTests::test_account_usage_cache_dedupes_expires_and_stays_bounded` |
| A6 | `InventoryParityTests::test_inventory_presence_comes_from_the_public_summary` |
| A7 | `InventoryParityTests::test_account_rows_dedupe_and_stay_bounded` |
| N1 | `CurrentNarrowingProbes::test_core_openrouter_snapshot_route_drops_money_and_key_detail` (rawless guard) |
| N2 | `CurrentNarrowingProbes::test_snapshot_serializer_preserves_account_identity_and_window_scope` |
| N3 | `CurrentNarrowingProbes::test_inventory_is_one_row_per_provider_while_overview_adds_accounts` |
| G1 | `LivingGuardTests::test_read_only_is_requested_wherever_core_supports_it` |
| G2 | `LivingGuardTests::test_manifest_declares_any_secret_name_the_code_reads` |
| AC1 | `MigrationAcceptanceTests::test_every_builtin_provider_parity_survives_without_a_raw_runtime_key` |
| AC2 | `MigrationAcceptanceTests::test_no_credential_store_or_private_auth_imports_remain` |
| AC3 | `MigrationAcceptanceTests::test_core_snapshot_route_preserves_openrouter_details` |
| AC4 | `MigrationAcceptanceTests::test_pool_only_accounts_surface_after_migration` |
| AC5 | `CoreSeamAcceptanceTests::test_every_supported_provider_has_a_sanctioned_public_route` |
| AC6 | `CoreSeamAcceptanceTests::test_core_builtin_fetchers_all_have_a_read_only_variant` |
| AC7 | `InstalledFixtureRouteTests::test_overview_accounts_use_the_installed_plugin_and_real_core` (fixture install + real core helpers) |
