// The whole vocabulary of the project. Five concepts.
//
// Receipt  one PR, and what happened when someone reviewed it
// Signal   a named, computed value derived from exactly one source
// Rule     what a signal is worth, as ordered tiers
// Group    display grouping + one multiplier + an optional floor
// Profile  the user's whole configuration
//
// REQUIREMENTS.md §9.5.

// ---------------------------------------------------------------------------
// Receipt — the primitive. §4.
// ---------------------------------------------------------------------------

export type PrOutcome = 'merged' | 'closed-unmerged' | 'open';

export interface Receipt {
  prUrl: string;
  prTitle: string;
  repo: string;
  number: number;
  createdAt: string;
  outcome: PrOutcome;

  /** A human who is not the author commented on or reviewed the PR. */
  reviewerEngaged: boolean;
  /** That engagement contained a question. */
  reviewerAskedQuestion: boolean;

  authorPushedAfter: boolean;
  authorRepliedAfter: boolean;
  /** The reply was prose, not just an ack or an emoji. */
  authorReplyWasProse: boolean;

  /** additions + deletions. null when GitHub withheld it (rare, but never guess). */
  sizeLines: number | null;
  /** Rollup at the time we looked. null when the repo runs no checks. */
  ciPassed: boolean | null;

  hoursToAuthorResponse: number | null;
  /**
   * How long the PROJECT took to look at it. Carried on every receipt as the
   * control for Li et al. 2021: without it we bill maintainer latency to the
   * contributor. §4.
   */
  projectHoursToFirstReview: number | null;

