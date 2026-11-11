# Running agents footer (provider usage popover)

Status: **design and verification record**. On stock Hermes 0.23.1 the gateway does not
publish the exact `provider_account_id` inventory, so a live footer can show the child's
provider but not a verified account; it renders an unknown account or no footer rather
than borrowing a number. Newer hosts that expose the optional identity helpers get exact
attribution automatically. Those helpers are not required to install Provider Usage.

A small, subordinate footer inside the existing bottom-left provider-usage chip
popover. It lists the delegated children **currently running in this chat**, and
— only when the backend publishes and the account inventory verifies them — the
provider/account they belong to and that account's **shared** remaining
percentage or credit balance.

Running children are a gateway fact, not a provider-usage fact: the footer is
offered in the popover's not-enabled and no-usage states too, and hides itself
when nothing is running.

It adds no provider adapter, no balance math, and no backend endpoint. The
renderer reads the gateway's public, session-scoped `subagent.list` RPC and
reuses the overview cache the popover already has.

## Data contract

| Piece | Source |
| --- | --- |
| Child identity | `subagent.list` (gateway JSON-RPC), params `{ session_id }` |
| Child fields used | `subagent_id`, `goal`, `model`, `status`, `depth`, `started_at`, `provider`, `provider_account_id` |
| Provider/account pool | the **already-fetched** `/overview` payload for this popover's profile + connection (`providerRows`) |
| Account identity on a pool row | `row.accounts[]` (`identity_id` or core `ProviderUsageAccount.id`) or a flat `row.identity_id` |
| Remaining % / balance | `compactFundingSummary(row, model)` over that cached row — the same helper the chip and popover use |

`subagent.list` is the only read that is scoped to one conversation **and**
owner-checked against the socket that commissioned the child
(`tui_gateway/methods_subagents.py`: `_current_session_steer_authority` +
`_visible_subagent_records` + `_subagent_transport_matches`). A wrong session, a
revoked/reconnected socket, or a transcript-only view returns `4001`; the footer
hides instead of guessing.

The core seam publishes:

- `provider` — the slug `child.provider` holds after the child's runtime
  resolved its route (never `requested_provider`, never the configured default).
  An init-time fallback rewrites `child.provider`; the heartbeat refreshes the
  live record, so a running footer converges on the provider actually serving
  the child. A completed child is removed and a late refresh is a no-op.
- `provider_account_id` — a stable **non-secret** account id from the credential
  the child is actually using: the same namespace as the account inventory
  (`agent.account_usage_cache._identity_id_for`, e.g. a decoded Codex principal
  or a token fingerprint). The token/key never rides the wire. `null` when no
  credential identity can be resolved.

Deliberately **not** used:

- `delegation.status` / `tools.delegate_tool_registry.list_active_subagents()` —
  process-wide and it strips `owner_session_id` from the copy, so it cannot be
  filtered to this chat. Using it would show another conversation's agents.
- `subagent.roster` — app-wide counts only, no identities.
- `session.stats` — exposes `active_subagents` as an integer count and the
  parent's model/provider, not per-child identity.
- `config.get` / the configured default provider — a configured default is not
  an account an agent actually used.
- A provider-qualified model slug (`openrouter/…`) as proof of the provider.
  A model namespace can be served through another gateway/account; it never
  verifies a pool.

## Attribution rules

1. **Scope.** One popover, one focused session, one gateway/profile/connection.
   The query key is `['provider-usage', 'running-agents', sourceId, sessionId]`,
   so two chats — or the same chat name on another connection — never share a
   snapshot. The footer is only enabled while the popover is open, the socket is
   ready (`gatewayReady`), a session id exists, and the focused chat is on the
   active source (`scope.source === 'active'`). `subagent.list` is owner-checked
   against the active socket; a chat whose backend is another profile/connection
   gets no footer rather than a foreign roster.
2. **Provider is published, never inferred.** A provider is claimed only from
   the row's `provider`. Without it the row renders **“provider not reported”**.
   A published provider that this profile's inventory does not know is still
   shown by its slug (it is the child's real route); it just cannot attach a
   pool.
3. **Account identity must match exactly.** Usage is attached only when the row
   publishes `provider_account_id` **and** the cached provider row names exactly
   one account identity equal to that id. A row with zero identities, multiple
   identities, or a different id is ambiguous: usage renders `—`. This is what
   prevents a worker on another credential from borrowing the popover's cached
   balance.
4. **Grouping.** Rows collapse on verified identity: same
   `provider + account (when published) + model`. Two credentials on one
   provider never merge into one group. Rows without a provider group by model
   only. Account labels appear beside the provider only when an identity
   matched; a worker whose account could not be matched is not labelled with
   someone else's account.
5. **Usage is the shared pool, never worker spend.** A verified group shows the
   matching account row's cached compact figure (`62% left`,
   `5h 62% · wk 84%`, `$8.72`). Nothing is divided, apportioned, or attributed
   per agent, and no per-agent cost is displayed.
