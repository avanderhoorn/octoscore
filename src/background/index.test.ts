import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeBrowser } from 'wxt/testing/fake-browser';
import * as api from './api';
import * as cache from './cache';
import { handleSignals, looksLikeBot, validateToken } from './index';
import type { ReceiptPr } from './nodes';
import { prAuthorsItem, settingsItem, tokenItem, tokenLoginItem } from './storage';

// The router is where the token, the network and the cache meet, so it is the
// one place where an ordering mistake can leak or lie. `graphql` is the only
// thing stubbed — everything else runs for real against WXT's in-memory
// storage, including the cache and the scorer.

const REQ = { kind: 'signals', repo: 'acme/core', prNumber: 99 } as const;

/**
 * Say who wrote a PR without spending a request on it.
 *
 * The author now comes from the API, so most tests would otherwise open with a
 * lookup that is not what they are testing. Seeding the remembered map is the
 * same path a second view of a PR takes.
 */
const authored = (by: string, prNumber: number = REQ.prNumber) =>
  prAuthorsItem.setValue({ [`${REQ.repo}#${prNumber}`]: by });

const prNode = (number: number, over: Partial<ReceiptPr> = {}): ReceiptPr => ({
  number,
  title: `PR ${number}`,
  url: `https://github.com/acme/core/pull/${number}`,
  createdAt: '2024-03-01T00:00:00Z',
  merged: true,
  closed: true,
  additions: 20,
  deletions: 5,
  repository: { nameWithOwner: 'acme/core' },
  author: { __typename: 'User', login: 'alice' },
  timelineItems: {
    totalCount: 2,
    nodes: [
      {
        __typename: 'PullRequestReview',
        createdAt: '2024-03-02T00:00:00Z',
        bodyText: 'why this approach?',
        state: 'CHANGES_REQUESTED',
        author: { __typename: 'User', login: 'maintainer' },
      },
      {
        __typename: 'IssueComment',
        createdAt: '2024-03-03T00:00:00Z',
        bodyText: 'x'.repeat(200),
        author: { __typename: 'User', login: 'alice' },
      },
    ],
  },
  ...over,
});

/** A full response for every source, so any fetch plan is satisfied. */
const fullData = (prs: ReceiptPr[]) => ({
  receipts: { nodes: prs },
  currentPr: { pullRequest: { authorAssociation: 'CONTRIBUTOR' } },
  mergedHere: { issueCount: 3 },
  issuesHere: { issueCount: 1 },
  externalClosed: { issueCount: 40 },
  externalMerged: { issueCount: 30 },
  linkedIssues: { issueCount: 5 },
  recentPrs: { issueCount: 20 },
  mergeSplit: { nodes: [] },
  user: {
    login: 'alice',
    createdAt: '2015-01-01T00:00:00Z',
    followers: { totalCount: 10 },
    isSiteAdmin: false,
    contributionsCollection: {
      contributionYears: [2024, 2023],
      restrictedContributionsCount: 0,
      totalPullRequestReviewContributions: 12,
    },
  },
  repository: { object: null },
});

const stub = (
  prs: ReceiptPr[] = [prNode(1), prNode(2)],
  author: string | { __typename: string; login: string } = 'alice',
) =>
  vi.spyOn(api, 'graphql').mockImplementation(async (query: string) => ({
    data: (query.includes('OctoScoreAuthor')
      ? {
          repository: {
            pullRequest: {
              author:
                typeof author === 'string'
                  ? { __typename: 'User', login: author }
                  : author,
            },
          },
        }
      : // biome-ignore lint/suspicious/noExplicitAny: the composed response is a union of source slices.
        fullData(prs)) as any,
    rate: null,
    withheld: null,
  }));

beforeEach(async () => {
  fakeBrowser.reset();
  await tokenItem.setValue('gh_test_token');
  await authored('alice');
});

describe('a reply always comes back', () => {
  /**
   * The panel waits on a promise that only the router resolves. When the work
   * behind it rejected, nothing answered, the browser closed the channel, and
   * the panel reported "Could not reach api.github.com" — blaming GitHub for a
   * fault in here. Everything below throws somewhere that used to be outside a
   * try block.
   */
  it.each([
    ['storage', () => vi.spyOn(settingsItem, 'getValue')],
    ['the remembered authors', () => vi.spyOn(prAuthorsItem, 'getValue')],
    ['the cache', () => vi.spyOn(cache, 'load')],
  ])('answers when %s throws', async (_what, target) => {
    stub();
    target().mockRejectedValue(new Error('disk on fire'));

    const r = await handleSignals({ ...REQ });

    expect(r.state).toBe('error');
    expect(r.error?.code).toBe('crashed');
    expect(r.error?.detail).toContain('disk on fire');
  });

  it('does not call an internal fault a network problem', async () => {
    stub();
    vi.spyOn(cache, 'load').mockRejectedValue(new Error('boom'));

    const r = await handleSignals({ ...REQ });

    // 'network' means api.github.com was unreachable. Saying that when the
    // fault is ours sends the maintainer to check their wifi.
    expect(r.error?.code).not.toBe('network');
  });
});

