# Provider support

Provider Usage answers one practical question: **what shared account resource governs the next request from the focused Hermes model?** It does not divide provider usage between chats or pretend that each session has its own quota.

## Capability table

| Provider or route | What is reported | Status | Limits and caveats |
| --- | --- | --- | --- |
| OpenAI Codex | Subscription windows, reset times, access state, and extra-usage balance when returned | Tested | Normal Codex models use the shared account window. Spark's separate 5-hour and weekly windows are both shown. Account metadata such as banked resets, message estimates, overage state, and spend controls is included only when returned. |
| OpenCode Go | 5-hour, weekly, and monthly subscription usage | Tested | The status chip keeps the 5-hour and weekly meters visible without crowding adjacent status items. The pane retains the monthly meter and every reset time. Uses OpenCode's Go usage route and displays OpenCode's percentages directly rather than converting token counts. |
| OpenCode Zen | Authenticated API-credit product state | Limited | A request to `/zen/v1/models` verifies API access. OpenCode API keys do not expose Zen wallet balance or spend, so the pane says **balance unavailable**. It does not scrape a browser session. |
| DeepSeek | API balance | Tested | Currency is displayed exactly as DeepSeek returns it. CNY is never relabeled as USD. |
| OpenRouter | Remaining API credits | Tested | Uses the credential already configured in Hermes. |
| SuperGrok / xAI OAuth | Subscription quota and reset data | Experimental | Uses an undocumented Grok billing endpoint that may change. The response does not expose a trustworthy plan tier, so the plugin labels the product **SuperGrok** and does not infer a higher tier. |
| Ollama Cloud | Session, weekly, and monthly usage windows plus per-model request counts | Experimental | Uses an account usage endpoint that is community-known rather than officially documented, so responses may change. Plans differ: newer plans report monthly credit usage; older ones report 5-hour and weekly windows. Reset times appear only when the account reports them; otherwise they stay marked unavailable. |
| Nous Portal | Portal credit snapshot | Experimental | Availability depends on the installed Hermes version and the account capabilities exposed by its runtime. |
| Declarative JSON definitions | Any fixed read-only HTTPS usage or balance endpoint described by the bundled v1 schema | Tested | Data-only schema; no scripts or literal secrets. Profile-local files require a local, fingerprint-bound approval before any credential read or request. Public pinned peer only, no redirects, bounded response/deadline. GitHub rate limits ship without a credential; Moonshot and ElevenLabs are available-to-connect. |
| Claude / Anthropic | Always-listed connection card. Claude subscription windows when a Claude Code OAuth grant exists; Anthropic API usage/admin boundary otherwise | Schema/fixture-tested; subscription read is the existing core adapter; **not live-verified in this change** | Subscription usage uses the core read-only Claude Code OAuth snapshot. Anthropic API usage and cost reports are a separate product: they require an organization Admin API key (`sk-ant-admin…`) and the admin role, and individual accounts cannot use the Admin API. The card never shows a zero or estimates API spend. |
| Google Gemini API | Always-listed connection card with API-key setup, per-project rate-limit facts, and official dashboard links | Schema/fixture-tested; **no live account and no network adapter** | No supported account-balance or remaining-quota endpoint is documented for a Gemini API key. Google publishes usage in AI Studio and prepay balance in Billing. Google AI Pro/Ultra benefits apply in the AI Studio web UI only; direct API use is billed separately through Cloud Billing. The card never infers quota from rate-limit caps or a local ledger. |
| Z.ai / GLM | Always-listed connection card separating GLM Coding Plan subscription quota from standard pay-as-you-go API billing, including global/China endpoints | Schema/fixture-tested; **no live account and no core `zai` account-usage hook** | Coding Plan applies a 5-hour and a weekly limit across supported tools; Coding Plan keys do not consume standard API balance. Standard keys bill from balance or usage bundles and do not consume plan quota. Keys are product-specific; global is `api.z.ai`, China is `open.bigmodel.cn`. No remaining quota or credit is invented. |

## Always-listed popular-provider cards

Three built-in cards appear even when no credential exists. They are rendered
from code-owned metadata plus Hermes' non-secret `provider_credential_summary`;
they do not call a provider, read a credential value, or contribute a number to
the usage rows. The states are `connected`, `connected_no_usage`,
`not_connected`, `needs_permission`, `unavailable`, and `unverified`.

