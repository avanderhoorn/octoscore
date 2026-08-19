/**
 * Calibration harness — REQUIREMENTS.md §11, FR12.
 *
 * The blocker before any UI is written. `replyRate` and `proseReplyRate` are
 * novel constructs with no support in the literature as author-level traits,
 * and together they are worth roughly ±40 points. This script runs the real
 * pipeline over real contributors so a maintainer can compare its output to
 * their own judgement.
 *
 *   GITHUB_TOKEN=... npm run calibrate -- --repo owner/name --limit 20
 *
 * FR14: if replyRate does not track maintainer judgement, it ships as
 * informational rather than being tuned until it agrees.
 */

import {
  buildQuery,
  graphql,
  parseVouch,
  type ReceiptPr,
  searchVars,
  shapePrCounts,
  shapeUserProfile,
  toReceipts,
  varsFor,
} from '../src/background/api';
import { sample } from '../src/background/receipts';
import { DEFAULT_PROFILE } from '../src/scoring/defaults';
import { evaluate, plan } from '../src/scoring/score';
import { DEFAULT_WINDOW } from '../src/scoring/signals';
import type { Receipt, SourceData } from '../src/shared/types';

// ---------------------------------------------------------------------------

const args = new Map<string, string>();
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i]?.replace(/^--/, '');
  if (k) args.set(k, process.argv[i + 1] ?? '');
}

const repo = args.get('repo');
const limit = Number(args.get('limit') ?? 20);
const window = Number(args.get('window') ?? DEFAULT_WINDOW);
const token = process.env.GITHUB_TOKEN ?? '';

if (!repo?.includes('/')) {
  console.error(
    'usage: npm run calibrate -- --repo owner/name [--limit 20] [--window 15]',
  );
  process.exit(1);
}
if (!token) {
  console.error('Set GITHUB_TOKEN. Fine-grained PAT, public repositories, read-only.');
  process.exit(1);
}

let totalCost = 0;
let remaining = 0;
/** Authors whose sample GitHub partially refused, usually SAML. Disclosed, never hidden. */
const withheldBy = new Map<string, { count: number; reason: string }>();

const bar = '─'.repeat(78);
const pct = (v: unknown) => (typeof v === 'number' ? `${Math.round(v * 100)}%` : '—');
const pad = (s: string, n: number) =>
  s.length > n ? `${s.slice(0, n - 1)}…` : s.padEnd(n);

// ---------------------------------------------------------------------------
// Who has sent PRs to this repo recently
// ---------------------------------------------------------------------------

async function recentAuthors(): Promise<{ login: string; assoc: string; pr: number }[]> {
  const q = `
    query($search: String!, $n: Int!) {
      search(query: $search, type: ISSUE, first: $n) {
        nodes { ... on PullRequest {
          number
          authorAssociation
          author { __typename login }
        } }
      }
      rateLimit { cost remaining }
    }`;
  const { data, rate } = await graphql<{
    search: {
      nodes: ({
        number: number;
        authorAssociation: string;
        author?: { __typename: string; login: string } | null;
      } | null)[];
    };
  }>(
    q,
    { search: `repo:${repo} is:pr sort:created-desc`, n: Math.min(limit * 3, 100) },
    token,
  );

  if (rate) {
    totalCost += rate.cost;
    remaining = rate.remaining;
  }

  // Keep the real PR number. Passing a placeholder made every author look like
  // GitHub had withheld something, because #1 usually does not exist.
  const seen = new Map<string, { assoc: string; pr: number }>();
  for (const n of data.search.nodes) {
    const a = n?.author;
    // Bot authors get a one-line note, not a panel. FR7
    if (!a?.login || a.__typename === 'Bot' || a.login.endsWith('[bot]')) continue;
    if (!seen.has(a.login))
      seen.set(a.login, { assoc: n?.authorAssociation ?? 'NONE', pr: n?.number ?? 0 });
  }
  return [...seen].slice(0, limit).map(([login, v]) => ({ login, ...v }));
}

// ---------------------------------------------------------------------------
// The real pipeline, for one author
// ---------------------------------------------------------------------------

async function fetchAuthor(
  login: string,
  assoc: string,
  pr: number,
): Promise<SourceData> {
  // Derived from config, not hand-maintained. Disabling a group provably stops
  // paying for it. §9.1
  const { sources } = plan(DEFAULT_PROFILE);
  const all = searchVars(login, repo as string, pr, window);
  const { data, rate, withheld } = await graphql<Record<string, unknown>>(
    buildQuery(sources, window),
    varsFor(sources, all),
    token,
  );
  if (rate) {
    totalCost += rate.cost;
    remaining = rate.remaining;
  }
  // Calibration judgements made against a silently-truncated sample are worse
  // than no calibration at all, so say so. §10.7
  if (withheld) withheldBy.set(login, withheld);

  const out: SourceData = {};

  if (sources.has('receipts')) {
    const nodes = (
      (data.receipts as { nodes: (ReceiptPr | null)[] })?.nodes ?? []
    ).filter((n): n is ReceiptPr => n != null && n.author != null);
    // Same two steps as the router: shape, then sample at read time. The PR we
    // found the author from must not be evidence about themselves. §10.3
    out.receipts = sample(
      toReceipts(nodes),
      { repo: repo as string, number: pr },
      window,
    );
  }

  if (sources.has('prCounts')) {
    out.prCounts = shapePrCounts(
      data as Parameters<typeof shapePrCounts>[0],
      login,
      assoc,
    );
  }

  if (sources.has('userProfile')) {
    const u = data.user as Parameters<typeof shapeUserProfile>[0] | null;
    if (u) out.userProfile = shapeUserProfile(u);
  }

  if (sources.has('vouch')) {
    const blob = (data.repository as { object?: { text?: string } } | null)?.object;
    out.vouch = parseVouch(blob?.text, login);
  }

  return out;
}

