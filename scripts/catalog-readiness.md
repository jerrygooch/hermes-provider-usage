# Catalog admission readiness — Provider Usage

Local packaging only. No publication, commit, push, install, restart, or daily-Hermes
mutation was performed. This file and the new root `plugin.yaml` are the only files this
lane owns.

## Candidate and manifest

- Repository: `C:\Users\jerry\projects\hermes-provider-usage-ext`
- Source HEAD inspected: `b050424`
- Worktree is **moving**: `dashboard/plugin_api.py` (backend worker) and
  `desktop/plugin.js` (UI worker) have uncommitted edits. Validation below labels the
  clean pinned candidate separately from the live worktree.
- New root manifest: `plugin.yaml`

Manifest choices:

| Field | Value | Basis |
|---|---|---|
| `name` | `provider-usage` | Matches `dashboard/manifest.json` and the installed plugin id. |
| `version` | `0.10.0` | `package.json`, `package-lock.json`, `dashboard/manifest.json`, `README.md` (“Provider Usage 0.10”) and this manifest all agree on `0.10.0`. |
| `requires_hermes` | **omitted** | The backend now requires public core seams that no Hermes release contains yet (read-only provider snapshots + `list_account_usage_identities` + `provider_credential_summary`, plus the xAI broker). A released floor would be false; a made-up version would be dishonest. The exact dependency is recorded in the `plugin.yaml` comment; older hosts get an explicit upgrade-required row. |
| `capabilities` | `[]` | The plugin registers no agent tools, hooks, middleware, LLM override, or platform actions. The Desktop half uses only `ctx.register`, `ctx.rest`, and `host.*`; the dashboard half is an HTTP router, not an agent capability. |
| `optional_env` | `MOONSHOT_API_KEY`, `ELEVENLABS_API_KEY` | Only the two bundled declarative definitions that reference a user key. They are optional, so `requires_env` stays empty. The backend resolves them through `agent.secret_scope.get_secret`. |
| `requires_auth` | `openai-codex`, `xai-oauth` | Codex uses the read-only snapshot; xAI uses `credentialed_provider_request`. Both are subscription sign-ins the host resolves; the plugin never holds the token. |
| `oauth`, `python_dependencies`, `config_schema` | omitted | No third-party OAuth client; no non-core Python dependency; no plugin settings schema. |

## Validation

Command (no `--install-deps`, so the daily Hermes venv was not mutated):

```bash
hermes plugins validate <path> --json
```

### Clean pinned candidate — HEAD `b050424` plus `plugin.yaml`

A `git archive HEAD` tree plus the new `plugin.yaml` and `scripts/catalog-readiness.md`
was validated in scratch; ignored build output and the live worktree edits were excluded.

- Result: `ok: true`, exit `0`, all 13 checks pass.
- `security scan`: **safe**
- `no core override`: pass
- `desktop surface`: pass — stays inside the plugin SDK surface
- `loadable`: `desktop/plugin.js`
- `capability probe`: skipped (no `__init__.py`)
- Warnings: manifest-only probe skipped; private core imports listed below.
- Raw JSON: `C:\Users\jerry\AppData\Local\hermes\cache\scratch\provider-usage-validate-clean-final.json`

### Live worktree — moving candidate

- Result: `ok: true`, exit `0`; all checks pass.
- `security scan`: **caution** only because the ignored, untracked
  `harness/dist/app.js` (5.86 MB generated harness bundle) is present on disk. Findings
  are `ssh_dir_access` and `sudo_usage` in that bundle. The file is covered by
  `harness/.gitignore`, is absent from `git archive HEAD`, and does not exist at a pinned
  clone. Do not commit or package `harness/dist/`; the clean candidate scans `safe`.
- Same private-core-import warnings, with current-worktree line numbers.
- Raw JSON: `C:\Users\jerry\AppData\Local\hermes\cache\scratch\provider-usage-validate-current-final.json`

## Admission blockers

### 1. Rule 11 — direct credential-store and token handling — **RESOLVED in the current candidate**

The current backend no longer reads runtime keys, credential pools, provider auth
state, or private Nous modules. Every adapter uses one of the sanctioned public
routes: `fetch_account_usage(..., read_only=True)` (Codex, Anthropic, OpenRouter,
DeepSeek, Ollama, OpenCode Zen/Go, Nous), `credentialed_provider_request`
(xAI OAuth), or `get_secret` (declarative definitions). Inventory presence uses
`provider_credential_summary`; pooled IDs/labels use
`list_account_usage_identities`. The migration acceptance test patches the four
forbidden paths to raise and still proves every parity field (56 tests, 0 skips,
against core HEAD `a4c484eb5d`). See `docs/credential-migration-parity.md`.

The audit below is kept as the historical state at `b050424`; its file/line
references are not current.

At HEAD `b050424`:

- `dashboard/plugin_api.py:212-219` `_runtime()` calls the private
  `hermes_cli.runtime_provider.resolve_runtime_provider()` and returns the raw
  `api_key`.
- Direct bearer-token requests then send that key from plugin code:
  - `_fetch_openrouter` `:380-388`
  - `_fetch_deepseek` `:468-475`
  - `_fetch_opencode_go` fallback `:507-526`
  - `_fetch_opencode_zen` `:598-608`
  - `_fetch_xai` / `_fetch_xai_proxy` `:821-896`
  - `_fetch_ollama_cloud` `:1125-1139`
- `_credential_value()` `:1921-1949` reads `os.environ` for declarative definitions and
  reads `hermes_cli.auth.get_provider_auth_state()` (including a `tokens` fallback) for
  `hermes_provider` references. That is a direct credential-store read.
