import { DEFAULT_WINDOW, TIMELINE_CAP } from '../scoring/signals';
import type {
  PrCounts,
  SourceId,
  UserProfile,
  Vouch,
  VouchStatus,
} from '../shared/types';
import type { MergeSplitPr, ReceiptPr } from './nodes';
import { toReceipts } from './receipts';

// ---------------------------------------------------------------------------
// All GitHub access. One builder per source; the router composes the ones the
// profile actually asked for into ONE request. §10.2
//
// GitHub's GraphQL limit is a complexity model with +1 overhead per REQUEST, so
// batching sources into a single document saves more than any node-count
// tuning. Every query therefore carries `rateLimit { cost remaining limit }` and we
// record what it actually costs rather than estimating.
// ---------------------------------------------------------------------------

const ENDPOINT = 'https://api.github.com/graphql';

export class GitHubError extends Error {
  constructor(
    readonly code:
      | 'no-token'
      | 'token-invalid'
      | 'token-scope'
      | 'rate-limited'
      | 'network',
    message: string,
  ) {
    super(message);
    this.name = 'GitHubError';
  }
}

export interface RateCost {
  cost: number;
  remaining: number;
  /**
   * Asked for rather than assumed. The documented figure is 5,000/hr, but a
   * `gh` CLI token measured against live GitHub reported 9,999 remaining — the
   * ceiling varies by token type, so hardcoding one prints a wrong denominator.
   */
  limit: number;
}

/**
 * Data GitHub refused to return inside an otherwise successful response.
 *
 * This is not an edge case. GraphQL is explicitly partial: a response can carry
 * `data` AND `errors`, with the forbidden nodes nulled out and everything else
 * intact. The common cause is SAML single sign-on — if the author has ever
 * contributed to a SAML-enforced org that your token is not authorised for,
 * those PRs come back `null` while the other 27 of 30 are perfectly good.
 *
 * Treating that as a hard failure breaks the extension for most people who work
 * at a company. Silently dropping the nulls is worse: the sample quietly shrinks
 * and the author's record is under-reported with no indication why, which is the
 * exact dishonesty the panel exists to avoid. So we keep the data AND count what
 * was withheld, and the panel says so. §7.1
 */
export interface Withheld {
  count: number;
  reason: 'saml' | 'forbidden';
}

interface GraphQLError {
  type?: string;
  message: string;
  extensions?: { saml_failure?: boolean };
}

export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  token: string,
): Promise<{ data: T; rate: RateCost | null; withheld: Withheld | null }> {
  if (!token) throw new GitHubError('no-token', 'No GitHub token configured.');

  let res: Response;
  try {
    res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'GraphQL-Features': 'issue_types',
      },
      body: JSON.stringify({ query, variables }),
    });
  } catch (e) {
    throw new GitHubError('network', `Could not reach api.github.com: ${String(e)}`);
  }

  if (res.status === 401) throw new GitHubError('token-invalid', 'Token rejected (401).');
  if (res.status === 403 || res.status === 429) {
    throw new GitHubError('rate-limited', 'GitHub rate limit reached.');
  }
  if (!res.ok) throw new GitHubError('network', `GitHub returned ${res.status}.`);

  const body = (await res.json()) as {
    data?: T & { rateLimit?: RateCost };
    errors?: GraphQLError[];
  };

  let withheld: Withheld | null = null;

  if (body.errors?.length) {
    const first = body.errors[0] as GraphQLError;

    // Rate limiting is never partial — there is nothing usable behind it.
    if (first.type === 'RATE_LIMITED') {
      throw new GitHubError('rate-limited', first.message);
    }

    // FORBIDDEN is a refusal: something exists and we are not allowed to see it.
    // NOT_FOUND is an absence, and on GitHub it is the ordinary reply for an
    // optional field — no VOUCHED.td, a deleted PR, a renamed repo. Both are
    // survivable, but only the first is worth telling the maintainer about.
    const refused = body.errors.filter((e) => e.type === 'FORBIDDEN');
    const absent = body.errors.filter((e) => e.type === 'NOT_FOUND');

    if (body.data && refused.length + absent.length === body.errors.length) {
      // Partial response with usable data: keep it. Disclose only the refusals.
      // Reporting absences here made the panel cry wolf on every single author
      // in a live calibration run, which is how a disclosure becomes noise.
      withheld = refused.length
        ? {
            count: refused.length,
            reason: refused.some((e) => e.extensions?.saml_failure)
              ? 'saml'
              : 'forbidden',
          }
        : null;
    } else if (refused.length || absent.length) {
      // Fine-grained tokens bind to ONE resource owner, so a cross-org read
      // fails here rather than at validation time. §10.4
      throw new GitHubError('token-scope', first.message);
    } else {
      throw new GitHubError('network', first.message);
    }
  }
  if (!body.data) throw new GitHubError('network', 'Empty response from GitHub.');

  return { data: body.data, rate: body.data.rateLimit ?? null, withheld };
}

