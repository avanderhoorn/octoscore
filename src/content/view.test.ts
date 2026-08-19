import { describe, expect, it } from 'vitest';
import type { Receipt, SignalsResponse } from '../shared/types';
import { buildView, humanHours, markOf } from './view';

const receipt = (o: Partial<Receipt> = {}): Receipt => ({
  prUrl: 'https://github.com/acme/core/pull/1',
  prTitle: 'Add a thing',
  repo: 'acme/core',
  number: 1,
  createdAt: '2024-03-01T00:00:00Z',
  outcome: 'merged',
  reviewerEngaged: true,
  reviewerAskedQuestion: false,
  authorPushedAfter: false,
  authorRepliedAfter: false,
  authorReplyWasProse: false,
  sizeLines: 40,
  ciPassed: true,
  hoursToAuthorResponse: null,
  projectHoursToFirstReview: 5,
  truncated: false,
  ...o,
});

const response = (receipts: Receipt[]): SignalsResponse => ({
  state: 'evidence',
  login: 'alice',
  repo: 'acme/core',
  prNumber: 99,
  signals: {},
  evidence: { replyRate: receipts },
  result: null,
  sampled: receipts.length,
  fetchedAt: Date.now(),
  stale: false,
  withheld: null,
});

describe('what mark a receipt earns', () => {
  it('replied beats pushed', () => {
    expect(markOf(receipt({ authorRepliedAfter: true, authorPushedAfter: true }))).toBe(
      'replied',
    );
  });

  it('pushed when they acted but said nothing', () => {
    expect(markOf(receipt({ authorPushedAfter: true }))).toBe('pushed');
  });

  it('silent when a reviewer engaged and nothing happened', () => {
    expect(markOf(receipt())).toBe('silent');
  });

  it('says nothing about a PR nobody reviewed', () => {
    expect(markOf(receipt({ reviewerEngaged: false }))).toBe('unreviewed');
  });

  it('never says "no reply" about a timeline it could not read', () => {
    // The one mistake this panel must not make: a truncated timeline cannot
    // prove absence, and rendering it as silence is a false accusation. §10.3
    expect(markOf(receipt({ truncated: true }))).toBe('unknown');
    // Truncation does not erase what we DID see.
    expect(markOf(receipt({ truncated: true, authorRepliedAfter: true }))).toBe(
      'replied',
    );
  });
});

describe('the sentences the panel is allowed to say', () => {
  it('states counts, never characterisations', () => {
    const v = buildView(
      response([
        receipt({ reviewerAskedQuestion: true, authorRepliedAfter: true }),
        receipt({ reviewerAskedQuestion: true }),
        receipt({}),
      ]),
    );
    expect(v.headline).toBe('Reviewers engaged on 3 recent PRs.');
    expect(v.subhead).toBe('Questions were asked on 2; alice replied on 1.');
  });

  it('says nothing about questions when none were asked', () => {
    const v = buildView(response([receipt()]));
    expect(v.subhead).toBeNull();
  });

  it('reports an empty window as an absence, not a finding', () => {
    const v = buildView(response([]));
    expect(v.headline).toMatch(/No reviewed PRs/);
    expect(v.rows).toEqual([]);
  });

  it('gets the singular right', () => {
    expect(buildView(response([receipt()])).headline).toBe(
      'Reviewers engaged on 1 recent PR.',
    );
  });
});

describe('the project as the alternative explanation', () => {
  it('surfaces project latency when the project is the slow one', () => {
    const slow = [1, 2, 3].map(() => receipt({ projectHoursToFirstReview: 40 * 24 }));
    expect(buildView(response(slow)).projectIsSlow).toBe(true);
  });

  it('stays quiet when the project was prompt', () => {
    const fast = [1, 2, 3].map(() => receipt({ projectHoursToFirstReview: 6 }));
    expect(buildView(response(fast)).projectIsSlow).toBe(false);
  });

  it('does not claim slowness with no timing data at all', () => {
    const none = [receipt({ projectHoursToFirstReview: null })];
    expect(buildView(response(none)).projectIsSlow).toBe(false);
  });
});

describe('durations read as a human would say them', () => {
  it('says never rather than 0 for unknown', () => {
    expect(humanHours(null)).toBe('never');
    expect(humanHours(0)).toBe('<1h');
  });

  it('switches to days past two', () => {
    expect(humanHours(30)).toBe('30h');
    expect(humanHours(72)).toBe('3d');
  });
});
