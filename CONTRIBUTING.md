# Contributing

Thanks for helping make Provider Usage useful beyond one set of accounts. We are especially looking for work on additional providers, account-plan testing, accessibility, and UI polish.

## Good contributions

- Add a provider adapter with a documented account-level usage or balance source.
- Test an existing adapter against another plan or account type and add a sanitized fixture.
- Improve the status chip or pane while keeping it consistent with Hermes Desktop.
- Fix keyboard, focus, contrast, screen-reader, resizing, or overflow problems.
- Document a provider limitation so the interface can report it plainly.

Provider coverage should stay capability-driven. If a provider does not expose a balance, reset time, or plan name, report that field as unavailable. Do not infer a higher subscription tier from the size of a quota.

## Keep private data out of Git

Do not commit or paste any of the following into a pull request or issue:

- API keys, access tokens, refresh tokens, cookies, or authorization headers;
- `.env`, `auth.json`, `config.yaml`, or Hermes session data;
- raw account responses, request dumps, or debug logs;
- screenshots containing names, email addresses, balances, account IDs, or billing details;
- machine-local paths that reveal a username or private workspace.

Build fixtures by hand with obviously fake values. Review the staged diff before committing, even when `.gitignore` looks correct.

## Adapter rules

A provider adapter must keep authentication in the Python backend and return only normalized, non-secret data to the Desktop plugin. Preserve provider-reported currency and timestamps. Mark unofficial endpoints experimental, and include a clear unavailable or unauthenticated state.

Add fixture coverage for the funding behavior you introduce. Subscription allowances take priority; API or extra-usage balances are fallback unless the product is credit-only.

## Before opening a pull request

Run:

```bash
npm run check
bash scripts/validate.sh
git diff --check
```

Then inspect every staged file and confirm it contains no private account data. A clean test run does not replace that review.