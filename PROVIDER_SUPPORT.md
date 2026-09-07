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
| Nous Portal | Portal credit snapshot | Experimental | Availability depends on the installed Hermes version and the account capabilities exposed by its runtime. |
| Anthropic, Google, Azure, and local providers | Honest capability state | Planned | A provider is added only when there is a useful authenticated account-level source. Until then, the plugin reports the limitation instead of guessing. |

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

## Adapter requirements

A new provider adapter must:

- resolve credentials through Hermes runtime or authentication helpers;
- keep credentials and authorization headers in the Python backend;
- normalize responses before data reaches the Desktop renderer;
- preserve provider-reported currencies and timestamps;
- return clear unsupported, unauthenticated, unavailable, and error states;
- include fixtures for subscription-first or credit-only behavior;
- cite a documented source, or carry an experimental label when the endpoint is unofficial.