// ---------------------------------------------------------------------------
// Fragments
// ---------------------------------------------------------------------------

const PR_WITH_TIMELINE = `
  number title url createdAt merged closed
  additions deletions
  repository { nameWithOwner owner { login } }
  author { __typename login }
  commits(last: 1) {
    nodes { commit { statusCheckRollup { state } } }
  }
  timelineItems(
    first: ${TIMELINE_CAP}
    itemTypes: [
      PULL_REQUEST_COMMIT, ISSUE_COMMENT, PULL_REQUEST_REVIEW,
      HEAD_REF_FORCE_PUSHED_EVENT
    ]
  ) {
    totalCount
    nodes {
      __typename
      ... on IssueComment      { createdAt bodyText author { __typename login } }
      ... on PullRequestReview { createdAt bodyText state author { __typename login } }
      ... on PullRequestCommit {
        commit {
          committedDate
          author { user { __typename login } }
        }
      }
      ... on HeadRefForcePushedEvent { createdAt actor { __typename login } }
    }
  }`;

const MERGE_SPLIT_PR = `
  number
  merged
  repository { nameWithOwner owner { login } }
  mergedBy { __typename login }`;

// ---------------------------------------------------------------------------
// One builder per source. Each returns { query, pick } so the router can splice
// them into a single document and pull its own slice back out.
// ---------------------------------------------------------------------------

export const SOURCE_QUERIES: Record<SourceId, (window: number) => string> = {
  receipts: (window) => `
    receipts: search(query: $prSearch, type: ISSUE, first: ${window}) {
      nodes { ... on PullRequest { ${PR_WITH_TIMELINE} } }
    }`,

  prCounts: () => `
    currentPr: repository(owner: $owner, name: $name) {
      pullRequest(number: $prNumber) { authorAssociation }
    }
    mergedHere:      search(query: $mergedHere,   type: ISSUE, first: 1) { issueCount }
    issuesHere:      search(query: $issuesHere,   type: ISSUE, first: 1) { issueCount }
    externalClosed:  search(query: $extClosed,    type: ISSUE, first: 1) { issueCount }
    externalMerged:  search(query: $extMerged,    type: ISSUE, first: 1) { issueCount }
    linkedIssues:    search(query: $linked,       type: ISSUE, first: 1) { issueCount }
    recentPrs:       search(query: $recentPrs,    type: ISSUE, first: 1) { issueCount }
    mergeSplit: search(query: $closedSample, type: ISSUE, first: 100) {
      nodes { ... on PullRequest { ${MERGE_SPLIT_PR} } }
    }`,

  userProfile: () => `
    user(login: $login) {
      login createdAt
      followers { totalCount }
      isSiteAdmin
      contributionsCollection {
        contributionYears
        restrictedContributionsCount
        totalPullRequestReviewContributions
      }
    }`,

  vouch: () => `
    repository(owner: $owner, name: $name) {
      object(expression: "HEAD:VOUCHED.td") { ... on Blob { text } }
    }`,
};

