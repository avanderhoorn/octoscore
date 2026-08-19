import { describe, expect, it, vi } from 'vitest';
import type { SourceId } from '../shared/types';
import { buildQuery, graphql, parseVouch, searchVars, splitMerges, varsFor } from './api';

describe('VOUCHED.td', () => {
  const file = `
# maintainers vouching for contributors
github:alice  reviewed her work for two years
github:bob
-github:mallory  submitted three AI PRs that did not compile
gitlab:alice  wrong platform, ignored
`;

  it('vouches by exact login, case-insensitively', () => {
    expect(parseVouch(file, 'alice').status).toBe('vouched');
    expect(parseVouch(file, 'ALICE').status).toBe('vouched');
    expect(parseVouch(file, 'bob').status).toBe('vouched');
  });

  it('parses a leading minus but refuses to publish it', () => {
    // Denouncements are deliberately unsupported: a repo-authored "this named
    // person is untrustworthy", rendered on their PRs by a third party, is a
    // defamation surface. It must read as no-vouch, never as a vouch.
    const v = parseVouch(file, 'mallory');
    expect(v.status).toBe('none');
    expect(v.reason).toBeNull();
  });

  it('ignores other platforms, comments and unknown logins', () => {
    expect(parseVouch(file, 'carol').status).toBe('none');
    expect(parseVouch('', 'alice').status).toBe('none');
    expect(parseVouch(null, 'alice').status).toBe('none');
  });

  it('does not match a login by prefix', () => {
    expect(parseVouch('github:alice ok', 'alic').status).toBe('none');
    expect(parseVouch('github:alice ok', 'alicexyz').status).toBe('none');
  });

  it('last entry wins, so a vouch can be retracted', () => {
    expect(parseVouch('github:alice ok\n-github:alice retracted', 'alice').status).toBe(
      'none',
    );
    expect(parseVouch('-github:alice oops\ngithub:alice ok', 'alice').status).toBe(
      'vouched',
    );
  });
});

describe('merge splitting (§7.3)', () => {
  let n = 0;
  const pr = (
    owner: string,
    merged: boolean,
    mergedBy: string | null,
    repo = 'repo',
  ) => ({
    number: ++n,
    merged,
    repository: { nameWithOwner: `${owner}/${repo}`, owner: { login: owner } },
    mergedBy: mergedBy ? { login: mergedBy } : null,
  });
  const merged = (owner: string, by: string, repo?: string) => pr(owner, true, by, repo);
  const rejected = (owner: string, repo?: string) => pr(owner, false, null, repo);

  it('survives the nulls SAML puts INSIDE the nodes array', () => {
    // Not hypothetical. Against live GitHub, 7 of 100 nodes came back null for
    // a real contributor because they had touched a SAML-enforced org this
    // token is not authorised for. Reading `.repository` off that threw, and
    // the whole author panel died.
    const s = splitMerges(
      [merged('acme', 'maintainer'), null, null, rejected('acme')],
      'mallory',
    );
    expect(s.mergedByOthersExternal).toBe(1);
    // The hidden PRs must not silently pad the denominator.
    expect(s.sampleSize).toBe(2);
    expect(s.sampledExternalClosed).toBe(2);
  });

  it('reports the maintainer-with-commit-rights shape faithfully', () => {
    // The real case that found this: a dotnet/aspnetcore maintainer had 86 of
    // 100 closed PRs merged, 83 of them self-merged because they have commit
    // rights. Leaving self-merges in the denominator scored them at 3% and the
    // panel labelled them "Most PRs closed unmerged".
    const nodes = [
      ...Array.from({ length: 83 }, () => merged('dotnet', 'mallory', 'aspnetcore')),
      ...Array.from({ length: 3 }, () => merged('dotnet', 'someone-else', 'aspnetcore')),
      ...Array.from({ length: 14 }, () => rejected('dotnet', 'aspnetcore')),
    ];
    const s = splitMerges(nodes, 'mallory');
    expect(s.selfMergeExternal).toBe(83);
    expect(s.mergedByOthersExternal).toBe(3);
    expect(s.sampledExternalClosed).toBe(100);
    // What the mergeRate signal does with this is asserted in scoring/signals.test.ts.
  });

  it('separates self-merges at home from work others merged', () => {
    const s = splitMerges(
      [
        merged('mallory', 'mallory'),
        merged('mallory', 'mallory'),
        merged('acme', 'maintainer'),
        merged('acme', 'mallory'),
        merged('mallory', 'someone'),
      ],
      'mallory',
    );
    expect(s.selfMergeOwn).toBe(2);
    expect(s.selfMergeExternal).toBe(1);
    expect(s.mergedByOthersOwn).toBe(1);
    expect(s.mergedByOthersExternal).toBe(1);
  });

  it('300 self-merges buy no external track record', () => {
    const s = splitMerges(
      Array.from({ length: 300 }, () => merged('mallory', 'mallory')),
      'mallory',
    );
    expect(s.mergedByOthersExternal).toBe(0);
    expect(s.uniqueMergers).toBe(0);
  });

  it('counts breadth of trust, not volume', () => {
    // 20 PRs merged by one person is one maintainer's trust, not twenty. §7.2
    const s = splitMerges(
      Array.from({ length: 20 }, () => merged('acme', 'sameperson')),
      'contributor',
    );
    expect(s.mergedByOthersExternal).toBe(20);
    expect(s.uniqueMergers).toBe(1);
  });

  it('counts self-merge REPOS, not self-merge PRs', () => {
    // "Has commit rights on 5 repos" and "merged 5 PRs on one repo" are
    // different claims and the label makes the first one.
    const s = splitMerges(
      [
        merged('acme', 'contributor', 'a'),
        merged('acme', 'contributor', 'a'),
        merged('acme', 'contributor', 'b'),
      ],
      'contributor',
    );
    expect(s.selfMergeExternal).toBe(3);
    expect(s.uniqueSelfMergeRepos).toBe(2);
  });

  it('derives the merge-rate denominator from the same sample', () => {
    // The bug this replaces: a capped numerator over an uncapped issueCount
    // read 400-merged-of-500 as 100-of-500 and penalised the best record.
    const s = splitMerges(
      [
        ...Array.from({ length: 8 }, () => merged('acme', 'maintainer')),
        rejected('acme'),
        rejected('acme'),
        merged('contributor', 'contributor'),
        rejected('contributor'),
      ],
      'contributor',
    );
    expect(s.mergedByOthersExternal).toBe(8);
    expect(s.sampledExternalClosed).toBe(10);
    expect(s.sampleSize).toBe(12);
  });

  it('does not count closed-unmerged PRs as merges', () => {
    const s = splitMerges([rejected('acme'), rejected('acme')], 'contributor');
    expect(s.mergedByOthersExternal).toBe(0);
    expect(s.sampledExternalClosed).toBe(2);
  });

  it('is case-insensitive about owners and mergers', () => {
    const s = splitMerges([merged('Mallory', 'MALLORY')], 'mallory');
    expect(s.selfMergeOwn).toBe(1);
  });
});

