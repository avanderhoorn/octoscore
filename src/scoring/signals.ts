import type { AnySignalDef, Receipt } from '../shared/types';

// ---------------------------------------------------------------------------
// Extraction constants — REQUIREMENTS.md §10.6.
//
// Policy, not taste. Only the sample window is user-facing (Settings → Data);
// these are fixed on purpose, because they are the knobs that get tuned until
// the tool agrees with the person tuning it. FR14.
// ---------------------------------------------------------------------------

/** Reviewed PRs needed before follow-through scores at all. */
export const MIN_ENGAGED = 4;
/** Questions asked before prose reply rate scores. */
export const MIN_ASKED = 3;
/** 14d. The project did its part, so a stall after this is the author's. */
export const PROJECT_GRACE_H = 336;
/** Below this, a "reply" is an ack, not an explanation. Calibration should set it. §13 Q3 */
export const PROSE_MIN_CHARS = 120;
/** Default sample window. User-adjustable. §10.6 */
export const DEFAULT_WINDOW = 15;
/** Timeline items read per PR. Beyond this we set `truncated`. §10.8 */
export const TIMELINE_CAP = 100;

// ---------------------------------------------------------------------------

const median = (xs: (number | null)[]): number | null => {
  const s = xs.filter((x): x is number => x != null).sort((a, b) => a - b);
  if (s.length === 0) return null;
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** null below the sample threshold. null never scores — unknown is not "average". §7.1 */
const rate = (n: number, d: number, min: number): number | null =>
  d >= min ? n / d : null;

const mean = (xs: (number | null)[]): number | null => {
  const s = xs.filter((x): x is number => x != null);
  return s.length ? Math.round(s.reduce((a, b) => a + b, 0) / s.length) : null;
};

const engagedIn = (rs: Receipt[]) => rs.filter((r) => r.reviewerEngaged);
const askedIn = (rs: Receipt[]) => engagedIn(rs).filter((r) => r.reviewerAskedQuestion);
const responded = (r: Receipt) => r.authorRepliedAfter || r.authorPushedAfter;
const wasProse = (r: Receipt) => r.authorReplyWasProse;

/**
 * A truncated timeline can confirm that something happened but never that it
 * didn't — the events we never fetched are exactly where it would be. So keep
 * the receipt when the fact was observed, and drop it when its absence is all
 * we have. Unknown, not guilty. §10.3
 */
const conclusive = (fact: (r: Receipt) => boolean) => (r: Receipt) =>
  fact(r) || !r.truncated;

// ---------------------------------------------------------------------------
// THE REGISTRY.
//
// One entry per signal. Adding a signal means adding one entry here and one
// rule to the profile. Nothing else changes: fetch planning, scoring and
// rendering all read this map. §9.2
//
//   source    which fetch provides the data. Every signal reads exactly ONE,
//             so `sources needed` is a lookup, not a judgement call.
//   compute   (sourceData) => value | null. null means unknown, and never scores.
//   evidence  optional. The receipts that justify the value, for click-through.
// ---------------------------------------------------------------------------

export const SIGNALS = {
  // ---- source: receipts ---------------------------------------------------
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
  // (Li et al. 2021). §8
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

  // ---- source: prCounts ---------------------------------------------------
  // Merge signals are split by WHO merged and WHOSE repo. A raw merged count is
  // inflatable to any number by merging your own PRs in your own repos. §7.3
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
    label: 'Merge rate where someone else decided',
    /**
     * "When this person sends a PR to a repo they do not own, and SOMEONE ELSE
     * has to decide, does it land?"
     *
     * External **self**-merges are removed from the denominator, not just the
     * numerator. Leaving them in made having commit rights look like failure:
     * a real dotnet/aspnetcore maintainer with 86 of 100 closed PRs merged
     * scored 3%, because 83 of those merges were their own — and the panel
     * would have labelled them "Most PRs closed unmerged". Found by running
     * this against live GitHub; no fixture would ever have produced it.
     *
     * They are not moved into the numerator either. A self-merge is not
     * somebody else's endorsement, and §7.3 already scores it as `selfMergeExternal`
     * — counting it twice is the inflation that section exists to prevent.
     *
     * Numerator and denominator still come from one sample. §7.3
     */
    compute: (c) =>
      rate(c.mergedByOthersExternal, c.sampledExternalClosed - c.selfMergeExternal, 10),
  },
  mergedByOthersExternal: {
    source: 'prCounts',
    label: "PRs merged on repos they don't own",
    // Uncapped lifetime count. Includes the rare external self-merge, which
    // requires commit rights and is separately visible below.
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
    // Measured over exactly the PRs shown as receipts, so the panel's two
    // halves can never disagree about which PRs they mean. §10.1
    compute: (rs) => mean(rs.map((r) => r.sizeLines)),
  },
  ciSuccessRate: {
    source: 'receipts',
    label: 'CI green on their recent PRs',
    // A ratio in 0..1, like every other `rate()` signal — the profile's tiers
    // are ratio bands and a 0..100 value here silently cleared `gte: 0.9` at a
    // 10% pass rate, making the failing tier unreachable.
    //
    // This is the rollup as it stands NOW, not as it stood at submission: a PR
    // that landed red and was fixed reads green. It measures "do their PRs end
    // up green", which is the question worth asking anyway.
    compute: (rs) => {
      const known = rs.filter((r) => r.ciPassed !== null);
      return rate(known.filter((r) => r.ciPassed).length, known.length, 3);
    },
  },

  // ---- source: userProfile ------------------------------------------------
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

  // ---- source: vouch ------------------------------------------------------
  vouchStatus: {
    source: 'vouch',
    label: 'Vouched for in this repo',
    compute: (v) => v.status,
  },
} as const satisfies Record<string, AnySignalDef>;

export type SignalId = keyof typeof SIGNALS;

export const isSignalId = (id: string): id is SignalId => id in SIGNALS;