- `_has_local_credentials()` `:2694-2721` reads `agent.credential_pool.load_pool()`,
  `get_provider_auth_state()`, and the runtime `api_key` just to decide whether a provider
  is configured. Presence checks still touch the credential store rule 11 says a plugin
  must not read.
- No `credentialed_provider_request` call exists anywhere in the backend, so
  `requires_auth` is intentionally absent.

Current worktree (uncommitted, backend-owned):

- `_read_definition_secret()` `dashboard/plugin_api.py:2215-2240` now uses
  `agent.secret_scope.get_secret()` and explicitly refuses an `os.environ` fallback.
- `_credential_value()` `:2234-2240` now accepts only `source: env`; the definition schema
  rejects `hermes_provider` references at `:1503-1515`. This fixes the declarative path
  **when committed**, and makes the new `optional_env` entries truthful.
- `_runtime()` and every adapter above are unchanged; `_has_local_credentials()` is
  unchanged at `:3183-3221`. The rule 11 blocker therefore remains for the provider
  adapters and the inventory credential probe.

Action:

- Do not ship a catalog entry while the backend reads Hermes auth/credential stores,
  credential pools, or runtime keys directly.
- For Codex subscription usage, use the core account-usage snapshot or, if a request must
  be made, `credentialed_provider_request` with `requires_auth: [openai-codex]`. That
  helper is absent in `0.21.6` and present in `0.21.7`, so adopting it requires raising
  `requires_hermes` to at least `>=0.21.7`.
- For xAI OAuth usage, use a core snapshot if one exists; otherwise request a Hermes
  request seam. Do not send a runtime-resolved token from plugin code.
- For API-key providers (OpenRouter, DeepSeek, Ollama, declarative definitions), declare
  the key under `requires_env`/`optional_env` or `config_schema`, read it with
  `get_secret`, and send it only to that provider's HTTPS origin. Do not resolve a raw
  runtime key and send it yourself.
- Removing a working adapter is a product decision for the parent; this packaging lane
  only records the blocker.

### 2. Rule 9 — private core imports (review warnings, not validation failures)

`hermes plugins validate` reports these at HEAD; the current worktree has equivalent
sites. Reviewers read warnings even when the gate is green.

- `dashboard/plugin_api.py:213`, `:1942`, `:2715` —
  `hermes_cli.runtime_provider.resolve_runtime_provider`
- `dashboard/plugin_api.py:933` — `hermes_cli.nous_account.get_nous_portal_account_info`
- `dashboard/plugin_api.py:1931`, `:2702` — `hermes_cli.auth.get_provider_auth_state`
- `dashboard/plugin_api.py:2595`, `:3400` —
  `hermes_cli.web_server_profiles._config_profile_scope` (private leading underscore)
- `dashboard/plugin_api.py:3210` — `agent.usage_pricing._OFFICIAL_DOCS_PRICING` and
  `agent.usage_pricing.get_pricing_entry`

`fetch_account_usage` and the Nous credit snapshot are the approved usage-panel
delegation; replacing those is not requested. The private module imports around them,
the private profile-scope context manager, and the private pricing table are coupling
that can break on any Hermes release. Replace with documented plugin APIs where they
exist, or file a Hermes seam request; do not patch core.

### 3. Version metadata is consistent at `0.10.0` — resolved

- `package.json`: `0.10.0`
- `package-lock.json`: `0.10.0`
- `dashboard/manifest.json`: `0.10.0`
- `README.md`: “Provider Usage 0.10”
- new `plugin.yaml`: `0.10.0`

The catalog entry must quote the same `0.10.0` when the frozen SHA is pinned. Do not
introduce another value.

### 4. Candidate is still moving (process blocker)

Backend and UI workers are editing `dashboard/plugin_api.py` and `desktop/plugin.js`
(plus harness/tests). `plugin.yaml` is untracked; `scripts/catalog-readiness.md` is new.
Freeze both workers, commit the final tree, then re-run the clean-tree validation and pin
that exact 40-character SHA. The live-worktree pass above is evidence about a moving
tree, not an admission decision.

### 5. Catalog entry is not created (parent action)

No `plugin-catalog/provider-usage.yaml` was written; publication is not authorized. After
the freeze, the entry needs:

- `repo: https://github.com/jerrygooch/hermes-provider-usage` (matches `origin`)
- exact 40-hex `sha`
- `maintainer: jerrygooch`, `tier: community` unless Nous changes it
- `category: desktop`
- `version: "0.10.0"` (matches `package.json`, `dashboard/manifest.json`, and `plugin.yaml`)
- `requires_hermes`: omit it (no release contains the required seams); record the
  exact core commits in the manifest comment instead of inventing a floor.
- `capabilities: {provides_tools: [], provides_hooks: [], provides_middleware: [], requires_env: []}`
- UI screenshots and a rule 13 disclosure covering provider network calls and credential
  handling.

### 6. Manifest-only plugin (informational)

There is no `__init__.py`. The capability probe is skipped and the catalog accepts the
`desktop/plugin.js` entrypoint. If an agent-side Python entrypoint is added later, declare
its tools/hooks and re-run validation.

## Minimum gate before opening the catalog PR

1. ~~Resolve the rule 11 credential path~~ — done in the current candidate; every
   adapter now uses a public read-only snapshot, the xAI broker, or get_secret.
2. ~~Reconcile the version in `package.json`, `dashboard/manifest.json`, and `plugin.yaml`~~
   — done; all package, manifest, and plugin metadata is `0.10.0`.
3. Freeze the moving tree and commit `plugin.yaml` plus the backend/UI changes.
4. Re-run `hermes plugins validate <clean checkout> --json` on that commit; only then run
   `--install-deps` in an isolated environment, never the daily venv.
5. Add the catalog entry with the exact SHA and the capability block above.
