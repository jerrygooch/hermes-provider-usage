# Catalog admission readiness — Provider Usage

Local packaging notes for the public release. No publication, commit, push, install, or
restart was performed by this lane.

## Candidate and manifest

- Repository: this checkout (`hermes-provider-usage-ext`)
- Source HEAD inspected: `fd895ea` (`fix(reset): require verified readback and exact identities`)
- Version: `0.10.0`
- Manifest: root `plugin.yaml`
- Hermes floor: `requires_hermes: ">=0.23.1"` — the released stock baseline. No unmerged
  core patch or private worktree is required to install or load the plugin.

| Field | Value | Basis |
|---|---|---|
| `name` | `provider-usage` | Matches `dashboard/manifest.json` and the installed plugin id. |
| `version` | `0.10.0` | `package.json`, `package-lock.json`, `dashboard/manifest.json`, `plugin.yaml`, and the README all agree. |
| `requires_hermes` | `>=0.23.1` | Stock 0.23.1 provides the required read-only account-usage route. Optional identity/summary/broker helpers degrade one row when absent. |
| `requires_auth` | `openai-codex`, `xai-oauth` | Codex uses the read-only snapshot; xAI is used only when the host brokers the sign-in. Stock does not broker xAI, so that row stays link-only. |
| `capabilities` | `[]` | No agent tools, hooks, middleware, LLM override, or platform actions. The Desktop half uses only `ctx.register`, `ctx.rest`, and host SDK surfaces; the backend is an HTTP router. |
| `optional_env` | provider API keys plus `MOONSHOT_API_KEY`, `ELEVENLABS_API_KEY` | Optional; resolved only through `agent.secret_scope.get_secret`. `requires_env` stays empty. |
| `oauth`, `python_dependencies`, `config_schema` | omitted | No third-party OAuth client, no non-core Python dependency, no plugin settings schema. |

## Validation

Command, run at the current worktree:

```bash
hermes plugins validate <repo-root> --json
```

Result: **`ok: true`, exit `0`**; all checks pass.

- `manifest`: `plugin.yaml` parses; `requires_hermes` spec parses.
- `manifest fields`: name, version, description present.
- `security scan`: **caution** only because the ignored, untracked `harness/dist/app.js`
  (generated harness bundle) is present on disk. Findings are `ssh_dir_access` and
  `sudo_usage` in that generated bundle. `harness/dist/` is ignored, is absent from a
  clean checkout or `git archive`, and must not be committed or packaged. A clean
  candidate scans `safe`.
- `no core override`: pass.
- `desktop surface`: pass, inside the plugin SDK surface.
- `loadable`: `desktop/plugin.js`.
- `capability probe`: skipped (manifest-only plugin; no `__init__.py`).
- `python dependencies`: none declared.

### Remaining advisory warnings (not validation failures)

`hermes plugins validate` reports private core imports. These are coupling risks that can
break on a future Hermes release; they are not install blockers and are not a reason to
patch core:

- `dashboard/plugin_api.py:3935`, `:5119`: `hermes_cli.web_server_profiles._config_profile_scope`
- `dashboard/plugin_api.py:4742`: `agent.usage_pricing._OFFICIAL_DOCS_PRICING` and
  `agent.usage_pricing.get_pricing_entry`
- `dashboard/reset_service.py:223`: `hermes_cli.web_server_profiles._config_profile_scope`
- `dashboard/reset_service.py:247`, `:283`: `hermes_cli.web_server_profiles._is_other_profile`

Replace these with documented plugin APIs where they exist, or open a Hermes seam request.
Do not vendor or patch core to hide the warning.

## Admission state

- Credential handling is on sanctioned public routes: `fetch_account_usage(...,
  read_only=True)` for Codex and Anthropic, plus OpenRouter and the provider-profile
  OpenCode Go hook; `credentialed_provider_request("xai-oauth", ...)` only when the host
  brokers it; `agent.secret_scope.get_secret` for API-key and declarative paths. No
  runtime token, credential pool, or auth store is read by plugin code.
- The focused release suite passes (parent verification: 56 focused tests, 0 failures).
  The full repository gate `npm run check` passes in this worktree: **208 tests, 11
  skipped, 0 failures**, plus the Node suites and bundled-definition validation. Live
  provider accounts were not exercised for the Claude, Gemini, or Z.ai cards.
- The catalog entry is **not created**. Publication is owned by the parent release
  process and needs an explicit exact 40-character SHA (`fd895ea` plus any final commit),
  `repo: https://github.com/jerrygooch/hermes-provider-usage`, `maintainer: jerrygooch`,
  `category: desktop`, `version: "0.10.0"`, and `requires_hermes: ">=0.23.1"`. Include the
  UI screenshots and the provider-network/credential disclosure required by the catalog.
- Optional core PR 153742 is unrelated to installation and is not an entry dependency.
  The catalog must not require it.

## Before the catalog PR

1. Freeze the final tree and pin the exact 40-hex SHA.
2. Re-run `hermes plugins validate <clean checkout> --json`; confirm `ok: true` and that
   the only caution is absent when `harness/dist/` is excluded.
3. Do not run `--install-deps` in the daily Hermes venv; there are no Python dependencies
   to install.
4. Open the catalog entry and PR manually. Nothing in this repository publishes itself.
