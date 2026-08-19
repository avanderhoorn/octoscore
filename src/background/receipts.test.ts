import { describe, expect, it } from 'vitest';
import type { ReceiptPr, TimelineNode } from './nodes';
import { isBot, toReceipt } from './receipts';

// ---------------------------------------------------------------------------
// Builders. Times are hours from a fixed origin so the tests read as a story.
// ---------------------------------------------------------------------------

const T0 = Date.parse('2024-03-01T00:00:00Z');
const at = (h: number) => new Date(T0 + h * 3600_000).toISOString();

const comment = (h: number, who: string, body = 'ok'): TimelineNode => ({
  __typename: 'IssueComment',
  createdAt: at(h),
  bodyText: body,
  author: { __typename: 'User', login: who },
});

const review = (
  h: number,
  who: string,
  state: 'COMMENTED' | 'CHANGES_REQUESTED' | 'APPROVED' = 'COMMENTED',
  body = 'looks fine',
): TimelineNode => ({
  __typename: 'PullRequestReview',
  createdAt: at(h),
  bodyText: body,
  state,
  author: { __typename: 'User', login: who },
});

/** A pushed commit. No createdAt and no actor exist on this node — see nodes.ts. */
const push = (h: number, who: string | null): TimelineNode => ({
  __typename: 'PullRequestCommit',
  commit: {
    committedDate: at(h),
    author: who ? { user: { __typename: 'User', login: who } } : null,
  },
});

const forcePush = (h: number, who: string): TimelineNode => ({
  __typename: 'HeadRefForcePushedEvent',
  createdAt: at(h),
  actor: { __typename: 'User', login: who },
});

const pr = (nodes: TimelineNode[], over: Partial<ReceiptPr> = {}): ReceiptPr => ({
  number: 7,
  title: 'Add a thing',
  url: 'https://github.com/acme/core/pull/7',
  createdAt: at(0),
  merged: true,
  closed: true,
  repository: { nameWithOwner: 'acme/core' },
  author: { __typename: 'User', login: 'alice' },
  timelineItems: { nodes, totalCount: nodes.length },
  ...over,
});

const LONG = 'x'.repeat(200);

// ---------------------------------------------------------------------------

describe('pushes are detected at all', () => {
  // Regression: PullRequestCommit carries neither createdAt nor actor, so an
  // extractor that filtered on createdAt dropped every push and reported that
  // nobody ever responded. This is the defect that motivated nodes.ts.

  it('sees an ordinary commit pushed after review', () => {
    const r = toReceipt(pr([review(10, 'maintainer'), push(12, 'alice')]));
    expect(r.reviewerEngaged).toBe(true);
    expect(r.authorPushedAfter).toBe(true);
    expect(r.hoursToAuthorResponse).toBe(2);
  });

  it('orders commits by committedDate, not by position', () => {
    const r = toReceipt(pr([push(20, 'alice'), review(10, 'maintainer')]));
    expect(r.authorPushedAfter).toBe(true);
  });

  it('ignores a commit pushed before the review', () => {
    const r = toReceipt(pr([push(2, 'alice'), review(10, 'maintainer')]));
    expect(r.authorPushedAfter).toBe(false);
  });

  it('still counts a force push', () => {
    const r = toReceipt(pr([review(10, 'maintainer'), forcePush(11, 'alice')]));
    expect(r.authorPushedAfter).toBe(true);
  });
});

describe('push attribution', () => {
  it('does not credit the author for a maintainer\u2019s commit', () => {
    const r = toReceipt(pr([review(10, 'maintainer'), push(12, 'maintainer')]));
    expect(r.authorPushedAfter).toBe(false);
  });

  it('does not credit the author for an unattributable commit', () => {
    // commit.author.user is null when the git email maps to no GitHub account.
    // Guessing "probably the author" is how a maintainer's rebase became the
    // contributor's follow-through.
    const r = toReceipt(pr([review(10, 'maintainer'), push(12, null)]));
    expect(r.authorPushedAfter).toBe(false);
  });

  it('does not credit the author for a maintainer force push', () => {
    const r = toReceipt(pr([review(10, 'maintainer'), forcePush(12, 'maintainer')]));
    expect(r.authorPushedAfter).toBe(false);
  });

  it('compares logins case-insensitively', () => {
    const r = toReceipt(pr([review(10, 'Maintainer'), push(12, 'ALICE')]));
    expect(r.authorPushedAfter).toBe(true);
  });
});

