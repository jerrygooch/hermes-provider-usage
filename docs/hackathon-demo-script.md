# Approved submission demo — 86 seconds

The approved [demo-full.mp4](../assets/hackathon/demo-full.mp4) is the final five-screen cut: **86.000 seconds**, 1280×720 H.264 Main with a silent AAC track. It was published at https://x.com/TigerNinjaChan/status/2120635628249649209.

It uses stable headings and clean cuts, holding the popover for 18 seconds, provider credits for 20, custom definitions for 16, reset preview for 18, and the install screen for 14. The Codex plan note appears only beside the visible five-hour bar. Captures use real components with synthetic data; they are not native Desktop/live-account evidence. The credit scene includes a cropped interaction from the verified source recording; the other screens are held captures. The 44 assertions below apply to the source recording, not to independent interactions in this final edit.

Approved MP4 SHA-256: `fe12aa9fe71076cac3e7728ede8320b619d6c9c1d86cd413a3f7b923b45834ed`.

Assembly script: `harness/hackathon-simple-cut.py`. The earlier interaction cut is preserved privately as a fallback and was not posted.

## Historical source-recording notes — superseded by the approved edit

The measurements and timeline below describe the earlier 83.77-second source recording, not the published final video.

**Deliverable:** [demo-full.mp4](../assets/hackathon/demo-full.mp4) — **83.77 s**, **1920×1080**, H.264 / yuv420p, 30 fps, silent, 4.56 MB.
**Poster:** [demo-full-poster.png](../assets/hackathon/demo-full-poster.png) (settled popover frame, 12.1 s).
**Provenance + assertion log:** `harness/dist/hackathon/demo-full.record.json`.
**X companion:** `C:/Users/jerry/projects/deliveries/provider-usage-0.10/demo-x-v3.mp4` — 1280×720, H.264 **Main** level 3.1, AAC-LC **silent** track (max −91 dB), `+faststart`, 83.77 s, 2.17 MB.

Recorded on port **8961**, distinct from the still-capture ports 8951/8952.

This is the submission demo. The older `assets/hackathon/demo.mp4` is a 5.9 s
teaser only; it is not the full script.

## What the video is

A screen recording of the **real shipped plugin** (`desktop/plugin.js`) rendered
with the **real Hermes SDK UI primitives** and the built-in `nous` dark theme in
the browser component harness. Every beat is a real DOM click, mouse-wheel
scroll, or `scrollIntoView`, followed by a state assertion. The visible badge
**“Component demo · sample data”** stays on screen; the end card repeats the
disclosure in its footnote.

Every value comes from a synthetic fixture. No live account, credential, email,
workspace name, balance, reset date, or local path from a user profile appears.

### Plan label: Plus, not Pro

The Codex fixture is **Plus** (`plan: "Plus"`, account label
`Codex Plus · sample`) because Plus and Standard Business expose a five-hour
window; **Pro plans currently have no five-hour limit**. The panel therefore
shows a 5-hour window and a Weekly window, and the status chip reports the
governing 5-hour window (`Codex · 5h 62%`).

A visible rail note states: **“\* Plus-plan example. Pro plans currently have no
five-hour limit.”** Source: <https://learn.chatgpt.com/docs/pricing> (read
2026-11-11; the FAQ says “Pro plans currently have no five-hour limit.”). The
harness also records plan-label checks proving the popover, reset summary, and
confirmation all read **Codex Plus**, never Codex Pro.

### Readability revision (2026-11-11 review)

Jerry’s review: the 60.6 s cut moved before headings could be read. This cut
keeps interaction timing intact and adds **settled-state dwell**, plus larger
type sized for the 720p X upload (CSS pixels map 1:1 to the X encode):

