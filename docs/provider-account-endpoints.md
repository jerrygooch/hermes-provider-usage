# Provider account endpoints — verified research (2026-11-13)

What each provider actually documents. One row per provider, verified against the vendor's
own docs, not a blog or an SDK wrapper. The **key** column is the one that decides whether
Provider Usage can ship a reader at all: the plugin only ever holds the credential Hermes
resolves for inference, so an endpoint that wants an admin or billing credential can never
be called from the plugin, however well documented it is.

## Readable with the credential the plugin already has

| Provider | Registry id | Endpoint | Returns |
| --- | --- | --- | --- |
| Moonshot / Kimi | `kimi-coding` | `GET https://api.moonshot.ai/v1/users/me/balance` | `available_balance`, `voucher_balance`, `cash_balance` (USD) |
| DeepInfra | `deepinfra` | `GET https://api.deepinfra.com/payment/checklist` | `stripe_balance`, `scoped_credits[].remaining_cents`, suspension state |
| DeepInfra (spend) | `deepinfra` | `GET https://api.deepinfra.com/payment/usage?from=YYYY.MM` | `months[].total_cost`, `items[].cost` (cents) |
| Fireworks | `fireworks` | `GET https://api.fireworks.ai/v1/accounts/{id}/billing/summary` | `lineItems[].totalCost` (money), daily buckets |
| Novita | `novita` | `GET https://api.novita.ai/openapi/v1/billing/balance/detail` | `availableBalance`, `cashBalance`, `pendingCharges` (1/10000 USD) |
| Arcee AI | `arcee` | `GET https://api.arcee.ai/api/v1/usage/summary` | `total_tokens`, `total_requests`, `api_usage` (tokens, not dollars) |
| StepFun | `stepfun` | `GET https://api.stepfun.com/v1/accounts` | `balance`, `total_cash_balance`, `total_voucher_balance`; plan usage at `/step_plan/v1/usage` |
| Hugging Face | `huggingface` | `GET https://huggingface.co/api/organizations/{name}/billing/usage/inference` | `requestCount`, `costCents`, tokens per model/provider — needs a token with billing-read |

## Verified, but not callable from a plugin

Well documented, and each one wants a credential Hermes does not hold for that provider.
These are the honest "no data" cards; the vendor dashboard link is the useful thing to show.

| Provider | Endpoint | Credential it demands |
| --- | --- | --- |
| OpenAI API | `GET /v1/organization/costs` | Organisation Admin key (a project key is refused) |
| Anthropic | `GET /v1/organizations/analytics/cost` | Admin key (`sk-ant-admin…`) + `anthropic-beta: analytics-usage-cost-2026-08-24` |
| Google Vertex AI | `GET monitoring.googleapis.com/v3/projects/{id}/timeSeries` | OAuth token with `monitoring.read` (tokens, not dollars) |
| AWS Bedrock | `POST ce.{region}.amazonaws.com` (`GetCostAndUsage`) | AWS SigV4 + `ce:GetCostAndUsage` |
| Azure OpenAI / Foundry | `POST management.azure.com/.../Microsoft.CostManagement/query` | Entra token + Cost Management Reader |
| Alibaba DashScope | `GET modelstudio.cn-beijing.aliyuncs.com/tokenplan/subscription/stats` | RAM AccessKey, ACS3-HMAC-SHA256 signature |

Vercel AI Gateway documents `GET https://ai-gateway.vercel.sh/v1/credits` and works with the
gateway key, but it is not a Hermes registry provider, so the plugin cannot reach it through
the broker at all.

## No account API documented

A dashboard, a console page, or nothing. No guessed endpoints ship for these.

Gemini via AI Studio · Z.ai / GLM · MiniMax · Upstage Solar · Nebius Token Factory · Kilo Code ·
Meta Llama API · NVIDIA NIM · Tencent TokenHub · CommandCode · GMI Cloud · Ramp Router.

## Unclear

**Xiaomi MiMo** — the docs index served an SPA shell and the billing page timed out, so an
account endpoint could be neither confirmed nor ruled out. Left out of the catalog rather
than guessed.

## What this means for the plugin

Eight providers can get a real reader on the credential the plugin already holds. Six more are
permanently out of reach from inside a plugin and get a dashboard link. Nine have nothing to
read. That is the full, honest map — and it is why "fully support everything" is a UI and
documentation problem as much as a code one.
