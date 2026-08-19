import { evaluate, plan } from '../scoring/score';
import { DEFAULT_WINDOW } from '../scoring/signals';
import type {
  ErrorCode,
  SignalsRequest,
  SignalsResponse,
  SourceData,
  SourceId,
} from '../shared/types';
import {
  AUTHOR_QUERY,
  type AuthorRaw,
  authorVars,
  buildQuery,
  GitHubError,
  graphql,
  type MergeSplitPr,
  type PrAuthor,
  parseVouch,
  pickAuthor,
  type ReceiptPr,
  searchVars,
  shapePrCounts,
  shapeUserProfile,
  varsFor,
} from './api';
import * as cache from './cache';
import { sample, toReceipts } from './receipts';
import {
  getProfile,
  inScope,
  prAuthorsItem,
  quotaItem,
  rememberPrAuthor,
  settingsItem,
  tokenItem,
  tokenLoginItem,
} from './storage';

// ---------------------------------------------------------------------------
// The router. The ONLY place the token, the network and the cache meet.
//
// The whole request is one straight line with no branches on signal names:
//
//   profile -> plan(sources) -> cache -> fetch the misses -> shape -> evaluate
//
// Adding a signal changes `signals.ts` and the profile JSON. Nothing here. §9.1
// ---------------------------------------------------------------------------

/** Shape of the composed GraphQL response. Only the slices we asked for exist. */
interface Raw {
  receipts?: { nodes?: (ReceiptPr | null)[] | null };
  currentPr?: { pullRequest?: { authorAssociation?: string | null } | null } | null;
  mergedHere?: { issueCount: number };
  issuesHere?: { issueCount: number };
  externalClosed?: { issueCount: number };
  externalMerged?: { issueCount: number };
  linkedIssues?: { issueCount: number };
  recentPrs?: { issueCount: number };
  mergeSplit?: { nodes?: (MergeSplitPr | null)[] | null };
  user?: Parameters<typeof shapeUserProfile>[0] | null;
  repository?: { object?: { text?: string } | null } | null;
}

const base = (req: SignalsRequest, login: string): SignalsResponse => ({
  state: 'evidence',
  login,
  repo: req.repo,
  prNumber: req.prNumber,
  signals: {},
  evidence: {},
  result: null,
  sampled: 0,
  fetchedAt: Date.now(),
  stale: false,
  withheld: null,
});

const failed = (
  req: SignalsRequest,
  code: ErrorCode,
  detail?: string,
  login = '',
): SignalsResponse => ({
  ...base(req, login),
  state: 'error',
  error: detail ? { code, detail } : { code },
});

/**
 * A login that is obviously a bot even without GitHub saying so.
 *
 * The authoritative answer is `__typename == "Bot"` on the author, and that is
 * what `authorOf` uses. This remains for entries remembered before that field
 * was recorded, so an upgrade does not start treating known bots as people.
 */
const BOT = /(\[bot\]|-bot)$/i;
const KNOWN_BOTS = new Set(['dependabot', 'renovate', 'github-actions', 'copilot']);
export const looksLikeBot = (login: string) =>
  BOT.test(login) || KNOWN_BOTS.has(login.toLowerCase());

const asGitHubError = (e: unknown) =>
  e instanceof GitHubError
    ? e
    : new GitHubError('network', e instanceof Error ? e.message : String(e));

/**
 * Resolve who opened this PR, remembering the answer permanently.
 *
 * Split out because it is the one thing that must happen before anything else:
 * the whole read is about a person, and until we know which person — and
 * whether it is a person at all — there is nothing to look up, no cache key,
 * and no bot check.
 *
 * The remembered map is consulted first, so a PR seen before resolves with no
 * request at all — and, importantly, with no token, which keeps previously
 * cached evidence readable when the token has gone missing or expired.
 */
async function authorOf(
  repo: string,
  prNumber: number,
  token: string,
): Promise<{ author: PrAuthor } | { error: ErrorCode; detail?: string }> {
  const key = `${repo}#${prNumber}`;
  const known = (await prAuthorsItem.getValue())[key];
  if (known) {
    return {
      author:
        typeof known === 'string' ? { login: known, bot: looksLikeBot(known) } : known,
    };
  }

  if (!token) return { error: 'no-token' };

  let author: PrAuthor | null;
  try {
    const { data } = await graphql<AuthorRaw>(
      AUTHOR_QUERY,
      authorVars(repo, prNumber),
      token,
    );
    author = pickAuthor(data);
  } catch (e) {
    const err = asGitHubError(e);
    return { error: err.code, detail: err.message };
  }

  if (!author) return { error: 'no-author' };
  await rememberPrAuthor(key, author);
  return { author };
}

/**
 * The router's contract: a reply, always.
 *
 * The message listener answers with `sendResponse` and returns `true` to hold
 * the channel open. If the promise behind it rejects, nothing ever answers, the
 * channel is closed by the browser, and the content script sees only "the
 * message channel closed before a response was received" — which the panel then
 * reported as a network error that had not happened. A failure inside this
 * extension must not be dressed up as a failure at GitHub.
 *
 * So every escape from `readSignals` becomes a response. Storage reads, the
 * cache, the profile parser and the scorer all run in here, and any of them
 * throwing used to hang the panel silently.
 */
export const crashedResponse = (req: SignalsRequest, detail: string): SignalsResponse =>
  failed(req, 'crashed', detail);

export async function handleSignals(req: SignalsRequest): Promise<SignalsResponse> {
  try {
    return await readSignals(req);
  } catch (e) {
    return failed(req, 'crashed', e instanceof Error ? e.message : String(e));
  }
}