// ---------------------------------------------------------------------------
// VOUCHED.td — repo-root, one entry per line:  platform:user reason
// Last entry wins. Case-insensitive. §7.2
//
// POSITIVE ONLY, deliberately. A repo-authored file that publishes "this named
// person is untrustworthy", rendered by a third-party extension on that
// person's PRs, is a defamation and harassment surface with no upside we
// need: the design already treats absence of evidence as absence of evidence,
// so a denouncement adds nothing a maintainer cannot express by not merging.
// A leading '-' is therefore parsed and IGNORED rather than silently treated
// as a vouch. §7.2
//
// Deliberately the same filename GitBaz uses: a shared convention beats a
// private one. §15
// ---------------------------------------------------------------------------

export function parseVouch(text: string | null | undefined, login: string): Vouch {
  if (!text) return { status: 'none', reason: null, by: null };
  const want = login.toLowerCase();
  let status: VouchStatus = 'none';
  let reason: string | null = null;

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const m = /^(-?)\s*([A-Za-z]+):([\w-]+)\s*(.*)$/.exec(t);
    if (!m) continue;
    const [, minus, platform, user, note] = m;
    if (platform?.toLowerCase() !== 'github') continue;
    if (user?.toLowerCase() !== want) continue;
    status = minus ? 'none' : 'vouched';
    reason = minus ? null : note?.trim() || null;
  }
  return { status, reason, by: null };
}

// ---------------------------------------------------------------------------
// Shaping raw GraphQL into source payloads
// ---------------------------------------------------------------------------

const DAY = 1000 * 60 * 60 * 24;

export function shapeUserProfile(u: {
  createdAt: string;
  followers: { totalCount: number };
  isSiteAdmin: boolean;
  contributionsCollection: {
    contributionYears: number[];
    restrictedContributionsCount: number;
    totalPullRequestReviewContributions: number;
  };
}): UserProfile {
  return {
    // contributionsCollection accepts a 1-year window max; tenure comes from
    // contributionYears in the same call. §10.8
    activeYears: u.contributionsCollection.contributionYears.length,
    reviewsGiven: u.contributionsCollection.totalPullRequestReviewContributions,
    accountAgeDays: Math.floor((Date.now() - Date.parse(u.createdAt)) / DAY),
    followers: u.followers.totalCount,
    hasStandingFlag: false,
    restrictedContributions: u.contributionsCollection.restrictedContributionsCount,
  };
}

export interface MergeSplitNode {
  repository: { owner: { login: string } };
  mergedBy?: { login?: string | null } | null;
}

/**
 * Split a sample of CLOSED PRs by WHO merged and WHOSE repo. A raw merged count
 * is inflatable to any number by merging your own PRs in your own repos, and a
 * naive merge rate is worse — self-merges are ~100% successful and drag the
 * ratio up. §7.3
 *
 * The sample is the author's last 100 closed PRs. Every number below is derived
 * from that ONE population, so the merge rate's numerator and denominator
 * always describe the same set of PRs. (An uncapped `issueCount` denominator
 * against a capped numerator reads a 400-of-500 contributor as 100-of-500 and
 * penalises the strongest possible record — see §7.3.)
 */
/**
 * `(MergeSplitPr | null)[]` is not defensive typing — it is what GitHub
 * actually returns. A repo the token cannot see under SAML comes back as a
 * `null` element *inside* the array, not as a missing array, and reading
 * `.repository` off it throws. Verified against live data: 7 of 100 nodes were
 * null for a real contributor. Filtering happens here, once, so every caller is
 * safe rather than every caller having to remember. §10.2
 */