describe('what counts as review', () => {
  it('ignores the author talking to themselves', () => {
    const r = toReceipt(pr([comment(1, 'alice'), comment(2, 'alice', LONG)]));
    expect(r.reviewerEngaged).toBe(false);
    expect(r.authorRepliedAfter).toBe(false);
  });

  it('ignores bots by typename and by login suffix', () => {
    const botTyped: TimelineNode = {
      __typename: 'IssueComment',
      createdAt: at(1),
      bodyText: 'coverage fell',
      author: { __typename: 'Bot', login: 'codecov' },
    };
    expect(toReceipt(pr([botTyped])).reviewerEngaged).toBe(false);
    expect(toReceipt(pr([comment(1, 'dependabot[bot]')])).reviewerEngaged).toBe(false);
  });

  it('ignores an actor with no login', () => {
    const ghost: TimelineNode = {
      __typename: 'IssueComment',
      createdAt: at(1),
      bodyText: 'hi',
      author: null,
    };
    expect(toReceipt(pr([ghost])).reviewerEngaged).toBe(false);
  });

  it('isBot recognises both shapes', () => {
    expect(isBot({ __typename: 'Bot', login: 'x' })).toBe(true);
    expect(isBot({ login: 'renovate[bot]' })).toBe(true);
    expect(isBot({ __typename: 'User', login: 'alice' })).toBe(false);
    expect(isBot(null)).toBe(false);
  });
});

describe('questions and answers', () => {
  it('treats a question mark as a question', () => {
    expect(toReceipt(pr([comment(1, 'm', 'why this way?')])).reviewerAskedQuestion).toBe(
      true,
    );
  });

  it('treats CHANGES_REQUESTED as a question even without a question mark', () => {
    const r = toReceipt(pr([review(1, 'm', 'CHANGES_REQUESTED', 'please rename this.')]));
    expect(r.reviewerAskedQuestion).toBe(true);
  });

  it('does not treat plain approval as a question', () => {
    expect(
      toReceipt(pr([review(1, 'm', 'APPROVED', 'nice')])).reviewerAskedQuestion,
    ).toBe(false);
  });

  it('anchors prose to the QUESTION, not to first contact', () => {
    // The load-bearing case. A long comment posted before the question does
    // not answer it, however long it is.
    const r = toReceipt(
      pr([
        comment(1, 'maintainer', 'thanks for this'), // engagement, no question
        comment(2, 'alice', LONG), // long, but answers nothing
        comment(5, 'maintainer', 'why did you drop the cache?'), // the question
      ]),
    );
    expect(r.reviewerAskedQuestion).toBe(true);
    expect(r.authorRepliedAfter).toBe(true);
    expect(r.authorReplyWasProse).toBe(false);
  });

  it('counts prose posted after the question', () => {
    const r = toReceipt(
      pr([
        comment(1, 'maintainer', 'thanks for this'),
        comment(5, 'maintainer', 'why did you drop the cache?'),
        comment(6, 'alice', LONG),
      ]),
    );
    expect(r.authorReplyWasProse).toBe(true);
  });

  it('does not count a terse reply as prose', () => {
    const r = toReceipt(pr([comment(1, 'm', 'why?'), comment(2, 'alice', 'done')]));
    expect(r.authorRepliedAfter).toBe(true);
    expect(r.authorReplyWasProse).toBe(false);
  });

  it('never claims prose when nothing was asked', () => {
    const r = toReceipt(pr([comment(1, 'm', 'thanks'), comment(2, 'alice', LONG)]));
    expect(r.reviewerAskedQuestion).toBe(false);
    expect(r.authorReplyWasProse).toBe(false);
  });
});