async function readSignals(req: SignalsRequest): Promise<SignalsResponse> {
  const settings = await settingsItem.getValue();
  if (!inScope(req.repo, settings.allowlist))
    return { ...base(req, ''), state: 'no-read' };

  const token = await tokenItem.getValue();
  const who = await authorOf(req.repo, req.prNumber, token);
  if ('error' in who) return failed(req, who.error, who.detail);
  const { login } = who.author;

  if (who.author.bot) return { ...base(req, login), state: 'bot' };

  const { profile } = await getProfile();
  const { sources } = plan(profile);
  const window = settings.window || DEFAULT_WINDOW;

  if (req.refresh) await cache.evict(login, req.repo, sources);

  const { data, missing, oldest } = await cache.load(login, req.repo, sources);
  let withheld: SignalsResponse['withheld'] = null;
  const cached = () => Object.keys(data).length > 0;
  let stale = false;

  if (missing.size > 0) {
    if (!token) {
      // A cached read is still worth showing; only a cold one is a hard stop.
      if (!cached()) return failed(req, 'no-token', undefined, login);
      stale = true;
    } else {
      try {
        const fetched = await fetchSources(req, login, missing, window, token);
        Object.assign(data, fetched.data);
        withheld = fetched.withheld;
        await store(req, login, fetched.data, settings.cacheMultiplier);
      } catch (e) {
        const err = asGitHubError(e);
        // Stale evidence, clearly marked, beats a blank panel. A cold failure
        // has nothing to be honest ABOUT, so it stays an error. §6.4
        if (!cached()) return failed(req, err.code, err.message, login);
        stale = true;
      }
    }
  }

  // Cached receipts are author-global and unfiltered. Narrowing to THIS PR's
  // view happens here, every read, so a cache hit gets the same treatment as a
  // fresh fetch. See `sample`.
  if (data.receipts) {
    data.receipts = sample(
      data.receipts,
      { repo: req.repo, number: req.prNumber },
      window,
    );
  }

  const { values, evidence, result } = evaluate(data, profile);
  return {
    ...base(req, login),
    signals: values,
    evidence,
    result,
    sampled: data.receipts?.length ?? 0,
    fetchedAt: oldest ?? Date.now(),
    stale,
    withheld,
  };
}

/** One composed request for every missing source. §10.2 */
async function fetchSources(
  req: SignalsRequest,
  login: string,
  missing: Set<SourceId>,
  window: number,
  token: string,
): Promise<{ data: SourceData; withheld: SignalsResponse['withheld'] }> {
  const vars = searchVars(login, req.repo, req.prNumber, window);
  const { data, rate, withheld } = await graphql<Raw>(
    buildQuery(missing, window + 1),
    varsFor(missing, vars),
    token,
  );

  if (rate)
    await quotaItem.setValue({
      remaining: rate.remaining,
      limit: rate.limit,
      at: Date.now(),
    });

  const out: SourceData = {};

  if (missing.has('receipts')) {
    const nodes = (data.receipts?.nodes ?? []).filter((n): n is ReceiptPr => n != null);
    out.receipts = toReceipts(nodes);
  }

  if (missing.has('prCounts')) {
    out.prCounts = shapePrCounts(
      {
        mergedHere: data.mergedHere ?? { issueCount: 0 },
        issuesHere: data.issuesHere ?? { issueCount: 0 },
        externalClosed: data.externalClosed ?? { issueCount: 0 },
        externalMerged: data.externalMerged ?? { issueCount: 0 },
        linkedIssues: data.linkedIssues ?? { issueCount: 0 },
        recentPrs: data.recentPrs ?? { issueCount: 0 },
        mergeSplit: {
          nodes: (data.mergeSplit?.nodes ?? []).filter(
            (n): n is MergeSplitPr => n != null,
          ),
        },
      },
      login,
      data.currentPr?.pullRequest?.authorAssociation ?? 'NONE',
    );
  }

  if (missing.has('userProfile') && data.user) {
    out.userProfile = shapeUserProfile(data.user);
  }

  if (missing.has('vouch')) {
    out.vouch = parseVouch(data.repository?.object?.text, login);
  }

  return { data: out, withheld };
}

/** TTL is decided once, from the freshly-fetched profile, and applied to all. */
async function store(
  req: SignalsRequest,
  login: string,
  fetched: SourceData,
  multiplier: number,
) {
  const maturity = cache.maturityOf(
    fetched.userProfile?.accountAgeDays ?? null,
    fetched.prCounts?.externalPrsMerged ?? null,
  );
  const ttl = cache.ttlFor(maturity, multiplier);

  for (const [source, value] of Object.entries(fetched)) {
    if (value == null) continue;
    await cache.write(
      login,
      req.repo,
      source as SourceId,
      value as NonNullable<SourceData[SourceId]>,
      ttl,
    );
  }
}

/** `viewer { login }` — the cheapest possible proof a token works. FR3 */
export async function validateToken(
  token: string,
): Promise<
  { ok: true; login: string } | { ok: false; code: ErrorCode; message: string }
> {
  try {
    const { data } = await graphql<{ viewer: { login: string } }>(
      'query { viewer { login } }',
      {},
      token,
    );
    await tokenItem.setValue(token);
    await tokenLoginItem.setValue(data.viewer.login);
    return { ok: true, login: data.viewer.login };
  } catch (e) {
    const err = e instanceof GitHubError ? e : null;
    return {
      ok: false,
      code: err?.code ?? 'network',
      message: err?.message ?? String(e),
    };
  }
}
