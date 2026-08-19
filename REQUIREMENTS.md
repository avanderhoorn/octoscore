# OctoScore — Contributor Engagement Evidence for PR Review

**Status:** v2 requirements (post-research rewrite)
**Last updated:** 2026-08-01

---

## 1. Summary

A browser extension that shows a maintainer, on the PR page, **what happened the last few
times someone reviewed this author's work.**

> Reviewer asked questions on 5 recent PRs. Author replied on 2 of them.

With links to all five, so the maintainer can check in ten seconds rather than trusting a
number.

The question it serves is: *if I invest an hour in this review, will it converge?* The
cost of producing a PR has collapsed; the cost of reviewing one has not. The durable
signal is not how the code was produced — it is whether there is a person on the other
end who will engage when asked.

**This is an evidence panel, not a score.** A configurable score exists (§7) because
different maintainers weigh things differently, but it is secondary UI. The primary
output is linked receipts.

### Why not a score, primarily

Two shipping extensions already do contributor scoring — **GitBaz** (0–100 across in-repo
PRs, merge rate, global PRs, commits, account age, followers) and **SlopScore** (merge
rate, account maturity, `authorAssociation`, spray-and-pray flags). That space is taken,
and the empirical literature is unkind to standalone reputation scores surfaced to
reviewers (§3).

Neither shows post-review engagement history. That is the gap, and GitHub's own agentic
code review guidance now tells reviewers to check exactly this before investing in a deep
review.

---

## 2. Goals

- Show, with links, how the author has behaved after review on recent PRs.
- Make the common case a ten-second check, not a number to interpret.
- Fetch only what the active configuration actually uses.
- Keep the codebase small enough to understand in one sitting.
- Isolate the token from the page and content script.
- **Do no harm to newcomers** — see §3, this is a first-class requirement, not a caveat.

## 3. Non-Goals and Known Limits

### Not a spam defence
Every signal here is history-based, and history-based signals are **defeated by making a
new account**. Daniel Stenberg on reputation systems during curl's AI-slop crisis:

> *"For new users that is mostly a pointless exercise as they can just create a new
> account next week. Banning those users is similarly a rather toothless threat."*

This tool helps allocate attention across the majority who don't bother. It is not a
gate, and must never be described as one.

### Not a judgement of the PR
No diff analysis, no size heuristics on the PR at hand. The maintainer is reading it.

### Not a verdict on the person
The empirical record here is specific and must shape the design:

- **PR abandonment is primarily caused by *maintainer* unresponsiveness, not author
  disengagement** (Li et al. 2021, IEEE TSE — 321 abandoned PRs plus 710 developers
  surveyed). Attributing abandonment to the author measures the wrong causal direction.
- **First-time contributors already face 20–40% longer review latency**, and the newcomer
  experience is the dominant dropout point in OSS (Steinmacher et al. 2014, 2015).
- **Reputation surfaced to reviewers produces a Matthew effect** and encodes historical
  inequality; PR acceptance bias tracks identity visibility, not code quality (Terrell et
  al. 2017, 3M+ PRs).

The design responses are §4 (receipts, not rates), §6.4 (no-read state), and §8 (project
mirror). These are not optional mitigations — remove them and the tool becomes a
gatekeeping amplifier.

### Also out of scope
No ML, no AI-detection, no backend, no telemetry, no writes to GitHub, no org dashboards,
no cross-user data sharing.

---

## 4. The Core Design Decision: Receipts, Not Rates

A rate asserts a trait. `abandonmentRate: 75%` says *this person abandons things* — a
claim the literature says is often false, because the maintainer may have gone silent
first.

A receipt asserts an event. *"On this PR, a reviewer asked a question and the author did
not reply"* — with a link — is simply true, and the maintainer can click through and see
the context, including whether the project itself dropped the ball.

So the primitive is not a number. It is a list:

```ts
interface Receipt {
  prUrl: string;
  prTitle: string;
  repo: string;               // nameWithOwner
  closedAt: string | null;
  outcome: 'merged' | 'closed-unmerged' | 'open';

  reviewerEngaged: boolean;   // a non-author, non-bot human commented or reviewed
  reviewerAskedQuestion: boolean;
  authorPushedAfter: boolean; // author added commits after that engagement
  authorRepliedAfter: boolean;// author commented after that engagement
  authorReplyWasProse: boolean; // reply over ~120 chars, not just "done"/"fixed"

  hoursToAuthorResponse: number | null;
  projectHoursToFirstReview: number | null;  // the confound, made visible
}
```

Every signal in §7 is an aggregate over `Receipt[]`, and every aggregate can be expanded
into the receipts that produced it. Nothing is asserted that cannot be clicked.

**`projectHoursToFirstReview` is deliberately carried on every receipt.** It is the
control for the Li 2021 confound: if the author took three weeks to respond but the
project took five weeks to review, that is visible rather than scored against them.

---

## 5. Proof of Understanding

The intervention practitioners actually converged on is not reputation. It is asking
contributors to demonstrate understanding:

- **Ghostty** (`CONTRIBUTING.md`): *"you must understand your code. If you can't explain
  what your changes do and how they interact with the greater system without the aid of
  AI tools, do not contribute to this project."* Plus a vouch system for first-timers.
- **Home Assistant** (`ai_policy`): *"we expect you to be able to explain the proposed
  changes in your own words… Do not use AI to generate answers to questions from
  maintainers."*
- **curl**: *"Humans must always drive the process, taking full responsibility for
  presenting, reviewing, and understanding every change."*

The framing from the 2026 "AI Slop is DDoSing Open Source" work is the useful one: proof
of engagement is **cheap for genuine newcomers who have engaged with the project, and
costly for volume contributors**. Unlike history-based scoring, it *inverts* the newcomer
penalty instead of amplifying it.

We cannot run a challenge-response from a read-only browser extension. What we can do is
show its **historical shadow**: when reviewers asked this author questions before, did
they answer in their own words?

`authorReplyWasProse` is that signal, and it is named honestly. We are measuring *a
substantive written reply followed a question*. We are **not** measuring comprehension,
and no UI copy may imply that we are.

Heuristic, stated openly in the UI on hover: an author comment posted after a reviewer
comment containing a question mark, longer than ~120 characters, that is not solely a
status acknowledgement ("done", "fixed", "updated", "ptal").

---

## 6. Panel

Three surfaces total. Everything below is real output from `examples/panels.mjs`, so the
spec and the renderer cannot drift.

| Surface | Where | Contents |
|---|---|---|
| **PR overlay** | injected on `github.com/*/pull/*` | collapsed line → three tabs |
| **Options page** | extension settings | token, weights, data & privacy |
| **First run** | on install | token choice, explained before it is asked for |

The overlay has three tabs and four states:

```
  collapsed:   ◆ octocat · answered 2/5 questions   +34   expand ▾

  expanded:    [ Receipts ]   Score   Project        ↻  ⚙  ✕
                    │           │        │
                    │           │        └─ §8 mirror — about the READER
                    │           └────────── full breakdown, nothing hidden
                    └────────────────────── default tab, the product
```

| Tab | Answers | Default |
|---|---|---|
| **Receipts** | "what happened last time someone reviewed this person?" | ✓ opens here |
| **Score** | "where did that number come from?" | |
| **Project** | "is my own repo the reason people go quiet?" | |

Tabs are how FR2's disclosure requirement is implemented: Receipts is always the landing
view and the score is never the first thing rendered. Naming the score in a tab bar is
acceptable; opening on it is not.

### 6.1 Receipts tab

Real output from `examples/panels.mjs` — the mock and the prototype are the same
thing, so they cannot drift:

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

Note what carries the meaning: the **✓ / ~ / ✗ column**. A maintainer reads that in about
two seconds without looking at the score at all. That is the design target — the score
column could be deleted and the panel would still work.

And the case that justifies §8, where the *project* is the problem:

