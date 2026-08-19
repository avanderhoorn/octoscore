import { describe, expect, it } from 'vitest';
import type { SourceId } from '../shared/types';
import { buildQuery, searchVars, varsFor } from './api';
import { hasField, schemaErrors } from './schema.testkit';

const ALL: SourceId[] = ['receipts', 'prCounts', 'userProfile', 'vouch'];

/** Every subset of sources the fetch plan can produce. */
function subsets<T>(xs: T[]): T[][] {
  const out: T[][] = [[]];
  for (const x of xs) for (const s of [...out]) out.push([...s, x]);
  return out;
}

describe('composed queries are legal GitHub GraphQL', () => {
  for (const combo of subsets(ALL).filter((c) => c.length > 0)) {
    it(`validates: ${combo.join(' + ')}`, () => {
      expect(schemaErrors(buildQuery(new Set(combo)))).toEqual([]);
    });
  }

  it('supplies a value for every variable it declares', () => {
    const all = searchVars('octocat', 'acme/core', 1);
    for (const combo of subsets(ALL).filter((c) => c.length > 0)) {
      const sources = new Set(combo);
      const declared = [...buildQuery(sources).matchAll(/\$(\w+):/g)].map((m) => m[1]);
      expect(Object.keys(varsFor(sources, all)).sort()).toEqual(
        [...new Set(declared)].sort(),
      );
    }
  });
});

describe('assumptions the extractor makes about the schema', () => {
  // Each of these encodes a decision in receipts.ts. If GitHub changes the
  // schema, this fails here rather than silently producing empty receipts.

  it('PullRequestCommit really has no createdAt and no actor', () => {
    expect(hasField('PullRequestCommit', 'createdAt')).toBe(false);
    expect(hasField('PullRequestCommit', 'actor')).toBe(false);
    // ...which is why ordering and attribution must come off the commit.
    expect(hasField('PullRequestCommit', 'commit')).toBe(true);
    expect(hasField('Commit', 'committedDate')).toBe(true);
    expect(hasField('Commit', 'pushedDate')).toBe(true);
    expect(hasField('Commit', 'author')).toBe(true);
  });

  it('comment and review nodes do carry createdAt and an author', () => {
    for (const t of ['IssueComment', 'PullRequestReview']) {
      expect(hasField(t, 'createdAt')).toBe(true);
      expect(hasField(t, 'author')).toBe(true);
      expect(hasField(t, 'bodyText')).toBe(true);
    }
    expect(hasField('PullRequestReview', 'state')).toBe(true);
  });

  it('force-push events carry createdAt and an actor', () => {
    expect(hasField('HeadRefForcePushedEvent', 'createdAt')).toBe(true);
    expect(hasField('HeadRefForcePushedEvent', 'actor')).toBe(true);
  });

  it('PullRequest exposes the fields the receipt is built from', () => {
    for (const f of ['additions', 'deletions', 'merged', 'closed', 'mergedBy']) {
      expect(hasField('PullRequest', f)).toBe(true);
    }
  });
});

describe('the validator itself rejects bad queries', () => {
  it('catches an unknown field', () => {
    const e = schemaErrors('{ viewer { notARealField } }');
    expect(e.length).toBeGreaterThan(0);
    expect(e[0]).toContain('notARealField');
  });

  it('catches the exact defect it was written for', () => {
    // What the query would look like if someone assumed PullRequestCommit
    // behaved like the other timeline nodes.
    const e = schemaErrors(`{
      node(id: "x") { ... on PullRequestCommit { createdAt actor { login } } }
    }`);
    expect(e.join(' ')).toContain('createdAt');
  });

  it('catches a declared-but-unused variable', () => {
    expect(schemaErrors('query Q($a: String!) { viewer { login } }').join(' ')).toContain(
      'never used',
    );
  });
});