// ---------------------------------------------------------------------------

const mark = (r: Receipt) =>
  !r.reviewerEngaged
    ? '  no review'
    : r.authorRepliedAfter
      ? '✓ replied  '
      : r.authorPushedAfter
        ? '~ pushed   '
        : '✗ no reply ';

async function main() {
  console.log(`\n${bar}\nCalibration — ${repo}   window=${window}  authors=${limit}`);
  console.log(`Sources: ${[...plan(DEFAULT_PROFILE).sources].join(', ')}\n${bar}\n`);

  const authors = await recentAuthors();
  const rows: {
    login: string;
    total: number;
    band: string;
    reply: unknown;
    prose: unknown;
    n: number;
  }[] = [];

  for (const { login, assoc, pr } of authors) {
    let data: SourceData;
    try {
      data = await fetchAuthor(login, assoc, pr);
    } catch (e) {
      console.log(`${pad(login, 24)} ERROR  ${(e as Error).message}\n`);
      continue;
    }

    const { values, result } = evaluate(data, DEFAULT_PROFILE);
    const receipts = data.receipts ?? [];
    const engaged = receipts.filter((r) => r.reviewerEngaged);

    console.log(`${login}  ·  ${assoc}`);
    console.log(
      `  ${result.total >= 0 ? '+' : ''}${result.total} of ${result.maxAchievable} ` +
        `(${Math.round(result.ratio * 100)}%)  ·  ${result.band}`,
    );
    console.log(
      `  replyRate ${pct(values.replyRate)}   proseReplyRate ${pct(values.proseReplyRate)}` +
        `   mergeRate ${pct(values.mergeRate)}   reviewed ${engaged.length}/${receipts.length}`,
    );

    for (const r of receipts.slice(0, 6)) {
      const proj =
        r.projectHoursToFirstReview != null && r.projectHoursToFirstReview > 168
          ? `   [project took ${Math.round(r.projectHoursToFirstReview / 24)}d]`
          : '';
      console.log(`    ${mark(r)} ${pad(r.prTitle, 40)} ${r.repo}#${r.number}${proj}`);
    }

    // The judgement call this whole script exists to enable.
    console.log("    → your read: [ worth reviewing / not / can't tell ]\n");

    rows.push({
      login,
      total: result.total,
      band: result.band,
      reply: values.replyRate,
      prose: values.proseReplyRate,
      n: engaged.length,
    });
  }

  console.log(bar);
  console.log(
    `${pad('author', 24)}${pad('score', 8)}${pad('reply', 8)}${pad('prose', 8)}${pad('reviewed', 10)}band`,
  );
  console.log(bar);
  for (const r of rows.sort((a, b) => b.total - a.total)) {
    console.log(
      pad(r.login, 24) +
        pad(`${r.total >= 0 ? '+' : ''}${r.total}`, 8) +
        pad(pct(r.reply), 8) +
        pad(pct(r.prose), 8) +
        pad(String(r.n), 10) +
        r.band,
    );
  }
  console.log(bar);

  // §10.2 — the real number, replacing the estimate that used to sit in the doc.
  const perAuthor = rows.length ? (totalCost / rows.length).toFixed(1) : '—';
  console.log(
    `API cost: ${totalCost} points for ${rows.length} authors (${perAuthor}/author). ` +
      `${remaining} remaining this hour.`,
  );
  if (withheldBy.size) {
    console.log(
      `\n⚠ GitHub withheld part of the sample for ${withheldBy.size}/${rows.length} authors:`,
    );
    for (const [login, w] of withheldBy) {
      const why =
        w.reason === 'saml'
          ? 'SAML org this token is not authorised for'
          : 'private or otherwise not visible';
      console.log(`    ${login}: ${w.count} item(s) hidden — ${why}`);
    }
    console.log('  Their rates are computed on what remains. Judge them accordingly.');
  }
  const nulls = rows.filter((r) => r.reply == null).length;
  if (nulls) {
    console.log(
      `\n⚠ ${nulls}/${rows.length} authors had too few reviewed PRs to score follow-through.\n` +
        `  If that is most of them, the window is too small for this repo. §10.6`,
    );
  }
  console.log();
}

main().catch((e) => {
  console.error(`\n${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