```
┌─ OctoScore ────────────────────────────────────────────────────────┐
│ [ Receipts ]  Score    Project                             ↻  ⚙  ✕ │
├────────────────────────────────────────────────────────────────────┤
│ Reviewers asked questions on 4 recent PRs. stalled-by-the-project  │
│ replied on 3.                                                      │
│                                                                    │
│ ✓ replied   Add plugin hook                acme/core#501         ↗ │
│             author 20h · project 38d to first review               │
│ ✓ replied   Support custom serializers     acme/core#498         ↗ │
│             author 30h · project 46d to first review               │
│ ✓ replied   Expose internal metrics        acme/core#470         ↗ │
│             author 12h · project 29d to first review               │
│ ✗ no reply  Allow config override          acme/core#455         ↗ │
│             author never · project 58d to first review             │
│ ✗ no reply  Fix flaky test                 acme/core#441         ↗ │
│             author never · project 67d to first review             │
│                                                                    │
│ ·································································· │
│ Based on 5 PRs · Mar 2024 – Jul 2026                               │
│ Established                                                 +105 ▸ │
└────────────────────────────────────────────────────────────────────┘
```

A naïve abandonment rate scores this person at 40% abandoned. The receipts show the
project took over a month to look at their work. Same data, opposite conclusion — this is
the entire argument for §4.

The project-latency line only renders when the project was slow in **absolute** terms
(>7 days). A ratio test alone fires on every fast-responding author and buries the real
cases; the prototype had exactly that bug before it was tuned.

### 6.2 Receipt marks

Three states, not two. Running the prototype surfaced the third one and it turned out to
be the most interesting:

| Mark | Meaning | Read |
|---|---|---|
| `✓ replied` | Author answered in prose after a reviewer engaged | Converges, and you can talk to them |
| `~ pushed` | Author pushed commits but wrote nothing | Converges, but you learn nothing about whether they understood |
| `✗ no reply` | Reviewer engaged, author did neither | Did not converge |

`~ pushed` is the agentic-contribution shape: fast, responsive to review, silent. The
prototype's `pushes-but-never-explains` fixture scores +43 — mid-band, deliberately not
condemned, because a contributor who silently fixes what you asked for *is* converging.
The panel just makes the silence visible so the maintainer can decide whether it matters
to them. This is precisely the case where a single number would mislead and the receipts
do not.

### 6.3 Score tab

The secondary view. Reachable in one click, never the landing page. It exists so the
number is auditable, not so the number is prominent.

```
┌─ OctoScore ────────────────────────────────────────────────────────┐
│   Receipts  [ Score ]  Project                             ↻  ⚙  ✕ │
├────────────────────────────────────────────────────────────────────┤
│ +43 of 215 possible (20%) — Some history                           │
│                                                                    │
│ After review   ×1                                              +10 │
│   Acted on almost every reviewed PR                    100%    +25 │
│      ⚠ novel signal — not validated, see §11                       │
│   Pushed commits after questions but never wrote …       0%    -15 │
│      ⚠ novel signal — not validated, see §11                       │
│   Usually replied within 3 days                          3h   info │
│                                                                    │
│ Track record   ×1                                              +33 │
│   Has merged here before                                  1    +10 │
│   Previous contributor                            CONTRIBU…     +8 │
│   Half of closed PRs merged                             58%     +3 │
│   10+ PRs merged on repos they don't own                 28     +5 │
│   2+ different maintainers have merged their work         3     +5 │
│   Rarely links PRs to issues                             7%     +0 │
│   1+ year of contribution activity                        1     +2 │
│   Past PRs typically very large                        2600   info │
│                                                                    │
└────────────────────────────────────────────────────────────────────┘
```

Four things this view is obliged to do:

1. **Show the denominator.** `+43 of 215 possible` — not a bare `+43`. An additive score
   has no natural ceiling, so a number without its achievable max is unreadable, and it
   silently changes meaning every time the user edits their profile (§7.1).
2. **Show every rule that fired, including the zero-point ones.** `Rarely links PRs to
   issues  7%  +0` earns its row: a missing row is indistinguishable from a rule the user
   forgot they disabled.
3. **Mark unvalidated signals inline.** The `⚠ novel signal` lines are attached to the
   rules themselves, not buried in a footnote, because those two rules are worth ±40 and
   have no literature behind them (§11).
4. **Say what it could not measure.** When active scoring signals came back `null`:

   ```
   │ Not enough data to judge: Acted on reviewed PRs, Posted a          │
   │ substantive written reply after questions, Merge rate (external    │
   │ repos). These contribute nothing rather than defaulting to a       │
   │ middle value.                                                      │
   ```

   Both shipped competitors default unknown signals to a middle value, which reads as
   "average" when it means "unknown". This line is the visible half of the invariant in
   §7.1 that `null` never scores.

   Three details it is easy to get wrong, and the first draft got all three:

   - **The list is derived from the active rules, never hardcoded.** A hardcoded list is
     the §9 violation ("config, not code") *and* it rots silently: add a signal, forget
     the list, and the panel starts claiming certainty it does not have.
   - **It names signals by their human label**, because `proseReplyRate` is an identifier
     from our source code and means nothing to the person reading the panel.
   - **"Turned off", "informational" and "unmeasurable" are three different things.**
     A rule the user disabled is not a measurement failure. A `mode: 'info'` rule was
     measured and deliberately not scored. Only `null` on an active scoring rule belongs
     here — collapsing them tells a maintainer we know something we don't.

Group multipliers appear as `×1` next to the group total, so the arithmetic
(`tier points × group importance`) is legible without opening settings.

### 6.4 Project tab

The mirror (§8). The only surface in the extension that is about the reader rather than
the contributor.

```
┌─ OctoScore ────────────────────────────────────────────────────────┐
│   Receipts    Score  [ Project ]                           ↻  ⚙  ✕ │
├────────────────────────────────────────────────────────────────────┤
│ acme/core — your repo, last 90 days                                │
│                                                                    │
│ Median time to first review                                    18d │
│ First-timer PRs with no human reply                            34% │
│   (12 of 35)                                                       │
│ Open PRs awaiting a maintainer                                  27 │
│                                                                    │
│ ·································································· │
│ For comparison: this author replied in a median of 20h, while this │
│ project takes 18d to first review.                                 │
│                                                                    │
│ Shown because the contributor is only half of whether a review     │
│ converges.                                                         │
└────────────────────────────────────────────────────────────────────┘
```

It is deliberately unscored and unbanded. The comparison line only renders when the
project's median exceeds the absolute floor (7 days) *and* the author is faster — the
same guard as §6.1, for the same reason.

### 6.5 States

| State | Condition | Renders |
|---|---|---|
| `evidence` | ≥1 receipt where a reviewer engaged | the receipt list |
| `no-read` | no receipts with reviewer engagement | "No review history to show… normal for new contributors." No score, no band. Vouch still shows if present. |
| `error` | token / network / permission failure | named cause **and** the fix |
| `bot` | author is a `Bot` or login ends `[bot]` | one line, no panel, no score |

Error states are enumerated rather than generic, because "something went wrong" trains
people to ignore the panel:

```
⚠ No GitHub token configured.        → Open settings →
⚠ Token rejected (401).              → Update it in settings →
⚠ Token lacks access to acme/core.   → See token setup →      (fine-grained/one-owner)
⚠ GitHub rate limit reached.         → Retry ↻                (cache shown, marked stale)
⚠ Could not reach api.github.com.    → Retry ↻
```

The rate-limit case is the only one permitted to show stale data, and it must be labelled
stale — FR10 forbids a blank or stale score without saying why.

### 6.6 Requirements

- **FR1** — Mounts near the PR header on `github.com/*/pull/*`; non-blocking, collapsible,
  dismissible for the session.
- **FR2** — Receipts are the landing tab. The score never renders above the receipt list,
  and never opens as the default view.