describe('who the PR is by', () => {
  it('asks GitHub rather than trusting the page', async () => {
    await prAuthorsItem.setValue({});
    const g = stub([prNode(1)], 'snemeckayova');

    const r = await handleSignals({ ...REQ });

    expect(r.login).toBe('snemeckayova');
    expect(g.mock.calls[0]?.[0]).toContain('OctoScoreAuthor');
  });

  it('remembers the author, so looking again costs no request', async () => {
    await prAuthorsItem.setValue({});
    const g = stub([prNode(1)], 'snemeckayova');
    await handleSignals({ ...REQ });
    g.mockClear();

    const again = await handleSignals({ ...REQ });

    expect(again.login).toBe('snemeckayova');
    expect(g.mock.calls.some((c) => String(c[0]).includes('OctoScoreAuthor'))).toBe(
      false,
    );
  });

  it('says so when GitHub reports no author', async () => {
    await prAuthorsItem.setValue({});
    vi.spyOn(api, 'graphql').mockResolvedValue({
      // A deleted account: `author` is nullable, and inventing one would be
      // worse than saying we cannot tell.
      data: { repository: { pullRequest: { author: null } } } as never,
      rate: null,
      withheld: null,
    });

    const r = await handleSignals({ ...REQ });

    expect(r.state).toBe('error');
    expect(r.error?.code).toBe('no-author');
  });

  it('still reads cached evidence for a known PR with no token', async () => {
    // The remembered author is what makes this possible: without it the panel
    // could not even name who the stale evidence is about.
    stub();
    await handleSignals({ ...REQ });
    await tokenItem.setValue('');

    const r = await handleSignals({ ...REQ });

    expect(r.state).toBe('evidence');
    expect(r.login).toBe('alice');
  });
});

describe('costs nothing when there is nothing to say', () => {
  it('never calls the API for a bot', async () => {
    const g = stub();
    let pr = 200;
    for (const login of ['dependabot[bot]', 'renovate', 'my-bot']) {
      await authored(login, ++pr);
      const r = await handleSignals({ ...REQ, prNumber: pr });
      expect(r.state).toBe('bot');
    }
    expect(g).not.toHaveBeenCalled();
  });

  it('takes GitHub’s word for it when an app is not named like one', async () => {
    // The bug this catches: bot detection used to be a guess from the login,
    // which misses every GitHub App not named `*-bot` or `*[bot]` —
    // dotnet-maestro, codecov, netlify. Those got a person-shaped read that
    // reported "no reviewed PRs found", i.e. "no track record", about software.
    const g = stub(undefined, { __typename: 'Bot', login: 'dotnet-maestro' });
    await prAuthorsItem.setValue({});
    await tokenItem.setValue('t');

    const r = await handleSignals({ ...REQ, prNumber: 321 });

    expect(r.state).toBe('bot');
    expect(looksLikeBot('dotnet-maestro')).toBe(false);
    // One request to learn who it is, and nothing after that.
    expect(g).toHaveBeenCalledTimes(1);
  });

  it('still knows a remembered bot is a bot after an upgrade', async () => {
    // Entries stored before the bot flag existed are bare logins. Reading one
    // must not quietly promote a known bot back to being a person.
    const g = stub();
    await prAuthorsItem.setValue({ 'acme/core#322': 'dependabot[bot]' });

    expect((await handleSignals({ ...REQ, prNumber: 322 })).state).toBe('bot');
    expect(g).not.toHaveBeenCalled();
  });

  it('knows a person is not a bot', () => {
    expect(looksLikeBot('alice')).toBe(false);
    expect(looksLikeBot('robotnik')).toBe(false);
  });

  it('never calls the API for a repo outside the allowlist', async () => {
    const g = stub();
    await settingsItem.setValue({
      window: 15,
      cacheMultiplier: 1,
      allowlist: ['other/repo'],
    });
    expect((await handleSignals({ ...REQ })).state).toBe('no-read');
    expect(g).not.toHaveBeenCalled();
  });

  it('runs on a repo covered by an org wildcard', async () => {
    stub();
    await settingsItem.setValue({
      window: 15,
      cacheMultiplier: 1,
      allowlist: ['acme/*'],
    });
    expect((await handleSignals({ ...REQ })).state).toBe('evidence');
  });
});

