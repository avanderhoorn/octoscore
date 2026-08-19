import { PROSE_MIN_CHARS, TIMELINE_CAP } from '../scoring/signals';
import type { PrOutcome, Receipt } from '../shared/types';
import type { ActorRef, ReceiptPr, TimelineNode } from './nodes';

// ---------------------------------------------------------------------------
// timelineItems -> Receipt[]. The file most likely to be wrong. §10.3
//
// Correctness rules, each of which has a test:
//   - Exclude the author's own comments when deciding "was this reviewed".
//   - Exclude bot actors. A PR whose only comment came from a linter did not
//     receive review.
//   - Record projectHoursToFirstReview even when the author responded promptly.
//   - Two anchors, not one. Whether the author RESPONDED is measured from the
//     first reviewer engagement; whether they ANSWERED is measured from the
//     first reviewer QUESTION. A long comment posted before a later question
//     does not answer it.
//   - A truncated timeline yields unknown, never "they never replied".
//
// Timestamps: comments, reviews and force-pushes carry a real `createdAt`.
// Commits do not — `PullRequestCommit` exposes neither `createdAt` nor `actor`
// (see nodes.ts), so ordering comes from `commit.committedDate`. Rebase and
// amend rewrite that, but only ever LATER, and a rebase is itself a push. So it
// can mildly over-report "pushed after review"; it cannot under-report.
// ---------------------------------------------------------------------------

export type { ReceiptPr, TimelineNode } from './nodes';

const HOUR = 1000 * 60 * 60;

export const isBot = (a?: ActorRef | null): boolean =>
  a?.__typename === 'Bot' || Boolean(a?.login?.endsWith('[bot]'));

const login = (a?: ActorRef | null): string => (a?.login ?? '').toLowerCase();

/**
 * When the node happened. `NaN` when we cannot tell, and callers drop those
 * rather than sorting them to the epoch.
 */
const time = (n: TimelineNode): number =>
  n.__typename === 'PullRequestCommit'
    ? Date.parse(String(n.commit.committedDate ?? ''))
    : Date.parse(String(n.createdAt ?? ''));

const isComment = (
  n: TimelineNode,
): n is Extract<TimelineNode, { __typename: 'IssueComment' | 'PullRequestReview' }> =>
  n.__typename === 'IssueComment' || n.__typename === 'PullRequestReview';

/** A human, not the author, saying something. This is what "reviewed" means. */
const isReviewerEngagement = (n: TimelineNode, author: string): boolean =>
  isComment(n) &&
  !isBot(n.author) &&
  login(n.author) !== author &&
  login(n.author) !== '';

const isAuthorComment = (n: TimelineNode, author: string): boolean =>
  isComment(n) && login(n.author) === author;

/**
 * The author pushing. Attribution must be positive: a maintainer rebasing or
 * pushing a fixup onto the branch is not the contributor responding. There is
 * deliberately no "unknown actor counts as the author" fallback — that is what
 * previously let any commit be attributed to the contributor.
 */
const isAuthorPush = (n: TimelineNode, author: string): boolean => {
  if (n.__typename === 'PullRequestCommit') {
    return login(n.commit.author?.user) === author;
  }
  if (n.__typename === 'HeadRefForcePushedEvent') return login(n.actor) === author;
  return false;
};

const outcomeOf = (pr: ReceiptPr): PrOutcome =>
  pr.merged ? 'merged' : pr.closed ? 'closed-unmerged' : 'open';

/**
 * A question mark is a crude proxy, but an explicit one. Reviews that request
 * changes count regardless: "please rename this" is a request even without a ?.
 */
const asksSomething = (n: TimelineNode): boolean =>
  isComment(n) &&
  (Boolean(n.bodyText?.includes('?')) ||
    (n.__typename === 'PullRequestReview' && n.state === 'CHANGES_REQUESTED'));

const isProse = (n: TimelineNode): boolean =>
  isComment(n) && (n.bodyText?.trim().length ?? 0) >= PROSE_MIN_CHARS;