describe('query composition', () => {
  const all = searchVars('octocat', 'acme/core', 1);

  it('declares exactly the variables it uses', () => {
    for (const sources of [
      new Set<SourceId>(['receipts']),
      new Set<SourceId>(['vouch']),
      new Set<SourceId>(['receipts', 'prCounts', 'userProfile', 'vouch']),
    ]) {
      const q = buildQuery(sources);
      const declared = [...q.matchAll(/\$(\w+):/g)].map((m) => m[1]);
      const used = new Set([...q.matchAll(/[:(]\s*\$(\w+)/g)].map((m) => m[1]));
      // GraphQL rejects a declared-but-unused variable.
      for (const d of declared) expect(used.has(d)).toBe(true);
      expect(Object.keys(varsFor(sources, all)).sort()).toEqual(
        [...new Set(declared)].sort(),
      );
    }
  });

  it('always asks what the request cost', () => {
    expect(buildQuery(new Set<SourceId>(['receipts']))).toContain('rateLimit');
  });

  it('excludes repos the author owns when counting external PRs', () => {
    expect(all.extClosed).toContain('-user:octocat');
  });
});

describe('partial responses (the SAML case)', () => {
  const ok = (body: unknown, status = 200) =>
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

  const samlError = (n: number) =>
    Array.from({ length: n }, () => ({
      type: 'FORBIDDEN',
      message: 'Resource protected by organization SAML enforcement.',
      extensions: { saml_failure: true },
    }));

  it('keeps usable data when SAML hides some nodes', async () => {
    // Verified against real GitHub: 27 of 30 nodes returned, 3 nulled, and
    // `errors` populated. Throwing here broke the extension outright for
    // anyone who has ever contributed to a SAML-enforced org.
    ok({
      data: { search: { nodes: [{ number: 1 }, null, null, null] }, rateLimit: null },
      errors: samlError(3),
    });

    const r = await graphql<{ search: { nodes: unknown[] } }>('query{}', {}, 'tok');
    expect(r.data.search.nodes).toHaveLength(4);
    expect(r.withheld).toEqual({ count: 3, reason: 'saml' });
  });

  it('reports a non-SAML refusal as forbidden, not saml', async () => {
    ok({
      data: { search: { nodes: [] } },
      errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible.' }],
    });
    const r = await graphql('query{}', {}, 'tok');
    expect(r.withheld).toEqual({ count: 1, reason: 'forbidden' });
  });

  it('does not cry wolf when something is merely absent', async () => {
    // NOT_FOUND is the ordinary reply for an optional field: no VOUCHED.td, a
    // deleted PR, a renamed repo. A live calibration run reported "GitHub
    // withheld part of the sample" for 7 of 7 authors on this alone, which is
    // how a disclosure stops meaning anything.
    ok({
      data: { search: { nodes: [] } },
      errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a PullRequest.' }],
    });
    const r = await graphql('query{}', {}, 'tok');
    expect(r.withheld).toBeNull();
  });

  it('discloses the refusal even when an absence rides along', async () => {
    ok({
      data: { search: { nodes: [] } },
      errors: [
        { type: 'NOT_FOUND', message: 'no VOUCHED.td' },
        { type: 'FORBIDDEN', message: 'saml', extensions: { saml_failure: true } },
      ],
    });
    const r = await graphql('query{}', {}, 'tok');
    expect(r.withheld).toEqual({ count: 1, reason: 'saml' });
  });

  it('still throws when the denial came with no data at all', async () => {
    ok({ errors: samlError(1) });
    await expect(graphql('query{}', {}, 'tok')).rejects.toMatchObject({
      code: 'token-scope',
    });
  });

  it('never swallows rate limiting, even alongside data', async () => {
    // Partial tolerance must not become "ignore errors". A rate limit has
    // nothing usable behind it and must stay a hard stop.
    ok({
      data: { search: null },
      errors: [{ type: 'RATE_LIMITED', message: 'slow down' }],
    });
    await expect(graphql('query{}', {}, 'tok')).rejects.toMatchObject({
      code: 'rate-limited',
    });
  });

  it('reports nothing withheld on a clean response', async () => {
    ok({ data: { search: { nodes: [] }, rateLimit: { cost: 1, remaining: 4999 } } });
    const r = await graphql('query{}', {}, 'tok');
    expect(r.withheld).toBeNull();
    expect(r.rate).toEqual({ cost: 1, remaining: 4999 });
  });
});