export function splitMerges(nodes: (MergeSplitPr | null)[], login: string) {
  const visible = nodes.filter((n): n is MergeSplitPr => n?.repository?.owner != null);
  const me = login.toLowerCase();
  let selfMergeOwn = 0;
  let selfMergeExternal = 0;
  let mergedByOthersOwn = 0;
  let mergedByOthersExternal = 0;
  let sampledExternalClosed = 0;
  const mergers = new Set<string>();
  const selfMergeRepos = new Set<string>();

  for (const n of visible) {
    const own = (n.repository.owner.login ?? '').toLowerCase() === me;
    if (!own) sampledExternalClosed++;
    if (!n.merged) continue;

    const by = (n.mergedBy?.login ?? '').toLowerCase();
    const self = by === me;
    if (self && own) selfMergeOwn++;
    else if (self) {
      selfMergeExternal++;
      selfMergeRepos.add(n.repository.nameWithOwner.toLowerCase());
    } else if (own) mergedByOthersOwn++;
    else {
      mergedByOthersExternal++;
      if (by) mergers.add(by);
    }
  }
  // Breadth of trust, not volume: 20 PRs merged by one person counts once. §7.2
  return {
    selfMergeOwn,
    selfMergeExternal,
    mergedByOthersOwn,
    mergedByOthersExternal,
    sampledExternalClosed,
    uniqueMergers: mergers.size,
    uniqueSelfMergeRepos: selfMergeRepos.size,
    // What we could SEE, not what we asked for. Counting hidden PRs in the
    // denominator would silently depress every rate derived from this sample.
    sampleSize: visible.length,
  };
}

export function shapePrCounts(
  d: {
    mergedHere: { issueCount: number };
    issuesHere: { issueCount: number };
    externalClosed: { issueCount: number };
    externalMerged: { issueCount: number };
    linkedIssues: { issueCount: number };
    recentPrs: { issueCount: number };
    mergeSplit: { nodes: MergeSplitPr[] };
  },
  login: string,
  authorAssociation: string,
): PrCounts {
  return {
    mergedPrsThisRepo: d.mergedHere.issueCount,
    authorAssociation,
    ...splitMerges(d.mergeSplit.nodes ?? [], login),
    externalPrsClosed: d.externalClosed.issueCount,
    externalPrsMerged: d.externalMerged.issueCount,
    issuesOpenedHere: d.issuesHere.issueCount,
    recentPrCount: d.recentPrs.issueCount,
    linkedIssuePrs: d.linkedIssues.issueCount,
  };
}

// ---------------------------------------------------------------------------
// Search strings.
//
// `-user:X` excludes repos the author owns. Receipts are meant to answer "what
// happened when someone else reviewed this person" — a PR merged in your own
// sandbox has no reviewer in it, so it is not a receipt.
//
// `mergeSplit` deliberately does NOT exclude own repos: telling self-merges at
// home apart from work others merged is the whole point of that sample. §7.3
// ---------------------------------------------------------------------------

export const searchVars = (
  login: string,
  repo: string,
  prNumber: number,
  window = DEFAULT_WINDOW,
) => ({
  login,
  owner: repo.split('/')[0] ?? '',
  name: repo.split('/')[1] ?? '',
  prNumber,
  // Over-fetch by one: the PR being viewed is dropped before the window is cut.
  window: window + 1,
  prSearch: `author:${login} is:pr -user:${login} sort:created-desc`,
  mergedHere: `repo:${repo} author:${login} is:pr is:merged`,
  issuesHere: `repo:${repo} author:${login} is:issue`,
  extClosed: `author:${login} is:pr is:closed -user:${login}`,
  extMerged: `author:${login} is:pr is:merged -user:${login}`,
  closedSample: `author:${login} is:pr is:closed sort:created-desc`,
  linked: `author:${login} is:pr linked:issue`,
  recentPrs: `author:${login} is:pr`,
});

export { type MergeSplitPr, type ReceiptPr, toReceipts };

// ---------------------------------------------------------------------------
// Composing one request. GraphQL rejects declared-but-unused variables, so the
// variable list is derived from the sources being asked for — same principle as
// the fetch plan itself (§9.1): derived, never maintained by hand.
// ---------------------------------------------------------------------------

