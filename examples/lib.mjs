// OctoScore — shared prototype logic.
//
// Proposed source layout this stands in for:
//   background/receipts.ts -> timelineItems -> Receipt[]  (fixtures below stand in)
//   scoring/signals.ts     -> SIGNALS registry + plan() + computeSignals()
//   scoring/score.ts       -> matches(), score()
//
// Imported by score-demo.mjs and panels.mjs so the scorer exists exactly once.
//
// THE PIPELINE, once, in one direction:
//
//   profile.rules -> signal ids -> sources -> fetch -> compute -> score -> render
//
// Everything below is a step in that line. There is no second path.

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
export const profile = JSON.parse(
  readFileSync(join(here, 'profile.default.json'), 'utf8'),
);

// --------------------------------------------------------------------------
// Extraction constants — REQUIREMENTS.md §10.6.
// Policy, not taste. Only the sample window is user-facing; these are fixed
// on purpose, because they are the knobs that get tuned until the tool agrees
// with the person tuning it.
// --------------------------------------------------------------------------

const MIN_ENGAGED = 4; // reviewed PRs needed before follow-through scores
const MIN_ASKED = 3; // questions asked before prose reply rate scores
const PROJECT_GRACE_H = 336; // 14d: project did its part, so a stall is the author's

const median = (xs) => {
  const s = xs.filter((x) => x != null).sort((a, b) => a - b);
  if (!s.length) return null;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const rate = (n, d, min) => (d >= min ? n / d : null);
const mean = (xs) => {
  const s = xs.filter((x) => x != null);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
};

// --------------------------------------------------------------------------
// scoring/signals.ts — THE REGISTRY.
//
// One entry per signal. Adding a signal means adding one entry here and one
// rule to the profile. Nothing else in the codebase changes: fetch planning,
// scoring, and rendering all read this map.
//
//   source    which fetch provides the data. Every signal reads exactly ONE
//             source — so `sources needed` is a lookup, not a judgement call.
//   compute   (sourceData) => number | string | null.  null means "unknown",
//             and null never scores (§7.1).
//   evidence  optional (sourceData) => Receipt[]. The receipts that justify
//             the value, for click-through. Returned, never smuggled.
// --------------------------------------------------------------------------

const engagedIn = (rs) => rs.filter((r) => r.reviewerEngaged);
const askedIn = (rs) => engagedIn(rs).filter((r) => r.reviewerAskedQuestion);
const responded = (r) => r.authorRepliedAfter || r.authorPushedAfter;
const wasProse = (r) => r.authorReplyWasProse;
// A truncated timeline can confirm that something happened but never that it
// didn't. Keep the receipt when the fact was observed; drop it when its
// absence is all we have. Unknown, not guilty.
const conclusive = (fact) => (r) => fact(r) || !r.truncated;

export const SIGNALS = {
  // ---- source: receipts -------------------------------------------------
  replyRate: {
    source: 'receipts',
    label: 'Acted on reviewed PRs',
    compute: (rs) => {
      const e = engagedIn(rs).filter(conclusive(responded));
      return rate(e.filter(responded).length, e.length, MIN_ENGAGED);
    },
    evidence: engagedIn,
  },
  proseReplyRate: {
    source: 'receipts',
    label: 'Posted a substantive written reply after questions',
    compute: (rs) => {
      const a = askedIn(rs).filter(conclusive(wasProse));
      return rate(a.filter(wasProse).length, a.length, MIN_ASKED);
    },
    evidence: askedIn,
  },
  medianResponseHours: {
    source: 'receipts',
    label: 'Median response time',
    compute: (rs) => median(engagedIn(rs).map((r) => r.hoursToAuthorResponse)),
    evidence: engagedIn,
  },
  // Stalled AND the project had already done its part. Without the second
  // clause we measure maintainer latency and bill it to the contributor
  // (Li et al. 2021).
  projectAdjustedStallRate: {
    source: 'receipts',
    label: 'Went quiet on a promptly-reviewed PR',
    compute: (rs) => {
      const e = engagedIn(rs).filter(conclusive(responded));
      const stalled = e.filter(
        (r) =>
          !responded(r) &&
          r.projectHoursToFirstReview != null &&
          r.projectHoursToFirstReview <= PROJECT_GRACE_H,
      );
      return rate(stalled.length, e.length, MIN_ENGAGED);
    },
    evidence: (rs) =>
      engagedIn(rs)
        .filter(conclusive(responded))
        .filter((r) => !responded(r)),
  },

  // ---- source: prCounts -------------------------------------------------
  // Merge signals are split by WHO merged and WHOSE repo (§7.3). A raw merged
  // count is inflatable to any number by merging your own PRs in your own repos.
  mergedPrsThisRepo: {
    source: 'prCounts',
    label: 'Merged PRs in this repo',
    compute: (c) => c.mergedPrsThisRepo,
  },
  authorAssociation: {
    source: 'prCounts',
    label: 'Association with this repo',
    compute: (c) => c.authorAssociation,
  },
  mergeRate: {
    source: 'prCounts',
    label: 'Merge rate (external repos)',
    // Numerator and denominator both from the last-100-closed sample.
    compute: (c) =>
      rate(c.mergedByOthersExternal, c.sampledExternalClosed - c.selfMergeExternal, 10),
  },
  mergedByOthersExternal: {
    source: 'prCounts',
    label: "PRs merged on repos they don't own",
    compute: (c) => c.externalPrsMerged,
  },
  uniqueMergers: {
    source: 'prCounts',
    label: 'Distinct maintainers who merged their work',
    compute: (c) => c.uniqueMergers,
  },
  selfMergeExternal: {
    source: 'prCounts',
    label: "Repos they don't own where they merge their own work",
    compute: (c) => c.uniqueSelfMergeRepos,
  },
  selfMergeOwnShare: {
    source: 'prCounts',
    label: 'Share of merges that are self-merges at home',
    compute: (c) =>
      rate(
        c.selfMergeOwn,
        c.selfMergeOwn +
          c.selfMergeExternal +
          c.mergedByOthersOwn +
          c.mergedByOthersExternal,
        5,
      ),
  },
  issuesOpenedHere: {
    source: 'prCounts',
    label: 'Issues opened in this repo',
    compute: (c) => c.issuesOpenedHere,
  },
  linkedIssueRate: {
    source: 'prCounts',
    label: 'PRs linked to an issue',
    compute: (c) => rate(c.linkedIssuePrs, c.recentPrCount, 5),
  },
  avgPrSizeLines: {
    source: 'receipts',
    label: 'Typical PR size',
    compute: (rs) => mean(rs.map((r) => r.sizeLines)),
  },
  ciSuccessRate: {
    source: 'receipts',
    label: 'CI green on their recent PRs',
    compute: (rs) => {
      const known = rs.filter((r) => r.ciPassed !== null);
      return rate(known.filter((r) => r.ciPassed).length, known.length, 3);
    },
  },

  // ---- source: userProfile ----------------------------------------------
  activeYears: {
    source: 'userProfile',
    label: 'Years with contribution activity',
    compute: (u) => u.activeYears,
  },
  reviewsGiven: {
    source: 'userProfile',
    label: 'Reviews given to others',
    compute: (u) => u.reviewsGiven,
  },
  accountAgeDays: {
    source: 'userProfile',
    label: 'Account age',
    compute: (u) => u.accountAgeDays,
  },
  followers: { source: 'userProfile', label: 'Followers', compute: (u) => u.followers },
  hasStandingFlag: {
    source: 'userProfile',
    label: 'Account flagged by GitHub',
    compute: (u) => u.hasStandingFlag,
  },

  // ---- source: vouch ----------------------------------------------------
  vouchStatus: {
    source: 'vouch',
    label: 'Vouched for in this repo',
    compute: (v) => v?.status ?? 'none',
  },
};

// --------------------------------------------------------------------------
// Fetch planning. Falls out of the registry — it is a lookup, not a mapping
// that has to be maintained alongside one. A disabled rule costs no API call.
// --------------------------------------------------------------------------

export const activeRules = (prof = profile) => {
  const g = Object.fromEntries(prof.groups.map((x) => [x.id, x]));
  return prof.rules.filter(
    (r) => r.mode !== 'off' && (g[r.group]?.importance ?? 0) !== 0,
  );
};

export function plan(prof = profile) {
  const signals = new Set(activeRules(prof).map((r) => r.signal));
  const sources = new Set([...signals].map((s) => SIGNALS[s]?.source).filter(Boolean));
  return { signals, sources };
}

// --------------------------------------------------------------------------
// Compute. Only signals whose source was fetched are computed; the rest stay
// absent, and absent is indistinguishable from null at scoring time.
// --------------------------------------------------------------------------

export function computeSignals(data, prof = profile) {
  const { signals } = plan(prof);
  const values = {},
    evidence = {};
  for (const id of signals) {
    const sig = SIGNALS[id];
    const payload = data[sig.source];
    if (payload == null) continue;
    values[id] = sig.compute(payload);
    if (sig.evidence) evidence[id] = sig.evidence(payload);
  }
  return { values, evidence };
}

// --------------------------------------------------------------------------
// scoring/score.ts — ordered tiers, first match wins, signed points, summed.
// --------------------------------------------------------------------------

export function matches(tier, v) {
  if (v == null) return false;
  if (tier.eq !== undefined) return v === tier.eq;
  if (tier.gte !== undefined && !(v >= tier.gte)) return false;
  if (tier.lt !== undefined && !(v < tier.lt)) return false;
  return tier.gte !== undefined || tier.lt !== undefined;
}

export function score(values, prof = profile) {
  const groups = Object.fromEntries(prof.groups.map((g) => [g.id, g]));
  const lines = [];

  for (const rule of activeRules(prof)) {
    const tier = rule.tiers.find((t) => matches(t, values[rule.signal]));
    if (!tier) continue;
    const scored = rule.mode === 'score';
    lines.push({
      rule: rule.id,
      group: rule.group,
      signal: rule.signal,
      raw: values[rule.signal],
      label: tier.label,
      points: scored ? tier.points * groups[rule.group].importance : 0,
      scored,
      evidence: rule.evidence ?? null,
    });
  }

  // Groups may declare a floor. trackRecord floors at zero: absence of history
  // is never a penalty. This is config, not a branch on a group name.
  let total = lines.reduce((a, l) => a + l.points, 0);
  for (const g of prof.groups.filter((x) => x.floorAtZero)) {
    const sub = lines.filter((l) => l.group === g.id).reduce((a, l) => a + l.points, 0);
    if (sub < 0) total -= sub;
  }

  // Bands are a fraction of what THIS rule set can award. An additive score has
  // no fixed ceiling, so absolute thresholds rot on every config edit.
  const maxAchievable = activeRules(prof)
    .filter((r) => r.mode === 'score')
    .reduce(
      (sum, r) =>
        sum + Math.max(0, ...r.tiers.map((t) => t.points)) * groups[r.group].importance,
      0,
    );

  const ratio = maxAchievable > 0 ? total / maxAchievable : 0;
  const band = prof.bands.find((b) => ratio >= b.gtePct)?.label ?? '';

  // Signals we could not measure, by human label. Derived from active rules,
  // never a hardcoded list — a signal the user turned off is not a measurement
  // failure. Mirrors scoring/score.ts.
  const unmeasured = [
    ...new Set(
      activeRules(prof)
        .filter((r) => r.mode === 'score' && (values[r.signal] ?? null) === null)
        .map((r) => SIGNALS[r.signal]?.label ?? r.signal),
    ),
  ];

  return { total, band, lines, maxAchievable, ratio, unmeasured };
}

export const evaluate = (person, prof = profile) => {
  const { values, evidence } = computeSignals(person, prof);
  return { signals: values, evidence, result: score(values, prof) };
};

// --------------------------------------------------------------------------
// Fixtures — plausible reconstructions of what timelineItems yields.
// --------------------------------------------------------------------------

const R = (prTitle, repo, o = {}) => ({
  prUrl: `https://github.com/${repo}/pull/${o.n ?? 0}`,
  prTitle,
  repo,
  outcome: o.outcome ?? 'merged',
  reviewerEngaged: o.engaged ?? true,
  reviewerAskedQuestion: o.asked ?? false,
  authorPushedAfter: o.pushed ?? false,
  authorRepliedAfter: o.replied ?? false,
  authorReplyWasProse: o.prose ?? false,
  sizeLines: o.size ?? null,
  ciPassed: o.ci ?? null,
  hoursToAuthorResponse: o.hrs ?? null,
  projectHoursToFirstReview: o.projHrs ?? 48,
});

export const people = [
  {
    login: 'sustained-maintainer',
    vouch: { status: 'none' },
    typicalPrSize: 210,
    blurb: '— long-term contributor to this repo',
    receipts: [
      R('Fix race in connection pool', 'acme/core', {
        n: 812,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 6,
      }),
      R('Add retry backoff', 'acme/core', {
        n: 803,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 14,
      }),
      R('Refactor config loader', 'acme/core', {
        n: 791,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 30,
      }),
      R('Document the cache layer', 'acme/core', {
        n: 780,
        replied: 1,
        prose: 1,
        hrs: 4,
      }),
      R('Bump minimum Node', 'acme/core', { n: 774, pushed: 1, hrs: 20 }),
      R('Handle EOF on stream close', 'other/lib', {
        n: 233,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 9,
      }),
    ],
    userProfile: {
      activeYears: 9,
      reviewsGiven: 140,
      accountAgeDays: 3600,
      followers: 300,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 41,
      authorAssociation: 'COLLABORATOR',
      mergedPrsGlobal: 380,
      closedUnmergedGlobal: 22,
      recentPrCount: 15,
      linkedIssuePrs: 12,
      selfMergeOwn: 60,
      selfMergeExternal: 40,
      mergedByOthersOwn: 10,
      mergedByOthersExternal: 93,
      uniqueMergers: 34,
      issuesOpenedHere: 12,
      externalPrsClosed: 290,
      sampledExternalClosed: 100,
      externalPrsMerged: 310,
      uniqueSelfMergeRepos: 2,
      sampleSize: 100,
    },
  },
  {
    login: 'genuine-newcomer',
    vouch: { status: 'none' },
    blurb: '— first PR to this repo, thin history',
    receipts: [],
    userProfile: {
      activeYears: 1,
      reviewsGiven: 0,
      accountAgeDays: 300,
      followers: 1,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 0,
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      mergedPrsGlobal: 2,
      closedUnmergedGlobal: 0,
      recentPrCount: 2,
      linkedIssuePrs: 1,
      selfMergeOwn: 0,
      selfMergeExternal: 0,
      mergedByOthersOwn: 0,
      mergedByOthersExternal: 2,
      uniqueMergers: 2,
      issuesOpenedHere: 0,
      externalPrsClosed: 2,
      sampledExternalClosed: 2,
      externalPrsMerged: 2,
      uniqueSelfMergeRepos: 0,
      sampleSize: 7,
    },
  },
  {
    login: 'looks-active-never-engages',
    vouch: { status: 'none' },
    typicalPrSize: 1400,
    blurb: '— high volume, vanishes when questioned',
    receipts: [
      R('Add feature X', 'a/one', {
        n: 44,
        outcome: 'closed-unmerged',
        asked: 1,
        projHrs: 20,
      }),
      R('Refactor module Y', 'b/two', {
        n: 17,
        outcome: 'closed-unmerged',
        asked: 1,
        projHrs: 30,
      }),
      R('Improve performance', 'c/three', {
        n: 91,
        outcome: 'closed-unmerged',
        asked: 1,
        projHrs: 12,
      }),
      R('Update dependencies', 'd/four', {
        n: 6,
        outcome: 'closed-unmerged',
        projHrs: 40,
      }),
      R('Fix typo in docs', 'e/five', {
        n: 120,
        outcome: 'merged',
        pushed: 1,
        hrs: 2,
        projHrs: 18,
      }),
      R('Add tests', 'f/six', {
        n: 58,
        outcome: 'closed-unmerged',
        asked: 1,
        projHrs: 24,
      }),
    ],
    userProfile: {
      activeYears: 1,
      reviewsGiven: 0,
      accountAgeDays: 200,
      followers: 3,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 0,
      authorAssociation: 'NONE',
      mergedPrsGlobal: 18,
      closedUnmergedGlobal: 46,
      recentPrCount: 15,
      linkedIssuePrs: 0,
      selfMergeOwn: 12,
      selfMergeExternal: 0,
      mergedByOthersOwn: 0,
      mergedByOthersExternal: 6,
      uniqueMergers: 4,
      issuesOpenedHere: 0,
      externalPrsClosed: 52,
      sampledExternalClosed: 52,
      externalPrsMerged: 6,
      uniqueSelfMergeRepos: 0,
      sampleSize: 57,
    },
  },
  {
    login: 'slow-but-converges',
    vouch: { status: 'none' },
    typicalPrSize: 480,
    blurb: '— distant timezone, always finishes',
    receipts: [
      R('Port driver to new API', 'acme/core', {
        n: 655,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 190,
        projHrs: 60,
      }),
      R('Fix locale handling', 'acme/core', {
        n: 640,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 240,
        projHrs: 72,
      }),
      R('Add IPv6 support', 'acme/core', {
        n: 611,
        asked: 1,
        replied: 1,
        prose: 1,
        pushed: 1,
        hrs: 300,
        projHrs: 90,
      }),
      R('Correct timestamp parsing', 'acme/core', {
        n: 590,
        replied: 1,
        prose: 1,
        hrs: 150,
        projHrs: 48,
      }),
      R('Handle empty payload', 'other/tool', {
        n: 88,
        pushed: 1,
        hrs: 210,
        projHrs: 55,
      }),
    ],
    userProfile: {
      activeYears: 3,
      reviewsGiven: 4,
      accountAgeDays: 1400,
      followers: 20,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 6,
      authorAssociation: 'CONTRIBUTOR',
      mergedPrsGlobal: 40,
      closedUnmergedGlobal: 6,
      recentPrCount: 12,
      linkedIssuePrs: 8,
      selfMergeOwn: 4,
      selfMergeExternal: 0,
      mergedByOthersOwn: 2,
      mergedByOthersExternal: 34,
      uniqueMergers: 9,
      issuesOpenedHere: 3,
      externalPrsClosed: 40,
      sampledExternalClosed: 40,
      externalPrsMerged: 34,
      uniqueSelfMergeRepos: 0,
      sampleSize: 45,
    },
  },
  {
    login: 'stalled-by-the-project',
    vouch: { status: 'none' },
    typicalPrSize: 320,
    blurb: '— went quiet AFTER the project did',
    receipts: [
      R('Add plugin hook', 'acme/core', {
        n: 501,
        asked: 1,
        replied: 1,
        prose: 1,
        hrs: 20,
        projHrs: 900,
      }),
      R('Support custom serializers', 'acme/core', {
        n: 498,
        asked: 1,
        replied: 1,
        prose: 1,
        hrs: 30,
        projHrs: 1100,
      }),
      R('Expose internal metrics', 'acme/core', {
        n: 470,
        asked: 1,
        replied: 1,
        prose: 1,
        hrs: 12,
        projHrs: 700,
      }),
      R('Allow config override', 'acme/core', {
        n: 455,
        outcome: 'closed-unmerged',
        asked: 1,
        projHrs: 1400,
      }),
      R('Fix flaky test', 'acme/core', {
        n: 441,
        outcome: 'closed-unmerged',
        projHrs: 1600,
      }),
    ],
    userProfile: {
      activeYears: 4,
      reviewsGiven: 2,
      accountAgeDays: 1800,
      followers: 40,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 3,
      authorAssociation: 'CONTRIBUTOR',
      mergedPrsGlobal: 25,
      closedUnmergedGlobal: 12,
      recentPrCount: 10,
      linkedIssuePrs: 7,
      selfMergeOwn: 3,
      selfMergeExternal: 0,
      mergedByOthersOwn: 1,
      mergedByOthersExternal: 21,
      uniqueMergers: 7,
      issuesOpenedHere: 4,
      externalPrsClosed: 31,
      sampledExternalClosed: 31,
      externalPrsMerged: 21,
      uniqueSelfMergeRepos: 0,
      sampleSize: 36,
    },
  },
  {
    login: 'pushes-but-never-explains',
    vouch: { status: 'none' },
    typicalPrSize: 2600,
    blurb: '— responds with commits, never words',
    receipts: [
      R('Implement caching layer', 'x/one', { n: 12, asked: 1, pushed: 1, hrs: 3 }),
      R('Add auth middleware', 'x/one', { n: 19, asked: 1, pushed: 1, hrs: 2 }),
      R('Optimise query path', 'x/one', { n: 25, asked: 1, pushed: 1, hrs: 5 }),
      R('Rewrite the scheduler', 'y/two', { n: 7, asked: 1, pushed: 1, hrs: 1 }),
      R('Add websocket support', 'y/two', { n: 9, pushed: 1, hrs: 4 }),
    ],
    userProfile: {
      activeYears: 1,
      reviewsGiven: 0,
      accountAgeDays: 240,
      followers: 5,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 1,
      authorAssociation: 'CONTRIBUTOR',
      mergedPrsGlobal: 30,
      closedUnmergedGlobal: 20,
      recentPrCount: 14,
      linkedIssuePrs: 1,
      selfMergeOwn: 2,
      selfMergeExternal: 0,
      mergedByOthersOwn: 0,
      mergedByOthersExternal: 28,
      uniqueMergers: 3,
      issuesOpenedHere: 0,
      externalPrsClosed: 48,
      sampledExternalClosed: 48,
      externalPrsMerged: 28,
      uniqueSelfMergeRepos: 0,
      sampleSize: 53,
    },
  },
  {
    login: 'self-merge-inflated',
    vouch: { status: 'none' },
    blurb: '— 210 "merged PRs", almost all their own',
    receipts: [],
    userProfile: {
      activeYears: 3,
      reviewsGiven: 0,
      accountAgeDays: 1100,
      followers: 8,
      hasStandingFlag: false,
    },
    prCounts: {
      mergedPrsThisRepo: 0,
      authorAssociation: 'NONE',
      mergedPrsGlobal: 210,
      closedUnmergedGlobal: 5,
      selfMergeOwn: 205,
      selfMergeExternal: 0,
      mergedByOthersOwn: 3,
      mergedByOthersExternal: 2,
      uniqueMergers: 2,
      issuesOpenedHere: 0,
      externalPrsClosed: 4,
      sampledExternalClosed: 4,
      externalPrsMerged: 2,
      uniqueSelfMergeRepos: 0,
      sampleSize: 9,
      recentPrCount: 15,
      linkedIssuePrs: 0,
    },
  },
  {
    login: 'vouched-newcomer',
    blurb: '— first PR here, vouched for by a maintainer',
    receipts: [],
    userProfile: {
      activeYears: 1,
      reviewsGiven: 0,
      accountAgeDays: 120,
      followers: 0,
      hasStandingFlag: false,
    },
    prCounts: {
      vouchStatus: 'vouched',
      mergedPrsThisRepo: 0,
      authorAssociation: 'FIRST_TIME_CONTRIBUTOR',
      mergedPrsGlobal: 1,
      closedUnmergedGlobal: 0,
      selfMergeOwn: 0,
      selfMergeExternal: 0,
      mergedByOthersOwn: 0,
      mergedByOthersExternal: 1,
      uniqueMergers: 1,
      issuesOpenedHere: 2,
      externalPrsClosed: 1,
      sampledExternalClosed: 1,
      externalPrsMerged: 1,
      uniqueSelfMergeRepos: 0,
      sampleSize: 6,
      recentPrCount: 1,
      linkedIssuePrs: 1,
    },
    vouch: { status: 'vouched' },
  },
];

// Fixture convenience: a person states one typical PR size; every receipt of
// theirs carries it. Keeps the mean exact so the pinned scores stay pinned.
for (const p of people) {
  for (const r of p.receipts) r.sizeLines ??= p.typicalPrSize ?? null;
}

export const byLogin = (login) => people.find((p) => p.login === login);

// The reader's own repo — REQUIREMENTS.md §8, cached per repo not per author.
export const repoMirror = {
  nameWithOwner: 'acme/core',
  medianHoursToFirstReview: 432,
  firstTimerPrsNoResponse: 12,
  firstTimerPrsTotal: 35,
  openPrsAwaitingMaintainer: 27,
  windowDays: 90,
};
