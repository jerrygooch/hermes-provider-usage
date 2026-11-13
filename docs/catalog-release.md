# Publishing a release to the Hermes catalogue

The catalogue pins a **full 40-character commit SHA**. Branches, tags and short SHAs
are rejected by the loader, and a listed plugin may not update itself — so every
release reaches users through a pin-bump pull request against
`NousResearch/hermes-agent`. That is the trust model, not an inconvenience to route
around: reviewers read the commit range being adopted.

Related catalogue rules that shape this checklist: capabilities must match what the
plugin registers at the pin, `hermes plugins validate` runs the admission scan, and
self-updating code (`check for updates`, signed downloaders, remote `plugin.js`
loaders) disqualifies an entry.

## Checklist

1. **Bump the version in all four places.** `package.json`, `dashboard/manifest.json`,
   `plugin.yaml`, and `_PLUGIN_VERSION` in `dashboard/plugin_api.py`. They are asserted
   against each other by the test suite, so a missed one fails rather than drifting.
2. **Run the suite.** `node --check desktop/plugin.js`, the five Node suites under
   `tests/` with `--experimental-vm-modules`, and `python -m unittest discover -s tests`.
3. **Validate the pin.** `hermes plugins validate <plugin dir>` from a Hermes install.
   It must print `Validation passed.` Read the warnings — private-core-import findings
   and scan caveats are disclosed in the PR body, not waved through.
4. **Push `main`.** The catalogue clones the repo at the pin, so the commit must exist
   on the remote before the pin moves.
5. **Move the pin locally:**
   ```bash
   python scripts/bump_catalog.py --catalog-dir <hermes-agent>/plugin-catalog --write
   ```
   Dry-run first without `--write`; it prints the old/new SHA and the compare URL. It
   rewrites `sha`, `version`, and every `raw.githubusercontent.com/<repo>/<sha>/...`
   URL so the screenshots do not point at a commit the entry no longer pins.
6. **Refresh the description** when user-visible behaviour changed. Undocumented new
   readers, new disclosure obligations, and changed defaults belong in the entry text;
   reviewers should not have to diff the plugin to find them.
7. **Open the pin-bump PR** against `NousResearch/hermes-agent` (`base: main`), titled
   `catalog: bump jg-provider-usage to <version>`. In the body: the compare link, what
   users gain from the range, the validation result, and any warnings with the reason
   they are acceptable.
8. **After merge**, `hermes plugins update jg-provider-usage` picks the new pin up on
   any install. Nothing self-updates.

## If PR creation is refused

GitHub has returned this for this account's API calls against
`NousResearch/hermes-agent`:

```
GraphQL: jerrygooch does not have the correct permissions to execute `CreatePullRequest`
```

A self-PR against this account's own fork succeeds, so it is a base-repository
restriction rather than a broken token. Workaround: open the compare URL printed by
`bump_catalog.py` in a signed-in browser and press **Create pull request**. Retry the
API path later; do not work around it by pushing to a branch on the upstream repo.