describe('the token', () => {
  it('refuses to fetch without one and says why', async () => {
    const g = stub();
    await tokenItem.setValue('');
    const r = await handleSignals({ ...REQ });
    expect(r.state).toBe('error');
    expect(r.error?.code).toBe('no-token');
    expect(g).not.toHaveBeenCalled();
  });

  /**
   * The panel keys its copy off `code` and prints `detail` underneath. When the
   * background also wrote a sentence for a condition the panel already has copy
   * for, the user saw the same instruction twice — which is what shipped, and
   * what this test exists to stop. The background carries detail it alone
   * knows; wording is the panel's.
   */
  it('sends no prose for a condition the panel already has copy for', async () => {
    stub();
    await tokenItem.setValue('');
    const r = await handleSignals({ ...REQ });
    expect(r.error?.detail).toBeUndefined();
  });

  it('never appears in the response', async () => {
    stub();
    const r = await handleSignals({ ...REQ });
    expect(JSON.stringify(r)).not.toContain('gh_test_token');
  });
});

describe('the cache', () => {
  it('fetches once and serves the second read from storage', async () => {
    const g = stub();
    const a = await handleSignals({ ...REQ });
    const b = await handleSignals({ ...REQ });
    expect(g).toHaveBeenCalledTimes(1);
    expect(b.sampled).toBe(a.sampled);
    expect(b.state).toBe('evidence');
  });

  it('refetches when the caller asks for a refresh', async () => {
    const g = stub();
    await handleSignals({ ...REQ });
    await handleSignals({ ...REQ, refresh: true });
    expect(g).toHaveBeenCalledTimes(2);
  });

  it('does not serve one author\u2019s data to another', async () => {
    const g = stub();
    await prAuthorsItem.setValue({ 'acme/core#99': 'alice', 'acme/core#100': 'bob' });

    await handleSignals({ ...REQ });
    const other = await handleSignals({ ...REQ, prNumber: 100 });

    expect(g).toHaveBeenCalledTimes(2);
    expect(other.login).toBe('bob');
  });

  it('gives an established account a longer life than a new one', () => {
    const est = cache.ttlFor(cache.maturityOf(3000, 200));
    const fresh = cache.ttlFor(cache.maturityOf(10, 0));
    expect(est).toBeGreaterThan(fresh);
    expect(cache.maturityOf(null, null)).toBe('unknown');
  });

  it('caching can be turned off entirely', async () => {
    const g = stub();
    await settingsItem.setValue({ window: 15, cacheMultiplier: 0, allowlist: [] });
    await handleSignals({ ...REQ });
    await handleSignals({ ...REQ });
    expect(g).toHaveBeenCalledTimes(2);
  });
});

describe('when GitHub fails', () => {
  it('reports a cold failure rather than an empty panel', async () => {
    vi.spyOn(api, 'graphql').mockRejectedValue(
      new api.GitHubError('rate-limited', 'slow down'),
    );
    const r = await handleSignals({ ...REQ });
    expect(r.state).toBe('error');
    expect(r.error?.code).toBe('rate-limited');
  });

  it('serves cached evidence marked stale rather than nothing', async () => {
    stub();
    await handleSignals({ ...REQ });

    // Age the cache past its TTL, then fail the refetch.
    vi.spyOn(api, 'graphql').mockRejectedValue(new api.GitHubError('network', 'offline'));
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 40 * 24 * 3600_000);

    const r = await handleSignals({ ...REQ });
    expect(r.state).toBe('evidence');
    expect(r.stale).toBe(true);
    expect(r.sampled).toBeGreaterThan(0);
  });
});

describe('the PR being viewed', () => {
  it('is not counted as its own history', async () => {
    // An open, un-reviewed PR would otherwise read as "engaged but silent" and
    // score the exact thing the maintainer is asking about.
    stub([prNode(99), prNode(1), prNode(2)]);
    const r = await handleSignals({ ...REQ, prNumber: 99 });
    const urls = (r.evidence.replyRate ?? []).map((x) => x.number);
    expect(urls).not.toContain(99);
    expect(urls).toContain(1);
  });

  it('is excluded on a CACHE HIT too, not just on the PR that was fetched', async () => {
    // The regression that made the exclusion move to read time. Receipts are
    // cached per author and reused across every PR you open, so filtering at
    // fetch time would freeze PR 99's exclusion into the payload and then
    // happily score PR 1 against itself on the next page view.
    const g = stub([prNode(99), prNode(1), prNode(2)]);
    // Both PRs by the same person, already known, so the only calls counted
    // here are evidence fetches.
    await prAuthorsItem.setValue({ 'acme/core#99': 'alice', 'acme/core#1': 'alice' });

    await handleSignals({ ...REQ, prNumber: 99 });
    expect(g).toHaveBeenCalledTimes(1);

    const r = await handleSignals({ ...REQ, prNumber: 1 });
    expect(g).toHaveBeenCalledTimes(1); // served from cache

    const numbers = (r.evidence.replyRate ?? []).map((x) => x.number);
    expect(numbers).not.toContain(1);
    expect(numbers).toContain(99);
  });
});

