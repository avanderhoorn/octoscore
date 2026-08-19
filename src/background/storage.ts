import { storage } from '#imports';
import { DEFAULT_PROFILE } from '../scoring/defaults';
import { parseProfile } from '../scoring/profile.schema';
import type { Profile } from '../shared/types';
import type { PrAuthor } from './api';

// ---------------------------------------------------------------------------
// Everything persistent, in one file, all `local:` — never `sync:`.
//
// The token is the reason for that rule: `storage.sync` ships to Mozilla's or
// Google's servers and back down to every browser the user is signed into. A
// PAT must not leave the machine except to api.github.com (§8, Privacy). The
// profile follows the same rule for a duller reason — a config that silently
// changes under you across machines is a support nightmare.
//
// Only the background imports this. The content script has no reason to read
// storage and every reason not to be able to. §9
// ---------------------------------------------------------------------------

export const tokenItem = storage.defineItem<string>('local:token', {
  fallback: '',
});

/** Who the token belongs to, proven at validation time. Shown in options. */
export const tokenLoginItem = storage.defineItem<string>('local:tokenLogin', {
  fallback: '',
});

const profileItem = storage.defineItem<unknown>('local:profile', {
  fallback: null,
});

export interface Settings {
  /** How many past PRs to read as receipts. §10.1 */
  window: number;
  /** Multiplies every cache TTL. 1 = defaults. */
  cacheMultiplier: number;
  /** Repos the panel runs on. Empty = everywhere the extension has access. */
  allowlist: string[];
}

export const DEFAULT_SETTINGS: Settings = {
  window: 15,
  cacheMultiplier: 1,
  allowlist: [],
};

export const settingsItem = storage.defineItem<Settings>('local:settings', {
  fallback: DEFAULT_SETTINGS,
});

/**
 * Last quota GitHub reported. Recorded because the one thing a maintainer
 * cannot see from inside a browser extension is how much of their hourly budget this
 * tool is spending, and "it stopped working" is the worst way to find out.
 * Purely a display value — nothing branches on it. §10.2
 */
export const quotaItem = storage.defineItem<{
  remaining: number;
  limit: number;
  at: number;
} | null>('local:quota', { fallback: null });

/**
 * `owner/name#123` → who opened it.
 *
 * A pull request's author never changes, so this never needs a TTL and a PR
 * looked at twice costs nothing the second time. It exists because the author
 * now comes from the API rather than the page — see FR8a — and without it
 * every page view would spend a request re-learning a fact that cannot have
 * changed.
 *
 * A bare string is the shape this held before it recorded whether the author
 * was a bot. Entries written then are still readable, so an upgrade does not
 * silently discard a user's cache. Bounded so a long session cannot grow it
 * without limit.
 */
export const prAuthorsItem = storage.defineItem<Record<string, PrAuthor | string>>(
  'local:prAuthors',
  { fallback: {} },
);

const PR_AUTHOR_LIMIT = 500;

export async function rememberPrAuthor(key: string, author: PrAuthor) {
  const map = await prAuthorsItem.getValue();
  const keys = Object.keys(map);
  // Oldest-inserted first: object key order is insertion order for string keys.
  const trimmed =
    keys.length >= PR_AUTHOR_LIMIT
      ? Object.fromEntries(
          keys.slice(-PR_AUTHOR_LIMIT + 1).map((k) => [k, map[k] as PrAuthor | string]),
        )
      : map;
  await prAuthorsItem.setValue({ ...trimmed, [key]: author });
}

/**
 * A stored profile is untrusted input — it may predate a signal rename, or have
 * been hand-edited. Falling back to the default is right: a broken config
 * should degrade to "works out of the box", never to a blank panel.
 */
export async function getProfile(): Promise<{ profile: Profile; fellBack: boolean }> {
  const raw = await profileItem.getValue();
  if (raw == null) return { profile: DEFAULT_PROFILE, fellBack: false };
  try {
    return { profile: parseProfile(raw), fellBack: false };
  } catch {
    return { profile: DEFAULT_PROFILE, fellBack: true };
  }
}

/** Validates before writing, so storage can never hold an unparseable profile. */
export async function setProfile(raw: unknown): Promise<Profile> {
  const profile = parseProfile(raw);
  await profileItem.setValue(profile);
  return profile;
}

export async function resetProfile(): Promise<void> {
  await profileItem.removeValue();
}

/** True when the repo is in scope. An empty allowlist means "everywhere". */
export function inScope(repo: string, allowlist: string[]): boolean {
  if (allowlist.length === 0) return true;
  const r = repo.toLowerCase();
  return allowlist.some((entry) => {
    const e = entry.trim().toLowerCase();
    if (!e) return false;
    // `owner/*` covers a whole org; anything else is an exact repo.
    return e.endsWith('/*') ? r.startsWith(e.slice(0, -1)) : r === e;
  });
}
