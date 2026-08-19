import * as v from 'valibot';
import { EVIDENCE_LEVELS, type EvidenceLevel, type Profile } from '../shared/types';
import { isSignalId } from './signals';

// ---------------------------------------------------------------------------
// A profile is data, and data from disk or from a user's import is untrusted.
// `raw as unknown as Profile` compiles and then lies: it hid seven evidence
// values the type never declared. Everything below is validated ONCE, here, so
// every consumer downstream can trust the shape without re-checking it. §7.1
//
// This is also the import/export gate: the same schema validates a profile the
// user pastes in, so a bad file fails at the boundary with a readable path
// rather than as `undefined.tiers` deep inside the scorer.
// ---------------------------------------------------------------------------

/** Levels that must render a caveat in the panel rather than pass silently. §11 */
export const NEEDS_CAVEAT: ReadonlySet<EvidenceLevel> = new Set(['novel', 'contested']);

const Tier = v.pipe(
  v.object({
    gte: v.exactOptional(v.number()),
    lt: v.exactOptional(v.number()),
    eq: v.exactOptional(v.union([v.string(), v.boolean()])),
    points: v.number(),
    label: v.pipe(v.string(), v.nonEmpty()),
  }),
  v.check(
    (t) => t.gte !== undefined || t.lt !== undefined || t.eq !== undefined,
    'a tier must test something: one of gte, lt or eq',
  ),
);

const Rule = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  group: v.pipe(v.string(), v.nonEmpty()),
  signal: v.pipe(
    v.string(),
    v.check(isSignalId, 'not a signal in the registry (src/scoring/signals.ts)'),
  ),
  mode: v.picklist(['score', 'info', 'off']),
  evidence: v.exactOptional(v.picklist(EVIDENCE_LEVELS)),
  note: v.exactOptional(v.string()),
  tiers: v.array(Tier),
});

const Group = v.object({
  id: v.pipe(v.string(), v.nonEmpty()),
  label: v.pipe(v.string(), v.nonEmpty()),
  importance: v.number(),
  aboveFold: v.boolean(),
  floorAtZero: v.exactOptional(v.boolean()),
});

const Band = v.object({
  gtePct: v.number(),
  label: v.pipe(v.string(), v.nonEmpty()),
});

export const ProfileSchema = v.pipe(
  v.object({
    id: v.pipe(v.string(), v.nonEmpty()),
    name: v.pipe(v.string(), v.nonEmpty()),
    groups: v.pipe(v.array(Group), v.minLength(1)),
    rules: v.array(Rule),
    bands: v.pipe(v.array(Band), v.minLength(1)),
  }),
  // Cross-field checks. A rule pointing at a group that does not exist is
  // silently never active, which is the worst kind of config bug: it costs
  // nothing, breaks nothing, and quietly removes a signal.
  v.check((p) => {
    const ids = new Set(p.groups.map((g) => g.id));
    return p.rules.every((r) => ids.has(r.group));
  }, 'a rule references a group that does not exist'),
  v.check(
    (p) => new Set(p.rules.map((r) => r.id)).size === p.rules.length,
    'two rules share an id',
  ),
  v.check(
    (p) => new Set(p.groups.map((g) => g.id)).size === p.groups.length,
    'two groups share an id',
  ),
);

/** Throws with the offending path on invalid input. */
export function parseProfile(raw: unknown): Profile {
  const r = v.safeParse(ProfileSchema, raw);
  if (r.success) return r.output;
  const where = r.issues
    .map((i) => `  ${v.getDotPath(i) ?? '<root>'}: ${i.message}`)
    .join('\n');
  throw new Error(`Invalid profile:\n${where}`);
}