const sizeOf = (pr: ReceiptPr): number | null =>
  pr.additions == null && pr.deletions == null
    ? null
    : (pr.additions ?? 0) + (pr.deletions ?? 0);

// A repo that runs no checks reports null, not failure. Absence of CI is not
// evidence about the contributor. §7.1
const ciOf = (pr: ReceiptPr): boolean | null => {
  const state = pr.commits?.nodes?.[0]?.commit?.statusCheckRollup?.state;
  if (state === 'SUCCESS') return true;
  if (state === 'FAILURE' || state === 'ERROR') return false;
  return null;
};

export function toReceipt(pr: ReceiptPr): Receipt {
  const author = login(pr.author);
  const truncated = pr.timelineItems.totalCount > TIMELINE_CAP;

  const nodes = (pr.timelineItems.nodes ?? [])
    .filter((n): n is TimelineNode => n != null && Number.isFinite(time(n)))
    .sort((a, b) => time(a) - time(b));

  const engagements = nodes.filter((n) => isReviewerEngagement(n, author));
  const firstEngagement = engagements[0];
  const firstQuestion = engagements.find(asksSomething);

  // Recorded even when the author responded promptly — it is the control for
  // maintainer latency, not a fallback. §8
  const projectHoursToFirstReview = firstEngagement
    ? (time(firstEngagement) - Date.parse(pr.createdAt)) / HOUR
    : null;

  let authorRepliedAfter = false;
  let authorPushedAfter = false;
  let authorReplyWasProse = false;
  let hoursToAuthorResponse: number | null = null;

  if (firstEngagement) {
    const after = nodes.filter((n) => time(n) > time(firstEngagement));
    const replies = after.filter((n) => isAuthorComment(n, author));
    const pushes = after.filter((n) => isAuthorPush(n, author));

    authorRepliedAfter = replies.length > 0;
    authorPushedAfter = pushes.length > 0;

    // Anchored to the QUESTION, not to first contact: answering requires
    // something to answer.
    authorReplyWasProse =
      firstQuestion != null &&
      nodes.some(
        (n) => time(n) > time(firstQuestion) && isAuthorComment(n, author) && isProse(n),
      );

    const firstResponse = [...replies, ...pushes].sort((a, b) => time(a) - time(b))[0];
    if (firstResponse) {
      hoursToAuthorResponse = (time(firstResponse) - time(firstEngagement)) / HOUR;
    }
  }

  return {
    prUrl: pr.url,
    prTitle: pr.title,
    repo: pr.repository.nameWithOwner,
    number: pr.number,
    createdAt: pr.createdAt,
    outcome: outcomeOf(pr),
    reviewerEngaged: engagements.length > 0,
    reviewerAskedQuestion: firstQuestion != null,
    authorPushedAfter,
    authorRepliedAfter,
    authorReplyWasProse,
    sizeLines: sizeOf(pr),
    ciPassed: ciOf(pr),
    hoursToAuthorResponse,
    projectHoursToFirstReview,
    truncated,
  };
}

/** Shape every PR the search returned. Author-global, so it is what gets cached. */
export const toReceipts = (prs: ReceiptPr[]): Receipt[] => prs.map(toReceipt);

/**
 * The PR being viewed never appears in its own history: it is usually open and
 * un-reviewed, which would read as "engaged but never replied" and score the
 * exact PR the maintainer is asking about. The search over-fetches by one so
 * removing it still leaves a full window.
 *
 * This runs at READ time, not fetch time, and that is load-bearing. Receipts
 * are cached per author and reused across every PR you open, so an exclusion
 * baked into the stored payload would be the wrong PR's exclusion on the very
 * next page view — the cache would silently reintroduce the bug this prevents.
 */
export const sample = (
  receipts: Receipt[],
  exclude: { repo: string; number: number },
  window: number,
): Receipt[] =>
  receipts
    .filter(
      (r) =>
        r.number !== exclude.number ||
        r.repo.toLowerCase() !== exclude.repo.toLowerCase(),
    )
    .slice(0, window);
