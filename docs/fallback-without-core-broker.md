# Fallback plan if core does not take the broker change

The plugin is designed so that the core PR (NousResearch/hermes-agent#155148) is an
*upgrade*, not a dependency. Nothing below needs that PR to merge.

## Works today, no core change

- **API-key providers read directly**, using the key Hermes already stores for that
  provider, against the provider's own documented host: DeepSeek, OpenRouter, Ollama Cloud,
  OpenCode Go, and any declarative definition with a key (Moonshot ships in the catalog).
- **Declarative definitions** cover any provider with a fixed read-only HTTPS endpoint.
  A user-added definition is approval-gated: the plugin shows the destination and the
  credential *names*, never the values, and refuses to run until the local user approves
  that exact content.
- **Status, spend, reset and window data** for those providers render exactly as they do
  with the newer core.

## Does not work without it, and must not be faked

OAuth-subscription providers whose usage lives behind the sign-in: xAI / Grok today, and any
future provider of the same shape. The plugin never reads `auth.json` or a vendor token file.
Refresh tokens are single-use, so a second refresher can revoke the rotation chain and sign
the user out, and the "it works" version of that bug is indistinguishable from a support
nightmare.

What the user sees instead:

- the Grok card states that this Hermes build does not broker xAI sign-in, and links the
  provider dashboard;
- `GET /diagnostics` returns `core_broker: {available, providers, xai, reason}`, so the
  reason is inspectable instead of being a mystery tooltip;
- once a build ships the broker, the same card fills in with no plugin update.

## Compatibility mode for OAuth providers (the actual fallback)

On a build with no xAI broker route, the plugin can still read Grok usage through Hermes's
**own locked sign-in path** rather than a token file:

- it calls `resolve_xai_oauth_runtime_credentials()`, the same resolver inference uses, so the
  refresh happens under the store lock and cannot race or revoke the rotation chain;
- it sends to `cli-chat-proxy.grok.com`, `grok.com` or `api.x.ai` only, HTTPS, no redirects,
  no embedded credentials, and it refuses a caller-supplied `Authorization`, `Host` or
  `Content-Length`;
- the access token lives in one stack frame for the length of one request. It is never written,
  logged, cached or returned, and the frame's references are cleared before it unwinds;
- every failure becomes a message with the error's type name, never the token or the request.

It is **off by default** and enabled per profile with either:

```json
// $HERMES_HOME/provider-usage/settings.json
{"compat_oauth_reads": true}
```

or `HERMES_PROVIDER_USAGE_COMPAT_OAUTH=1`. While it is off, the Grok card states that this
build has no broker route and names the switch, instead of pretending the provider has no data.

The honest difference from the core broker: with compatibility mode the token exists inside
this process, which a code-owned broker avoids entirely. That is why it is opt-in and why the
PR is still worth merging.


## Coverage of the wider provider list

`docs/provider-account-endpoints.md` records the verified state of 27 providers: 14 publish a
documented account endpoint, and only 8 of those accept the inference credential the plugin
already holds. The rest need an admin or billing credential, which a plugin must never have,
so those cards say so and link the dashboard. That is the honest end state with or without
the core PR.