describe('cache keys follow what an answer actually depends on', () => {
  it('reuses author-global sources across repos', async () => {
    const g = stub();
    await prAuthorsItem.setValue({ 'acme/core#99': 'alice', 'other/thing#99': 'alice' });
    await handleSignals({ ...REQ, repo: 'acme/core' });
    g.mockClear();

    await handleSignals({ ...REQ, repo: 'other/thing' });
    // A second repo must not refetch the author's receipts or profile.
    const query = g.mock.calls[0]?.[0] ?? '';
    expect(query).not.toContain('receipts:');
    expect(query).not.toContain('contributionYears');
    expect(query).toContain('mergedHere:'); // but the repo-scoped source does refetch
  });

  it('reuses the repo vouch file across authors', async () => {
    const g = stub();
    await prAuthorsItem.setValue({ 'acme/core#99': 'alice', 'acme/core#100': 'bob' });
    await handleSignals({ ...REQ });
    g.mockClear();

    await handleSignals({ ...REQ, prNumber: 100 });
    // VOUCHED.td is one file per repo. Re-reading it once per contributor is
    // pure waste, and on a busy repo it is the most repeated call we make.
    const query = g.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('receipts:'); // different author, so this does refetch
    expect(query).not.toContain('VOUCHED.td');
  });
});

describe('the shape of a good answer', () => {
  it('carries finished evidence and a finished score', async () => {
    stub();
    const r = await handleSignals({ ...REQ });
    expect(r.state).toBe('evidence');
    expect(r.login).toBe('alice');
    expect(r.result?.lines.length).toBeGreaterThan(0);
    // The panel must be able to check the response is for who it asked about.
    expect(r.repo).toBe('acme/core');
  });

  it('always fetches receipts, even with every rule off', async () => {
    const g = stub();
    await handleSignals({ ...REQ });
    const query = g.mock.calls[0]?.[0] ?? '';
    expect(query).toContain('receipts:');
  });
});

describe('validating a token', () => {
  it('stores the token and the login it proved', async () => {
    await tokenItem.setValue('');
    vi.spyOn(api, 'graphql').mockResolvedValue({
      // biome-ignore lint/suspicious/noExplicitAny: viewer is not a SourceData slice.
      data: { viewer: { login: 'anthony' } } as any,
      rate: null,
      withheld: null,
    });

    const r = await validateToken('gh_good');
    expect(r).toEqual({ ok: true, login: 'anthony' });
    expect(await tokenItem.getValue()).toBe('gh_good');
    expect(await tokenLoginItem.getValue()).toBe('anthony');
  });

  it('never stores a token that failed', async () => {
    // The whole point of validate-then-store: a rejected token must not be
    // able to sit in storage failing every later request with a stale error.
    await tokenItem.setValue('gh_previously_good');
    vi.spyOn(api, 'graphql').mockRejectedValue(
      new api.GitHubError('token-invalid', 'Bad credentials'),
    );

    const r = await validateToken('gh_bad');
    expect(r).toEqual({
      ok: false,
      code: 'token-invalid',
      message: 'Bad credentials',
    });
    expect(await tokenItem.getValue()).toBe('gh_previously_good');
  });

  it('reports a network failure as network, not as a bad token', async () => {
    // Telling someone their token is invalid when their wifi dropped sends
    // them to GitHub to regenerate a credential that was fine.
    vi.spyOn(api, 'graphql').mockRejectedValue(new TypeError('Failed to fetch'));
    const r = await validateToken('gh_good');
    expect(r).toMatchObject({ ok: false, code: 'network' });
  });

  it('asks for nothing beyond the login', async () => {
    const g = vi.spyOn(api, 'graphql').mockResolvedValue({
      // biome-ignore lint/suspicious/noExplicitAny: viewer is not a SourceData slice.
      data: { viewer: { login: 'anthony' } } as any,
      rate: null,
      withheld: null,
    });
    await validateToken('gh_good');
    expect(g.mock.calls[0]?.[0]).toBe('query { viewer { login } }');
  });
});