- **FR3** — Every receipt links to its PR. Every aggregate expands to its receipts.
- **FR4** — Where the project's own latency exceeded the author's, the receipt shows both.
- **FR5** — Neutral visual treatment. No red/green on the score. Receipt marks (✓/✗) are
  factual, not evaluative.
- **FR6** — `no-read` shows no score and no band, and its copy must not frame absence of
  history as risk.
- **FR7** — Bot authors render an "automated account" note instead of a panel, and the
  test is **`__typename == "Bot"` on the author**, not the shape of the login. Guessing
  from the name misses every GitHub App not called `*-bot` or `*[bot]` — dotnet-maestro,
  codecov, netlify — and those then got a full person-shaped read whose empty result read
  as "this contributor has no track record", about software. The login heuristic survives
  only for authors remembered before the account type was recorded.
- **FR8** — Mount discovery uses a fallback selector chain and no-ops cleanly when none
  match. **Select only on `data-component`.** GitHub's PR page is Primer React and its
  class names carry per-build content hashes (`prc-PageHeader-Title-p0Mgh`); a selector
  built from one breaks on a deploy that changed nothing visible. The page is also fully
  client-rendered, so selectors cannot be derived from served HTML — they must be checked
  against a real browser's rendered DOM.
- **FR8a** — **The page is trusted for the URL and nothing else.** The author is read from
  the API, never from the header. Two shipped bugs came from reading it: scoped to the page
  header the selector matched the repository owner in the breadcrumb, crediting every PR to
  the org; scoped tighter it matched the *merger* on merged PRs — GitHub renders
  "Youssef1313 merged 6 commits into dotnet:main from snemeckayova:…", so the maintainer
  who pressed the button was profiled instead of the contributor. Both failures are silent
  and both invert the panel's answer. The header is prose about a pull request, and which
  person it names depends on state the content script cannot see.
- **FR8b** — **The panel survives soft navigation.** GitHub is a Turbo app: clicking from
  one PR to the next replaces the DOM without a page load, so a content script that mounts
  once on `DOMContentLoaded` silently stops working from the second PR onward — and does so
  invisibly, which is the worst failure mode for a tool people are meant to trust. Listen
  for `turbo:load` / `pjax:end` with a `MutationObserver` fallback, and re-resolve the
  author and repo from the URL on every mount rather than caching them in module scope.
  **Mounting once is not enough**: the panel is a *sibling* of the header, so Turbo carries
  it out with the subtree it replaces. The mounted handle stays non-null while its host is
  no longer in the document, so "mount once" quietly became "mount once, then never again".
  Ask the host whether it is still connected; WXT does not fire `onRemove` when the anchor
  disappears.
- **FR8c** — **A fault in this extension is never reported as a fault at GitHub.** Three
  distinct failures used to arrive at the panel as "Could not reach api.github.com": a
  background handler that threw before answering, a message listener that returned `true`
  and then never called `sendResponse` (leaving the channel to dangle until the browser
  closed it), and a content script outliving the background that injected it. Only the
  last is common in the wild — it happens to *every* open GitHub tab each time the
  extension updates — and the fix a reader needs is "reload the page", not "check your
  network". Errors therefore carry a `code` that selects the panel's wording, and the
  transport classifies its own rejections (`disconnected` vs `network`) because it is the
  only layer that can tell them apart. The background's handler cannot reject: any throw
  becomes a `crashed` response that names the extension as the culprit.
- **FR9** — The Score tab renders the achievable maximum alongside the total, every rule
  that fired including zero-point ones, an inline `⚠` on any rule flagged unvalidated, and
  an explicit list of signals that returned `null`.
- **FR10** — Error states name their cause and their remedy (§6.5). Only the rate-limit
  case may render cached data, and only when labelled stale.

---

## 7. Scoring (secondary)

Retained because maintainers weigh things differently and configuration is the point.
TRaSH-style: ordered tiers, first match wins, signed points, summed. Groups scale their
children by `importance`. Unchanged from v1 in mechanism.

```ts
interface Tier { gte?: number; lt?: number; eq?: string | boolean;
                 points: number; label: string }
interface Rule { id: string; group: GroupId; signal: SignalKey;
                 mode: 'score' | 'info' | 'off'; tiers: Tier[] }
interface Group { id: GroupId; label: string; importance: number;
                  aboveFold: boolean; floorAtZero?: boolean }
interface Profile { id: string; name: string; groups: Group[];
                    rules: Rule[]; bands: Band[] }
```

`mode` is the **only** off-switch on a rule. An earlier draft had `enabled: boolean` and
`scored: boolean`, which is two booleans, four combinations, and one of them
(`enabled: false, scored: true`) meaningless. Three named states are smaller and cannot
be put into an invalid configuration.

### 7.1 Invariants

- **Negative points only from observed behaviour**, never from absence or volume. Only
  `followThrough` may go negative; `trackRecord` declares `floorAtZero: true`, and
  `vouch` is positive-only by construction (§7.2). The floor is a group property in config, not a branch on
  a group name in the scorer — an earlier draft had `l.group === 'trackRecord'` hardcoded
  inside the pure scoring function, which is exactly the "hardcoded branch instead of
  data" this project is supposed to avoid.
- **Informational rules** (`mode: 'info'`) render without contributing points.
- **Disabled rules** (`mode: 'off'`) are not fetched, not computed, not shown.
- **`null` never scores.** Signals gate on sample size and return `null` below it.
- **Nesting is one multiply.** `points = tier.points × group.importance`. A group subtotal
  is the sum of its visible children and nothing more. No parent signal is ever computed
  from child sub-scores.
- **Band thresholds are ratios, not absolute points.** A band is matched on
  `total / maxAchievable`, where `maxAchievable` is the best score the *currently active*
  rules could award. An additive total has no fixed ceiling, so absolute thresholds rot
  silently every time a rule is added, removed or reweighted — which is precisely what a
  user-editable config invites. This was found the hard way: the fixture bands in the
  prototype had to be retuned three times while signals were being added, which is a
  design smell rather than a tuning problem. Verified by disabling 45 points of rules and
  confirming only the one fixture that depended on them changed band.
  Note this does **not** normalise the score — the total stays additive and inspectable;
  only the label lookup adapts.

### 7.2 Signal catalogue

