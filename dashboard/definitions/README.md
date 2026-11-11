# Declarative provider definitions

Provider Usage can read a simple, read-only usage or balance API from a JSON
definition. This is for endpoints that return account data with a fixed HTTPS
GET and need no custom code. Complex protocols, OAuth refresh, gRPC, and HTML
scraping still belong in a Python adapter.

The definition is **data only**. It has no scripts, expressions, templates, or
`eval`. Credentials are references resolved inside the Hermes backend; a
definition never contains a literal key or token.

## Where definitions live

- Bundled: `dashboard/definitions/catalog/*.json` (shipped with the plugin).
- Profile-local: `$HERMES_HOME/provider-usage/providers/*.json` (for
  `default`, `~/.hermes/provider-usage/providers/`; for a named profile,
  `~/.hermes/profiles/<name>/provider-usage/providers/`).
- Template: `dashboard/definitions/TEMPLATE.json`.

The provider page lists every definition, including ones that are **available
to connect** (a credential is missing), **invalid** (with the exact schema
error), and connected rows. The directory is re-read on each overview request,
so adding or editing a file only needs a refresh, not a backend restart.

## Collision rules

- A definition id may not reuse a built-in provider id or alias (`openai-codex`,
  `openrouter`, `deepseek`, `xai-oauth`, `nous`, `anthropic`, `opencode-go`,
  `opencode-zen`, `ollama-cloud`, and their aliases).
- A profile definition whose id matches a bundled definition is rejected unless
  it sets `"override": true`. The catalog marks the replacement as overriding
  the bundled copy.
- Two profile files with the same id: the first in filename order wins; the
  later file is reported as invalid. Fix or remove the duplicate.

## Setup for an agent or a person

1. Copy the template and choose a unique lowercase slug for `id`.
2. Set `request.url` to the documented HTTPS endpoint. `request.hosts` must
   contain exactly that host. Only the default HTTPS port is allowed.
3. List credentials as references:
   - `{"source": "env", "name": "MOONSHOT_API_KEY"}` for an environment
     variable (Hermes loads the active profile's `.env`).
   - `{"source": "hermes_provider", "provider": "moonshot", "field": "api_key"}`
     to reuse an existing Hermes credential. The backend resolves it; the key
     never crosses the REST boundary.
   The header value is built from the reference plus the optional `prefix`
   (for example `"Bearer "`). There are no literal header values.
4. Map paths such as `data.available_balance` into windows or balances. Paths
   are dot-separated object keys and numeric array indexes; there is no
   expression language.
5. Validate before restarting or refreshing:

   ```bash
   python scripts/validate_definition.py ~/.hermes/provider-usage/providers/my-api.json
   ```

   The same schema is exposed at
   `POST /api/plugins/provider-usage/definitions/validate` with
   `{"definition": {...}}`; it returns `ok`, `errors`, `warnings`, and a
   summary without making a network request.
6. Refresh the Provider Usage page. A missing credential shows **Available to
   connect** with the environment variable name; a rejected request shows
   **Permission needed** or **Unavailable**; a response whose paths match
   nothing shows **Unverified mapping**, never a fabricated 0.

## Schema v1 reference

Top-level keys: `schema`, `id`, `name`, `description`, `version`, `docs_url`,
`scope_note`, `stability`, `override`, `author`, `license`, `request`,
`cache_ttl_seconds`, `mapping`. Unknown keys are errors.

`request`: `url` (HTTPS, no query/fragment), `method` (`GET` only), `hosts`
(exact allow-list, max 4), `headers` (max 6 credential references). Redirects
are refused, so an Authorization header cannot be forwarded to another host.

`mapping`:
- `title`, `scope_note`: static text.
- `plan`: a string or `{ "path": "..." }`.
- `windows`: up to 12 fixed window specs.
- `windows_from`: `{ "path": "data.windows", "label": {"path": "name"}, ... }`
  for an array of window objects (max 50 shown).
- `balances`: up to 10 `{label, amount, currency, unit, kind, detail}` specs.
- `details`: up to 20 static or path-derived strings.

A window supports `label`, `kind` (`five_hour`, `daily`, `weekly`, `monthly`,
`rolling`, `custom`), `rolling`, `period_seconds`, `unit` (`percent`,
`requests`, `tokens`, `characters`, `usd`, `credits`, `custom`), `currency`,
`limit`, `used`, `remaining`, `used_percent`, `remaining_percent`, `reset_at`,
and `detail`. Values are JSON paths; `reset_at` accepts `format` `iso`, `unix`,
or `unix_ms`. A percentage is computed from `used`/`limit` or
`remaining`/`limit` when the API does not publish one. Missing values stay
`null`; the UI shows **Unavailable** rather than 0.

`cache_ttl_seconds` is 30–86400 (default 300). Responses are capped at 512 KiB
and a 10-second timeout. A successful response is cached in-process; a later
failure can show the last good row as **Stale data** with the error attached.
Cached rows carry `definition_id`, `definition_version`, endpoint host, fetch
time, cache state, TTL, and profile scope.

## Security boundaries

- HTTPS only, default port only, exact host allow-list, no userinfo, no query
  strings, no redirects.
- Public DNS only. Every resolved address must be globally routable; loopback,
  link-local, private, reserved, and multicast answers are refused before the
  request (a deliberate SSRF guard). DNS rebinding is reduced by resolving at
  request time; this is not a substitute for running Hermes on a trusted host.
- No literal credentials or arbitrary header values in a definition. Only
  `Authorization`-style header slots built from a credential reference plus a
  prefix.
- Data-only dot paths, no `eval`, no template language, no shell.
- Response size and count limits; strict unknown-key rejection; actionable
  validation errors.
- The renderer receives normalized numbers, labels, states, and provenance. It
  never receives keys, tokens, or raw provider bodies.

## Contributing a definition

Do not publish automatically. To prepare a portable, sanitized package locally:

```bash
python scripts/package-definition.py ~/.hermes/provider-usage/providers/my-api.json
```

The script validates the definition, rejects secret-looking values and local
paths, writes `dist/contributions/<id>/` with a canonical `definition.json`,
a short README, and hashes. Review the output and open a pull request manually;
no GitHub publication or network call is performed by the script.
