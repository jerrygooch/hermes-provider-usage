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

The provider page lists every definition, including ones that **require local
approval**, are **blocked** because their approval no longer matches, are
**available to connect** (a credential is missing), are **invalid** (with the
exact schema error), and connected rows. The directory is re-read on each
overview request, so adding or editing a file only needs a refresh, not a
backend restart. A new or edited file stays **Requires approval** until the
local user approves that exact content.

## Approval

Bundled catalog definitions are code-owned and ship trusted. Every
profile-local definition is untrusted by default, even when it sets
`"override": true` for a bundled id. Before the backend reads any credential or
makes any request it requires an approval record in
`$HERMES_HOME/provider-usage/approvals.json` — a separate file outside the
definitions directory — containing:

- the SHA-256 of the canonical definition content;
- the exact request endpoint;
- the structured credential references.

Create or refresh it with:

```bash
python scripts/approve_definition.py ~/.hermes/provider-usage/providers/my-api.json
```

The command prints the destination and every credential reference (names only),
reads no secret, and requires typing `approve`. `--revoke` removes the record.
The page never approves anything, the definition cannot approve itself, and the
packager neither includes nor creates an approval.

Editing any behavior-bearing part of the definition changes its digest and moves
it to **Blocked** until reviewed again. Deleting or corrupting `approvals.json`
also blocks profile-local definitions; bundled definitions are unaffected.

Approval is a **local-user consent boundary, not a sandbox**. Code running as the
same OS user can edit the definition and the approval file, and can read the
profile's credentials directly. The gate stops an unreviewed file that arrived
from a pack, update, or another tool from using profile secrets without a human
seeing the destination and references first. It does not defend against
malicious same-user code or a compromised Hermes process.

## Collision rules

- A definition id may not reuse a built-in provider id or alias (`openai-codex`,
  `openrouter`, `deepseek`, `xai-oauth`, `nous`, `anthropic`, `opencode-go`,
  `opencode-zen`, `ollama-cloud`, and their aliases).
- A profile definition whose id matches a bundled definition is rejected unless
  it sets `"override": true`. The catalog marks the replacement as overriding
  the bundled copy, and it still requires local approval.
- Two profile files with the same id: the first in filename order wins; the
  later file is reported as invalid. Fix or remove the duplicate.

## Setup for an agent or a person

1. Copy the template and choose a unique lowercase slug for `id`.
2. Set `request.url` to the documented HTTPS endpoint. `request.hosts` must
   contain exactly that host. Only the default HTTPS port is allowed.
3. List credentials as `{"source": "env", "name": "MOONSHOT_API_KEY"}`. The
   backend resolves the name only through `agent.secret_scope.get_secret`; it
   never calls `os.environ` itself and never reads `.env`, `auth.json`, or vendor
   CLI credentials directly. `{"source": "hermes_provider", ...}` is not supported
   in schema v1 and is rejected with an explicit error; reusing a provider
   credential needs a code-owned adapter.
   The header value is built from the reference plus the optional `prefix`
   (for example `"Bearer "`). There are no literal header values.
4. Map paths such as `data.available_balance` into windows or balances. Paths
   are dot-separated object keys and numeric array indexes; there is no
   expression language.
5. Validate, then approve before restarting or refreshing:

   ```bash
   python scripts/validate_definition.py ~/.hermes/provider-usage/providers/my-api.json
   python scripts/approve_definition.py ~/.hermes/provider-usage/providers/my-api.json
   ```

   The same schema is exposed at
   `POST /api/plugins/jg-provider-usage/definitions/validate` with
   `{"definition": {...}}`; it returns `ok`, `errors`, `warnings`, and a
   summary without making a network request or approval.
6. Refresh the Provider Usage page. States are `connected`, `ready` (bundled,
   no credential needed), `available` (catalog: missing credential),
   `not_connected` (row: missing credential), `requires_approval`, `blocked`,
   `invalid`, `needs_permission`, `unverified`, `stale`, and `unavailable`.
   A missing credential never becomes a fabricated 0.

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
or `unix_ms`. `rolling` defaults to `true` only when `kind` is `rolling`; a
daily, weekly, monthly, five-hour, or custom window is not silently treated as
rolling. Money and credit units require an explicit `currency`. A percentage is
computed from `used`/`limit` or `remaining`/`limit` when the API does not
publish one. Missing values stay `null`; the UI shows **Unavailable** rather
than 0. If a `windows_from` or balance entry cannot be mapped, it is omitted
from the row and a warning such as `1 of 2 mapped windows had no usable values`
is added to the details. A currency expression that resolves to nothing is
reported as `UNKNOWN`, never assumed to be USD.

`cache_ttl_seconds` is 30–86400 (default 300). Responses are capped at 512 KiB,
with a 10-second per-read timeout and a 20-second wall-clock budget checked
across DNS and streaming. A successful response is cached in-process, keyed by
the effective canonical Hermes home; a later failure can show the last good row
as **Stale data** with the error attached. Cached rows carry `definition_id`,
`definition_version`, endpoint host, fetch time, cache state, TTL, and home
scope. The cache is never shared across Hermes homes or profiles.

## Security boundaries

- HTTPS only, default port only, exact host allow-list, no userinfo, no query
  strings, no redirects.
- **Pinned public peer.** The backend resolves the hostname once under a
  3-second bound and requires every answer to be globally routable; loopback,
  private, link-local, reserved, multicast, NAT64, and IPv4-mapped answers are
  refused before the request. It then connects to that vetted IP while keeping
  TLS SNI and the `Host` header set to the definition hostname for certificate
  verification and virtual hosting. A second DNS answer cannot redirect the
  connection. This is still not a substitute for running Hermes on a trusted
  host or for a hardened network egress policy.
- No literal credentials or arbitrary header values in a definition. Only
  `Authorization`-style header slots built from a credential reference plus a
  prefix. Names are resolved only through `agent.secret_scope.get_secret`;
  there is no process-environment fallback.
- Data-only dot paths, no `eval`, no template language, no shell.
- Response size and count limits; strict unknown-key rejection with per-file
  error containment, so one malformed port, deeply nested JSON file, or
  recursion failure cannot take down the catalog.
- The renderer receives normalized numbers, labels, states, and provenance. It
  never receives keys, tokens, or raw provider bodies.

## Contributing a definition

Do not publish automatically. To prepare a portable, sanitized package locally:

```bash
python scripts/package-definition.py ~/.hermes/provider-usage/providers/my-api.json
```

The script validates the definition, rejects secret-looking values and local
paths, writes `dist/contributions/<id>/` with a canonical `definition.json`,
a short README, and hashes. It refuses approval manifests as input, removes a
stale approval artifact from a reused output directory, and never creates or
includes an approval. Packaging is not approval: the receiving user must approve
the definition locally. Review the output and open a pull request manually; no
GitHub publication or network call is performed by the script.
