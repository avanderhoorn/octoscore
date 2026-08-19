import { describe, expect, it } from 'vitest';
import { DEFAULT_PROFILE } from './defaults';
import { NEEDS_CAVEAT, parseProfile } from './profile.schema';
import { isSignalId } from './signals';

// The default profile is validated at import time, so `DEFAULT_PROFILE`
// existing at all is the first assertion. Everything below covers the bugs the
// old `as unknown as Profile` cast let through.

type Raw = Record<string, unknown>;
const clone = () => structuredClone(DEFAULT_PROFILE) as unknown as Raw;

/** Reach into a cloned profile as untyped data — the point is to corrupt it. */
const rule = (p: Raw, i: number): Raw => {
  const r = (p.rules as Raw[])[i];
  if (!r) throw new Error(`fixture has no rule ${i}`);
  return r;
};

describe('the shipped default is valid', () => {
  it('parses', () => {
    expect(DEFAULT_PROFILE.rules.length).toBeGreaterThan(0);
    expect(DEFAULT_PROFILE.groups.length).toBeGreaterThan(0);
  });

  it('every rule points at a real signal', () => {
    for (const r of DEFAULT_PROFILE.rules) expect(isSignalId(r.signal)).toBe(true);
  });

  it('every rule points at a real group', () => {
    const ids = new Set(DEFAULT_PROFILE.groups.map((g) => g.id));
    for (const r of DEFAULT_PROFILE.rules) expect(ids.has(r.group)).toBe(true);
  });

  it('declares an evidence level for every scoring rule', () => {
    // A rule that moves the number without saying where its warrant comes from
    // is exactly what \u00a711 exists to prevent.
    for (const r of DEFAULT_PROFILE.rules) {
      if (r.mode === 'score') expect(r.evidence).toBeDefined();
    }
  });

  it('flags its own unvalidated signals', () => {
    const caveated = DEFAULT_PROFILE.rules.filter(
      (r) => r.evidence && NEEDS_CAVEAT.has(r.evidence),
    );
    expect(caveated.length).toBeGreaterThan(0);
  });

  it('publishes no negative vouch tier', () => {
    // Positive vouches only. \u00a77.2
    const vouch = DEFAULT_PROFILE.rules.find((r) => r.signal === 'vouchStatus');
    expect(vouch?.tiers.every((t) => t.points >= 0)).toBe(true);
  });
});

describe('rejects what the cast used to hide', () => {
  it('an evidence level outside the vocabulary', () => {
    const p = clone();
    rule(p, 0).evidence = 'vibes';
    expect(() => parseProfile(p)).toThrow(/evidence/);
  });

  it('a signal that is not in the registry', () => {
    const p = clone();
    rule(p, 0).signal = 'looksTrustworthy';
    expect(() => parseProfile(p)).toThrow(/registry/);
  });

  it('a rule in a group that does not exist', () => {
    // Silently never active: costs nothing, breaks nothing, removes a signal.
    const p = clone();
    rule(p, 0).group = 'nonesuch';
    expect(() => parseProfile(p)).toThrow(/group that does not exist/);
  });

  it('two rules with the same id', () => {
    const p = clone();
    rule(p, 1).id = rule(p, 0).id;
    expect(() => parseProfile(p)).toThrow(/share an id/);
  });

  it('a tier that tests nothing', () => {
    const p = clone();
    rule(p, 0).tiers = [{ points: 10, label: 'free points' }];
    expect(() => parseProfile(p)).toThrow(/must test something/);
  });

  it('a mode that is not one of the three', () => {
    const p = clone();
    rule(p, 0).mode = 'maybe';
    expect(() => parseProfile(p)).toThrow();
  });

  it('junk', () => {
    expect(() => parseProfile(null)).toThrow(/Invalid profile/);
    expect(() => parseProfile({})).toThrow(/Invalid profile/);
    expect(() => parseProfile('{}')).toThrow(/Invalid profile/);
  });

  it('names the offending path', () => {
    const p = clone();
    rule(p, 3).evidence = 'vibes';
    expect(() => parseProfile(p)).toThrow(/rules\.3\.evidence/);
  });
});