const SOURCE_VARS: Record<SourceId, string[]> = {
  receipts: ['prSearch'],
  prCounts: [
    'mergedHere',
    'issuesHere',
    'extClosed',
    'linked',
    'recentPrs',
    'extMerged',
    'closedSample',
    'owner',
    'name',
    'prNumber',
  ],
  userProfile: ['login'],
  vouch: ['owner', 'name'],
};

const VAR_TYPES: Record<string, string> = {
  login: 'String!',
  owner: 'String!',
  name: 'String!',
  prSearch: 'String!',
  mergedHere: 'String!',
  issuesHere: 'String!',
  extClosed: 'String!',
  linked: 'String!',
  recentPrs: 'String!',
  extMerged: 'String!',
  closedSample: 'String!',
  prNumber: 'Int!',
};

export function buildQuery(sources: Set<SourceId>, window = DEFAULT_WINDOW): string {
  const names = [...new Set([...sources].flatMap((s) => SOURCE_VARS[s]))];
  const decl = names.map((n) => `$${n}: ${VAR_TYPES[n]}`).join(', ');
  const body = [...sources].map((s) => SOURCE_QUERIES[s](window)).join('\n');
  return `query OctoScore${decl ? `(${decl})` : ''} {\n${body}\n  rateLimit { cost remaining limit }\n}`;
}

/**
 * Who opened this PR, according to GitHub.
 *
 * This is asked of the API rather than read off the page, and the reason is a
 * bug that shipped: the PR header names the *merger*, not the author, once a PR
 * is merged — "Youssef1313 merged 6 commits into dotnet:main from
 * snemeckayova:…". Every merged PR profiled the maintainer who pressed the
 * button instead of the contributor who wrote the code. An earlier variant of
 * the same bug credited every PR to the repository owner in the breadcrumb.
 *
 * The URL is the only thing the page is now trusted for, because it is the one
 * part that cannot be re-labelled by a redesign. Who the person IS comes from
 * the API, where the field is called `author` and means it.
 *
 * Query and shaper, not a fetching function, so the router stays the only
 * place that talks to the network — the same shape as every other source here.
 */
export const AUTHOR_QUERY = `query OctoScoreAuthor($owner: String!, $name: String!, $prNumber: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $prNumber) { author { __typename login } }
  }
}`;

export interface AuthorRaw {
  repository?: {
    pullRequest?: { author?: { __typename?: string; login?: string } | null } | null;
  } | null;
}

export interface PrAuthor {
  login: string;
  /**
   * GitHub's own answer, not a guess from the name.
   *
   * `author` is an `Actor`, so `__typename` distinguishes `Bot` from `User`
   * authoritatively. Guessing from the login misses every GitHub App that is
   * not named `*-bot` or `*[bot]` — dotnet-maestro, codecov, netlify — and the
   * panel then runs a person-shaped read on an app and reports "no reviewed
   * PRs found", which reads as "this contributor has no track record". FR7
   */
  bot: boolean;
}

/** `null` when GitHub has no author: a deleted account, or no such PR. */
export const pickAuthor = (d: AuthorRaw): PrAuthor | null => {
  const author = d?.repository?.pullRequest?.author;
  if (!author?.login) return null;
  return { login: author.login, bot: author.__typename === 'Bot' };
};

export const authorVars = (repo: string, prNumber: number) => {
  const [owner, name] = repo.split('/');
  return { owner, name, prNumber };
};

/** Only the variables the composed document actually declares. */
export function varsFor(
  sources: Set<SourceId>,
  all: ReturnType<typeof searchVars>,
): Record<string, unknown> {
  const names = new Set([...sources].flatMap((s) => SOURCE_VARS[s]));
  return Object.fromEntries(
    Object.entries(all).filter(([k]) => names.has(k as keyof typeof all & string)),
  );
}
