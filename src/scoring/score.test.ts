import { describe, expect, it } from 'vitest';
// @ts-expect-error — the prototype is untyped .mjs on purpose; it is the reference.
import { people } from '../../examples/lib.mjs';
import type { Profile, SourceData } from '../shared/types';
import { DEFAULT_PROFILE } from './defaults';
import { activeRules, evaluate, matches, plan, score } from './score';

// The prototype in examples/ was calibrated by hand and its output is pasted
// throughout REQUIREMENTS.md. This file proves the TypeScript port is
// behaviourally identical to it, so the doc's mocks stay true.

const EXPECTED: Record<string, number> = {
  // 183 before `selfMergeExternal` began counting distinct repos instead of
  // PRs: 40 self-merges concentrated on 2 repos is two delegations of commit
  // rights, not forty, and the label always claimed repos. §7.3
  'sustained-maintainer': 177,
  'genuine-newcomer': 9,
  'looks-active-never-engages': -26,
  'slow-but-converges': 119,
  'stalled-by-the-project': 105,
  'pushes-but-never-explains': 43,
  'self-merge-inflated': 12,
  'vouched-newcomer': 42,
};

describe('parity with the prototype', () => {
  for (const person of people as (SourceData & { login: string })[]) {
    it(`${person.login} scores the same as examples/lib.mjs`, () => {
      const { result } = evaluate(person, DEFAULT_PROFILE);
      expect(result.total).toBe(EXPECTED[person.login]);
    });
  }
});

describe('invariants', () => {
  const byLogin = (l: string) =>
    (people as (SourceData & { login: string })[]).find(
      (p) => p.login === l,
    ) as SourceData;

  it('null never scores — unknown is not "average"', () => {
    expect(matches({ gte: 0, points: 1, label: '' }, null)).toBe(false);
    expect(matches({ lt: 100, points: 1, label: '' }, null)).toBe(false);
    expect(matches({ eq: 'NONE', points: 1, label: '' }, null)).toBe(false);
  });

  it('a contributor with no history is never pushed negative', () => {
    const { result } = evaluate(byLogin('genuine-newcomer'), DEFAULT_PROFILE);
    expect(result.total).toBeGreaterThanOrEqual(0);
  });

  it('self-merging cannot buy a track record', () => {
    // 205 self-merges in own repos, 2 merged by anyone else. §7.3
    const inflated = evaluate(byLogin('self-merge-inflated'), DEFAULT_PROFILE);
    const newcomer = evaluate(byLogin('genuine-newcomer'), DEFAULT_PROFILE);
    expect(inflated.result.total - newcomer.result.total).toBeLessThan(10);
    expect(inflated.values.mergeRate).toBeNull();
  });

  it('maintainer latency is not billed to the contributor', () => {
    // Same surface abandonment rate; opposite cause. §8
    const stalled = evaluate(byLogin('stalled-by-the-project'), DEFAULT_PROFILE);
    const absent = evaluate(byLogin('looks-active-never-engages'), DEFAULT_PROFILE);
    expect(stalled.result.total).toBeGreaterThan(absent.result.total + 100);
  });

  it('evidence is returned, not smuggled into the values bag', () => {
    const { values, evidence } = evaluate(
      byLogin('sustained-maintainer'),
      DEFAULT_PROFILE,
    );
    expect(Object.keys(values).some((k) => k.startsWith('_'))).toBe(false);
    expect(evidence.replyRate?.length).toBeGreaterThan(0);
  });
});