| Element | Before | After |
| --- | --- | --- |
| Caption step label | 10.5 px | 12 px |
| Caption headline | 25 px / 1.12 | **33 px / 1.08** |
| Caption note body | 14 px / 1.55 | **18.5 px / 1.50** |
| Plan note | — | 14 px, amber rule |
| Legal line | 9.5 px | 11.5 px |
| Caption rail width | 308 px | 322 px |
| End-card headline | 50 px | **60 px** |
| End-card tagline | 18 px | 22 px |
| End-card fact title / body | 12.5 / 10.5 px | 15 / 13.5 px |
| End-card footnote | 13 px | **15.5 px** |
| End-card legal | 10.5 px | 12.5 px |
| Install command | 15 px | 17 px |
| Ring hint | 9 px | 11 px |

No plugin CSS was changed. The harness asserts every caption for
headline/note font floors, horizontal overflow, body clipping, rail-vs-legal
clearance and rail/stage spacing; all 17 layout checks pass. The end card
additionally asserts the install command does not clip and the footnote clears
both the closing line and the legal line.

### Dwell map (measured from the rendered cut)

Holds are settled-state waits after the interaction has finished; click and
scroll animation timing is unchanged.

| Beat | Hold |
| --- | --- |
| 01 Status-bar chip / intro | **7.0 s** before hover |
| 02 Popover, both windows | 5.2 s |
| 03 Running agents footer | 4.3 s |
| 03 View all / far-left sidebar instruction | **4.0 s before the click**, 0.6 s after page opens |
| 04 Full provider page | 6.5 s |
| 05 OpenRouter $24.18 / DeepSeek $8.72 detail | **6.6 s** |
| 06 Manage-account link (hover only) | 3.2 s |
| 07 Popular providers | 3 × 1.6 s + 0.8 s |
| 08 Definitions & trust states | 3.4 s |
| 09 Reset scene intro | 1.2 s |
| 09 Read-only reset summary | **6.3 s** |
| 10 Review-before-confirm intro | 1.1 s (+0.7 s ring) |
| 10 Confirmation preview | **6.6 s** |
| 11 End card | **8.0 s** + 1.0 s tail |

Total runtime **83.77 s**; the harness refuses anything outside 80–88 s and
refuses 90 s or more.

### Beats

1. **Status-bar chip** — Codex Plus, weekly 84% and 5-hour 62% in the popover;
   resting chip reads `5h 62%`. Caption says to click the usage chip in the
   bottom status bar.
2. **Click the chip** — popover opens with 5-hour 62% left, Weekly 84% left,
   reset times, the sample paid-fallback balance, and activity.
3. **Wheel-scroll the popover** — running-agents footer: 3 agents, `2× Codex`
   and an anonymous `qwen3-coder` child. Every pool value is an **em dash**.
4. **Click View all providers** — the chip/popover dismiss and the full page
   opens on the active Codex card. Caption also names the far-left sidebar entry
   (alongside New session, Capabilities and Scheduled jobs).
5. **Click Expand OpenRouter** — labelled **sample credit balance of $24.18**.
   DeepSeek’s own **$8.72** stays on its separate row.
6. **Manage account link** — DeepSeek expands; its Billing link is highlighted
   and hovered, **not clicked**. No login page, no external request.
7. **Popular providers** — Claude / Anthropic, Google Gemini API, and Z.ai /
   GLM are each scrolled into frame and ringed. Cards state “No balance or
   quota is inferred.”
8. **Provider definitions** — **Approval required**, **Blocked**, **Unverified
   mapping** on screen.
9. **Banked reset, read-only** — reset scene opens with every Codex window at
   **0% left**. Click **Check reset credits** → summary for `Codex Plus · sample`:
   2 banked, 1 usable now.
10. **Preview reset** — click **Preview reset** → confirmation names the account
    and the spend. The video **stops here**; the final **Confirm reset on Codex
    Plus · sample** button is visible and was never clicked.
11. **End card** — install command
    `hermes plugins install jerrygooch/hermes-provider-usage`, three
    capabilities, and the readable footnote **“\* Usage figures in this demo are
    sample data, not real account usage.”**

## Honesty rails (verified, not narrated)

