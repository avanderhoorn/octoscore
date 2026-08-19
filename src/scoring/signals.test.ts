import { describe, expect, it } from 'vitest';
import type { PrCounts } from '../shared/types';
import { SIGNALS } from './signals';

/**
 * Signal-level arithmetic. score.test.ts asserts whole profiles against the
 * prototype; this file pins the individual formulas that live data proved we
 * had wrong.
 */

const counts = (over: Partial<PrCounts>): PrCounts => ({
  selfMergeOwn: 0,
  selfMergeExternal: 0,
  mergedByOthersOwn: 0,
  mergedByOthersExternal: 0,
  uniqueSelfMergeRepos: 0,
  sampledExternalClosed: 0,
  sampleSize: 0,
  externalPrsClosed: 0,
  externalPrsMerged: 0,
  uniqueMergers: 0,
  issuesOpenedHere: 0,
  recentPrCount: 0,
  mergedPrsThisRepo: 0,
  authorAssociation: 'NONE',
  linkedIssuePrs: 0,
  ...over,
});

describe('mergeRate', () => {
  const rate = (c: Partial<PrCounts>) => SIGNALS.mergeRate.compute(counts(c) as never);

  it('does not read commit rights as merge failure', () => {
    // A real dotnet/aspnetcore maintainer, measured against live GitHub:
    // 86 of 100 closed PRs merged, 83 of them self-merged because they have
    // commit rights there. Counting self-merges in the denominator but not the
    // numerator scored them 3%, and the panel called them "Most PRs closed
    // unmerged" — of an actual maintainer of the repo being reviewed.
    const r = rate({
      selfMergeExternal: 83,
      mergedByOthersExternal: 3,
      sampledExternalClosed: 100,
    });
    // 3 of the 17 PRs somebody else decided on — not 3 of 100.
    expect(r).toBeCloseTo(0.176, 2);
  });

  it('does not count a self-merge as somebody else saying yes', () => {
    // The opposite failure mode: folding self-merges into the numerator would
    // read 100%, and anyone with a repo they control could manufacture it.
    // Commit rights are scored on their own as selfMergeExternal. §7.3
    expect(
      rate({
        selfMergeExternal: 40,
        mergedByOthersExternal: 0,
        sampledExternalClosed: 40,
      }),
    ).toBeNull(); // nothing left to measure once self-merges are removed
  });

  it('is unknown rather than zero below the sample floor', () => {
    expect(rate({ mergedByOthersExternal: 2, sampledExternalClosed: 5 })).toBeNull();
    expect(rate({ mergedByOthersExternal: 5, sampledExternalClosed: 10 })).toBeCloseTo(
      0.5,
      5,
    );
  });

  it('measures only the PRs still visible after a SAML denial', () => {
    // splitMerges drops nodes the token cannot see, so both sides shrink
    // together and the rate stays honest.
    expect(
      rate({
        mergedByOthersExternal: 9,
        sampledExternalClosed: 12,
        selfMergeExternal: 0,
      }),
    ).toBeCloseTo(0.75, 5);
  });
});