describe('the fetch plan is derived from config', () => {
  it('asks for every source by default', () => {
    expect([...plan(DEFAULT_PROFILE).sources].sort()).toEqual([
      'prCounts',
      'receipts',
      'userProfile',
      'vouch',
    ]);
  });

  it('stops fetching a source when every group that reads it is disabled', () => {
    // `vouch` is a pure scoring source, so disabling its rules provably stops
    // paying for it — that is what "the plan is derived" buys.
    const p: Profile = structuredClone(DEFAULT_PROFILE);
    for (const r of p.rules) if (r.signal === 'vouchStatus') r.mode = 'off';
    expect(plan(p).sources.has('vouch')).toBe(false);
  });

  it('never stops fetching receipts, whatever the config says', () => {
    // Receipts are the panel's primary surface, not a scoring input (§10.1).
    // Deriving the plan from scoring alone let a config edit blank the product,
    // so mandatory product sources are unioned in.
    const p: Profile = structuredClone(DEFAULT_PROFILE);
    for (const g of p.groups) g.importance = 0;
    for (const r of p.rules) r.mode = 'off';
    expect([...plan(p).sources]).toEqual(['receipts']);
    expect(plan(p).signals.size).toBe(0);
  });
});

describe('bands are ratios, not absolute points', () => {
  it('survive disabling a large block of rules', () => {
    // An additive total has no fixed ceiling, so absolute thresholds rot on
    // every config edit. §7.1
    const p: Profile = structuredClone(DEFAULT_PROFILE);
    for (const r of p.rules) if (r.group === 'trackRecord') r.mode = 'off';

    const before = score(
      evaluate(
        (people as (SourceData & { login: string })[]).find(
          (x) => x.login === 'sustained-maintainer',
        ) as SourceData,
        DEFAULT_PROFILE,
      ).values,
      DEFAULT_PROFILE,
    );
    const after = evaluate(
      (people as (SourceData & { login: string })[]).find(
        (x) => x.login === 'sustained-maintainer',
      ) as SourceData,
      p,
    ).result;

    expect(after.maxAchievable).toBeLessThan(before.maxAchievable);
    // Still a strong contributor on what remains measurable.
    expect(after.ratio).toBeGreaterThan(0.5);
  });

  it('never divides by zero when everything is off', () => {
    const p: Profile = structuredClone(DEFAULT_PROFILE);
    for (const g of p.groups) g.importance = 0;
    const r = evaluate({}, p).result;
    expect(activeRules(p)).toHaveLength(0);
    expect(r.total).toBe(0);
    expect(r.ratio).toBe(0);
  });
});

describe('what we could not measure is stated, not implied', () => {
  const byLogin = (l: string) =>
    (people as (SourceData & { login: string })[]).find(
      (p) => p.login === l,
    ) as SourceData;

  it('lists a null scoring signal by its human label, not its id', () => {
    // A newcomer has no receipts, so the follow-through signals are null.
    const { result } = evaluate(byLogin('genuine-newcomer'), DEFAULT_PROFILE);
    expect(result.unmeasured).toContain('Acted on reviewed PRs');
    expect(result.unmeasured).not.toContain('replyRate');
  });

  it('says nothing when everything was measurable', () => {
    const { result } = evaluate(byLogin('sustained-maintainer'), DEFAULT_PROFILE);
    expect(result.unmeasured).toEqual([]);
  });

  it('does not report a signal the user turned off as unmeasured', () => {
    // "I chose not to score this" and "I could not read this" are different
    // sentences, and only one of them belongs in the panel.
    const off: Profile = {
      ...DEFAULT_PROFILE,
      rules: DEFAULT_PROFILE.rules.map((r) =>
        r.signal === 'replyRate' ? { ...r, mode: 'off' as const } : r,
      ),
    };
    const { result } = evaluate(byLogin('genuine-newcomer'), off);
    expect(result.unmeasured).not.toContain('Acted on reviewed PRs');
  });

  it('does not report informational rules as unmeasured', () => {
    // `mode: 'info'` is measured and deliberately unscored.
    const { result } = evaluate(byLogin('sustained-maintainer'), DEFAULT_PROFILE);
    const infoLabels = DEFAULT_PROFILE.rules
      .filter((r) => r.mode === 'info')
      .map((r) => r.signal);
    expect(infoLabels.length).toBeGreaterThan(0);
    expect(result.unmeasured).toEqual([]);
  });
});