describe('the project as control', () => {
  it('records how long the project took even when the author was fast', () => {
    const r = toReceipt(pr([review(72, 'maintainer'), comment(73, 'alice', LONG)]));
    expect(r.projectHoursToFirstReview).toBe(72);
    expect(r.hoursToAuthorResponse).toBe(1);
  });

  it('reports unknown, not zero, when nobody ever looked', () => {
    const r = toReceipt(pr([push(1, 'alice')]));
    expect(r.projectHoursToFirstReview).toBeNull();
    expect(r.hoursToAuthorResponse).toBeNull();
    expect(r.reviewerEngaged).toBe(false);
  });

  it('measures author response from first engagement', () => {
    const r = toReceipt(pr([review(10, 'm'), review(20, 'm2'), comment(30, 'alice')]));
    expect(r.hoursToAuthorResponse).toBe(20);
  });
});

describe('robustness', () => {
  it('drops nodes with unparseable timestamps rather than producing NaN', () => {
    const broken: TimelineNode = {
      __typename: 'IssueComment',
      createdAt: 'not a date',
      bodyText: 'hi',
      author: { __typename: 'User', login: 'maintainer' },
    };
    const r = toReceipt(pr([broken, review(10, 'maintainer'), comment(12, 'alice')]));
    expect(r.projectHoursToFirstReview).toBe(10);
    expect(Number.isNaN(r.hoursToAuthorResponse)).toBe(false);
  });

  it('handles an empty timeline', () => {
    const r = toReceipt(pr([]));
    expect(r.reviewerEngaged).toBe(false);
    expect(r.truncated).toBe(false);
  });

  it('reports outcome from the PR, not from timeline events', () => {
    expect(toReceipt(pr([], { merged: true, closed: true })).outcome).toBe('merged');
    expect(toReceipt(pr([], { merged: false, closed: true })).outcome).toBe(
      'closed-unmerged',
    );
    expect(toReceipt(pr([], { merged: false, closed: false })).outcome).toBe('open');
  });
});

describe('truncation', () => {
  it('flags a timeline longer than the cap', () => {
    const r = toReceipt(
      pr([comment(1, 'm')], { timelineItems: { nodes: [], totalCount: 500 } }),
    );
    expect(r.truncated).toBe(true);
  });

  it('does not flag a timeline at the cap', () => {
    const r = toReceipt(pr([], { timelineItems: { nodes: [], totalCount: 100 } }));
    expect(r.truncated).toBe(false);
  });
});

describe('patch size and CI', () => {
  it('sizes a PR as additions plus deletions', () => {
    expect(toReceipt(pr([], { additions: 40, deletions: 12 })).sizeLines).toBe(52);
  });

  it('reports null rather than zero when GitHub withheld the counts', () => {
    expect(toReceipt(pr([])).sizeLines).toBeNull();
  });

  it('reads the rollup of the last commit', () => {
    const ci = (state?: string) =>
      pr([], {
        commits: { nodes: [{ commit: { statusCheckRollup: state ? { state } : null } }] },
      });
    expect(toReceipt(ci('SUCCESS')).ciPassed).toBe(true);
    expect(toReceipt(ci('FAILURE')).ciPassed).toBe(false);
    expect(toReceipt(ci('ERROR')).ciPassed).toBe(false);
  });

  it('treats a repo with no checks as unknown, not as failure', () => {
    expect(toReceipt(pr([])).ciPassed).toBeNull();
    expect(toReceipt(pr([], { commits: { nodes: [] } })).ciPassed).toBeNull();
  });

  it('does not call a pending run a failure', () => {
    const pending = pr([], {
      commits: { nodes: [{ commit: { statusCheckRollup: { state: 'PENDING' } } }] },
    });
    expect(toReceipt(pending).ciPassed).toBeNull();
  });
});