6. **Unknown stays unknown.** No provider, no account identity, no matching
   cached row, or a matching row with no figures renders `—` (the plugin's
   existing unknown glyph), never `0%` and never a borrowed balance. A
   currency-less balance keeps the plugin's `5.31 (currency not reported)` form
   instead of inventing USD.
7. **Hide when none.** No live children, an empty payload, a `4001`/error, a
   closed popover, a reconnecting socket, or a foreign session-bound payload all
   render nothing — no “0 running”, no stale roster.

## Lifecycle

- **One read per refresh, never per agent.** A single `subagent.list` call
  returns the whole roster; the footer sets `refetchInterval: 5000` and
  `staleTime: 4000`, and only while the popover is mounted and open. A closed
  popover is silent (Radix unmounts the content; `enabled` is also false).
- **Completion** shows up on the next snapshot: the backend registry drops a
  finished child, so the row disappears on the following read. No
  `subagent.complete` subscription is required (and none is used), which avoids
  event-ordering/staleness bugs between the parent and child transports.
- **Session switch** changes the query key; the previous chat's rows are not
  shown while the new one loads, and a late reply for the old session is
  discarded (`normaliseRunningAgents` drops a payload whose `session_id` does
  not match the requested session).
- **No per-agent polling, no backend calls, no credentials.** The only network
  traffic is the one gateway RPC plus the overview request the popover already
  makes.

## Seam status and account-inventory contract

The core metadata + account-identity seam exists in an optional, isolated core checkout
(now proposed upstream; not installed here). It is **not required** and is **not
installed** in the live Hermes tree. The stock `0.23.1` backend publishes no
`provider`/`provider_account_id`, so a real footer still shows “provider not
reported” until a host release containing that optional seam is installed.

The plugin side is now wired. `/overview` adds, for providers with known
non-secret identities:

`accounts: [{ identity_id, label, account_id, credential_id, status,
available, ...normalized usage fields... }]`

Rules the backend enforces (see `docs/credential-migration-parity.md`):

1. `identity_id` is exactly what core's `_identity_id_for` produced, surfaced by
   `list_account_usage_identities(provider)`; no key/token/URL is serialized.
2. A single-account row reuses the provider-wide usage on that one entry only
   when the source snapshot's verified `identity_id`/`account_id` matches that
   account; otherwise it makes an exact `fetch_account_usage(...,
   identity_id=…)` read where supported and never stamps the flat row with an
   unproven account. xAI (brokered provider-wide) and Nous (account-global
   credits) leave the entry unknown. A multi-account row never reuses the
   provider-wide figure.
3. Multi-account entries are fetched separately with the exact
   `fetch_account_usage(provider, identity_id=…)`; a missing identity is `—`,
   never a provider-wide fallback. Reads are TTL-cached, deduped and bounded.
4. The footer still matches the child's `provider_account_id` only against the
   cached rows fetched for that same popover source. Ambiguous/absent identity
   shows `—`; no UI edit was needed because the consumer already reads
   `row.accounts[]`.

No further `agent/account_usage.py` change is needed for the identity contract:
`_identity_id_for` and `list_account_usage_identities` already expose the stable
id. The plugin backend now consumes it (`_attach_accounts`).

## Verification

All commands run from the repository root. Tiers are separate evidence:

- **Pure + SSR + mounted component (jsdom):**
  `node --experimental-vm-modules tests/running_agents_footer_test.mjs`
  Covers normalisation, terminal-status filtering, foreign-session rejection,
  provider publication (no slug inference), exact account match/mismatch,
  multi-account ambiguity, credential grouping, unknown/currency-unknown
  honesty, SSR markup, one-read-per-footer, session switch + late reply,
  completion, inactive/closed-socket/no-session, error and empty hiding. This is
  a controlled SDK double, not a live desktop.
- **Full repo gate:** `npm run check` (adds the suite to the existing chain).
- **Real browser, real SDK components:**
  `node harness/build.mjs && node harness/popover-verify.mjs --fixture running-agents --theme nous --mode dark`
  Opens the shipped chip, asserts `aria-haspopup/aria-expanded`, the popover,
  the `[data-running-agents]` section (count, row count, width inside the
  popover, 10.5px row type below the 13px provider title), and captures
  `harness/dist/shots/popover-running-agents_w760.png`.
  `--fixture compact-5h-wk` proves a fixture with no children renders **no**
  footer. The running-agents fixture is **synthetic fixture data**, not proof
  that a live backend publishes these fields.
- **Live desktop:** not run for this change (no install/restart was authorized). The live
  `subagent.list` contract was read from the installed Hermes source at
  `<hermes-install>/tui_gateway/methods_subagents.py`.

## Privacy / safety

- No credentials, tokens, goals, or child transcripts are sent anywhere; the
  footer reads only the roster payload and the cached usage rows. The core
  account id is a non-secret stable identity, never a key or token.
- Goals appear only in a hover tooltip, truncated to three, and are never
  persisted.
- No per-agent spend, no cost estimation, no invented balance.
