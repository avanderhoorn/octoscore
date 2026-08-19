# OctoScore

**What happened the last few times someone reviewed this author's work.**

A browser extension that puts one line of evidence on the GitHub PR page:

> Reviewers asked questions on 4 recent PRs. This author replied on 0.

With links to all four, so you can check in ten seconds instead of trusting a number.

---

## Why

The cost of producing a pull request has collapsed. The cost of reviewing one has not.

The question a maintainer actually needs answered before opening the diff is not *is this
person good* or *is this code AI-generated* — it is **if I invest an hour in this review,
will it converge to a merge, or will the author vanish when I ask a question?**

That is a behavioural question with a public, checkable answer, and nothing on the PR page
surfaces it. Two shipping extensions already score contributors ([GitBaz][gitbaz],
[SlopScore][slop]); neither shows post-review engagement history. That gap is the product.

**This is an evidence panel, not a verdict.** A configurable score exists because different
maintainers weigh things differently, but it is the second tab. The first tab is receipts.

[gitbaz]: https://github.com/happyhackingspace/gitbaz
[slop]: https://github.com/hanzili/slopscore

---

## Status: pre-alpha. Do not install this yet.

Honest inventory, because the whole point of the tool is not overclaiming:

| | |
|---|---|
| Pipeline against live GitHub | ✅ works, validated on 2 repos |
| Test suite | ✅ 185 unit tests + 13 browser tests |
| Loaded in a real browser | ✅ automated: `npm run e2e` drives Chrome against live github.com |
| Turbo navigation between PRs | ✅ follows to the new author |
| Error states | ✅ missing token, SAML, rate limit, extension reload, internal fault |
| Firefox / Safari builds | ❌ untested |
| Headline signals validated against maintainer judgement | ❌ see [Calibration](#calibration) |
| Published to any store | ❌ |

Two of the three headline signals (`replyRate`, `proseReplyRate`) have never been checked
against a real maintainer's read of the same contributors. Until that happens the numbers
are plausible, not trustworthy. `REQUIREMENTS.md` §11 gates shipping on it.

---

## What it looks like

```
┌─ OctoScore ────────────────────────────────────────────────────────┐
│ [ Receipts ]  Score    Project                             ↻  ⚙  ✕ │
├────────────────────────────────────────────────────────────────────┤
│ Reviewers asked questions on 4 recent PRs.                         │
│ looks-active-never-engages replied on 0.                           │
│                                                                    │
│ ✗ no reply  Add feature X                  a/one#44              ↗ │
│ ✗ no reply  Refactor module Y              b/two#17              ↗ │
│ ✗ no reply  Improve performance            c/three#91            ↗ │
│ ✗ no reply  Update dependencies            d/four#6              ↗ │
│ ~ pushed    Fix typo in docs               e/five#120            ↗ │
│ ✗ no reply  Add tests                      f/six#58              ↗ │
│                                                                    │
│ ·································································· │
│ Based on 6 PRs · Mar 2024 – Jul 2026                               │
│ Reviewed PRs often went unanswered                           -26 ▸ │
└────────────────────────────────────────────────────────────────────┘
```

Crucially, the same panel also blames the **project** when the project is at fault:

```
│ ✗ no reply  Allow config override          acme/core#455         ↗ │
│             author never · project 58d to first review             │
```

Nobody is unresponsive to a review they waited two months for. Signals that would punish an
author for a maintainer's own latency are suppressed. See `REQUIREMENTS.md` §8.

Run `node examples/panels.mjs` to see every state the panel can render.

---

## Getting started

```bash
npm install
npm run dev            # Chrome, live reload
npm run dev:firefox
```

`npm run dev` launches a browser with the extension already loaded and opens a real PR
page. You do **not** need to load anything by hand, and `localhost:3000` is not a page to
visit — it is the reload server the extension connects to, so opening it shows a 404.

Dev Chrome uses a project-local profile (`.chrome-profile/`, gitignored) so you stay signed
in to GitHub between restarts. That matters: signed-out GitHub serves different markup, and
the panel would simply not appear. Change the launch behaviour in `web-ext.config.ts`.

If you would rather load it yourself, the folder is `.output/chrome-mv3-dev` (or
`.output/chrome-mv3` after `npm run build`) via `chrome://extensions` → *Load unpacked*.

```bash
npm test               # 185 unit tests
npm run e2e            # 13 browser tests: real Chrome, real github.com
npm run compile        # tsc --noEmit
npm run check          # biome
npm run build          # + build:firefox
```

### Browser tests

Every serious bug this project has shipped passed `npm test` and was obvious within
seconds of opening a PR page: selectors pointing at a page GitHub had rewritten, the
merger's name where the author's belonged, a message channel that closed without
answering. So `npm run e2e` loads the built extension into a real Chrome and drives it
against real pull requests.

```bash
npm run e2e                              # skips the tests that need GitHub
GITHUB_TOKEN=$(gh auth token) npm run e2e   # runs all of them
npm run e2e:headed                       # watch it happen
```

It runs headless in a throwaway profile, so it is signed out of GitHub — which is what a
new user's first page load looks like. `e2e/navigation.spec.ts` is a canary pointed at
GitHub rather than at us: it fails if GitHub stops firing the events the panel needs to
follow a soft navigation.

### Token

Settings opens itself on first install. To get back to it later:

- **Click the OctoScore toolbar icon.** (In Chrome you may need to unpin it from the ⧉
  puzzle-piece menu first.)
- **Click *Open settings* on the panel itself** — it appears on any error you fix there,
  including the missing-token one.
- Or `chrome://extensions` → **OctoScore** → *Details* → *Extension options*.

Any of these token types work — the `Authorization: Bearer` header does not care which:

| Token | Notes |
|---|---|
| **`gh auth token`** | Easiest. Already on your machine if you use the GitHub CLI. |
| **Fine-grained PAT** | Recommended for daily use. Repository access → *Public Repositories (read-only)*. Binds to a single resource owner, so it cannot span orgs. |
| **Classic PAT** | Needed only for private or multi-org reads. |

Whatever you use is **read-only** — the extension never writes to GitHub.

If a contributor has touched an org that enforces SAML SSO and your token isn't authorised
for it, GitHub silently returns partial data. OctoScore keeps what it can see, computes
rates on the visible subset only, and **says so on the panel**. It does not quietly shrink
the sample. See `REQUIREMENTS.md` §10.7.

---

## Architecture

One direction, four layers, no framework doing anything clever.

```
storage (profile + token)
      ↓
plan(profile) ──► only the sources the active config actually uses
      ↓
background/api.ts ──► one batched GraphQL query   ~1.2 API points per author
      ↓
cache.ts ──► scoped by (author | repo | both), TTL
      ↓
scoring/score.ts ──► pure: (SourceData, Profile) => ScoreResult
      ↓
content/view.ts ──► every sentence the panel can say, as data
      ↓
content/Panel.tsx ──► renders that. No fetching, no arithmetic.
```

Four rules hold the shape:

1. **The token never leaves the background script.** Not in the content script, not in the
   page. Verified against the built bundle in CI, not just asserted — see the isolation
   check below.
2. **Scoring is pure.** No DOM, no network, no clock. `(signals, weights) => result`.
3. **Signals are config, not code.** Adding one means a row in `src/scoring/signals.ts` and
   an entry in `profile.default.json`. Never a branch in the UI or the message router.
4. **What you don't measure, you don't pay for.** The fetch plan is *derived* from the
   active profile. Turning a group off provably stops querying for it.

```
src/
  background/   api · cache · receipts · storage · index (message router)
  scoring/      signals (the catalogue) · score (pure) · profile.default.json
  content/      mount · view (all copy) · Panel.tsx
  options/      settings UI
  shared/       types · messaging
```

Token isolation is checkable at any time:

```bash
npm run build
grep -ro "Authorization\|local:token\|graphql" .output/chrome-mv3/content-scripts/ | wc -l
# expect 0
```

---

## Calibration

Scoring that has never been checked against a human is decoration. The harness runs the
**real pipeline** — same query, same shaping, same scorer — against a live repo and prints
each author's receipts next to a blank for your own read:

```bash
GITHUB_TOKEN=$(gh auth token) npm run calibrate -- --repo advplyr/audiobookshelf --limit 8
```

It also reports what it *couldn't* see, because a calibration judgement made against a
silently truncated sample is worse than no calibration.

Live runs so far have found four defects that 147 passing unit tests did not, including a
core `dotnet/aspnetcore` maintainer scoring 3% merge rate because self-merges sat in a
denominator. **Run this before trusting anything.**

### The known hard problem

On both repos tested, most PRs have **no review at all** — 5 of 7 authors on one repo had
too little reviewed history to score follow-through. The signal that matters most is the
one most often missing. OctoScore reports that as *unknown* rather than as *bad*, but it
is a real limit on how often the tool can help, and it is not solved.

---

## What this deliberately is not

- **Not a spam defence.** Every signal here is history-based, and history-based signals are
  defeated by making a new account. This helps allocate attention across the majority who
  don't bother. It is not a gate and must never be described as one.
- **Not AI-detection.** It measures engagement after review, not how code was produced.
- **Not a judgement of people.** A newcomer with no history reads as *no history*, never as
  *bad*. Doing no harm to newcomers is a first-class requirement, not a caveat.
- **Not telemetry.** No backend, no analytics, nothing leaves your machine except calls to
  `api.github.com`. See `PRIVACY.md`.

---

## Docs

| File | |
|---|---|
| `REQUIREMENTS.md` | The design authority. Research, signal catalogue, honesty rules, open questions. |
| `AGENTS.md` | Working agreements for this repo. `src/content/` and `src/options/` add UI-layer doctrine. |
| `PRIVACY.md` | What is stored, where, and for how long. |
| `examples/` | Runnable prototype — the parity oracle for every panel state in the docs. |

---

## License

Not yet chosen.
