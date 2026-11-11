# Stock Hermes compatibility

Provider Usage 0.10 runs on the **stock** Hermes 0.23.1 tree pinned at
`C:/Users/jerry/projects/provider-usage-stock-host` (`92790b119b`) with no core
patch, no private worktree and no required core commit. The manifest floor is
`requires_hermes: ">=0.23.1"`.

## Route matrix on stock 0.23.1

| Provider | Stock route | What remains | What is lost vs the enhanced path |
| --- | --- | --- | --- |
| OpenAI Codex | `agent.account_usage.fetch_account_usage("openai-codex", read_only=True)` + `snapshot.raw` | plan, 5-hour/weekly/Spark/code-review groups, credits, banked resets, model access, spend control | nothing observed |
| Anthropic | `fetch_account_usage("anthropic", read_only=True)` | four subscription windows including Opus/Sonnet weeks, extra usage, honest API-key reason | nothing observed |
| OpenRouter | stock snapshot (no `raw`) followed by the profile's `OPENROUTER_API_KEY` at `https://openrouter.ai/api/v1/{credits,key}` | credits total/used/remaining, key quota, free-model quota, daily/weekly/monthly/BYOK spend | core does not return the raw bodies, so the plugin reads the same two documented endpoints with the profile key |
| DeepSeek | `DEEPSEEK_API_KEY` at `https://api.deepseek.com/user/balance` | every currency row, granted/topped-up components, availability flag | stock has no DeepSeek core fetcher |
| Ollama Cloud | `OLLAMA_API_KEY` at `https://ollama.com/api/{usage,balance}` | session/weekly/monthly windows, per-model counts, activity totals/buckets, included allowance, purchased credits | stock has no Ollama core fetcher |
| OpenCode Zen | `OPENCODE_ZEN_API_KEY` at `https://opencode.ai/zen/v1/models` | authenticated-access proof and the explicit "wallet not exposed" statement | stock has no Zen core fetcher; no wallet figure exists on either path |
| OpenCode Go | stock `fetch_account_usage("opencode-go", read_only=True)`, which runs the bundled provider profile hook | rolling→5-hour, weekly, monthly windows; both product entries | the hook returns normalized windows without `raw`; the pane's existing normalized fallback is used |
| Nous | stock `agent.account_usage.build_nous_credits_snapshot` with its core-owned portal helper | plan, gauge percent, top-up/purchased/total details, renewal, depleted line | no `fetch_account_usage("nous")` entry exists on stock; the plugin calls the same core builder the stock CLI uses. This is a core-owned helper, not a plugin token read |
| xAI / Grok | no stock broker for `xai-oauth` | unavailable row with the official `https://grok.com/dashboard` link | subscription credits and product split are unavailable until the host brokers xAI sign-in; the plugin never reads a raw token |

Per-account `accounts[]` metadata, exact pooled-account attribution in the
running-agents footer, and `provider_credential_summary`-backed inventory are
absent on stock because `list_account_usage_identities` /
`provider_credential_summary` do not exist there. Those rows stay **unknown**
instead of borrowing one account's figures for another. They appear
automatically on a host that provides the helpers; no plugin setting changes.

Stock-only limitations, stated exactly:

- A **pool-only** API-key account for OpenRouter, DeepSeek, Ollama or Zen has no
  env key this plugin may read under rule 11, so its row stays unavailable on
  stock. A pooled account is never read through the credential store.
- An **OAuth-only** Anthropic sign-in cannot be proven without the non-secret
  summary helper; its connection card says the sign-in cannot be verified
  rather than claiming "not connected".
- xAI/Grok subscription credits are not readable until the host has the xAI
  broker; the row and official link are still shown.
- The footer cannot name an exact account when stock has no identity inventory;
  it shows the provider and an unknown account rather than guessing.
- The optional reset service targets the account Hermes currently resolves. It
  does not enumerate the credential pool and its pre-redeem identity/count
  re-check is point-in-time, not atomic. A pooled-account switch between that
  re-check and core's account-implicit redemption cannot be excluded, so a
  multi-account Redeem button is not safe.

## Credential rules kept on stock

- API-key reads use only `agent.secret_scope.get_secret(NAME)`; there is no
  `os.environ` fallback and no direct credential-pool or auth-store read.
- Direct requests go only to fixed official HTTPS origins, with
  `follow_redirects=False`; a redirect or a foreign host is refused.
- A direct env read says so on the row: it is never labelled as a pooled account.
- Subscription reads still go through core's read-only snapshot route (or the
  core Nous builder); the plugin never resolves or returns an OAuth token.
- Connection cards use the profile secret scope for presence when the host has
  no non-secret credential summary. OAuth-only providers that cannot be proven
  are shown as unverifiable, not "not connected".

## Verification

```bash
cd C:/Users/jerry/projects/hermes-provider-usage-ext

# stock 0.23.1
PYTHONPATH=C:/Users/jerry/projects/provider-usage-stock-host \
  python -m unittest discover -s tests -p "test_stock_compatibility.py" -q

# whole plugin suite on stock
PYTHONPATH=C:/Users/jerry/projects/provider-usage-stock-host npm run check

# enhanced seam worktree (optional helpers present)
PYTHONPATH=C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams \
  npm run check
HERMES_PU_ACCEPT_MIGRATION=1 \
PYTHONPATH=C:/Users/jerry/AppData/Local/hermes/worktrees/provider-usage-core-seams \
  python -m unittest discover -s tests -p "test_credential_migration_parity.py" -q
```

The stock acceptance test executes the real stock `fetch_account_usage` for
Codex, Anthropic, OpenRouter and the Go provider hook; only HTTP transport and
auth resolution are fixtures. It also checks the direct env fallbacks, the Nous
builder, the official-link xAI row, and that no account identity is invented.
