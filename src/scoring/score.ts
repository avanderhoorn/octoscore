import type {
  Profile,
  Rule,
  ScoreLine,
  ScoreResult,
  SignalEvidence,
  SignalValue,
  SignalValues,
  SourceData,
  SourceId,
  Tier,
} from '../shared/types';
import { isSignalId, SIGNALS } from './signals';

// ---------------------------------------------------------------------------
// The pipeline, in one direction, with no fork:
//
//   profile.rules -> signal ids -> sources -> fetch -> compute -> score
//
// REQUIREMENTS.md §9.1
// ---------------------------------------------------------------------------

/** Rules that are on, in groups that are on. Everything downstream derives from this. */
export function activeRules(profile: Profile): Rule[] {
  const groups = new Map(profile.groups.map((g) => [g.id, g]));
  return profile.rules.filter(
    (r) => r.mode !== 'off' && (groups.get(r.group)?.importance ?? 0) !== 0,
  );
}

/**
 * Sources the product needs regardless of scoring config. Receipts ARE the
 * panel's primary surface (§10.1) — they are evidence, not a scoring input, and
 * turning off every rule that happens to read them must not make the panel go
 * blank. Scoring is one CONSUMER of the fetch, never its sole author.
 */
export const MANDATORY_SOURCES: readonly SourceId[] = ['receipts'];

/**
 * The fetch plan is DERIVED, not maintained. Nothing has to be kept in sync by
 * hand, so it cannot drift: disabling a rule provably stops paying for it —
 * except for the mandatory product sources above, which are always fetched. §9.1
 */
export function plan(profile: Profile): {
  signals: Set<string>;
  sources: Set<SourceId>;
} {
  const signals = new Set(activeRules(profile).map((r) => r.signal));
  const sources = new Set<SourceId>(MANDATORY_SOURCES);
  for (const id of signals) {
    if (isSignalId(id)) sources.add(SIGNALS[id].source);
  }
  return { signals, sources };
}

/**
 * Only signals whose source was fetched are computed. The rest stay absent, and
 * absent is indistinguishable from null at scoring time — so "source not
 * fetched" needs no special case anywhere.
 */
export function computeSignals(
  data: SourceData,
  profile: Profile,
): { values: SignalValues; evidence: SignalEvidence } {
  const values: SignalValues = {};
  const evidence: SignalEvidence = {};

  for (const id of plan(profile).signals) {
    if (!isSignalId(id)) continue;
    const sig = SIGNALS[id];
    const payload = data[sig.source];
    if (payload == null) continue;

    // The registry is `as const`, so each entry's compute is narrowed to its own
    // source. The lookup above is dynamic, so widen once, here, deliberately.
    const def = sig as {
      compute: (d: unknown) => SignalValue;
      evidence?: (d: unknown) => SourceData['receipts'];
    };
    values[id] = def.compute(payload);
    const ev = def.evidence?.(payload);
    if (ev) evidence[id] = ev;
  }
  return { values, evidence };
}

// ---------------------------------------------------------------------------
// Ordered tiers, first match wins, signed points, summed. §7
// ---------------------------------------------------------------------------

/** null never matches. Unknown is not "average" — that is the cold-start bug. §7.1 */
export function matches(tier: Tier, v: SignalValue): boolean {
  if (v == null) return false;
  if (tier.eq !== undefined) return v === tier.eq;
  if (typeof v !== 'number') return false;
  if (tier.gte !== undefined && !(v >= tier.gte)) return false;
  if (tier.lt !== undefined && !(v < tier.lt)) return false;
  return tier.gte !== undefined || tier.lt !== undefined;
}

export function score(values: SignalValues, profile: Profile): ScoreResult {
  const groups = new Map(profile.groups.map((g) => [g.id, g]));
  const rules = activeRules(profile);
  const lines: ScoreLine[] = [];

  for (const rule of rules) {
    const raw = values[rule.signal] ?? null;
    const tier = rule.tiers.find((t) => matches(t, raw));
    if (!tier) continue;
    const importance = groups.get(rule.group)?.importance ?? 0;
    const scored = rule.mode === 'score';
    lines.push({
      rule: rule.id,
      group: rule.group,
      signal: rule.signal,
      raw,
      label: tier.label,
      points: scored ? tier.points * importance : 0,
      scored,
      evidence: rule.evidence ?? null,
    });
  }

  // Groups may declare a floor. trackRecord floors at zero: absence of history
  // is never a penalty. This is config, not a branch on a group name. §7.1
  let total = lines.reduce((a, l) => a + l.points, 0);
  for (const g of profile.groups) {
    if (!g.floorAtZero) continue;
    const sub = lines.filter((l) => l.group === g.id).reduce((a, l) => a + l.points, 0);
    if (sub < 0) total -= sub;
  }

  // Bands are a fraction of what THIS rule set can award. An additive score has
  // no fixed ceiling, so absolute thresholds rot on every config edit. §7.1
  const maxAchievable = rules
    .filter((r) => r.mode === 'score')
    .reduce(
      (sum, r) =>
        sum +
        Math.max(0, ...r.tiers.map((t) => t.points)) *
          (groups.get(r.group)?.importance ?? 0),
      0,
    );

  const ratio = maxAchievable > 0 ? total / maxAchievable : 0;
  const band = profile.bands.find((b) => ratio >= b.gtePct)?.label ?? '';

  // What we could not measure. This is the visible half of the invariant that
  // `null` never scores (§7.1): without it, an unmeasurable signal and a signal
  // worth zero points look identical in the panel, and "unknown" quietly reads
  // as "average" — which is exactly the competitors' cold-start bug wearing a
  // different hat. Derived from the ACTIVE rules, so it is config not code: a
  // signal the user turned off is not something we failed to measure.
  const unmeasured = [
    ...new Set(
      rules
        .filter((r) => r.mode === 'score' && (values[r.signal] ?? null) === null)
        .map((r) => (isSignalId(r.signal) ? SIGNALS[r.signal].label : r.signal)),
    ),
  ];

  return { total, band, lines, maxAchievable, ratio, unmeasured };
}

export function evaluate(
  data: SourceData,
  profile: Profile,
): { values: SignalValues; evidence: SignalEvidence; result: ScoreResult } {
  const { values, evidence } = computeSignals(data, profile);
  return { values, evidence, result: score(values, profile) };
}