  /** Timeline was longer than the per-PR cap, so booleans may under-report. §10.8 */
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Sources — one fetch each. Every signal reads exactly one. §9.2
// ---------------------------------------------------------------------------

export type SourceId = 'receipts' | 'prCounts' | 'userProfile' | 'vouch';

export interface PrCounts {
  mergedPrsThisRepo: number;
  authorAssociation: string;
  /** Split by WHO merged and WHOSE repo — a raw merged count is inflatable. §7.3 */
  selfMergeOwn: number;
  selfMergeExternal: number;
  mergedByOthersOwn: number;
  mergedByOthersExternal: number;
  /**
   * Distinct external repos where they merged their own PR. Commit rights on
   * five repos is a different claim from five self-merges on one repo. §7.3
   */
  uniqueSelfMergeRepos: number;
  /**
   * Denominator for the merge rate, from the SAME sample as the numerator.
   * `externalPrsClosed` below is the uncapped lifetime figure and is shown as a
   * disclosure ("sampled N of M"), never used as a denominator. §7.3
   */
  sampledExternalClosed: number;
  sampleSize: number;
  externalPrsClosed: number;
  externalPrsMerged: number;
  uniqueMergers: number;
  issuesOpenedHere: number;
  recentPrCount: number;
  linkedIssuePrs: number;
}

export interface UserProfile {
  activeYears: number;
  reviewsGiven: number;
  accountAgeDays: number;
  followers: number;
  hasStandingFlag: boolean;
  /** Contributions we cannot see. Say so rather than misreading private work. §10.8 */
  restrictedContributions: number;
}

/** Positive only. A denouncement surface is an abuse vector we do not need. 00a77.2 */
export type VouchStatus = 'vouched' | 'none';

export interface Vouch {
  status: VouchStatus;
  reason: string | null;
  by: string | null;
}

/** What a fetch produces. Absent means "not fetched", which scores as null. */
export interface SourceData {
  receipts?: Receipt[];
  prCounts?: PrCounts;
  userProfile?: UserProfile;
  vouch?: Vouch;
}

// ---------------------------------------------------------------------------
// Signals
// ---------------------------------------------------------------------------

export type SignalValue = number | string | boolean | null;

export interface SignalDef<S extends SourceId = SourceId> {
  source: S;
  label: string;
  compute: (data: NonNullable<SourceData[S]>) => SignalValue;
  /** The receipts that justify the value, for click-through. Returned, never smuggled. */
  evidence?: (data: NonNullable<SourceData[S]>) => Receipt[];
}

/**
 * A signal definition for SOME source, with `compute` narrowed to that source's
 * payload. Distributing over SourceId is what keeps `compute` typed per entry;
 * `SignalDef<SourceId>` would widen every payload to the union and lose it.
 */
export type AnySignalDef = { [S in SourceId]: SignalDef<S> }[SourceId];

export type SignalValues = Record<string, SignalValue>;
export type SignalEvidence = Record<string, Receipt[]>;

// ---------------------------------------------------------------------------
// Profile — config, not code. §7
// ---------------------------------------------------------------------------

export interface Tier {
  gte?: number;
  lt?: number;
  eq?: string | boolean;
  points: number;
  label: string;
}

/** The only off-switch. Two booleans allowed an invalid combination. §7.1 */
export type RuleMode = 'score' | 'info' | 'off';

/**
 * How well supported a signal is, strongest first. About PROVENANCE of the
 * evidence, never confidence in a person. Levels in NEEDS_CAVEAT render a
 * warning in the breakdown. §11
 */
export const EVIDENCE_LEVELS = [
  'strong', // replicated in peer-reviewed work
  'supported', // published; single study or narrow context
  'moderate', // published but contested effect size
  'controls-confound', // derived to control for a known confound, not measured
  'practitioner', // widely-used practice, no formal study
  'contested', // published evidence points both ways
  'novel', // ours, unvalidated
] as const;

export type EvidenceLevel = (typeof EVIDENCE_LEVELS)[number];

export interface Rule {
  id: string;
  group: string;
  signal: string;
  mode: RuleMode;
  evidence?: EvidenceLevel;
  note?: string;
  tiers: Tier[];
}

export interface Group {
  id: string;
  label: string;
  importance: number;
  aboveFold: boolean;
  /** Absence of history is never a penalty. Config, not a branch on a group name. */
  floorAtZero?: boolean;
}

export interface Band {
  gtePct: number;
  label: string;
}

export interface Profile {
  id: string;
  name: string;
  groups: Group[];
  rules: Rule[];
  bands: Band[];
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export interface ScoreLine {
  rule: string;
  group: string;
  signal: string;
  raw: SignalValue;
  label: string;
  points: number;
  scored: boolean;
  evidence: Rule['evidence'] | null;
}

export interface ScoreResult {
  total: number;
  band: string;
  lines: ScoreLine[];
  /** Bands are a fraction of this, not absolute points. §7.1 */
  maxAchievable: number;
  ratio: number;
  /**
   * Human labels for active scoring signals that came back `null`. Shown so
   * "could not measure" is never mistaken for "measured, worth nothing". §7.1
   */
  unmeasured: string[];
}

// ---------------------------------------------------------------------------
// Messaging — the content script asks, the background answers. It never holds
// the token and never makes a network call. §9
// ---------------------------------------------------------------------------

export interface SignalsRequest {
  kind: 'signals';
  repo: string;
  /**
   * The PR being viewed. Excluded from its own history — an open PR nobody has
   * reviewed yet would otherwise be counted as a receipt where the author
   * "never replied", scoring the very thing we are being asked to judge.
   */
  prNumber: number;
  /** Bypass cache for this author. FR: manual refresh. */
  refresh?: boolean;
}

export type PanelState = 'evidence' | 'no-read' | 'error' | 'bot';

export type ErrorCode =
  | 'no-token'
  | 'no-author'
  | 'token-invalid'
  | 'token-scope'
  | 'rate-limited'
  | 'network'
  /**
   * The content script outlived the background that injected it — the
   * extension was updated or reloaded under an open tab. Only the content
   * script can raise this; the background is by definition gone.
   */
  | 'disconnected'
  /** A fault inside this extension, kept distinct so it is never blamed on GitHub. */
  | 'crashed';

export interface SignalsResponse {
  state: PanelState;
  /**
   * Who this is about. Resolved by the background from the API — the content
   * script asks about a pull request, not a person, and learns the name here.
   */
  login: string;
  repo: string;
  /** Echoed back so the panel can tell a late reply from a relevant one. */
  prNumber: number;
  signals: SignalValues;
  evidence: SignalEvidence;
  result: ScoreResult | null;
  /** Sample window actually used, for the "Based on N PRs" line. */
  sampled: number;
  fetchedAt: number;
  stale: boolean;
  /**
   * GitHub returned data but refused part of it — almost always an org this
   * token is not SAML-authorised for. Disclosed rather than dropped: a smaller
   * sample with no explanation reads as "this person has done less". §7.1
   */
  withheld: { count: number; reason: 'saml' | 'forbidden' } | null;
  /**
   * `code` selects what the user is told; the panel owns that wording. `detail`
   * is GitHub's own text, carried through only when it says something the code
   * cannot — which rejection, which resource. Omitted when it would only
   * restate the code, so the panel never prints the same sentence twice.
   */
  error?: { code: ErrorCode; detail?: string };
}