**`vouch`** — read from a `VOUCHED.td` file in the repo root (convention taken from
gitbaz, pattern from Ghostty's contributor vouching). One cached file fetch per repo.

| Signal | Definition | Evidence status |
|---|---|---|
| `vouchStatus` | `vouched` or `none` for this login | **Practitioner-endorsed.** The only signal here that can speak positively for someone with no history at all |

This is deliberately the highest-value positive signal a newcomer can have, and it is the
design's only real answer to §3's newcomer-penalty problem. Everything else in this
document rewards having been here before; this rewards a human deciding to speak for
someone.

**Positive only.** An earlier draft parsed a leading `-` as a *denouncement* worth −40.
That is cut, and the decision is not a close one. A repo-authored file that publishes
"this named person is untrustworthy", rendered onto that person's PRs by a third-party
extension they cannot see or answer, is a defamation and harassment surface — and it buys
nothing, because a maintainer who does not trust someone can simply not merge their work.
The parser still *recognises* a leading `-`, so it retracts a prior vouch rather than
being silently read as one, and `VouchStatus` has no negative member for a scoring rule
to reach for. A file cannot make this tool say something bad about a person.

**`followThrough`** — aggregates over receipts where a reviewer engaged. `null` below 4
such receipts.

| Signal | Definition | Evidence status |
|---|---|---|
| `replyRate` | Receipts where the author replied or pushed after engagement | **Novel.** Not validated as an author-level trait; endorsed as a review heuristic by GitHub's agentic review guidance |
| `proseReplyRate` | Of receipts where a reviewer asked a question, those with a substantive written reply (§5) | **Novel.** Closest observable to the practitioner "explain it yourself" test |
| `medianResponseHours` | Median author response time | **Informational, unscored.** Penalises distant timezones and evening contributors |
| `projectAdjustedStallRate` | Receipts where the author stalled *and* the project was faster than they were | Controls the Li 2021 confound; default off pending calibration |

**`trackRecord`** — below the fold, floors at zero. These are the *well-supported*
predictors, which is why they are kept despite the competitors also using them.

| Signal | Evidence status |
|---|---|
| `mergedPrsThisRepo` | Strongly supported (Gousios 2014; Rahman & Rigby 2019). Repo-specific count beats cross-repo |
| `authorAssociation` | Largest single binary predictor across multiple studies |
| `mergeRate` | Strongest single predictor. **External repos only** (see §7.3); numerator and denominator both from the last-100-closed sample; `null` below 10 |
| `mergedByOthersExternal` | Supported. Lifetime count of merged PRs on repos the author does **not** own. Uncapped `issueCount`, so the 200+ tier is reachable |
| `uniqueMergers` | Count of **distinct** maintainers who merged their work. Breadth of trust rather than volume |
| `selfMergeExternal` | Distinct **repos** they don't own where they self-merged → someone granted them commit rights there |
| `selfMergeOwnShare` | **Informational, unscored.** Share of merges that are self-merges in own repos |
| `issuesOpenedHere` | Issues filed in *this* repo. Engagement beyond dropping code |
| `linkedIssueRate` | Supported (Rahman & Rigby 2019) |
| `avgPrSizeLines` | Strongly supported, negative direction. Informational by default |
| `ciSuccessRate` | Supported where CI exists. A ratio in `0..1`. Read from the status rollup **at view time**, not at submission — a PR that landed red and was fixed reads green. Null where the repo runs no checks: absence of CI says nothing about the contributor |
| `activeYears` | Moderate support |
| `reviewsGiven` | Moderate, indirect (Tsay 2014, "prior interactions") |

**Dropped:** `prsPerRepo` — no supporting evidence found. `multiDayPrRate` — the
literature measures PR *lifetime*, not author work style; confounded. `mergedPrsGlobal` —
see §7.3.

**Off by default:** `accountAgeDays`, `followers`, `publicOrgs`, `standingFlags`. Retained
for configurability. Note the practitioner objection that 2FA/GPG/account-age signals
correlate with resources and sophistication, penalising exactly the newcomers worth
attracting.

### 7.3 Merged-PR counts are inflatable, and that is not a small problem

A raw "merged PRs" count — which is what both shipping competitors and this document's own
earlier draft used — can be set to any number the author likes by opening PRs in their own
repository and merging them. So can a naïve merge rate, and the merge rate is worse,
because self-merges are ~100% "successful" and drag the ratio up.

So every merge-derived signal is split by **who merged it** and **whose repo it was**:

| | own repo | external repo |
|---|---|---|
| **merged by self** | means nothing — informational only | commit rights elsewhere → strong positive |
| **merged by other** | weak | the number that actually means something |

`uniqueMergers` is the same idea from the other direction: *N distinct people each
independently decided this person's work was worth taking.* It cannot be inflated by
volume, and it does not reward spraying PRs across many repos — twenty PRs merged by one
maintainer counts as one merger. `selfMergeExternal` counts the same way: five
self-merges on one repo is **one** delegation of commit rights, not five, and the label
always claimed repos.

**The sample and the denominator must be the same population.** An earlier version of
this computed `mergeRate` as `mergedByOthersExternal / externalPrsClosed`, where the
numerator came from a `first: 100` node list and the denominator from an *uncapped*
`issueCount`. A contributor with 400 merged of 500 closed therefore computed as
`100 / 500 = 20%` and was told *"Most PRs closed unmerged"*. The cap did not just make
the top tier unreachable — **it inverted the signal for the strongest possible record.**
Both numbers now come from one sample of the author's last 100 *closed* PRs. The uncapped
lifetime count survives only as a volume signal and as a "sampled 100 of N" disclosure,
never as a denominator.

The `self-merge-inflated` fixture is the regression test. An author with 210 self-merged
PRs in their own repos scored **+32** under the previous naïve signals; under the split
they score **+12**, `mergeRate` correctly returns `null` (too few external PRs to judge),
and the panel prints *"Merged PRs are almost all self-merges on own repos — 98%"*.

Note that this is **not** treated as a penalty. Working alone on your own projects is not
a fault; it just isn't evidence that anyone else has trusted your work. The signal is
withheld, not inverted.

---

## 8. The Project Mirror

The literature's explicit recommendation, and the design's main defence against scoring
the newcomer while ignoring the cause:

- **FR11** — The panel shows the **maintainer's own repo** alongside the author: median
  time to first review, and the share of first-time-contributor PRs that received no
  human response. Behind the same disclosure as the score.

If this repo takes 18 days to first review, that is the most decision-relevant number on
the panel, and it is about the reader rather than the contributor.

---

## 9. Architecture

One direction, three layers, and — the part that took a rewrite to get right — **one
pipeline with no fork in it**.

`background (token + API + cache)` → `content script (mount + messaging)` → `panel (render)`

### 9.1 The pipeline

```
profile.rules ─→ signal ids ─→ sources ─→ fetch ─→ compute ─→ score ─→ render
                     │            │                    │         │
                     └────────────┴─ SIGNALS registry ─┘         └─ pure reducer
```

Every arrow is a total function and every stage is derived from the one before it. Notably
**the fetch plan is derived, not maintained**: `plan(profile)` walks the active rules,
looks up each signal's declared `source`, and returns the set of API calls to make.
Nothing has to be kept in sync by hand, so it cannot drift.

```js
plan(defaultProfile).sources   // → { vouch, receipts, prCounts, userProfile }

// set vouch importance to 0:
plan(p).sources                // → { receipts, prCounts, userProfile }   ← vouch dropped
```

A source is dropped only when *every* rule that reads it is off, which is not always the
obvious group. `receipts` feeds both follow-through and the two track-record signals
measured over the same window, so switching off follow-through alone still fetches it.
That asymmetry is exactly why the plan is derived rather than written down.

**One exception, and it is deliberate: `receipts` is mandatory.** The derived plan is
unioned with a small `MANDATORY_SOURCES` set before it is returned. Receipts are the
*product* (§4) — the score is the configurable part. Deriving the fetch plan purely from
active scoring rules meant a user who turned off enough rules would find the receipts list
silently empty, having configured away the main view while trying to adjust a secondary
one. Configuration governs what is **scored**; it does not govern what is **shown**.

The cost of the exception is that "switching a rule off provably stops paying for it" is
now true for every source except this one. That is the right trade: the alternative is a
panel that can be configured into blankness.

### 9.2 The signal registry

The registry is the load-bearing primitive. One entry per signal:

```js
replyRate: {
  source: 'receipts',
  compute:  (rs) => rate(engagedIn(rs).filter(responded).length, engagedIn(rs).length, 4),
  evidence: engagedIn,          // the receipts that justify the value
}
```

Three properties fall out of this shape, and each replaced something worse:

- **Adding a signal is one registry entry plus one rule.** Code declares what a signal
  *is*; config declares what it is *worth*. An earlier draft had two aggregation functions
  of different shapes (`aggregate()` over receipts, `derive()` over counts) whose outputs
  were spread into one bag — adding a signal meant editing the right one of the two,
  adding the rule, and separately remembering to make the fetch provide the field.
- **Every signal reads exactly one source.** Not a rule imposed from outside; it turned
  out to be true of all 21. It makes `sources` a lookup rather than a judgement call, and
  it means a signal can be tested with one fixture object.
- **Evidence is returned, not smuggled.** `compute` yields the number, `evidence` yields
  the receipts behind it. The previous draft passed receipts through underscore-prefixed
  keys (`_engaged`, `_asked`) inside the signals object, which the renderer reached into —
  a leak across the cleanest boundary in the design.

Other invariants:

- Content script never holds the token and never makes a network call.
- Scoring is pure: `(signals, profile) => ScoreResult`. No DOM, no network, no clock.
- Absent and `null` are the same thing at scoring time, so "source not fetched" needs no
  special case anywhere.
- **React is confined to the two rendering surfaces.** `content/panel.tsx` and `options/`
  may use it; `scoring/`, `background/receipts.ts` and `shared/types.ts` must not. That
  boundary is what keeps the scorer testable with no DOM and no browser, which is the
  property this whole design is built around. An earlier draft banned frameworks outright;
  the boundary is the part that actually mattered.

### 9.3 Stack

| Choice | Why |
|---|---|
| **WXT** | Chrome + Firefox + Safari from one codebase, so the portability NFR is config rather than a rewrite. Also ships `createShadowRootUi`. |
| **React 19 + TS 7** | |
| **`preact/compat` alias** | Write React, ship ~5KB instead of ~45KB into every PR page. One Vite alias, no code change, reversible. |
| **Shadow DOM — mandatory** | The panel is injected into GitHub's own page. Without isolation, Primer's CSS styles our panel and ours leaks into theirs, and it re-breaks every time GitHub ships a change. |
| **`@octokit/graphql-schema`** | Node types are `Pick<>`ed from the real schema in `background/nodes.ts`. `receipts.ts` parses nested `timelineItems` unions and is the file most likely to be wrong; a mistyped union member must fail at compile time, not produce a silently empty receipt — which is precisely what happened before this was in place (§10.3). **graphql-codegen was evaluated and dropped:** the queries are composed at runtime from per-source fragments, so there is no static document for codegen to read, and `Pick<>` over the same package gives the identical guarantee with four fewer dependencies and no build step. A test suite separately validates every composable query against the published SDL. |
| **Vitest** | Scoring and receipts are pure — no DOM, no browser, no fixtures beyond plain objects. |
| **valibot** | Profile import/export is a real breakage surface; malformed JSON must fail cleanly. 2KB. |
| **Biome** | One tool for lint + format, near-zero config. |

Deliberately **not** using Tailwind: it fights Shadow DOM (`preflight`, stylesheet
injection) and a ten-element panel does not earn it. Plain CSS inside the shadow root.

### 9.4 Files

```
manifest.json
src/
  shared/types.ts        — Receipt, Rule, Group, Profile, ScoreResult, messages
  background/api.ts      — GraphQL client + one builder per source
  background/receipts.ts — timelineItems → Receipt[]   ← correctness lives here
  background/cache.ts    — storage.local with TTL
  background/index.ts    — message router
  scoring/signals.ts     — the registry: source + compute + evidence, one entry each
  scoring/defaults.ts    — default profile (pure data)
  scoring/score.ts       — the reducer. ~40 lines.
  content/inject.ts      — mount discovery + messaging
  content/panel.ts       — pure render, no network
  options/options.ts     — token, group importance, TTL, export/import
  options/options.html
```

`receipts.ts` is the file most likely to be wrong and carries the heaviest test burden.

### 9.5 The concept count

Five: **Receipt, Signal, Rule, Group, Profile.** `Tier` lives inside `Rule`; `ScoreResult`
is output, not vocabulary. A contributor who holds those five can read any file in the
project without opening a second one.

---

## 10. Data

### 10.1 What feeds what

Receipts and scores are not two datasets. Four of the twenty-one scoring signals **are**
the receipts, summarised — which is what makes "click an aggregate, see the receipts
behind it" (FR3) possible rather than a separate lookup.

```
FETCH A  author's last N PRs + timelines
   │
   ├─→ Receipt[] ───────────────→ RECEIPTS TAB    rendered raw, one row per PR
   │        │
   │        ├─ 4 signals ───────→ followThrough ──→ SCORE
   │        │                     replyRate, proseReplyRate,
   │        │                     medianResponseHours, projectAdjustedStallRate
   │        │
   │        └─ 2 signals ───────→ trackRecord ────→ SCORE
   │                              avgPrSizeLines, ciSuccessRate
   │                              measured over the same PRs shown above, so the
   │                              two halves cannot disagree about which PRs
FETCH B  prCounts + userProfile
   └─→ 14 signals ──────────────→ trackRecord ────→ SCORE
                                  standing (off) ─→ SCORE

FETCH C  VOUCHED.td in this repo
   └─→ vouchStatus ─────────────→ vouch ──────────→ SCORE

FETCH D  this repo's own PR stats
   └─→ ──────────────────────────→ PROJECT TAB     never scored
```

| | Receipts | Score | Project mirror |
|---|---|---|---|
| Source | Fetch A | Fetches A + B + C | Fetch D |
| Signals | — (raw events) | 21 rules over 21 signals | 3 stats |
| User configures | window size only (§10.6) | rule `mode`, tiers, group importance | nothing |
| Can be turned off | **no** | yes, entirely | yes |
| About | the contributor | the contributor | the reader |

The asymmetry in row four is the thesis. Set every group to `importance: 0` and the panel
still works — the receipt list is unaffected and remains useful. There is no configuration
that removes the receipts. **The score is the convenience; the receipts are the product.**

Two consequences for implementation:

- Fetch A is unconditional, and it is unconditional **in code**, not by convention: the
  derived plan is unioned with a mandatory-source set (§9.1). An earlier version derived
  it purely from active rules, which meant turning off enough rules quietly emptied the
  receipts list — configuring away the product while adjusting the convenience. Fetches B,
  C and D *are* skipped entirely when their rules are disabled: `mode: 'off'` and
  `importance: 0` suppress the network call, not just the arithmetic, because
  `plan(profile)` derives the source set from the registry. `standing` costs zero API
  budget by default.
- Fetch A excludes the author's own repositories (`-user:<login>`) and **the PR being
  viewed**. The first keeps self-merged PRs out of a track record that claims other people
  merged the work (§7.3). The second stops an open, un-reviewed PR from being counted as
  evidence about itself. That exclusion is applied when the cache is *read*, not when it is
  written, because the cached receipts are author-global and get replayed against every PR
  you open (§10.5).
- The cache stores `Receipt[]` and raw counts, never signals or scores (§10.5). Aggregation
  and scoring are pure functions run at render time, so editing a weight or a window
  recomputes without a refetch.

### 10.2 Sources

| Source | Query | Cost | Provides |
|---|---|---|---|
| `receipts` | `search` + nested `timelineItems` over ~15 recent PRs | ~10 pts | everything in §4, plus `additions`/`deletions` and the head commit's `statusCheckRollup` — **free**, they ride along on nodes already fetched |
| `userProfile` | `user(login:)` | ~1 pt | active years, 12-month contribution totals, standing flags |
| `prCounts` | aliased `search` | 1 pt | merged / closed-unmerged counts, external vs own, `issuesOpenedHere` |
| `vouch` | `repository.object(expression: "HEAD:VOUCHED.td")` | ~1 pt | §7.2 vouch status; cached per repo, not per author |
| `projectMirror` | repo-scoped `search` + timeline sample | ~5 pts | §8, cached per repo not per author |

**The per-author cost is measured, not estimated.** GitHub's GraphQL limit is a
complexity model, not a node count — shallow queries often cost 1–2 points regardless of
how many items they return, and every *request* carries +1 overhead on top of its cost.
The first implementation spike must include `rateLimit { cost, remaining }` in every query
and record the real numbers here. An earlier draft asserted "~13 points, ~380 authors/hour"
from arithmetic on node counts; that is a guess wearing a number's clothes.

Two consequences that are already firm:

- **One aliased request per author, not one per source.** With +1 overhead per request,
  batching the four author-scoped sources into a single query saves more than any node-count
  tuning. `api.ts` exposes one builder per source, and the router composes them into one
  document.
- **The two repo-scoped sources are fetched once per repo**, not once per author (§10.5),
  so they cost nothing on the second and subsequent PRs.

### 10.3 Building receipts

Filter `timelineItems` to `PULL_REQUEST_COMMIT`, `ISSUE_COMMENT`, `PULL_REQUEST_REVIEW`
and `HEAD_REF_FORCE_PUSHED_EVENT`. Interleaving them yields every field in §4.
`MERGED_EVENT` and `CLOSED_EVENT` are deliberately **not** requested: the outcome comes
off the PR's own `merged`/`closed` fields, and every type in the list competes for the
same 100-node cap.

**`PullRequestCommit` is not shaped like the other three, and assuming it was cost this
design its most distinctive signal.** It has exactly five fields — `commit`, `id`,
`pullRequest`, `resourcePath`, `url`. It has **no `createdAt` and no `actor`.** An earlier
draft of this section instructed the opposite ("use the event's `createdAt`, never the
commit's `committedDate`"), which is not merely suboptimal, it is unimplementable. The
code written from it read `undefined`, produced `NaN`, and dropped every pushed commit
before attribution ever ran — so `authorPushedAfter` could only be set by a *force* push,
the `~ pushed` mark almost never appeared, and "acts on review but never explains" (the
agentic-contribution signal this whole tool exists to surface) silently did not work. The
fixtures hid it because they set the field directly instead of going through the
extractor.

So, concretely:

- **Order commits by `commit.committedDate`;** it is the only timestamp available.
  `pushedDate` is deprecated with a stated removal date and must not be used. Rebase and
  amend do rewrite `committedDate`, but only ever *forward*, and a rebase is itself a push
  — so this can mildly over-report "pushed after review" and **cannot** under-report it.
- **Attribute commits via `commit.author.user.login`,** never via a fallback. The earlier
  code treated "no actor" as "must be the author", which is *always* true for a commit
  node — fixing only the timestamp would have flipped the bug into attributing every
  maintainer's rebase to the contributor.
- **A commit we cannot attribute is not the author's.** `commit.author.user` is null when
  the git email maps to no GitHub account. Unknown is unknown.
- **Model the timeline as a discriminated union on `__typename`** (`background/nodes.ts`),
  derived from `@octokit/graphql-schema` rather than retyped by hand. This makes the defect
  above *unrepresentable*: reading `createdAt` off a commit node is now a compile error.
  A test suite validates every composable query against GitHub's published SDL, which
  proved the queries were always legal — the bug was entirely in the extractor, which is
  exactly why query validation alone is not enough.

Correctness requirements for `receipts.ts`:

- **Exclude the author's own comments** when determining whether a reviewer engaged.
- **Exclude bot actors** (CI, Dependabot, review bots). A PR whose only comment came from
  a linter did not receive review.
- **Require a human non-author event** before a receipt counts toward `followThrough`.
- Record `projectHoursToFirstReview` even when the author responded promptly.
- **Two anchors, not one.** `authorRepliedAfter` and `replyRate` anchor to the first
  *engagement*; `authorReplyWasProse` anchors to the first *question*. A long comment
  posted before anyone asked anything does not answer it, however long it is.
- **The PR being viewed is excluded from its own history.** It is usually open and
  un-reviewed, so including it reads as "engaged but silent" and scores the very PR the
  maintainer is asking about. The search over-fetches by one so the window stays full.
  That PR node is also the runtime source for `authorAssociation`.
- **Truncation is unknown, not guilt.** Only the first `TIMELINE_CAP` events are fetched.
  A truncated timeline can confirm that a reply happened but never that it didn't — the
  missing events are exactly where it would be. So a truncated receipt renders as
  `· not shown` rather than `✗ no reply`, and is dropped from the denominator of the
  follow-through rates unless the fact in question was actually observed. Positive
  evidence survives truncation; absence does not.

### 10.4 Token

- **Public repos only** — fine-grained PAT, repository access "Public Repositories
  (read-only)". Recommended default.
- **Private / multi-org** — fine-grained PATs bind to a single resource owner, so they
  cannot span orgs. Those maintainers need a classic PAT with read scopes.
- **`gh` CLI token** — `gh auth token` works as-is and needs no special handling; the
  `Authorization: Bearer` header does not care what shape the token is. It is the easiest
  way to try the extension. Two caveats: it carries whatever scopes `gh` was authorised
  with, and it is subject to per-org SSO authorisation (see §10.7).

The hourly budget is **asked for, not assumed**. The documented figure is 5,000 points,
but a `gh` CLI token measured against live GitHub reported 9,999 remaining. `rateLimit`
returns `limit` alongside `remaining`, so the settings page prints the real ceiling rather
than a plausible-looking wrong one.

First run explains the choice rather than asking for "a token" and failing later. On
install — and only on a genuine install, with no token already stored — the settings page
opens itself. Otherwise a maintainer's introduction to the tool is an error panel on the
first PR they open, which is a bad first impression of something whose entire pitch is
"be honest about what you don't know".

**Getting *back* to settings has to be as easy.** Opening it once on install is not
enough: the user who closes that tab, or who revokes a token six months later, meets a
panel telling them to visit "the extension's settings" with no way to get there — the
real route being `chrome://extensions` → *Details* → *Extension options*, which nobody
guesses. So there are three routes, and every one of them is reachable from where the
user already is:

1. The **toolbar icon** — `action` with no popup, opening settings on click. There is
   nothing else the icon could usefully do; the product lives on the PR page.
2. An **"Open settings" button on the panel**, shown for exactly the errors that settings
   fixes (`no-token`, `token-invalid`, `token-scope`) and no others. A content script
   cannot call `openOptionsPage`, so this is a message to the background like anything
   else — the isolation boundary does not bend for convenience (§9).
3. The extensions page, for completeness.

Validation is `viewer { login }` with explicit success/failure, and it is **validate then
store**, in that order: a token that failed its check is never written, so it cannot sit
in storage failing every later request with a stale error. A network failure during
validation reports as `network`, never as `token-invalid` — telling someone their
credential is bad when their wifi dropped sends them off to regenerate a token that was
fine.

The extension also records the `rateLimit` that every query already returns, and shows it
in settings. Quota is invisible from inside a browser extension, and "it stopped working"
is the worst possible way to find out you spent it.

### 10.5 Caching

Cache **per source**, keyed to that source's actual scope — not per `(author, repo)`.
Most signals are author-global; keying everything by repo would refetch a contributor's
entire history the first time you see them on a second repo.

```
receipts:<login>          author-global
userProfile:<login>       author-global
prCounts:<login>:<repo>   author + repo
vouch:<repo>              repo-only     ← shared by every author on the repo
projectMirror:<repo>      repo-only     ← likewise
```

Each source declares its scope and the key is built from that declaration, so the scope
is stated once rather than implied by a string template. The two repo-only entries matter
more than they look: `vouch` and `projectMirror` are fetched once and reused for every
contributor you ever look at on that repo — on a busy repo, re-reading `VOUCHED.td` once
per contributor would be the single most repeated call the extension makes.

**Anything that varies per PR must be applied on read, not baked into the payload.** The
current-PR exclusion (§10.3) is the live example: receipts are cached per *author* and
replayed on every PR you open, so filtering at fetch time would freeze the first PR's
exclusion into storage and then score the *next* PR against itself. The cached payload is
the unfiltered author-global evidence; narrowing to this PR's view happens on every read,
cache hit and fresh fetch alike.

**TTL adapts to how fast the answer can change**, an idea taken from SlopScore's staleness
handling:

| Account looked | TTL |
|---|---|
| >2y old, ≥20 merged | 7 days |
| >6mo old | 3 days |
| newer | 24 hours |
| unknown | 12 hours |

This is an accuracy argument as much as a rate-limit one. A ten-year account with 400
merged PRs will not become a different person in a week. An account created on Tuesday
might — and caching a newcomer for a week means showing "no history" to someone who has
since built one, which is the §7.1 cold-start failure arriving late instead of early. A
user-set multiplier scales all four; zero disables caching outright.

Cache stores **source payloads** — receipts and raw counts — never signals or scores. Both
computation stages are pure, so editing a weight, a group importance, or the sample window
recomputes from cache with no network at all.

MV3 service workers are torn down after ~30s idle: cache and in-flight request dedup must
be storage-backed. No module-level state survives. Manual refresh bypasses for one author.

### 10.6 Extraction constants

Receipt extraction has five thresholds that are not weights and do not live in the
profile's rule list. They are worth naming explicitly because they are **policy wearing
implementation clothes** — each one changes the output more than most weight edits, and
four of them are invisible in the UI.

| Constant | Default | What it decides | Exposed? |
|---|---|---|---|
| sample window | last 15 PRs | how far back evidence is drawn from | **yes** — Settings → Data |
| `MIN_ENGAGED` | 4 | below this many reviewed PRs, `replyRate` is `null` | no |
| `MIN_ASKED` | 3 | below this many questions asked, `proseReplyRate` is `null` | no |
| project-stall forgiveness | 336h (14d) | how long the project gets before a stall counts against the author (§8) | no |
| prose threshold | ~120 chars | separates "replied" from "acked" | no |

**The sample window is exposed; the other four deliberately are not.**

The window is exposed because reasonable maintainers genuinely differ and the correct
value depends on the repo, not on taste. On a low-volume repo, "4 of the last 15 PRs had a
reviewer engage" is a bar most legitimate contributors fail — so the panel shows no score
for people with a perfectly good record spread over 40 PRs. That is a real failure mode
and the user needs a lever for it. The options page therefore shows the *consequence* of
the setting, not just the number:

```
│ DATA                                                               │
│                                                                    │
│   Cache TTL                   6 hours       ◀ ─────●──── ▶         │
│   PRs sampled per author      15            ◀ ──●─────── ▶         │
│   At 15, an author needs 4 reviewed PRs before follow-through is   │
│   scored at all. On a low-volume repo, raise this — otherwise good │
│   contributors show no score. Costs ~1 API point per 5 PRs.        │
│                                                                    │
│   Cache size                  412 KB · 96 authors                  │
```

The note names `MIN_ENGAGED` in plain language without exposing it as a control. That is
the intended pattern for all four fixed constants: legible, not adjustable.

The other four are documented but fixed, because they are exactly the knobs that get
tuned until the tool agrees with the person tuning them. `MIN_ENGAGED` in particular is a
confidence threshold: lowering it does not produce more information, it produces
confident-looking output from two data points. FR14 exists to prevent this class of
adjustment; leaving these in the UI would invite it through a side door.

Raising the window is not free — it is a linear increase in fetch cost per author
(§10.2), and it lags reform in both directions (§13 Q1). The options page states both.

### 10.7 Partial responses

GraphQL can return `data` **and** `errors` in the same response, and against real GitHub
it routinely does. The common cause is SAML: if the contributor has touched an org that
enforces SSO and the token is not authorised for it, GitHub returns everything else
normally and refuses those items. It shows up two ways at once:

1. **Response level** — an `errors` entry of type `FORBIDDEN` with
   `extensions.saml_failure`, sitting next to a perfectly good `data` payload.
2. **Array level** — the refused items come back as `null` **inside** `nodes`, so any
   code that reads a field off an element without a guard throws.

Both were found on the first run against live GitHub, against the author's own token. The
first meant the extension was **completely non-functional for anyone in a SAML-enforced
org** — which is most corporate GitHub users — because 27 usable nodes were discarded over
3 refused ones. No fixture would ever have produced either.

The rule: **a partial denial is disclosed, never dropped, and never silently absorbed.**

- Usable data is returned, with a `Withheld { count, reason }` alongside it.
- The panel says so, as a disclosure rather than an alarm: the maintainer needs to know
  the sample is short, not to be alarmed about the contributor.
- Every derived rate is computed on **visible** items only. Counting hidden items in a
  denominator would silently depress every rate and make a prolific contributor look
  quiet — the precise dishonesty this tool exists to avoid.
- The calibration harness discloses it too. A calibration judgement made against a
  truncated sample the calibrator cannot see is worse than no calibration.
- Rate limiting is the exception and still hard-fails. There is nothing usable behind it.

### 10.8 Constraints

- `contributionsCollection` accepts a **1-year window** maximum. Multi-year tenure comes
  from `contributionYears` in one call.
- Search `issueCount` is approximate at scale; display "1000+" rather than a wrong number.
- Private contributions are invisible. When `restrictedContributionsCount > 0`, say so —
  otherwise the tool misreads everyone who works mostly in private repos.
- **The sample is displayed, not weighted.** "Based on 6 PRs · Mar 2024 – Jul 2026." That
  count is the number of receipts actually read, **not** the configured window and not a
  PR count from another source: showing "based on 15" above six rows is exactly the small
  dishonesty this panel exists to avoid. No recency weighting either; invisible maths
  violates §9.
- **No pagination.** The receipts query takes the first page at the configured window size
  and stops. There is deliberately no `hasNextPage` loop: the window is a sample, not a
  census, and following cursors would make cost unbounded for exactly the prolific authors
  who least need the extra evidence. Prolific contributors hit their band on the first page
  regardless.
- **Timeline items are capped per PR.** A PR with 300 comments contributes the same four
  booleans as one with six. Take the first 100 timeline items and set a `truncated` flag on
  the receipt so the panel can say so rather than silently under-reporting.

---

## 11. Validation

**Mandatory before shipping.** `replyRate` and `proseReplyRate` are novel constructs, not
validated in the literature as author-level traits.

- **FR12** — A calibration harness runs receipt extraction over a real repo's recent PR
  authors and outputs receipts plus scores for manual comparison against the maintainer's
  own judgement.
- **FR13** — `receipts.ts` has fixture tests covering: force-pushed PRs, bot-only comments,
  self-comments, maintainer-stalled PRs, PRs with no review, and rebased branches.
- **FR14** — If calibration shows `replyRate` does not track maintainer judgement, it ships
  informational (unscored) rather than being tuned until it agrees.
- **FR15** — **A browser suite runs the built extension against live github.com.** Unit
  tests cannot see this project's characteristic failures, because all of them live in the
  gap between what the code believes about GitHub and what GitHub does: selectors aimed at
  a page that had been rewritten in Primer React, a header that names the merger rather
  than the author, a message channel that returned `true` and never answered, a panel
  carried out of the DOM by a soft navigation, a GitHub App treated as a person. Every one
  passed `vitest` and every one was caught by a human opening a pull request. The suite is
  therefore not a nicety on top of unit tests — it is the only layer that tests the
  assumption the unit tests encode. It includes a canary asserting GitHub still fires the
  navigation events the panel depends on, so that change is reported rather than silently
  breaking the panel.

Calibration is heavier for a public tool than a private one. Tuning a heuristic against
your own repo tells you it works on your repo; shipping it tells strangers it works on
theirs. The harness must therefore run against **at least two repos with different
cultures** — one high-volume with fast review, one low-volume with slow review — because
the failure mode found in §10.6 (a good contributor showing no score because the default
window is wrong for the repo) is invisible on any single project.

---

## 12. Distribution

Shipping publicly adds obligations that a personal tool does not have. Listed here because
several of them constrain the code, not just the listing.

### 12.1 Store requirements

- **No remote code.** MV3 forbids it and the design has none — no CDN, no `eval`, no
  hosted config. The default profile is bundled data.
- **Privacy policy is mandatory** because the extension handles a credential.
  [`PRIVACY.md`](PRIVACY.md) is short and true: the token is stored in `storage.local`,
  never synced, transmitted only to `api.github.com`, and there is no backend, no
  telemetry, no analytics. It is versioned in the repository so the history of what was
  promised is public and dated.
- **Permissions must be minimal and justified.** `storage`, plus host access to
  `github.com/*` and `api.github.com`. No `tabs`, no `<all_urls>`, no content script on
  any page that is not a PR.
- **Firefox** is a `browser_specific_settings` block and an `action`/`browser_action`
  shim, per §NFR portability. Verified as part of the first release, not deferred.

### 12.2 The obligation that isn't a checkbox

The tool renders judgements about identifiable people to strangers, on repos we have never
seen. Three commitments follow, and they are requirements rather than sentiment:

- **FR15** — Ship with `standing` disabled (account age, followers, flags) and keep it
  disabled by default forever. Terrell et al. 2017 found identity-visibility bias in PR
  acceptance across 3M PRs; these signals are proxies for it.
- **FR16** — `no-read` copy must never imply risk. A contributor with no history is the
  normal case for every project's next maintainer.
- **FR17** — Unvalidated signals carry a visible `⚠` in the panel, not only in the config.
  A public user did not read §11.

### 12.3 Differentiation — the question to settle before writing code

GitBaz and SlopScore already ship contributor scoring. A third scorer is not worth anyone's
install. The claim that justifies this one is narrow and testable:

> They answer "what is this person's score." OctoScore answers "what happened the last five
> times someone reviewed this person's work," and links to it.

If a week of calibration shows the receipts view is not meaningfully more useful than
SlopScore's breakdown, the honest outcome is a PR to one of them rather than a third
extension. That decision belongs after §11, not after a v1 release.

**Naming tension, worth resolving before a store listing:** the project is called
OctoScore, but the entire design pivot was *away* from the score and toward the receipts —
the score is a secondary tab that the panel can function without. A name that leads with
"score" advertises the thing we deliberately demoted, and invites exactly the comparison
in which we are the third-best scorer rather than the only receipts view.

---

## 13. Open Questions

1. **Sample bias.** Most-recent-15 favours current behaviour but lags reform in both
   directions. Widen, or show the window and accept it?
2. **Unreviewed history.** Roughly 90% of agentic PRs receive zero review comments. A
   contributor whose PRs were never reviewed has no receipts — correct, but it means the
   population of most concern may be the least measurable.
3. **Prose heuristic.** The ~120-character threshold is a guess. Calibration should set it,
   and it may be indefensible for non-native English speakers writing tersely.
4. **Project mirror scope.** Does showing a maintainer their own newcomer-abandonment rate
   read as useful, or as an accusation?
5. **Differentiation.** Moved to §12.3 — now a decision with a deadline (settle after
   calibration, before v1) rather than an open question.
6. **Name.** "OctoScore" leads with the thing the design demoted (§12.3).

---

## 14. Prototype

```
examples/
  profile.default.json   the default profile — also the spec-by-example for the rules format
  lib.mjs                SIGNALS registry + plan() + score() + fixtures. The scorer, once.
  score-demo.mjs         the fixture regression table
  panels.mjs             every pane, tab and state the extension can render
```

```
node examples/score-demo.mjs        scoring regression set
node examples/panels.mjs            all surfaces
node examples/panels.mjs overlay    just the PR overlay
node examples/panels.mjs options    just the settings page
```

No dependencies. `SIGNALS`, `plan()`, `computeSignals()`, `matches()` and `score()` in
`lib.mjs` are the literal proposed contents of `scoring/signals.ts` and `scoring/score.ts`
— the registry is declarations, and the scorer is about 30 lines. Fixtures are keyed by
**source** (`receipts`, `prCounts`, `userProfile`, `vouch`), so they double as a spec for
what each GraphQL call in `api.ts` has to return. The renderers in `panels.mjs` are pure
`(person, signals, result) => string`; replacing the string building with DOM nodes is the
only work needed to make `content/panel.ts` real. Every mock in this document is real
output from these files.

The eight fixtures are the regression set. Each exists to defeat a specific failure mode,
and the ordering below is the current output — the spread matters more than any one value:

| Fixture | Score | Band | Defeats |
|---|---|---|---|
| `sustained-maintainer` | +183 | Long track record | — (control: obvious yes) |
| `slow-but-converges` | +119 | Established | penalising distant timezones |
| `stalled-by-the-project` | +105 | Established | attributing maintainer latency to the author |
| `pushes-but-never-explains` | +43 | Some history | conflating "responded" with "engaged" |
| `vouched-newcomer` | +42 | Some history | a first-timer having no path to a positive read (§7.2) |
| `self-merge-inflated` | +12 | Limited public history | merged counts inflated by self-merging (§7.3) |
| `genuine-newcomer` | +9 | Limited public history | scoring absence of history as risk → `no-read` |
| `looks-active-never-engages` | −26 | Reviewed PRs often went unanswered | volume masquerading as merit |

Two adjacencies are load-bearing. `stalled-by-the-project` must land near
`slow-but-converges` and far from `looks-active-never-engages`, because on a naïve
abandonment rate all three look identical. And `self-merge-inflated` must land near
`genuine-newcomer` despite 300 merged PRs, because none of them were merged by anyone else.

Changing a weight and re-running should move these in ways you can predict. If it doesn't,
the change is wrong.

---

## 15. Prior Art

Two extensions already ship contributor scoring on GitHub PR pages. Both were read in
full before this revision, and both contributed signals to §7.

### GitBaz — `happyhackingspace/gitbaz` (MIT)
CLI + MV3 extension, `bun`/WXT/turbo monorepo. 100-point scale over in-repo PRs (25),
merge rate (20), global PRs (20), commits (15), account age (10), followers (10), with
Newcomer→Maintainer tiers and badges. Also does repo-level work well outside this scope:
OpenSSF Scorecard reimplementation, bus factor, knowledge-silo detection via git blame.

**Taken:** the `VOUCHED.td` convention (§7.2) — but positive entries only; see §7.2 for
why denouncements are cut. A repo-local, maintainer-authored file of
vouches. This is the Ghostty pattern as a portable file format, and it
is the single best idea in either codebase — it is the only mechanism that gives a
newcomer a positive signal, and it puts a named human rather than a statistic behind the
judgement. Adopting the same filename is deliberate: a shared convention is worth more
than a private one.

**Also worth stealing later:** their `compare.mjs` validates their Scorecard
implementation against real published OSSF scores. That is exactly the shape §11 needs.

### SlopScore — `hanzili/slopscore` (WXT/MV3)
Badge on PR pages. `calculateScore` = global × 0.4 + repo × 0.6, over merge rate, repo
quality, trust, account, and repo history sub-scores.

**Taken:**
- **The merge breakdown** (§7.3) — `mergedBy` vs `repository.owner` to separate self-merges
  from merges by others, and own repos from external ones. This found a real defect in
  this document's earlier draft.
- **`uniqueMergers`** — distinct maintainers who merged the author's work. The best signal
  in either project and the one this design had no equivalent of.
- **`issuesOpenedHere`** — engagement with the project beyond dropping code.
- **External-only merge rate** — their `externalMergeRate` correctly excludes own-repo PRs.

**Not taken, with reasons:**

| Their signal | Why not |
|---|---|
| PRs to 100+ star repos | Popularity is not a quality bar; biases against niche and domain work |
| Profile completeness (bio, company) | Trivially gameable; correlates with employment status |
| New-account burst rate (`prsPerDay`) | §3 — this is not a spam defence, and a fresh account defeats it anyway |
| 🟢🟡🔴 grades | Violates FR5 |
| `= 50` default for missing data | Makes "unknown" and "mediocre" the same number. This is the cold-start bug; §7.1 uses `null` instead, and `null` never scores |
| Penalty scaling with closed-unmerged PRs in-repo | Closed-unmerged is frequently the *maintainer's* choice (out of scope, duplicate, superseded). §7.1 floors `trackRecord` at zero instead |

### Positioning

Both competitors answer *"is this contributor reputable?"* This document answers *"will
this review converge?"* — the receipts view (§4), proof-of-understanding (§5), and the
project mirror (§8) have no counterpart in either. That remains the differentiator, and
§12.3 still asks honestly whether it is a large enough one to justify a third extension
rather than a PR to one of these two.
