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

## What would count as a secure fallback for Grok

Only these:

1. **Core broker** (the PR). Credential resolved by core, request made by core, token never
   in plugin memory.
2. **A user-run export**: the user produces a usage file with the vendor's own CLI, and points
   the plugin at the file. The plugin reads data, not credentials. Not shipped because it
   needs a stable vendor command and user setup to be worth the support cost.
3. **The vendor dashboard link**, which is what the card shows today.

Rejected on purpose: reading token files, scraping HTML with a session cookie, proxying
through a local helper that holds the grant, or shipping an endpoint that a blog mentioned
but the vendor does not document. Each one moves the secret back into plugin code and turns a
blank card into a silent security regression.

## Coverage of the wider provider list

`docs/provider-account-endpoints.md` records the verified state of 27 providers: 14 publish a
documented account endpoint, and only 8 of those accept the inference credential the plugin
already holds. The rest need an admin or billing credential, which a plugin must never have,
so those cards say so and link the dashboard. That is the honest end state with or without
the core PR.
