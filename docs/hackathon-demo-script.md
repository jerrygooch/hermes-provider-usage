# Provider Usage — finished under-90-second demo

**Deliverable:** [demo-full.mp4](../assets/hackathon/demo-full.mp4) — **83.2 s**, **1920×1080**, H.264 / yuv420p, 30 fps, silent, 4.45 MB.
**Poster:** [demo-full-poster.png](../assets/hackathon/demo-full-poster.png) (frame at 8 s).
**Provenance + assertion log:** `harness/dist/hackathon/demo-full.record.json`.

Recorded on port **8961**, distinct from the still-capture ports 8951/8952.

This is the submission demo. The older `assets/hackathon/demo.mp4` is a 5.9 s
teaser only; it is not the 86-second script.

## What the video is

A screen recording of the **real shipped plugin** (`desktop/plugin.js`) rendered
with the **real Hermes SDK UI primitives** and the built-in `nous` dark theme in
the browser component harness. Every beat is a real DOM click, mouse-wheel
scroll, or `scrollIntoView`, followed by a state assertion. The visible badge
**“Real plugin components · sample data”** stays on screen; the end card repeats
the disclosure.

Every value comes from a synthetic fixture. No live account, credential, email,
workspace name, balance, reset date, or local path from a user profile appears.

### Beats

1. **Status-bar chip** — Codex, weekly 84% left, resting state.
2. **Click the chip** — popover opens with 5-hour 62% left, Weekly 84% left,
   reset times, the sample paid-fallback balance, and activity.
3. **Wheel-scroll the popover** — running-agents footer: 3 agents, `2× Codex`
   and an anonymous `qwen3-coder` child. Because this fixture has no account
   identity inventory (stock behaviour), every pool value is an **em dash**.
   It never borrows another account’s balance.
4. **Click View all providers** — the chip/popover dismiss and the full page
   opens on the active Codex card.
5. **Click Expand DeepSeek** — real disclosure expands to its own balance and
   reset detail. The row is `aria-expanded="true"` at capture time.
6. **Manage account link** — highlighted with a ring and hovered, **not
   clicked**. DeepSeek Billing is a real official HTTPS URL; no login page is
   opened, no external request is made.
7. **Popular providers** — Claude / Anthropic, Google Gemini API, and Z.ai /
   GLM are each scrolled into frame and ringed. The cards state “No balance or
   quota is inferred.”
8. **Provider definitions** — real catalog states on screen: **Approval
   required**, **Blocked**, **Unverified mapping**.
9. **Banked reset, read-only** — the reset scene opens with **all Codex
   windows at 0% left** (an enabled preview beside healthy meters would be
   impossible). Click **Check reset credits** → summary for the sample Codex
   account: 2 banked, 1 usable now.
10. **Preview reset** — click **Preview reset** → confirmation names the account
    and the spend. The video **stops here**. The final **Confirm reset** button
    is visible and was never clicked.
11. **End card** — real components, sample data only, nothing spent.

## Honesty rails (verified, not narrated)

- The harness `ctx.rest` is counted. `/reset/summary` and `/reset/preview` were
  called; **`/reset/confirm` was called zero times**. No reset, credit, or
  purchase was made. The confirmation payload is a fixture returned by the
  intercepted REST door; there is no live mutation path in the harness.
- All external HTTP(S) requests are blocked by the browser context and counted.
  **0 external requests**, **0 popups**, and only two local harness pages (healthy
  flow, then exhausted-reset scene); no external site is visited.
- Manage-account links are only hovered/outlined. The recording never visits a
  real sign-in page.
- The reset beat is a dedicated harness page with the same synthetic overview
  and every Codex window forced to **0% left**. It is a cut, not a live
  mutation; the earlier beats keep the healthy 62%/84% sample windows. This is
  why the preview is never shown beside a healthy meter.
- No `accounts[]` identity metadata is used. The footer deliberately renders
  unknown (`—`) for every child, matching a stock host without
  `list_account_usage_identities`.
- `demo-full.mp4` carries the source hashes in its container comment:
  plugin `9cc969ee…a158e0e`, harness bundle `7ecc3017…b613ef`.

## Rerender

The video is generated from the current build. If the plugin or bundle changes,
the recorded file is stale by definition.

```bash
cd C:/Users/jerry/projects/hermes-provider-usage-ext

# 1. Rebuild the harness bundle from the current shipped plugin.
node harness/build.mjs

# 2. Record the 60–90 s demo (headless Edge/Chrome, external requests blocked).
node harness/hackathon-demo.mjs

# 3. Fail if assets/hackathon/demo-full.mp4 predates the current plugin/bundle.
node harness/hackathon-demo.mjs --check
```

`hackathon-demo.mjs` writes:

- `assets/hackathon/demo-full.mp4`
- `assets/hackathon/demo-full-poster.png`
- `harness/dist/hackathon/demo-full.record.json` — SHA-256 source hashes,
  ffprobe output, all 44 assertions, REST-call counts (6 reads, 0 confirms), external-request count
- `harness/dist/hackathon/demo-full-frames/*.png` — review stills

Encoding is `libx264`, `-crf 19`, `-preset medium`, `-pix_fmt yuv420p`,
`+faststart`, no audio track, scaled to 1920×1080. The script rejects a duration
outside 60–90 s or a non-H.264/yuv420p output.

## Source of record

| Item | Value |
| --- | --- |
| Plugin | `desktop/plugin.js` |
| Plugin SHA-256 | `9cc969ee7aa5d7f6494fc51e9d57683d93896db90b79a4405db057a52a158e0e` |
| Harness bundle | `harness/dist/app.js` |
| Bundle SHA-256 | `7ecc301716a98b4bab27f0ee8b859267da4bb81f13c20197cada26481fb613ef` |
| Fixture | `harness/hackathon-demo.mjs` (synthetic; no live accounts) |
| ffprobe | 83.230 s · 1920×1080 · h264 · yuv420p · 30/1 |

## What not to claim

- Do not call this the packaged desktop app. It is the real plugin inside the
  component harness.
- Do not say any balance, reset, or quota is live. It is sample data.
- Do not say the reset was redeemed. The demo stops at the preview.
- Do not say approval is a security sandbox. It is an explicit human trust step
  for exact local file content.
