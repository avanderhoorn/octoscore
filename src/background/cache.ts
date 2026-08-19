import { storage } from '#imports';
import type { SourceData, SourceId } from '../shared/types';

// ---------------------------------------------------------------------------
// Cache. Keyed per (login, repo, source) so a config change that adds ONE
// source refetches that source and nothing else — the fetch plan already tells
// us which sources it wants, so the cache answers at the same granularity. §10.5
//
// TTL adapts to how fast the answer can change, an idea taken from SlopScore.
// A ten-year account with 400 merged PRs will not become a different person in
// a week; an account created on Tuesday might, so it is re-read in hours. This
// is a rate-limit AND an accuracy argument: caching a newcomer for a week means
// showing "no history" to someone who has since built one.
// ---------------------------------------------------------------------------

const HOUR = 3600_000;

/**
 * What a source's answer actually depends on. This is the whole reason the
 * cache key is not just `(login, repo)`: `vouch` is one file that is the same
 * for every contributor on a repo, and `receipts` is the same evidence no
 * matter which of that author's PRs you happen to be looking at. Keying
 * everything by both would refetch a contributor's entire history the first
 * time you see them on a second repo, and re-read VOUCHED.td once per author. §10.5
 */
const SCOPE: Record<SourceId, 'author' | 'repo' | 'both'> = {
  receipts: 'author',
  userProfile: 'author',
  vouch: 'repo',
  prCounts: 'both',
};

export interface CacheEntry<T = unknown> {
  value: T;
  fetchedAt: number;
  /** Milliseconds after `fetchedAt` at which this stops being fresh. */
  ttl: number;
}

/**
 * How mature the account looked when we fetched. The TTL follows from this and
 * nothing else, so the decision is one lookup rather than scattered branches.
 */
export type Maturity = 'established' | 'moderate' | 'new' | 'unknown';

const TTL_HOURS: Record<Maturity, number> = {
  established: 24 * 7,
  moderate: 24 * 3,
  new: 24,
  unknown: 12,
};

/**
 * Deliberately coarse. Precision here would imply the boundaries mean something
 * — they do not, they are just "how long before this is worth re-reading".
 */
export function maturityOf(accountAgeDays: number | null, mergedPrs: number | null) {
  if (accountAgeDays == null) return 'unknown';
  if (accountAgeDays > 730 && (mergedPrs ?? 0) >= 20) return 'established';
  if (accountAgeDays > 180) return 'moderate';
  return 'new';
}

export const ttlFor = (m: Maturity, multiplier = 1) =>
  TTL_HOURS[m] * HOUR * Math.max(0, multiplier);

const key = (login: string, repo: string, source: SourceId) => {
  const scope = SCOPE[source];
  const who = scope === 'repo' ? '' : login.toLowerCase();
  const where = scope === 'author' ? '' : repo.toLowerCase();
  return `local:cache:${source}:${who}:${where}` as const;
};

export async function read<K extends SourceId>(
  login: string,
  repo: string,
  source: K,
): Promise<CacheEntry<NonNullable<SourceData[K]>> | null> {
  return (
    (await storage.getItem<CacheEntry<NonNullable<SourceData[K]>>>(
      key(login, repo, source),
    )) ?? null
  );
}

export async function write<K extends SourceId>(
  login: string,
  repo: string,
  source: K,
  value: NonNullable<SourceData[K]>,
  ttl: number,
): Promise<void> {
  await storage.setItem<CacheEntry>(key(login, repo, source), {
    value,
    fetchedAt: Date.now(),
    ttl,
  });
}

export const isFresh = (e: CacheEntry, now = Date.now()) => now - e.fetchedAt < e.ttl;

/**
 * Which of the wanted sources we already hold, and which must be fetched.
 *
 * A stale entry is still RETURNED, not dropped: if the network then fails we
 * would rather show yesterday's evidence clearly marked stale than an empty
 * panel. Nothing here decides how that gets rendered — it just reports
 * freshness and lets the caller be honest about it. §6.4
 */
export async function load(
  login: string,
  repo: string,
  wanted: Set<SourceId>,
): Promise<{
  data: SourceData;
  fresh: Set<SourceId>;
  missing: Set<SourceId>;
  oldest: number | null;
}> {
  const data: SourceData = {};
  const fresh = new Set<SourceId>();
  const missing = new Set<SourceId>();
  let oldest: number | null = null;

  for (const source of wanted) {
    const entry = await read(login, repo, source);
    if (!entry) {
      missing.add(source);
      continue;
    }
    // biome-ignore lint/suspicious/noExplicitAny: key and value are correlated by `read`, which TS cannot express here.
    (data as any)[source] = entry.value;
    if (isFresh(entry)) fresh.add(source);
    else missing.add(source);
    oldest = oldest == null ? entry.fetchedAt : Math.min(oldest, entry.fetchedAt);
  }
  return { data, fresh, missing, oldest };
}

/** Manual refresh, one author. Never a global purge — that just burns quota. */
export async function evict(login: string, repo: string, sources: Set<SourceId>) {
  await storage.removeItems([...sources].map((s) => key(login, repo, s)));
}