- **Claude / Anthropic** (`anthropic`)
  - Supported read: Claude subscription limits through the core read-only
    Claude Code OAuth snapshot (`5-hour`, weekly, and model-scoped windows when
    the account reports them).
  - Separate product: Anthropic API usage/cost reports through the Admin API.
    An Admin API key (`sk-ant-admin…`) plus the organization admin role is
    required, and individual accounts cannot use the Admin API. This plugin
    does not read or estimate API usage.
  - Docs: [Claude Code plans](https://support.anthropic.com/en/articles/11145838-using-claude-code-with-your-pro-or-max-plan),
    [Admin API](https://platform.claude.com/docs/en/manage-claude/admin-api),
    [Usage and Cost API](https://platform.claude.com/docs/en/manage-claude/usage-cost-api).
  - Verification: existing core adapter; card states/metadata are fixture-tested.
    No live account was used in this change.
- **Google Gemini API** (`gemini`)
  - Supported read: inference with a Gemini Developer API key. Rate limits are
    per project (RPM, TPM, RPD); every key belongs to a Google Cloud project.
  - No supported account balance/quota read: Google exposes usage in
    [AI Studio → Usage](https://aistudio.google.com/usage) and prepay balance in
    [Billing](https://aistudio.google.com/billing). This plugin does not infer a
    remaining amount from rate-limit caps or local token totals.
  - Subscription boundary: Google AI Pro/Ultra benefits apply in the AI Studio
    web UI only; direct Gemini API use is billed separately through Cloud
    Billing. See [Google AI plans](https://ai.google.dev/gemini-api/docs/google-ai-plans)
    and [Gemini API billing](https://ai.google.dev/gemini-api/docs/billing).
  - Docs: [API keys](https://ai.google.dev/gemini-api/docs/api-key),
    [rate limits](https://ai.google.dev/gemini-api/docs/rate-limits).
  - Verification: no live account and no network adapter; docs-verified limits,
    fixture-tested rendering.
- **Z.ai / GLM** (`zai`)
  - Supported read: inference through Hermes' `zai` provider. There is no core
    `zai` account-usage hook, so the card does not show quota or credits.
  - Product split: GLM Coding Plan is subscription quota (5-hour and weekly
    limits shared across supported tools). Standard API keys are pay-as-you-go
    and bill from account balance or usage bundles. Standard keys do not consume
    Coding Plan quota; Coding Plan keys do not consume API balance.
  - Endpoints: global `https://api.z.ai/api/paas/v4`; China
    `https://open.bigmodel.cn/api/paas/v4`. Coding Plan uses
    `/api/coding/paas/v4` (OpenAI) or `/api/anthropic`. Key type, not endpoint,
    determines billing. See [Coding Plan](https://docs.z.ai/devpack/overview),
    [API key management](https://docs.z.ai/devpack/notice/api-key-management),
    [quick start](https://docs.z.ai/devpack/quick-start), and
    [China platform](https://open.bigmodel.cn/dev/api).
  - Verification: no live account; product separation and endpoints are from
    official docs and Hermes provider routing; rendering is fixture-tested.

## OpenCode products

OpenCode is grouped into one pane section so it is easy to scan, but Go and Zen remain separate products.

- **OpenCode Go** is subscription-funded. It has its own credentials, `/zen/go/v1` base route, and subscription usage windows.
- **OpenCode Zen** is API-credit-funded. It uses `/zen/v1`. API authentication can be verified, but the Zen wallet amount is not available to an API key.
- **OpenCode Free** is a separate keyless access mode. It is not a Zen wallet and is not reported as one.

If Zen fallback is enabled in the OpenCode account, Zen credits may fund a request after a Go limit is reached. That account policy does not merge their balances or authentication.

## Selection rules

1. The focused session supplies the provider and model.
2. A governing subscription allowance takes priority over money or API credits.
3. Every applicable subscription window stays visible in the detailed pane.
4. The compact chip moves to paid fallback only when a governing subscription window is exhausted or the product is credit-only.
5. Provider-supplied currency, reset times, renewal data, and account metadata are preserved.
6. Missing values remain missing. The plugin does not invent renewal dates, prices, token counts, demand periods, history, or wallet balances.

OpenAI Codex limits are account-wide. Focusing a different session changes which meter is selected; it does not create a new quota.

## Declarative definitions

A fixed read-only HTTPS endpoint with a JSON body can be added without a Python adapter. The definition is versioned data (`hermes.provider-usage.definition/1`), loaded from the bundled catalog or `$HERMES_HOME/provider-usage/providers/*.json`. It maps dot paths into 5-hour, daily, weekly, monthly, rolling, or custom windows and into credit/currency balances.

The boundary is deliberately narrow:

- **Trust gate:** bundled definitions are code-owned. Every profile-local definition — including an `override` of a bundled id — stays **Requires approval** until `scripts/approve_definition.py` records its canonical definition SHA-256, endpoint, and structured credential references in `$HERMES_HOME/provider-usage/approvals.json`. No credential is read and no request is made before that. Editing the file changes the fingerprint and moves it to **Blocked** until re-approved. Nothing in a definition or the packager can self-approve.
- HTTPS GET, default port, exact host allow-list, no query string, no redirects.
- One bounded DNS resolution; every answer must be globally routable. The request connects to the vetted IP with TLS SNI and `Host` preserved, and rejects reserved, NAT64, and IPv4-mapped IPv6 answers.
- Credential *references* are environment variable names resolved only through `agent.secret_scope.get_secret`; there is no literal header value, no `os.environ` fallback, and `hermes_provider` references are deferred with an explicit validation error.
- Strict unknown-key rejection, 512 KiB response cap, 10-second read timeout, a 20-second wall-clock budget checked across DNS and streaming, and a 30–86,400 second cache keyed by the effective canonical Hermes home.
- Missing paths stay unavailable or unverified, never zero; omitted rows and unresolved currencies are reported explicitly (`UNKNOWN`, never assumed USD).

Definitions cannot express OAuth refresh, multi-step requests, writes, HTML scraping, or arbitrary code. Those still require a Python adapter.

### Approval trust boundary

Approval is a local consent record, not a sandbox. Code running as the same OS user can edit the definition and the approval manifest, and can read the profile's credentials directly. The gate prevents an unreviewed definition that arrives from a pack, update, or another tool from using profile secrets without a human seeing its destination and credential references. It does not protect against malicious same-user code or a compromised Hermes process.

### Built-in adapter credential routes (stock + enhanced)

Stock Hermes 0.23.1 is the supported baseline. Every built-in adapter reads
through a sanctioned public route; none reads a runtime key, credential store,
or private auth module.

- **Core read-only snapshots:** OpenAI Codex, Anthropic, OpenRouter and OpenCode
  Go call `agent.account_usage.fetch_account_usage(provider, read_only=True)`.
  Codex keeps the exact provider body on `snapshot.raw`. Nous uses the stock
  core `build_nous_credits_snapshot` builder when the host has no `fetch_account_usage`
  entry for it.
- **Stock API-key fallbacks:** DeepSeek, Ollama Cloud and OpenCode Zen have no
  stock core fetcher. The profile's own key is read only through
  `agent.secret_scope.get_secret` and sent only to that provider's fixed HTTPS
  origin. OpenRouter uses the same method only to recover the credits/key detail
  the stock snapshot omits. The row discloses the env read and never attributes
  it to a pool account. See `docs/stock-support.md`.
- **Always-listed connection cards:** Claude / Anthropic, Google Gemini API, and
  Z.ai / GLM use only code-owned metadata plus `provider_credential_summary(provider)`
  when present, otherwise the profile secret scope (presence only). No request,
  no balance, no quota, and no credential value is produced; Google and Z.ai have
  no account-usage adapter here.
- **Brokered subscription sign-in:** when the host brokers xAI OAuth, the plugin
  calls `credentialed_provider_request("xai-oauth", ...)` for both the credits
  proxy and the gRPC fallback; the token never enters plugin code. Stock does not
  broker xAI, so the row stays unavailable with the official account link.
- **Non-secret inventory:** on enhanced hosts `provider_credential_summary(provider)`
  decides presence, and `list_account_usage_identities(provider)` supplies pooled
  account ids/labels. Per-account usage is requested with the exact
  `fetch_account_usage(provider, identity_id=..., read_only=True)` id; a missing
  identity is unknown, never a provider-wide fallback.
- **Declarative definitions:** credential references resolve only through
  `agent.secret_scope.get_secret`.

An older build without `fetch_account_usage(read_only=True)` loads the plugin and
shows an explicit unavailable row; there is no raw-key fallback. Optional helpers
degrade one row and never disable the plugin. `plugin.yaml` floors at the
released `0.23.1` baseline.

The declarative path itself resolves credentials only through `agent.secret_scope.get_secret`; it never reads a credential from `os.environ`, `.env`, `auth.json`, vendor CLI credentials, or raw OAuth.

## Adapter requirements

A new provider adapter must:

- use the core read-only `agent.account_usage.fetch_account_usage(..., read_only=True)` snapshot when core supports the provider;
- otherwise use `credentialed_provider_request(..., requires_auth=...)`;
- never resolve a raw runtime key or read a credential store in plugin code;
- keep credentials and authorization headers in the Python backend and never return them to the renderer;
- normalize responses before data reaches the Desktop renderer;
- preserve provider-reported currencies and timestamps;
- return clear unsupported, unauthenticated, unavailable, and error states;
- include fixtures for subscription-first or credit-only behavior;
- cite a documented source, or carry an experimental label when the endpoint is unofficial.
