# OctoScore — working agreements

A browser extension that shows a maintainer **what happened the last few times
someone reviewed this contributor's work**, so they can decide whether a PR is
worth their review hour.

`REQUIREMENTS.md` is the design authority. Section numbers below (§7, §9…) refer
to it. If code and doc disagree, one of them is a bug — say which.

## Commands

```bash
npm test           # vitest, 50 tests. Run this before claiming anything works.
npm run compile    # tsc --noEmit
npm run check:fix  # biome format + lint
npm run build      # chrome-mv3
npm run build:firefox
npm run calibrate -- --repo owner/name   # needs GITHUB_TOKEN
```

## The pipeline

One direction. Every stage is a function of the one before it.

```
profile.json → plan() → fetch → SourceData → computeSignals() → score() → panel
   config      sources   api     payloads      SignalValues     ScoreResult  DOM
```

Two consequences worth internalising:

- **The fetch plan is derived, not maintained.** `plan(profile)` walks the active
  rules and reads each signal's declared `source`. Nobody keeps a list of API
  calls in sync. Do not add one.
- **Editing config never refetches.** The cache stores *source payloads*, never
  signals and never scores. Change a weight, the score recomputes offline.

## Layers

| Directory | May import | Must never import | Invariant |
|---|---|---|---|
| `shared/` | nothing | everything | Types only. No logic. |
| `scoring/` | `shared/` | React, `wxt/*`, `fetch`, DOM | Pure. Same input, same output, forever. |
| `background/` | `shared/`, `scoring/` | React, DOM | Only layer that holds the token or opens a socket. |
| `content/` | `shared/` | `background/*`, the token, `fetch` | Renders. Asks background for data by message. |
| `options/` | `shared/`, `scoring/` | `background/api` | Edits config. May validate, may not fetch signals. |

The token rule is not stylistic. `content/` runs in a tab alongside github.com;
anything it can reach, a page compromise can reach. It gets computed results and
nothing else. §9

## Writing UI

**Read [`src/content/AGENTS.md`](src/content/AGENTS.md) before writing any React.**
It is short, it is opinionated about hooks, and it applies to `src/options/` too.

We write React and ship Preact via a `preact/compat` alias (~5KB, not ~45KB, into
every PR page). Practical effect: no React-19-only APIs, no `react-dom/server`.

## Adding a signal

Two edits, no more. If you find yourself touching a third file, the abstraction
has leaked and that is the bug to fix.

1. One entry in `src/scoring/signals.ts` — declares its `source` and its `compute`.
2. One rule in `src/scoring/profile.default.json` — declares what it is worth.

Then: no UI change, no messaging change, no fetch-plan change. That is the whole
point of the registry. §9.2

## Rules that are load-bearing

- **`null` never scores.** Unknown is not "average" and not "bad". A signal below
  its sample threshold returns `null` and contributes zero. §7.1
- **Absence of history is never a penalty.** New contributors score low, not
  negative. That is `floorAtZero` in config, not a branch on a group name.
- **Bands are ratios of what is achievable**, never absolute point thresholds.
  Users disable rules; absolute thresholds rot the moment they do. §7.1
- **Every signal reads exactly one source.** Not imposed — it fell out. It is
  what makes `sources` a lookup and each signal testable with one object.
- **Never bill maintainer latency to the contributor.** Every receipt carries
  `projectHoursToFirstReview` as the control. §4
- **Never trust a raw merged count.** Split by who merged and whose repo, or
  self-merges manufacture a track record. §7.3

## Testing

`examples/lib.mjs` is not dead scaffolding. It is a standalone prototype whose 8
fixtures are imported by `src/scoring/score.test.ts`, which asserts the
TypeScript scorer produces byte-identical numbers.

**Before any refactor of `scoring/`, capture the baseline:**

```bash
node examples/score-demo.mjs > /tmp/before.txt
# ...refactor...
node examples/score-demo.mjs | diff /tmp/before.txt -
```

A structural change that alters a score is not a structural change. If a score
*should* move, say so out loud and update the pinned numbers deliberately.

`examples/panels.mjs` renders every panel surface as text. Mocks pasted into
`REQUIREMENTS.md` §6 come from it, so its output changing means the doc is stale.

## Honesty rules

These exist because the tool makes claims about people.

- Never invent a number. No estimated API costs, no guessed thresholds. Measure
  it or leave it out and say it is unmeasured.
- A signal with no literature behind it is marked `evidence: 'novel'` and renders
  a ⚠ in the panel. §11
- Contributions we cannot see are reported as unseen, never read as absence.
- The tool never says "reject". It shows what happened and links to it.