- The harness `ctx.rest` is counted. `/reset/summary` and `/reset/preview` were
  called; **`/reset/confirm` was called zero times**. No reset, credit, or
  purchase was made.
- All external HTTP(S) requests are blocked by the browser context and counted.
  **0 external requests**, **0 popups**, and only two local harness pages.
- Manage-account links are only hovered/outlined.
- The reset beat is a dedicated harness page with every Codex window forced to
  **0% left**. It is a cut, not a live mutation.
- No `accounts[]` identity metadata is used. Every child row renders unknown
  (`—`), matching a stock host without `list_account_usage_identities`.
- **44/44 assertions pass**, including zero external requests, zero
  reset-confirm calls, one View-all click, and plan-label checks.
- `demo-full.mp4` carries the source hashes in its container comment:
  plugin `30709fa2…c3eda6`, harness bundle `62c21499…20b6ae`.

## Rerender

```bash
cd C:/Users/jerry/projects/hermes-provider-usage-ext

# 1. Rebuild the harness bundle from the current shipped plugin.
node harness/build.mjs

# 2. Record the 80–88 s demo and encode the X companion in one pass.
node harness/hackathon-demo.mjs --x C:/Users/jerry/projects/deliveries/provider-usage-0.10/demo-x-v3.mp4

# 3. Fail if assets/hackathon/demo-full.mp4 predates the current plugin/bundle.
node harness/hackathon-demo.mjs --check
```

`hackathon-demo.mjs` writes:

- `assets/hackathon/demo-full.mp4`
- `assets/hackathon/demo-full-poster.png`
- `harness/dist/hackathon/demo-full.record.json` — SHA-256 source hashes,
  ffprobe output, 44 assertions, 17 layout checks, beat marks, REST-call counts
  (6 reads, 0 confirms), external-request count, X-companion probe
- `harness/dist/hackathon/demo-full-frames/*.png` — review stills

Master encoding is `libx264`, `-crf 19`, `-preset medium`, `-pix_fmt yuv420p`,
`+faststart`, no audio track, scaled to 1920×1080. The X companion is a separate
transcode of that MP4: 1280×720, H.264 **Main** level 3.1, `-crf 20`,
`-preset slow`, AAC-LC stereo silent track, `+faststart`. The script verifies
the X duration matches, the video is Main/720p, the audio is ≥90 dB of silence,
and `moov` precedes `mdat`.

## Source of record

| Item | Value |
| --- | --- |
| Plugin | `desktop/plugin.js` |
| Plugin SHA-256 | `30709fa2e9c4ab1498ade141226746b1b90cc5ef6c2bb9a76840d5ffc4c3eda6` |
| Harness bundle | `harness/dist/app.js` |
| Bundle SHA-256 | `62c2149966d02643922b042e309982e4de1d87b23e329d23e9eee5699e20b6ae` |
| Fixture | `harness/hackathon-demo.mjs` (synthetic; no live accounts) |
| ffprobe master | 83.767 s · 1920×1080 · h264 · yuv420p · 30/1 · 4,778,938 B |
| ffprobe X | 83.767 s · 1280×720 · h264 Main · yuv420p · 30/1 · AAC-LC silent · 2,172,304 B |
| Master SHA-256 | `ab4bc73a3190ea4e46e53b351cad8dc96ab1787cbdab3b11ce62abecfb33cba0` |
| X SHA-256 | `8c7bcbe18d45a06b64da3b88440aeb2f7b3f72c40f57a616de1e5e369a294c28` |

## What not to claim

- Do not call this the packaged desktop app. It is the real plugin inside the
  component harness.
- Do not say any balance, reset, or quota is live. It is sample data.
- Do not say the reset was redeemed. The demo stops at the preview.
- Do not present this as a Pro-plan five-hour demo. It is a **Plus-plan
  example**; Pro plans currently have no five-hour limit.
- Do not say approval is a security sandbox. It is an explicit human trust step
  for exact local file content.
