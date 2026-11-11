# Hackathon verification notes

Status: **historical hackathon record**. Current release evidence, the visual package,
and the stock install path are in [hackathon-guide.md](hackathon-guide.md) and
[../scripts/catalog-readiness.md](../scripts/catalog-readiness.md).

## What the evidence covers

- **Stock compatibility.** Provider Usage 0.10 loads on stock Hermes 0.23.1 with no core
  patch and no private worktree. The manifest floor is `requires_hermes: ">=0.23.1"`.
- **Automated tests.** The route-level reset regression passes (5 tests: preview → confirm
  through the registered HTTP routes, single-use replay, expiry, cross-session and
  cross-account rejection). The full repository gate is `npm run check`: **214 tests,
  11 skipped, 0 failures**. Release procedure: pin the exact tested SHA at freeze time;
  this document does not embed its own commit hash.
- **Browser visual package.** The screenshots and gallery, the infographic, and the demo
  are **browser component-renderer** output from the real plugin and SDK primitives with
  synthetic fixtures. They are not packaged-Electron screenshots and not live provider
  reads. Final imagery is owned by the release assembly step.
- **Reset flow.** Captures stop at the preview. No reset was redeemed. The service has no
  exact-credit selector, force flag, caller URL, or purchase action; success requires a
  verified same-identity readback, and the active-account check is point-in-time rather
  than atomic.

## Not verified live

- No private provider account was called for the Claude subscription, Gemini, or Z.ai
  cards. Gemini and Z.ai are setup-only cards with no account-usage adapter here.
- Stock 0.23.1 has no xAI broker, so Grok subscription credits remain an unavailable row
  with the official dashboard link.
- The packaged Electron app was not launched for these component images. A real gateway
  `/overview` round-trip and live `subagent.list` identity attribution were not exercised.
- Moonshot and ElevenLabs definitions are schema-valid and follow published docs, but no
  private account was called.

## Honest boundaries

- Declarative approval is a local consent boundary, not a sandbox. Same-user code can
  edit definitions and approvals and can read profile credentials.
- The definition HTTP client pins a vetted public peer, disables proxy/netrc discovery,
  and enforces a bounded response. That narrows the network attack surface; it is not a
  claim of unlimited security.
- Provider endpoints change. Experimental adapters are labelled in
  [PROVIDER_SUPPORT.md](../PROVIDER_SUPPORT.md), and optional host helpers degrade one
  row instead of disabling the plugin.
